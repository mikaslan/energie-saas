import { Pool } from "pg";
import { z } from "zod";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import { sweepOverdueDocumentsAsWorker } from "../lib/integrations/invoicing/overdue-sweep-core";

// F8-24a · Worker-Queue `overdue.sweep` (Muster `invoice-pdf.render`, eigene
// Queue/eigener Handler): kein pgboss-Dispatch, kein Render-Job — der Sweep
// ist lesend + Status-Update. Bootstrap (Queue + Schedule + Shutdown) lebt in
// worker/index.ts (Owner).
export const OVERDUE_SWEEP_QUEUE = "overdue.sweep" as const;
export const OVERDUE_SWEEP_SCHEDULE_CRON = "0 6 * * *" as const;
export const OVERDUE_SWEEP_SCHEDULE_TIMEZONE = "Europe/Berlin" as const;
export const OVERDUE_SWEEP_DISPATCH_SCHEMA_VERSION =
  "overdue-sweep-dispatch.v1" as const;

export const OVERDUE_SWEEP_WORKSPACE_PAGE_LIMIT = 100;

const dispatchSchema = z.strictObject({
  schemaVersion: z.literal(OVERDUE_SWEEP_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid().optional(),
});

export type OverdueSweepDispatchPayload = z.infer<typeof dispatchSchema>;

export class OverdueSweepDispatchError extends Error {
  constructor() {
    super("overdue sweep dispatch payload is invalid");
    this.name = "OverdueSweepDispatchError";
  }
}

export function parseOverdueSweepDispatchPayload(
  value: unknown,
): OverdueSweepDispatchPayload {
  const parsed = dispatchSchema.safeParse(value);
  if (!parsed.success) throw new OverdueSweepDispatchError();
  return parsed.data;
}

export type OverdueSweepWorkspacePage = {
  workspaceIds: string[];
  nextAfterWorkspaceId: string | null;
};

export type OverdueSweepWorkspaceResult = {
  swept: number;
  sweptDocumentIds: string[];
  truncated: boolean;
};

// Der Runner kapselt DB-Zugriff + Worker-Principal: `sweepWorkspace` ruft
// `sweepOverdueDocuments` in einer Worker-Principal-Transaktion (Verdrahtung
// in worker/index.ts, Owner). Injizierbar, damit der Handler ohne DB
// testbar bleibt.
export type OverdueSweepRunner = {
  listWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<OverdueSweepWorkspacePage>;
  sweepWorkspace(workspaceId: string): Promise<OverdueSweepWorkspaceResult>;
};

type Dependencies = {
  runner: OverdueSweepRunner;
};

export function createOverdueSweepHandler(
  dependencies: Dependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const dispatch = parseOverdueSweepDispatchPayload(
        job !== null && typeof job === "object" && "data" in job
          ? (job as { data?: unknown }).data
          : undefined,
      );
      if (dispatch.workspaceId !== undefined) {
        await dependencies.runner.sweepWorkspace(dispatch.workspaceId);
        continue;
      }
      let afterWorkspaceId: string | null = null;
      for (;;) {
        const page = await dependencies.runner.listWorkspaces({
          afterWorkspaceId,
          limit: OVERDUE_SWEEP_WORKSPACE_PAGE_LIMIT,
        });
        for (const workspaceId of page.workspaceIds) {
          await dependencies.runner.sweepWorkspace(workspaceId);
        }
        if (page.nextAfterWorkspaceId === null) break;
        afterWorkspaceId = page.nextAfterWorkspaceId;
      }
    }
  };
}

export type OverdueSweepDatabaseGateway = {
  runner: OverdueSweepRunner;
  probe(): Promise<void>;
  close(): Promise<void>;
};

// F8-24a: Vorrat-Seite (eigene Funktion, damit DB-Tests die
// Paginierung ohne Worker-Rolle pruefen koennen — das Gateway
// erzwingt app_worker, die es im Legacy-Testmodus nicht gibt).
export async function listOverdueSweepWorkspacePage(
  pool: Pick<Pool, "query">,
  input: {
    afterWorkspaceId: string | null;
    limit: number;
  },
): Promise<OverdueSweepWorkspacePage> {
  const result = await pool.query<{ workspace_id: string }>(
    `select workspace_id from overdue_sweep_workspace
      where ($1::uuid is null or workspace_id > $1::uuid)
      order by workspace_id asc
      limit $2::int`,
    [input.afterWorkspaceId, input.limit],
  );
  const workspaceIds = result.rows.map((row) => row.workspace_id);
  return {
    workspaceIds,
    nextAfterWorkspaceId: workspaceIds.length < input.limit
      ? null
      : (workspaceIds[workspaceIds.length - 1] ?? null),
  };
}

// Gateway (Owner): eigener Pool als app_worker; Workspace-IDs aus dem
// RLS-freien Arbeitsvorrat (0200, Trigger-Spiegel — `workspace` selbst
// ist FORCE-RLS und liefert ohne Tenant-Kontext null Zeilen), jeder
// Sweep in dessen FORCE-RLS-Kontext via withTenantOn (Muster
// invoice-pdf-database.ts).
export function createOverdueSweepDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): OverdueSweepDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;

  const runner: OverdueSweepRunner = {
    async listWorkspaces(input) {
      return listOverdueSweepWorkspacePage(pool, input);
    },
    async sweepWorkspace(workspaceId) {
      return withTenantOn(pool, workspaceId, (tx) =>
        sweepOverdueDocumentsAsWorker(tx, workspaceId));
    },
  };

  return {
    runner,
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
