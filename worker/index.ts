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
import { createHealthProbe, createHealthServer } from "./health";

const STARTED = new Date().toISOString();

// POSTGRES_URL_WORKER hat Vorrang: nach der Rollentrennung (ADR 0003) läuft der
// Worker als app_worker mit eigenem pgboss-Schema und ohne Domänenrechte auf
// Vorrat. Solange die Trennung aussteht, ist der Fallback auf POSTGRES_URL der
// heutige Zustand — die dort dokumentierte M0-Limitation. Der Wert wird EINMAL
// aufgelöst, damit pg-boss und die Health-Probe garantiert dieselbe Datenbank
// messen; sonst könnte /health eine andere DB grün melden, als der Worker nutzt.
const WORKER_URL = process.env.POSTGRES_URL_WORKER ?? process.env.POSTGRES_URL;
if (!WORKER_URL) throw new Error("Weder POSTGRES_URL_WORKER noch POSTGRES_URL ist gesetzt");

const boss = new PgBoss(WORKER_URL);
boss.on("error", (err) => console.error("[pg-boss]", err));

// Readiness braucht eine AKTUELLE Probe, nicht nur "hat mal gestartet" — und
// diese Probe braucht Timeouts, die tatsächlich abbrechen. Beides steckt in
// worker/health.ts (dort auch die vollständige Begründung); hier bleibt nur
// die Verdrahtung, damit der Probe-Pfad ohne den pg-boss-Start testbar ist.
const health = createHealthProbe(WORKER_URL);
const server = createHealthServer(health, STARTED);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} empfangen, fahre herunter …`);
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await health.close().catch((err: unknown) => console.error("[worker] health.close:", err));
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
