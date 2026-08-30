// Worker-Host: pg-boss + Healthcheck. Läuft als eigener Prozess neben dem
// Next.js-Portal (siehe docs/runbooks/worker.md) und blockiert dieses NIE —
// fällt der Worker aus, verzögern sich nur Jobs (PDF/Simulation), das Portal
// bleibt erreichbar.
//
// pg-boss-API-Stand (siehe Doku-Abgleich in docs/runbooks/worker.md,
// Abschnitt "Doku-Abweichungen von der Aufgabenskizze"): v12 — createQueue()
// vor send(), work()-Handler erhält ein Job-Array (batchSize default 1).
//
// Kein Top-Level-await: package.json setzt "type" nicht auf "module", daher
// transformiert tsx diese Datei für die CJS-Ausgabe — dort ist Top-Level-
// await nicht erlaubt ("Transform failed ... Top-level await is currently
// not supported with the 'cjs' output format", verifiziert beim ersten
// lokalen Start). Die Aufgabenskizze nutzte Top-Level-await; hier stattdessen
// in eine async main()-Funktion verpackt.
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { calculatePlanningEstimate } from
  "../lib/integrations/calculation/engine";
import { buildPlanningCalculationInput } from
  "../lib/integrations/calculation/prepare";
import { fetchPvgisYieldSnapshots } from
  "../lib/integrations/calculation/pvgis";
import { requireServiceDatabaseUrl } from "../lib/db/role-env";
import { createCalculationExecuteHandler } from "./calculation";
import { createCalculationDatabaseGateway } from "./calculation-database";
import { createHealthProbe, createHealthServer, startHeartbeat } from "./health";
import {
  createOfferPdfRenderHandler,
  startOfferPdfRecoverySweep,
  type OfferPdfRecoveryController,
} from "./offer-pdf";
import { createOfferPdfDatabaseGateway } from "./offer-pdf-database";
import { createPlaywrightOfferPdfRenderer } from "./offer-pdf-renderer";
import {
  createFatalWorkerErrorReporter,
  createVerifiedPgBossDatabase,
} from "./pgboss-database";
import { createWorkerStartupGate } from "./startup-gate";

const STARTED = new Date().toISOString();
const CALCULATION_QUEUE = "calculation.execute";
const OFFER_PDF_QUEUE = "pdf.render";

// Einziger Worker-Principal: kein stiller Rückfall auf die Runtime-Rolle. Der
// Wert wird EINMAL aufgelöst, damit pg-boss und Health-Probe garantiert dieselbe
// Datenbank messen. app_worker besitzt nur das vorab angelegte Schema pgboss.
const WORKER_URL = requireServiceDatabaseUrl("POSTGRES_URL_WORKER", "app_worker");

// Wird in main() gesetzt, wenn SENTRY_DSN vorhanden ist. Handler unten dürfen
// nicht auf Sentrys Unhandled-Hooks vertrauen: sie BEHANDELN die Fehler ja
// (Codex-Review #6) — also hier explizit erfassen.
let sentry: typeof import("@sentry/node") | undefined;
let stopHeartbeat: (() => void) | undefined;
let offerPdfRecovery: OfferPdfRecoveryController | undefined;
let shutdownPromise: Promise<void> | undefined;
let fatalShutdown = false;
let bossFailure: Error | undefined;
const startupGate = createWorkerStartupGate();

const reportFatalWorkerError = createFatalWorkerErrorReporter((source, error) => {
  bossFailure = error;
  console.error(`[${source}]`, error);
  sentry?.captureException(error);
  void shutdown(`${source}-Fehler`, true);
});

// Der Pool-Listener hängt bereits, bevor PgBoss den Adapter erhält und seine
// erste Query ausführen kann. Pool- und PgBoss-Fehler teilen denselben
// einmaligen Fatalpfad.
const bossDatabase = createVerifiedPgBossDatabase(WORKER_URL, 5, (error) => {
  reportFatalWorkerError("pg-boss-pool", error);
});
const calculationGateway = createCalculationDatabaseGateway(
  WORKER_URL,
  (error) => reportFatalWorkerError("calculation-pool", error),
  2,
);
const offerPdfGateway = createOfferPdfDatabaseGateway(
  WORKER_URL,
  (error) => reportFatalWorkerError("offer-pdf-pool", error),
  2,
);
const boss = new PgBoss({
  db: bossDatabase,
  schema: "pgboss",
  createSchema: false,
});
boss.on("error", (err) => {
  // Ein laufender Prozess mit dauerhaft fehlerhaftem Poller ist schlimmer als
  // ein sichtbarer Restart: Er würde sonst weiter Health/Dead-Man grün melden,
  // obwohl keine Kundenjobs mehr bearbeitet werden. Docker startet ihn mit
  // `restart: always` nach dem geordneten Fehler-Shutdown neu.
  reportFatalWorkerError("pg-boss", err);
});
const calculationHandler = createCalculationExecuteHandler({
  database: calculationGateway.database,
  provider: { fetch: fetchPvgisYieldSnapshots },
  buildInput: buildPlanningCalculationInput,
  engine: {
    async calculate(input) {
      return calculatePlanningEstimate(input);
    },
  },
  createLeaseToken: randomUUID,
});
const offerPdfHandler = createOfferPdfRenderHandler({
  database: offerPdfGateway.database,
  renderer: createPlaywrightOfferPdfRenderer(),
  createLeaseToken: randomUUID,
  onIntegrityIncident: (error) => {
    reportFatalWorkerError("offer-pdf-integrity", error);
  },
});

// Readiness braucht eine AKTUELLE Probe, nicht nur "hat mal gestartet" — und
// diese Probe braucht Timeouts, die tatsächlich abbrechen. Beides steckt in
// worker/health.ts (dort auch die vollständige Begründung); hier bleibt nur
// die Verdrahtung, damit der Probe-Pfad ohne den pg-boss-Start testbar ist.
const health = createHealthProbe(WORKER_URL, undefined, () => {
  if (bossFailure) throw new Error("pg-boss ist nicht mehr betriebsfähig.", { cause: bossFailure });
});
const server = createHealthServer(health, STARTED);

function closeHealthServer(): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function shutdown(signal: string, fatal = false): Promise<void> {
  // Synchron vor jedem await sichtbar: main() darf ab jetzt keinen weiteren
  // Queue-/Heartbeat-/Server-Startschritt mehr registrieren.
  startupGate.requestShutdown();
  fatalShutdown ||= fatal;
  shutdownPromise ??= (async () => {
    console.log(`[worker] ${signal} empfangen, fahre herunter …`);
    stopHeartbeat?.();
    stopHeartbeat = undefined;
    const recoveryStopped = offerPdfRecovery?.stop() ?? Promise.resolve();
    offerPdfRecovery = undefined;

    // Keine neuen Health-Requests mehr annehmen; bestehende Requests dürfen
    // parallel zum pg-boss-Drain innerhalb ihres 2-s-Probe-Budgets enden.
    const serverClosed = closeHealthServer();
    const stopBoss = async () => {
      try {
        // Der tenantweise Recovery-Sweep darf nach Beginn des Drains keine
        // weiteren Dispatches erzeugen. stop() wartet auf genau den laufenden,
        // begrenzten Sweep; es gibt wegen rekursivem Timeout nie einen zweiten.
        await recoveryStopped;
        await boss.stop({ graceful: true, timeout: 15_000 });
      } finally {
        // Bei einem benutzerdefinierten IDatabase-Adapter verwaltet pg-boss
        // dessen Lifecycle bewusst nicht selbst. Der Fachpool schliesst erst
        // nach dem Drain, damit ein laufender Calculation-Handler seine letzte
        // CAS-Transaktion noch abschliessen kann.
        await Promise.all([
          bossDatabase.close(),
          calculationGateway.close(),
          offerPdfGateway.close(),
        ]);
      }
    };
    const results = await Promise.allSettled([
      stopBoss(),
      serverClosed,
      health.close(),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    for (const failure of failures) {
      if (failure.status === "rejected") console.error("[worker] Shutdownfehler:", failure.reason);
    }

    await sentry?.flush(2_000).catch((error: unknown) => {
      console.error("[worker] Sentry-Flush fehlgeschlagen:", error);
    });
    process.exitCode = failures.length === 0 && !fatalShutdown ? 0 : 1;
  })();
  return shutdownPromise;
}

async function main() {
  startupGate.assertOpen();
  // Gerüst hinter Env-Flag (Tooling-Mission): ohne SENTRY_DSN inaktiv. Werte
  // kommen mit der Einkaufsliste (docs/tooling/einkaufsliste.md, EU-Region!).
  if (process.env.SENTRY_DSN) {
    sentry = await import("@sentry/node");
    startupGate.assertOpen();
    sentry.init({ dsn: process.env.SENTRY_DSN });
    console.log("[worker] Sentry aktiv");
  }

  // Fail-closed noch vor pg-boss: Die unabhängige Probe muss den echten
  // app_worker-Principal (und bei Neon Tenant/Timeline) live bestätigen.
  // Danach prüft derselbe Pool jede neu aufgebaute Probe-Verbindung erneut.
  await health.probe();
  startupGate.assertOpen();
  await calculationGateway.probe();
  startupGate.assertOpen();
  await offerPdfGateway.probe();
  startupGate.assertOpen();
  await boss.start();
  startupGate.assertOpen();
  await boss.createQueue(CALCULATION_QUEUE, {
    policy: "exclusive",
    retryLimit: 10,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 60,
    expireInSeconds: 900,
  });
  startupGate.assertOpen();
  await boss.createQueue("health.echo");
  startupGate.assertOpen();
  await boss.work("health.echo", async (jobs) => {
    for (const job of jobs) console.log("[health.echo]", job.id, job.data);
  });
  startupGate.assertOpen();
  await boss.work(CALCULATION_QUEUE, calculationHandler);
  startupGate.assertOpen();
  await boss.createQueue(OFFER_PDF_QUEUE, {
    policy: "exclusive",
    retryLimit: 10,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 60,
    expireInSeconds: 180,
  });
  startupGate.assertOpen();
  await boss.work(
    OFFER_PDF_QUEUE,
    { batchSize: 1, localConcurrency: 2 },
    offerPdfHandler,
  );
  startupGate.assertOpen();
  offerPdfRecovery = startOfferPdfRecoverySweep({
    database: offerPdfGateway,
    onFatal: (error) => {
      reportFatalWorkerError("offer-pdf-recovery", error);
    },
  });
  startupGate.assertOpen();
  // M4 registriert hier simulation.run (pvlib-Sidecar).
  // Job-Namenskonvention: "<modul>.<aufgabe>".

  // Dead-Man-Heartbeat ERST nach vollständiger Worker-Registrierung (Codex-
  // Review #3): ein Ping attestiert "arbeitsfähig", nicht bloß "DB erreichbar".
  if (process.env.HEALTHCHECKS_PING_URL) {
    stopHeartbeat = startHeartbeat(health, process.env.HEALTHCHECKS_PING_URL);
    console.log("[worker] Dead-Man-Heartbeat aktiv");
  }

  startupGate.assertOpen();
  server.listen(8080, () => console.log("worker health on :8080"));
}

// Bereits vor dem ersten await in main() registriert: Auch ein Signal während
// Live-Verifikation, pg-boss-Start oder Queue-Registrierung läuft durch
// denselben idempotenten Cleanup-Pfad.
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

main().catch(async (err) => {
  if (startupGate.shutdownRequested) {
    await shutdown("Startabbruch");
    return;
  }
  console.error("[worker] Startfehler:", err);
  bossFailure = err instanceof Error ? err : new Error(String(err));
  sentry?.captureException(err);
  await shutdown("Startfehler", true);
});
