// F1-21 Lead-Score-Recompute: worker-seitiges DB-Gateway (app_worker).
//
// Recompute und Requeue laufen ausschließlich über Definer-Kapseln; die
// Sweep-Kandidaten stammen aus der worker-owned pg-boss-Historie (Muster
// offer-pdf-database: strikt ID-only, vertraglich validiert).
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import type { TenantTx } from "../lib/db/types";
import {
  isLeadScoreSignal,
  scoreBandForValue,
} from "../lib/lead-score";
import {
  LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION,
  LEAD_SCORE_RECOMPUTE_QUEUE,
  type LeadScoreRecomputeDatabase,
  type LeadScoreRecomputeResult,
  type LeadScoreRecoveryDatabase,
  type LeadScoreRecoveryWorkspacePage,
} from "./lead-score";

export class LeadScoreWorkerError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "invalid_result"
      | "dispatch_unavailable",
  ) {
    super(`lead score worker: ${code}`);
    this.name = "LeadScoreWorkerError";
  }
}

function invalidInput(): never {
  throw new LeadScoreWorkerError("invalid_input");
}

const recomputeInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

const recomputeRowSchema = z.strictObject({
  score_value: z.int().safe().min(0).max(100),
  score_band: z.enum(["hot", "warm", "cold"]),
  score_signals: z.array(z.string()),
  score_computed_at: z.union([z.date(), z.string()]),
});

const requeueSchema = z.strictObject({
  workspaceId: z.uuid(),
  limit: z.int().safe().min(1).max(100),
});

const recoveryWorkspaceSchema = z.strictObject({
  afterWorkspaceId: z.uuid().nullable(),
  limit: z.int().safe().min(1).max(100),
});

type RecoveryWorkspaceRow = {
  workspace_id: string | null;
  contract_valid: boolean;
};

type RequeueCandidateRow = {
  project_id: string | null;
  contract_valid: boolean;
};

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LeadScoreWorkerError("invalid_result");
  }
  return date.toISOString();
}

function validateRecomputeRow(value: unknown): LeadScoreRecomputeResult {
  const parsed = recomputeRowSchema.safeParse(value);
  if (!parsed.success) throw new LeadScoreWorkerError("invalid_result");
  const row = parsed.data;
  if (!row.score_signals.every(isLeadScoreSignal)) {
    throw new LeadScoreWorkerError("invalid_result");
  }
  if (scoreBandForValue(row.score_value) !== row.score_band) {
    throw new LeadScoreWorkerError("invalid_result");
  }
  return {
    value: row.score_value,
    band: row.score_band,
    signals: row.score_signals,
    computedAt: asIso(row.score_computed_at),
  };
}

async function recomputeScore(
  tx: TenantTx,
  value: unknown,
): Promise<LeadScoreRecomputeResult | null> {
  const parsed = recomputeInputSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  const result = await tx.execute<Record<string, unknown>>(sql`
    select * from public._f121_recompute_lead_score(
      ${input.workspaceId}::uuid,
      ${input.projectId}::uuid
    )
  `);
  const row = result.rows[0];
  // Keine Zeile = Projekt fehlt (Erasure) → stiller No-Op, kein Retry-Grund.
  if (!row) return null;
  return validateRecomputeRow(row);
}

async function enqueueRecompute(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await tx.execute(sql`
    select pgboss.enqueue_lead_score_recompute(
      ${workspaceId}::uuid,
      ${projectId}::uuid
    )
  `);
}

async function tenantWorkspaceExists(
  pool: Pool,
  workspaceId: string,
): Promise<boolean> {
  return withTenantOn(pool, workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id::text as id
        from workspace
       where id = ${workspaceId}::uuid
       limit 1
    `);
    return result.rows[0]?.id === workspaceId;
  });
}

async function listRecoveryWorkspaces(
  pool: Pool,
  value: unknown,
): Promise<LeadScoreRecoveryWorkspacePage> {
  const parsed = recoveryWorkspaceSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;

  // pgboss ist app_worker-owned und enthält den strikten ID-only-Dispatch.
  // Er dient nur der Kandidatenfindung; jede Fachmutation läuft danach mit
  // dem jeweiligen Workspace-Kontext.
  const result = await pool.query<RecoveryWorkspaceRow>(
    `
    with dispatch as materialized (
      select case
               when pg_catalog.jsonb_typeof(job.data) = 'object'
                 then job.data->>'workspaceId'
               else null
             end as workspace_id,
             case
               when pg_catalog.jsonb_typeof(job.data) = 'object' then
                 coalesce(
                   job.data = pg_catalog.jsonb_build_object(
                     'schemaVersion', $2::text,
                     'workspaceId', job.data->>'workspaceId',
                     'projectId', job.data->>'projectId'
                   )
                   and job.data->>'schemaVersion' = $2::text
                   and job.data->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   and job.data->>'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                   false
                 )
               else false
             end as contract_valid
        from pgboss.job as job
       where job.name = $1::text
    ), integrity as (
      select coalesce(pg_catalog.bool_and(contract_valid), true)
               as contract_valid
        from dispatch
    ), candidates as (
      select distinct workspace_id
        from dispatch
       where contract_valid
         and ($3::text is null or workspace_id > $3::text)
       order by workspace_id
       limit $4::integer
    )
    select candidates.workspace_id, integrity.contract_valid
      from integrity
      left join candidates on true
      order by candidates.workspace_id nulls last
  `,
    [
      LEAD_SCORE_RECOMPUTE_QUEUE,
      LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION,
      input.afterWorkspaceId,
      input.limit,
    ],
  );
  if (result.rows.some((row) => row.contract_valid !== true)) invalidInput();

  const candidateIds: string[] = [];
  for (const row of result.rows) {
    if (row.workspace_id === null) continue;
    const parsedWorkspaceId = z.uuid().safeParse(row.workspace_id);
    if (!parsedWorkspaceId.success) invalidInput();
    candidateIds.push(parsedWorkspaceId.data);
  }

  const workspaceIds: string[] = [];
  for (const workspaceId of candidateIds) {
    if (await tenantWorkspaceExists(pool, workspaceId)) workspaceIds.push(workspaceId);
  }
  return {
    workspaceIds,
    nextAfterWorkspaceId: candidateIds.length === input.limit
      ? (candidateIds.at(-1) ?? null)
      : null,
  };
}

async function requeueDue(
  pool: Pool,
  value: unknown,
): Promise<string[]> {
  const parsed = requeueSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;

  // Repariert genau die verlorenen Recomputes: Projekte mit fehlgeschlagenem
  // oder abgebrochenem Terminalzustand und ohne aktiven Nachfolgejob.
  // Erfolgreiche Jobs rührt der Sweep nie an (kein Refresh-Churn — frische
  // Scores liefert der Board-Lesepfad, stale Karten triggern neu).
  const candidates = await pool.query<RequeueCandidateRow>(
    `
    with dispatch as materialized (
      select job.data->>'projectId' as project_id,
             case
               when pg_catalog.jsonb_typeof(job.data) = 'object' then
                 coalesce(
                   job.data = pg_catalog.jsonb_build_object(
                     'schemaVersion', $3::text,
                     'workspaceId', job.data->>'workspaceId',
                     'projectId', job.data->>'projectId'
                   )
                   and job.data->>'schemaVersion' = $3::text
                   and job.data->>'workspaceId' = $2::text
                   and job.data->>'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                   false
                 )
               else false
             end as contract_valid
        from pgboss.job as job
       where job.name = $1::text
         and case
               when pg_catalog.jsonb_typeof(job.data) = 'object'
                 then job.data->>'workspaceId'
               else null
             end = $2::text
    ), integrity as (
      select coalesce(pg_catalog.bool_and(contract_valid), true)
               as contract_valid
        from dispatch
    ), candidates as (
      select distinct dispatch.project_id as project_id
        from dispatch
       where dispatch.contract_valid
         and not exists (
           select 1
             from pgboss.job as active_job
            where active_job.name = $1::text
              and active_job.singleton_key = dispatch.project_id
              and active_job.state in ('created', 'retry', 'active')
         )
         and exists (
           select 1
             from pgboss.job as terminal_job
            where terminal_job.name = $1::text
              and terminal_job.singleton_key = dispatch.project_id
              and terminal_job.state in ('failed', 'cancelled')
         )
       order by dispatch.project_id
       limit $4::integer
    )
    select candidates.project_id, integrity.contract_valid
      from integrity
      left join candidates on true
      order by candidates.project_id nulls last
  `,
    [
      LEAD_SCORE_RECOMPUTE_QUEUE,
      input.workspaceId,
      LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION,
      input.limit,
    ],
  );
  if (candidates.rows.some((row) => row.contract_valid !== true)) invalidInput();

  const projectIds: string[] = [];
  for (const row of candidates.rows) {
    if (row.project_id === null) continue;
    const parsedProjectId = z.uuid().safeParse(row.project_id);
    if (!parsedProjectId.success) invalidInput();
    projectIds.push(parsedProjectId.data);
  }
  if (projectIds.length === 0) return [];

  await withTenantOn(pool, input.workspaceId, async (tx) => {
    for (const projectId of projectIds) {
      await enqueueRecompute(tx, input.workspaceId, projectId);
    }
  });
  return projectIds;
}

export interface LeadScoreDatabaseGateway {
  database: LeadScoreRecomputeDatabase & LeadScoreRecoveryDatabase;
  probe(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Dedicated app_worker pool for short tenant transactions. Recompute work
 * itself happens inside the definer capsule; pg-boss keeps its independent
 * adapter pool.
 */
export function createLeadScoreDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): LeadScoreDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);

  return {
    database: {
      recompute: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
        recomputeScore(tx, input)),
      listRecoveryWorkspaces: (input) => listRecoveryWorkspaces(pool, input),
      requeueDue: (input) => requeueDue(pool, input),
    },
    async probe() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
