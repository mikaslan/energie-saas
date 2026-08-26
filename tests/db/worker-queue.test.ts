// pg-boss v12: work()-Handler erhält ein Job-Array (batchSize default 1),
// createQueue() muss vor send() aufgerufen werden, fetch()/complete()
// arbeiten ebenfalls mit Arrays — siehe Doku-Abgleich in
// docs/runbooks/worker.md ("Doku-Abweichungen von der Aufgabenskizze").
import { describe, it, expect } from "vitest";
import { PgBoss } from "pg-boss";

interface EchoPayload {
  ping: number;
}

describe("pg-boss Roundtrip", () => {
  it("sendet und empfängt einen Job", async () => {
    const boss = new PgBoss(process.env.POSTGRES_URL_TEST!);
    await boss.start();
    await boss.createQueue("health.echo");
    await boss.send("health.echo", { ping: 1 });
    const [job] = await boss.fetch<EchoPayload>("health.echo");
    expect(job?.data.ping).toBe(1);
    await boss.complete("health.echo", [job!.id]);
    await boss.stop({ graceful: false });
  }, 30_000);
});
