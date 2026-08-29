import { readFile } from "node:fs/promises";
import { PgBoss } from "pg-boss";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFatalWorkerErrorReporter,
  pgBossWorkerPoolConfig,
  VerifiedPgBossDatabase,
} from "@/worker/pgboss-database";

const ORIGINAL_ROLE_MODE = process.env.DB_ROLE_MODE;

class FakeQueryPool extends EventEmitter {
  query = vi.fn(async (text: string, values?: unknown[]) => {
    void text;
    void values;
    return { rows: [] as unknown[] };
  });
  end = vi.fn(async () => undefined);
}

afterEach(() => {
  if (ORIGINAL_ROLE_MODE === undefined) delete process.env.DB_ROLE_MODE;
  else process.env.DB_ROLE_MODE = ORIGINAL_ROLE_MODE;
});

describe("verifizierter pg-boss-Pool", () => {
  it("nutzt den offiziell unterstützten IDatabase-Injektionspfad", () => {
    const pool = new FakeQueryPool();
    const database = new VerifiedPgBossDatabase(pool, vi.fn());
    const boss = new PgBoss({ db: database, schema: "pgboss", createSchema: false });

    expect(boss.getDb()).toBe(database);
  });

  it("baut den Worker-Pool mit dem app_worker-Live-Verify-Gate", () => {
    process.env.DB_ROLE_MODE = "strict";

    const config = pgBossWorkerPoolConfig(
      "postgres://app_worker:secret@127.0.0.1:5432/app",
      7,
    );

    expect(config.max).toBe(7);
    expect(config.verify).toBeTypeOf("function");
  });

  it("delegiert SQL und schließt den injizierten Pool genau einmal", async () => {
    const pool = new FakeQueryPool();
    pool.query.mockResolvedValue({ rows: [{ ok: true }] });
    const database = new VerifiedPgBossDatabase(pool, vi.fn());

    await expect(database.executeSql("select $1::int as ok", [1])).resolves.toEqual({
      rows: [{ ok: true }],
    });
    expect(pool.query).toHaveBeenCalledWith("select $1::int as ok", [1]);

    await Promise.all([database.close(), database.close()]);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("fängt einen idle-Poolfehler ab und startet den zentralen Fatalpfad nur einmal", () => {
    const pool = new FakeQueryPool();
    const onFirstError = vi.fn();
    const reportFatal = createFatalWorkerErrorReporter(onFirstError);
    new VerifiedPgBossDatabase(pool, (error) => reportFatal("pg-boss-pool", error));

    const idleFailure = new Error("idle socket lost");
    expect(() => pool.emit("error", idleFailure)).not.toThrow();
    expect(reportFatal("pg-boss", new Error("poller followed"))).toBe(false);
    expect(onFirstError).toHaveBeenCalledTimes(1);
    expect(onFirstError).toHaveBeenCalledWith("pg-boss-pool", idleFailure);
  });

  it("verdrahtet im Worker keine zweite direkte pg-boss-Verbindung mehr", async () => {
    const source = await readFile("worker/index.ts", "utf8");

    expect(source).toContain("db: bossDatabase");
    expect(source).toContain("createVerifiedPgBossDatabase(WORKER_URL, 5, (error)");
    expect(source).toContain('reportFatalWorkerError("pg-boss-pool", error)');
    expect(source).toContain('reportFatalWorkerError("pg-boss", err)');
    expect(source).toContain("shutdown(`${source}-Fehler`, true)");
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain('await shutdown("Startfehler", true)');
    expect(source).not.toContain("process.exit(1)");
    expect(source).toContain("failures.length === 0 && !fatalShutdown ? 0 : 1");
    expect(source).not.toContain("postgresConnectionTransport");
  });
});
