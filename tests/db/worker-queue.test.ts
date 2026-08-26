// pg-boss v12: work()-Handler erhält ein Job-Array (batchSize default 1),
// createQueue() muss vor send() aufgerufen werden, fetch()/complete()
// arbeiten ebenfalls mit Arrays — siehe Doku-Abgleich in
// docs/runbooks/worker.md ("Doku-Abweichungen von der Aufgabenskizze").
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";

interface EchoPayload {
  ping: number;
}

describe("pg-boss Roundtrip", () => {
  // Codex-Review (Minor): der Test war auf zwei Arten falsch-grün-fähig.
  //  1. Fester Queue-Name "health.echo": aus einer PERSISTENTEN Test-DB
  //     konnte fetch() einen Altjob eines früheren Laufs liefern, während der
  //     gerade gesendete Job noch gar nicht sichtbar war. Deshalb jetzt ein
  //     eindeutiger Queue-Name pro Lauf.
  //  2. Die von send() gelieferte Job-ID wurde ignoriert. Jetzt wird sie
  //     gegen die gefetchte ID geprüft — nur so ist bewiesen, dass GENAU der
  //     abgeschickte Job zurückkam.
  // Zusätzlich: try/finally um stop() (nach einem Fehler blieb sonst ein
  // laufender pg-boss samt Verbindungen zurück) und ein error-Listener, damit
  // asynchrone pg-boss-Fehler nicht als unhandled 'error' den Lauf killen.
  it("sendet und empfängt GENAU den abgeschickten Job", async () => {
    const queue = `test.echo.${randomUUID()}`;
    const boss = new PgBoss(process.env.POSTGRES_URL_TEST!);
    const bossErrors: unknown[] = [];
    boss.on("error", (err) => bossErrors.push(err));

    try {
      await boss.start();
      await boss.createQueue(queue);

      const sentId = await boss.send(queue, { ping: 1 });
      expect(sentId, "send() lieferte keine Job-ID").toBeTruthy();

      const [job] = await boss.fetch<EchoPayload>(queue);
      expect(job, "kein Job aus der Queue erhalten").toBeDefined();
      expect(job!.id, "gefetchter Job ist NICHT der gesendete").toBe(sentId);
      expect(job!.data.ping).toBe(1);

      await boss.complete(queue, [job!.id]);

      // Nach complete() liefert dieselbe Queue nichts mehr.
      const nachher = await boss.fetch<EchoPayload>(queue);
      expect(nachher ?? [], "Job wurde nicht als erledigt markiert").toHaveLength(0);
    } finally {
      await boss.stop({ graceful: false }).catch(() => {});
    }

    expect(bossErrors, `pg-boss meldete Fehler: ${bossErrors.map(String).join(", ")}`).toEqual([]);
  }, 30_000);
});
