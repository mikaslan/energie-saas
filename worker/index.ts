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
import { PgBoss } from "pg-boss";
import { requireServiceDatabaseUrl } from "../lib/db/role-env";
import { createHealthProbe, createHealthServer, startHeartbeat } from "./health";
import {
  createFatalWorkerErrorReporter,
  createVerifiedPgBossDatabase,
} from "./pgboss-database";

const STARTED = new Date().toISOString();

// Einziger Worker-Principal: kein stiller Rückfall auf die Runtime-Rolle. Der
// Wert wird EINMAL aufgelöst, damit pg-boss und Health-Probe garantiert dieselbe
// Datenbank messen. app_worker besitzt nur das vorab angelegte Schema pgboss.
const WORKER_URL = requireServiceDatabaseUrl("POSTGRES_URL_WORKER", "app_worker");

// Wird in main() gesetzt, wenn SENTRY_DSN vorhanden ist. Handler unten dürfen
// nicht auf Sentrys Unhandled-Hooks vertrauen: sie BEHANDELN die Fehler ja
// (Codex-Review #6) — also hier explizit erfassen.
let sentry: typeof import("@sentry/node") | undefined;
let stopHeartbeat: (() => void) | undefined;
let shutdownPromise: Promise<void> | undefined;
let fatalShutdown = false;
let bossFailure: Error | undefined;

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
  fatalShutdown ||= fatal;
  shutdownPromise ??= (async () => {
    console.log(`[worker] ${signal} empfangen, fahre herunter …`);
    stopHeartbeat?.();
    stopHeartbeat = undefined;

    // Keine neuen Health-Requests mehr annehmen; bestehende Requests dürfen
    // parallel zum pg-boss-Drain innerhalb ihres 2-s-Probe-Budgets enden.
    const serverClosed = closeHealthServer();
    const stopBoss = async () => {
      try {
        await boss.stop({ graceful: true, timeout: 15_000 });
      } finally {
        // Bei einem benutzerdefinierten IDatabase-Adapter verwaltet pg-boss
        // dessen Lifecycle bewusst nicht selbst.
        await bossDatabase.close();
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
  // Gerüst hinter Env-Flag (Tooling-Mission): ohne SENTRY_DSN inaktiv. Werte
  // kommen mit der Einkaufsliste (docs/tooling/einkaufsliste.md, EU-Region!).
  if (process.env.SENTRY_DSN) {
    sentry = await import("@sentry/node");
    sentry.init({ dsn: process.env.SENTRY_DSN });
    console.log("[worker] Sentry aktiv");
  }

  // Fail-closed noch vor pg-boss: Die unabhängige Probe muss den echten
  // app_worker-Principal (und bei Neon Tenant/Timeline) live bestätigen.
  // Danach prüft derselbe Pool jede neu aufgebaute Probe-Verbindung erneut.
  await health.probe();
  await boss.start();
  await boss.createQueue("health.echo");
  await boss.work("health.echo", async (jobs) => {
    for (const job of jobs) console.log("[health.echo]", job.id, job.data);
  });
  // M2 registriert hier pdf.render (Playwright/Chrome), M4 simulation.run (pvlib-Sidecar).
  // Job-Namenskonvention: "<modul>.<aufgabe>".

  // Dead-Man-Heartbeat ERST nach vollständiger Worker-Registrierung (Codex-
  // Review #3): ein Ping attestiert "arbeitsfähig", nicht bloß "DB erreichbar".
  if (process.env.HEALTHCHECKS_PING_URL) {
    stopHeartbeat = startHeartbeat(health, process.env.HEALTHCHECKS_PING_URL);
    console.log("[worker] Dead-Man-Heartbeat aktiv");
  }

  server.listen(8080, () => console.log("worker health on :8080"));
}

// Bereits vor dem ersten await in main() registriert: Auch ein Signal während
// Live-Verifikation, pg-boss-Start oder Queue-Registrierung läuft durch
// denselben idempotenten Cleanup-Pfad.
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

main().catch(async (err) => {
  console.error("[worker] Startfehler:", err);
  bossFailure = err instanceof Error ? err : new Error(String(err));
  sentry?.captureException(err);
  await shutdown("Startfehler", true);
});
