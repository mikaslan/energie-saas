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

const STARTED = new Date().toISOString();

const boss = new PgBoss(process.env.POSTGRES_URL!);
boss.on("error", (err) => console.error("[pg-boss]", err));

const server = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, startedAt: STARTED }));
});

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} empfangen, fahre herunter …`);
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
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
