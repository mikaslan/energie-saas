import { Pool } from "pg";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccessV2,
  persistProjectCalculationInputV2,
} from "../modules/energy";
import type { CalculationV2Database } from "./calculation-v2";

export type CalculationV2DatabaseGateway = {
  database: CalculationV2Database;
  probe(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Eigener, live verifizierter app_worker-Pool fuer die kurzen fachlichen
 * Transaktionsgrenzen der v2-Kette (Spec F4-01). Gleiche Isolation wie das
 * v1-Gateway: Weder ein Provideraufruf noch die Engine kann versehentlich
 * eine von pg-boss gehaltene Verbindung/Transaktion mitbenutzen. Claim und
 * Failure-Finalize sind versionsrein ueber die Routinen geteilt (Routing
 * nach contract_version); Persist und Success-Finalize nutzen die
 * v2-eigenen Servicefunktionen (0078/0079).
 */
export function createCalculationV2DatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): CalculationV2DatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;

  const database: CalculationV2Database = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimProjectCalculationJob(tx, input)),
    persistInput: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      persistProjectCalculationInputV2(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeProjectCalculationSuccessV2(tx, input)),
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
