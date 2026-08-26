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
import { createServer } from "node:http";
import { Pool } from "pg";

const STARTED = new Date().toISOString();

const boss = new PgBoss(process.env.POSTGRES_URL!);
boss.on("error", (err) => console.error("[pg-boss]", err));

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #26: /health lieferte nach einem erfolgreichen Start DAUERHAFT
// HTTP 200 — auch wenn die Datenbank längst weg war. pg-boss-Fehler wurden nur
// geloggt. Ein Worker, der keinen einzigen Job mehr verarbeiten kann, blieb so
// health-grün: kein Neustart durch den Orchestrator, kein Alarm.
//
// Readiness braucht deshalb eine AKTUELLE Probe, nicht nur "hat mal gestartet".
// Eigener kleiner Pool statt des pg-boss-internen: der ist nicht öffentlich
// zugesichert, und eine unabhängige Verbindung misst genau das, was der Worker
// zum Arbeiten braucht.
// ═══════════════════════════════════════════════════════════════════════
const probePool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
probePool.on("error", (err) => console.error("[health-probe]", err));

const PROBE_TIMEOUT_MS = 2_000;

async function probeDatabase(): Promise<void> {
  const client = await probePool.connect();
  try {
    // statement_timeout deckt eine hängende Query ab; das Promise.race deckt
    // zusätzlich ein Hängen VOR der Query ab (z. B. TCP ohne Antwort).
    await client.query(`set local statement_timeout = ${PROBE_TIMEOUT_MS}`);
    await client.query("select 1");
  } finally {
    client.release();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Health-Probe nach ${ms} ms abgebrochen`)), ms).unref(),
    ),
  ]);
}

const server = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  withTimeout(probeDatabase(), PROBE_TIMEOUT_MS).then(
    () => res.end(JSON.stringify({ ok: true, startedAt: STARTED })),
    (err: unknown) => {
      console.error("[worker] Health-Probe fehlgeschlagen:", err);
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, startedAt: STARTED, error: String(err) }));
    },
  );
});

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} empfangen, fahre herunter …`);
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await probePool.end().catch((err: unknown) => console.error("[worker] probePool.end:", err));
  process.exit(0);
}

async function main() {
  await boss.start();
  await boss.createQueue("health.echo");
  await boss.work("health.echo", async (jobs) => {
    for (const job of jobs) console.log("[health.echo]", job.id, job.data);
  });
  // M2 registriert hier pdf.render (Playwright/Chrome), M4 simulation.run (pvlib-Sidecar).
  // Job-Namenskonvention: "<modul>.<aufgabe>".

  server.listen(8080, () => console.log("worker health on :8080"));

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] Startfehler:", err);
  process.exit(1);
});
