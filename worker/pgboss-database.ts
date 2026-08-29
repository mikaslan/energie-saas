import type { Db as PgBossDatabase } from "pg-boss";
import { Pool, type PoolConfig, type QueryResult } from "pg";
import { servicePoolConfig } from "../lib/db/role-env";

type PgBossQueryResult = Pick<QueryResult, "rows">;

interface QueryPool {
  query(text: string, values?: unknown[]): Promise<PgBossQueryResult>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type FatalWorkerErrorReporter = (source: string, error: unknown) => boolean;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Pool- und pg-boss-Fehler können nahezu gleichzeitig eintreffen. Nur der
 * erste darf den zentralen Fatalpfad starten; shutdown() selbst bleibt eine
 * zweite, unabhängige Idempotenzgrenze.
 */
export function createFatalWorkerErrorReporter(
  onFirstError: (source: string, error: Error) => void,
): FatalWorkerErrorReporter {
  let reported = false;
  return (source, error) => {
    if (reported) return false;
    reported = true;
    onFirstError(source, asError(error));
    return true;
  };
}

/**
 * Der offizielle pg-boss-v12-Adaptervertrag ist absichtlich klein:
 * `ConstructorOptions.db` erwartet ein `IDatabase` mit `executeSql()`.
 * Dadurch kann pg-boss denselben verifizierten pg-Pool-Vertrag wie die
 * übrigen Dienste verwenden, statt intern einen ungeprüften Pool zu bauen.
 */
export class VerifiedPgBossDatabase implements PgBossDatabase {
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly pool: QueryPool,
    onPoolError: (error: Error) => void,
  ) {
    // Ein idle pg-Client meldet seinen Fehler am Pool-EventEmitter. Ohne
    // Listener würde Node wegen des besonderen `error`-Events den Prozess
    // abrupt beenden und pg-boss könnte seine WIP-Jobs nicht freigeben.
    // Pflichtparameter + synchrone Registrierung verhindern ein Zeitfenster,
    // in dem der Pool bereits existiert, aber noch unbeobachtet genutzt wird.
    this.pool.on("error", onPoolError);
  }

  executeSql(text: string, values?: unknown[]): Promise<PgBossQueryResult> {
    return this.pool.query(text, values);
  }

  close(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }
}

export function pgBossWorkerPoolConfig(connectionString: string, max = 5): PoolConfig {
  return servicePoolConfig(connectionString, "app_worker", max);
}

export function createVerifiedPgBossDatabase(
  connectionString: string,
  max = 5,
  onPoolError: (error: Error) => void,
): VerifiedPgBossDatabase {
  return new VerifiedPgBossDatabase(
    new Pool(pgBossWorkerPoolConfig(connectionString, max)),
    onPoolError,
  );
}
