import { Pool } from "pg";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccess,
  persistProjectCalculationInput,
} from "../modules/energy";
import type { CalculationDatabase } from "./calculation";

export type CalculationDatabaseGateway = {
  database: CalculationDatabase;
  probe(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Eigener, live verifizierter app_worker-Pool fuer die kurzen fachlichen
 * Transaktionsgrenzen. pg-boss behaelt seinen separaten Adapter-Pool; dadurch
 * kann weder ein Provideraufruf noch die Engine versehentlich eine von
 * pg-boss gehaltene Verbindung/Transaktion mitbenutzen.
 */
export function createCalculationDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): CalculationDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;

  const database: CalculationDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimProjectCalculationJob(tx, input)),
    persistInput: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      persistProjectCalculationInput(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeProjectCalculationSuccess(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeProjectCalculationFailure(tx, input)),
  };

  return {
    database,
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
