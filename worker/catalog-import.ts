import { z } from "zod";

import {
  parseCatalogImportCleanupDispatchV1,
  parseCatalogImportDispatchV1,
} from "../lib/integrations/catalog/import-contract";
import {
  CatalogImportWorkerDatabaseError,
  type CatalogImportDatabase,
  type CatalogImportDatabaseGateway,
} from "./catalog-import-database";

const uuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const DEFAULT_MAINTENANCE_OPTIONS = Object.freeze({
  intervalMs: 60_000,
  locatorLimit: 100,
  jobsPerWorkspaceLimit: 100,
});

export const CATALOG_IMPORT_BATCH_LIMIT = 25 as const;
export const CATALOG_IMPORT_SWEEP_LIMIT = 100 as const;

export class CatalogImportDispatchError extends Error {
  constructor() {
    super("catalog import dispatch payload is invalid");
    this.name = "CatalogImportDispatchError";
  }
}

export class CatalogImportMaintenanceSweepError extends Error {
  readonly code = "catalog_import_maintenance_failed" as const;

  constructor() {
    super("catalog import maintenance sweep failed");
    this.name = "CatalogImportMaintenanceSweepError";
  }
}

type ImportHandlerDependencies = Readonly<{
  database: CatalogImportDatabase;
}>;

type CleanupHandlerDatabase = Pick<
  CatalogImportDatabaseGateway,
  "recoverDue" | "cleanupDue"
>;

type MaintenanceDatabase = Pick<
  CatalogImportDatabaseGateway,
  | "listRecoveryLocators"
  | "listCleanupLocators"
  | "recoverDue"
  | "cleanupDue"
  | "handleInvalidLocator"
>;

type MaintenanceOptions = Readonly<{
  intervalMs?: number;
  locatorLimit?: number;
  jobsPerWorkspaceLimit?: number;
}>;

export type CatalogImportMaintenanceController = Readonly<{
  stop(): Promise<void>;
}>;

function parseJob(value: unknown): { id: string; data: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogImportDispatchError();
  }
  const record = value as Record<string, unknown>;
  const id = uuidSchema.safeParse(record.id);
  if (!id.success || !Object.hasOwn(record, "data")) {
    throw new CatalogImportDispatchError();
  }
  return { id: id.data, data: record.data };
}

function parseImportJob(value: unknown) {
  const job = parseJob(value);
  try {
    return { ...job, dispatch: parseCatalogImportDispatchV1(job.data) };
  } catch {
    throw new CatalogImportDispatchError();
  }
}

function parseCleanupJob(value: unknown) {
  const job = parseJob(value);
  try {
    return { ...job, dispatch: parseCatalogImportCleanupDispatchV1(job.data) };
  } catch {
    throw new CatalogImportDispatchError();
  }
}

function isEnqueueFailure(error: unknown): boolean {
  return error instanceof CatalogImportWorkerDatabaseError
    && error.code === "enqueue_failed";
}

async function recordClaimEnqueueFailure(
  database: CatalogImportDatabase,
  key: { workspaceId: string; importId: string; dispatchId: string },
): Promise<void> {
  await database.recordDispatchFailure({
    workspaceId: key.workspaceId,
    importId: key.importId,
    dispatchId: key.dispatchId,
    errorCode: "enqueue_failed",
  });
}

async function recordLeaseEnqueueFailure(
  database: CatalogImportDatabase,
  key: {
    workspaceId: string;
    importId: string;
    leaseToken: string;
    leaseGeneration: string;
  },
): Promise<void> {
  await database.finalizeFailure({ ...key, errorCode: "enqueue_failed" });
}

/** Each database.applyRow call is a separate tenant transaction in the gateway. */
export function createCatalogImportHandler(
  dependencies: ImportHandlerDependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const rawJob of jobs) {
      const job = parseImportJob(rawJob);
      const claimKey = {
        workspaceId: job.dispatch.workspaceId,
        importId: job.dispatch.importId,
        dispatchId: job.id,
        batchLimit: CATALOG_IMPORT_BATCH_LIMIT,
      };
      let claim;
      try {
        claim = await dependencies.database.claim(claimKey);
      } catch (error) {
        if (!isEnqueueFailure(error)) throw error;
        await recordClaimEnqueueFailure(dependencies.database, claimKey);
        continue;
      }
      if (claim === null) continue;
      const leaseKey = {
        workspaceId: claim.workspaceId,
        importId: claim.importId,
        leaseToken: claim.leaseToken,
        leaseGeneration: claim.leaseGeneration,
      };
      let stopped = false;
      for (const rowNumber of claim.rowNumbers) {
        try {
          const outcome = await dependencies.database.applyRow({
            ...leaseKey,
            rowNumber,
          });
          if (
            outcome.status === "failed_final"
            || (outcome.status === "conflict" && "code" in outcome)
          ) {
            stopped = true;
            break;
          }
        } catch (error) {
          if (!isEnqueueFailure(error)) throw error;
          await recordLeaseEnqueueFailure(dependencies.database, leaseKey);
          stopped = true;
          break;
        }
      }
      if (stopped) continue;
      try {
        await dependencies.database.completeBatch(leaseKey);
      } catch (error) {
        if (!isEnqueueFailure(error)) throw error;
        await recordLeaseEnqueueFailure(dependencies.database, leaseKey);
      }
    }
  };
}

/** Preview expiry is recovered before due terminal snapshots are redacted. */
export function createCatalogImportCleanupHandler(
  database: CleanupHandlerDatabase,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const rawJob of jobs) {
      const job = parseCleanupJob(rawJob);
      await database.recoverDue({
        workspaceId: job.dispatch.workspaceId,
        limit: CATALOG_IMPORT_SWEEP_LIMIT,
      });
      await database.cleanupDue({
        workspaceId: job.dispatch.workspaceId,
        limit: CATALOG_IMPORT_SWEEP_LIMIT,
      });
    }
  };
}

function validateMaintenanceOptions(options: MaintenanceOptions) {
  const merged = { ...DEFAULT_MAINTENANCE_OPTIONS, ...options };
  if (
    !Number.isSafeInteger(merged.intervalMs)
    || merged.intervalMs < 1
    || merged.intervalMs > 60 * 60_000
    || !Number.isSafeInteger(merged.locatorLimit)
    || merged.locatorLimit < 1
    || merged.locatorLimit > 100
    || !Number.isSafeInteger(merged.jobsPerWorkspaceLimit)
    || merged.jobsPerWorkspaceLimit < 1
    || merged.jobsPerWorkspaceLimit > 100
  ) throw new CatalogImportMaintenanceSweepError();
  return merged;
}

async function runMaintenancePage(
  database: MaintenanceDatabase,
  cursors: { recovery: string | null; cleanup: string | null },
  locatorLimit: number,
  jobsPerWorkspaceLimit: number,
): Promise<{ recovery: string | null; cleanup: string | null }> {
  const recoveryPage = await database.listRecoveryLocators({
    afterJobId: cursors.recovery,
    limit: locatorLimit,
  });
  const recoveryWorkspaces = new Set(
    recoveryPage.locators.flatMap((locator) =>
      locator.workspaceId === null ? [] : [locator.workspaceId]),
  );
  for (const workspaceId of recoveryWorkspaces) {
    await database.recoverDue({ workspaceId, limit: jobsPerWorkspaceLimit });
  }
  for (const locator of recoveryPage.locators) {
    if (locator.status === "queue_locator_invalid") {
      await database.handleInvalidLocator(locator);
    }
  }

  const cleanupPage = await database.listCleanupLocators({
    afterJobId: cursors.cleanup,
    limit: locatorLimit,
  });
  const cleanupWorkspaces = new Set(
    cleanupPage.locators.flatMap((locator) =>
      locator.workspaceId === null ? [] : [locator.workspaceId]),
  );
  for (const workspaceId of cleanupWorkspaces) {
    await database.recoverDue({ workspaceId, limit: jobsPerWorkspaceLimit });
    await database.cleanupDue({ workspaceId, limit: jobsPerWorkspaceLimit });
  }
  for (const locator of cleanupPage.locators) {
    if (locator.status === "queue_locator_invalid") {
      await database.handleInvalidLocator(locator);
    }
  }
  return {
    recovery: recoveryPage.nextAfterJobId,
    cleanup: cleanupPage.nextAfterJobId,
  };
}

/** The next bounded locator pass starts only after both current pages settle. */
export function startCatalogImportMaintenanceSweep(
  dependencies: {
    database: MaintenanceDatabase;
    onFatal(error: CatalogImportMaintenanceSweepError): void;
  },
  options: MaintenanceOptions = {},
): CatalogImportMaintenanceController {
  const config = validateMaintenanceOptions(options);
  let cursors = { recovery: null as string | null, cleanup: null as string | null };
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const schedule = () => {
    if (stopped) return;
    timeout = setTimeout(run, config.intervalMs);
    timeout.unref();
  };
  const complete = (task: Promise<void>) => {
    if (active === task) active = undefined;
    schedule();
  };
  const run = () => {
    if (stopped || active !== undefined) return;
    const task = (async () => {
      try {
        cursors = await runMaintenancePage(
          dependencies.database,
          cursors,
          config.locatorLimit,
          config.jobsPerWorkspaceLimit,
        );
      } catch {
        stopped = true;
        const failure = new CatalogImportMaintenanceSweepError();
        try {
          dependencies.onFatal(failure);
        } catch {
          throw failure;
        }
      }
    })();
    active = task;
    void task.then(() => complete(task), () => complete(task));
  };

  run();
  return {
    async stop() {
      stopped = true;
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      const current = active;
      if (current !== undefined) await current;
    },
  };
}
