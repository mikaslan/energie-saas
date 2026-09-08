import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
  endPoolsAndStopEmbeddedPostgres,
  trackPoolClientLifecycleAtCreation,
} from "../setup/pg-pool-drain";
import { closePerFileTestPools } from "../setup/pool-teardown";

class ControlledPool extends EventEmitter {
  _clients: object[] = [];
  readonly options = { idleTimeoutMillis: 0 };
  ending = false;
  ended = false;
  endCalls = 0;
  endError: Error | undefined;

  get totalCount(): number {
    return this._clients.length;
  }

  connectClient(client: object): void {
    this._clients.push(client);
    this.emit("connect", client);
  }

  releaseWithDestroy(client: object): void {
    this.beginRemoval(client);
  }

  removeAfterQueryError(client: object): void {
    this.beginRemoval(client);
  }

  private beginRemoval(client: object): void {
    this._clients = this._clients.filter((candidate) => candidate !== client);
  }

  finishSocketRemoval(client: object): void {
    this.emit("remove", client);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
    this.ending = true;
    // Wie pg-pool 3.14: `_clients` wird vor den client.end(callback)-Events
    // geleert und end() kann dadurch bereits erfolgreich auflösen.
    this._clients = [];
    this.ended = true;
    if (this.endError) throw this.endError;
  }
}

function tracked(pool: ControlledPool): Pool {
  return trackPoolClientLifecycleAtCreation(pool as unknown as Pool);
}

async function closedTcpPort(): Promise<number> {
  const server = createServer();
  server.unref();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Freier TCP-Port konnte nicht bestimmt werden."));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pool-Regression lief in einen Timeout.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function typescriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptSources(path);
    return /\.(?:[cm]?ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

type DirectEndCall = {
  receiver: string;
  line: number;
};

function directEndCalls(file: string, source: string): DirectEndCall[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: DirectEndCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let receiver: ts.Expression | undefined;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "end") {
        receiver = callee.expression;
      } else if (
        ts.isElementAccessExpression(callee)
        && ts.isStringLiteral(callee.argumentExpression)
        && callee.argumentExpression.text === "end"
      ) {
        receiver = callee.expression;
      }
      if (receiver) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        calls.push({ receiver: receiver.getText(sourceFile), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

describe("endPoolAndWaitForClientRemoval", () => {
  it("beendet einen echten fehlgeschlagenen Pending-Connect ohne remove-Event", async () => {
    const port = await closedTcpPort();
    const pool = createDrainTrackedPool({
      host: "127.0.0.1",
      port,
      user: "closed_port_test",
      password: "closed_port_test",
      database: "closed_port_test",
      connectionTimeoutMillis: 1_000,
      max: 1,
      idleTimeoutMillis: 0,
    });

    const connection = pool.connect();
    const teardown = endPoolAndWaitForClientRemoval(pool);
    const [connectionResult, teardownResult] = await withTimeout(
      Promise.allSettled([connection, teardown]),
      5_000,
    );

    expect(connectionResult.status).toBe("rejected");
    expect(teardownResult).toEqual({ status: "fulfilled", value: undefined });
  });

  it("drainiert echte pg-Clients nach release(true) und einem Query-Fehler", async () => {
    const connectionString = process.env.POSTGRES_URL_TEST;
    if (!connectionString) throw new Error("POSTGRES_URL_TEST fehlt im DB-Testsetup.");
    const pool = createDrainTrackedPool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 0,
    });
    const removedClients: object[] = [];
    pool.on("remove", (client) => removedClients.push(client));

    const explicitlyDestroyed = await pool.connect();
    explicitlyDestroyed.release(true);
    await expect(pool.query("select 1 / 0")).rejects.toMatchObject({
      code: "22012",
    });

    await expect(endPoolAndWaitForClientRemoval(pool)).resolves.toBeUndefined();
    expect(removedClients).toHaveLength(2);
  });

  it("wartet auch dann auf release(true)/Fehler-Clients, wenn current remove zuerst kommt", async () => {
    const pool = new ControlledPool();
    const trackedPool = tracked(pool);
    const destroyedBeforeEnd = {};
    const failedBeforeEnd = {};
    const currentAtEnd = {};
    pool.connectClient(destroyedBeforeEnd);
    pool.connectClient(failedBeforeEnd);
    pool.connectClient(currentAtEnd);

    // Beide Clients verschwinden vor dem Teardown aus `_clients`; nur das seit
    // Pool-Erzeugung aktive Tracking kann ihre offenen Callbacks noch kennen.
    pool.releaseWithDestroy(destroyedBeforeEnd);
    pool.removeAfterQueryError(failedBeforeEnd);

    let teardownFinished = false;
    const teardown = endPoolAndWaitForClientRemoval(trackedPool).then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(pool.endCalls).toBe(1);

    // Der aktuell sichtbare Client schließt zuerst. Ein Post-hoc-Snapshot wäre
    // nun vorzeitig fertig und könnte Postgres vor den beiden stale Callbacks
    // stoppen.
    pool.finishSocketRemoval(currentAtEnd);
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    pool.finishSocketRemoval(destroyedBeforeEnd);
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    pool.finishSocketRemoval(failedBeforeEnd);
    await teardown;
    expect(teardownFinished).toBe(true);
    expect(pool.listenerCount("connect")).toBe(0);
    expect(pool.listenerCount("remove")).toBe(0);
  });

  it("verweigert Tracking nach der ersten Pool-Nutzung fail-closed", () => {
    const pool = new ControlledPool();
    pool.connectClient({});

    expect(() => tracked(pool)).toThrow(
      "muss unbenutzt und mit idleTimeoutMillis=0 registriert werden",
    );
  });

  it("drainiert trotz _clients/totalCount-Widerspruch und wirft ihn danach", async () => {
    const pool = new ControlledPool();
    const trackedPool = tracked(pool);
    const client = {};
    pool.connectClient(client);
    Object.defineProperty(pool, "totalCount", { value: 2 });

    const teardown = endPoolAndWaitForClientRemoval(trackedPool);
    pool.finishSocketRemoval(client);
    const error = await teardown.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("_clients und totalCount widersprechen sich"),
      }),
    ]);
    expect(pool.endCalls).toBe(1);
    expect(pool.listenerCount("connect")).toBe(0);
    expect(pool.listenerCount("remove")).toBe(0);
  });

  it("drainiert verbundene Clients auch nach einer Pool.end-Ablehnung", async () => {
    const pool = new ControlledPool();
    const trackedPool = tracked(pool);
    const client = {};
    const endError = new Error("intentional Pool.end rejection");
    pool.connectClient(client);
    pool.endError = endError;

    const teardown = endPoolAndWaitForClientRemoval(trackedPool);
    const observed = teardown.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve();
    let observedSettled = false;
    void observed.then(() => {
      observedSettled = true;
    });
    await Promise.resolve();
    expect(observedSettled).toBe(false);

    pool.finishSocketRemoval(client);
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(endError);
    expect(pool.listenerCount("connect")).toBe(0);
    expect(pool.listenerCount("remove")).toBe(0);
  });

  it("erkennt ein ausserhalb des Helpers gestartetes Pool.end", async () => {
    const pool = new ControlledPool();
    const trackedPool = tracked(pool);
    pool.ending = true;

    await expect(endPoolAndWaitForClientRemoval(trackedPool)).rejects.toThrow(
      "Pool.end wurde ausserhalb des Lifecycle-Helpers gestartet",
    );
    expect(pool.endCalls).toBe(0);
  });

  it("stoppt Embedded Postgres erst nach dem letzten Pool-remove", async () => {
    const first = new ControlledPool();
    const second = new ControlledPool();
    const firstTracked = tracked(first);
    const secondTracked = tracked(second);
    const firstClient = {};
    const secondClient = {};
    first.connectClient(firstClient);
    second.connectClient(secondClient);
    let stopped = false;

    const teardown = endPoolsAndStopEmbeddedPostgres(
      [firstTracked, secondTracked],
      { stop: async () => { stopped = true; } },
      "Test-Teardown fehlgeschlagen",
    );
    await Promise.resolve();
    expect(stopped).toBe(false);

    first.finishSocketRemoval(firstClient);
    await Promise.resolve();
    expect(stopped).toBe(false);

    second.finishSocketRemoval(secondClient);
    await teardown;
    expect(stopped).toBe(true);
  });

  it("schliesst den Superuser-Pool trotz abgelehntem Runtime-Drain", async () => {
    const runtimeError = new Error("Runtime-Drain absichtlich fehlgeschlagen");
    const calls: string[] = [];

    const error = await closePerFileTestPools(
      async () => {
        calls.push("runtime");
        throw runtimeError;
      },
      async () => {
        calls.push("superuser");
      },
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(calls).toEqual(["runtime", "superuser"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([runtimeError]);
  });

  it("erkennt direkte Pool.end-Aufrufe unabhaengig vom Kontrollfluss", () => {
    const source = `
      const returned = () => pool.end();
      const ignored = () => { void admin?.end(); };
      const chained = () => worker["end"]().then(() => undefined);
    `;
    expect(directEndCalls("negative-fixture.ts", source)).toEqual([
      { receiver: "pool", line: 2 },
      { receiver: "admin", line: 3 },
      { receiver: "worker", line: 4 },
    ]);
  });

  it("verbietet direkte Pool-Erzeugung und Pool.end in Embedded-PG-Testlaeufen", () => {
    const drainImplementation = resolve("tests", "setup", "pg-pool-drain.ts");
    const testSources = typescriptSources(resolve("tests"))
      .filter((file) => file !== drainImplementation);
    const centralLifecycleSources = [
      resolve("tests", "setup", "embedded-postgres.ts"),
      resolve("tests", "setup", "test-db.ts"),
      resolve("tests", "setup", "superuser-db.ts"),
      resolve("tests", "setup", "pool-teardown.ts"),
    ];
    for (const file of centralLifecycleSources) {
      expect(testSources, `${file}: zentraler Lifecycle-Pfad fehlt im Source-Gate`).toContain(file);
    }
    const diagnosticScripts = [
      resolve("extract-m204-pins.mts"),
      resolve("scripts", "adr-0003-probe.mts"),
      resolve("scripts", "pg18-createrole-regression.mts"),
    ];
    for (const file of diagnosticScripts) {
      expect(readFileSync(file, "utf8"), file).toContain("startEmbeddedPostgres");
    }
    const guardedSources = [...testSources, ...diagnosticScripts];
    expect(guardedSources.length).toBeGreaterThan(0);

    const directConstruction = new RegExp(["new", "Pool"].join("\\s+") + "\\s*\\(");
    const allowedNonPoolEnds = new Map<string, ReadonlySet<string>>([
      [resolve("tests", "e2e", "run.mts"), new Set(["response"])],
      [resolve("tests", "e2e", "next-server.mts"), new Set(["response"])],
      // F4.1-Loopback-Fetch: response.end gehoert zum HTTP-Server-Stub,
      // nicht zum Pool-Lifecycle (gleiche Ausnahme wie e2e).
      [resolve("tests", "unit", "f401-fetch-v2.test.ts"), new Set(["response"])],
    ]);
    for (const file of guardedSources) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file}: Pool muss bei Erzeugung drain-getrackt werden`).not.toMatch(
        directConstruction,
      );
      const allowedReceivers = allowedNonPoolEnds.get(file) ?? new Set<string>();
      const violations = directEndCalls(file, source)
        .filter((call) => !allowedReceivers.has(call.receiver));
      expect(
        violations,
        `${file}: Pool darf nur ueber zentralen Drain beendet werden`,
      ).toEqual([]);
    }
  });
});
