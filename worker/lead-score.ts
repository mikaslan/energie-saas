// F1-21 Lead-Score-Recompute: Async-Worker für Score-at-rest.
//
// Queue lead.score.recompute.v1 (exclusive, ID-only-Payload, singletonKey =
// Projekt). Der Handler ruft ausschließlich die Definer-Kapsel
// _f121_recompute_lead_score auf (idempotent, FOR UPDATE); der
// Recovery-Sweep stellt fehlgeschlagene/abgebrochene Dispatches begrenzt
// wieder zu (Muster offer-pdf: pg-boss-Historie als Kandidatenquelle,
// 25×25-Bound, kein Overlap via rekursivem Timeout).
import { z } from "zod";

export const LEAD_SCORE_RECOMPUTE_QUEUE = "lead.score.recompute.v1" as const;

export const LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION =
  "lead-score-recompute-dispatch.v1" as const;

const dispatchSchema = z.strictObject({
  schemaVersion: z.literal(LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

export type LeadScoreRecomputeDispatch = z.infer<typeof dispatchSchema>;

export class LeadScoreDispatchError extends Error {
  constructor() {
    super("lead score dispatch payload is invalid");
    this.name = "LeadScoreDispatchError";
  }
}

export class LeadScoreRecoverySweepError extends Error {
  readonly code = "lead_score_recovery_failed" as const;

  constructor() {
    super("lead score recovery sweep failed");
    this.name = "LeadScoreRecoverySweepError";
  }
}

export function parseLeadScoreRecomputeDispatch(value: unknown): LeadScoreRecomputeDispatch {
  const parsed = dispatchSchema.safeParse(value);
  if (!parsed.success) throw new LeadScoreDispatchError();
  return parsed.data;
}

export type LeadScoreRecomputeResult = {
  value: number;
  band: "hot" | "warm" | "cold";
  signals: string[];
  computedAt: string;
};

export type LeadScoreRecomputeDatabase = {
  recompute(input: {
    workspaceId: string;
    projectId: string;
  }): Promise<LeadScoreRecomputeResult | null>;
};

type HandlerDependencies = {
  database: LeadScoreRecomputeDatabase;
};

function jobPayload(job: unknown): unknown {
  return job !== null && typeof job === "object" && "data" in job
    ? (job as { data?: unknown }).data
    : undefined;
}

// Fehlendes Projekt (Erasure) = stiller No-Op; jeder echte Fehler wirft,
// damit pg-boss retried (einzige Retry-Quelle, Muster customer-notification).
export function createLeadScoreRecomputeHandler(
  dependencies: HandlerDependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const dispatch = parseLeadScoreRecomputeDispatch(jobPayload(job));
      await dependencies.database.recompute({
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
      });
    }
  };
}

export type LeadScoreRecoveryWorkspacePage = {
  workspaceIds: string[];
  nextAfterWorkspaceId: string | null;
};

export type LeadScoreRecoveryDatabase = {
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<LeadScoreRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
};

export type LeadScoreRecoveryController = {
  stop(): Promise<void>;
};

type LeadScoreRecoveryDependencies = {
  database: LeadScoreRecoveryDatabase;
  onFatal(error: LeadScoreRecoverySweepError): void;
};

type LeadScoreRecoveryOptions = {
  intervalMs?: number;
  workspaceLimit?: number;
  jobsPerWorkspaceLimit?: number;
};

const recoveryPageSchema = z.strictObject({
  workspaceIds: z.array(z.uuid()).max(100),
  nextAfterWorkspaceId: z.uuid().nullable(),
});

const recoveryOptionsSchema = z.strictObject({
  intervalMs: z.int().safe().min(1).max(60 * 60_000),
  workspaceLimit: z.int().safe().min(1).max(100),
  jobsPerWorkspaceLimit: z.int().safe().min(1).max(100),
});

const DEFAULT_RECOVERY_OPTIONS = Object.freeze({
  intervalMs: 60_000,
  workspaceLimit: 25,
  jobsPerWorkspaceLimit: 25,
});

function validateRecoveryPage(
  value: unknown,
  afterWorkspaceId: string | null,
): LeadScoreRecoveryWorkspacePage {
  const parsed = recoveryPageSchema.safeParse(value);
  if (!parsed.success) throw new LeadScoreRecoverySweepError();
  const page = parsed.data;
  for (let index = 0; index < page.workspaceIds.length; index += 1) {
    const current = page.workspaceIds[index];
    const previous = index === 0 ? afterWorkspaceId : page.workspaceIds[index - 1];
    if (previous !== null && current.localeCompare(previous) <= 0) {
      throw new LeadScoreRecoverySweepError();
    }
  }
  const cursorLowerBound = page.workspaceIds.at(-1) ?? afterWorkspaceId;
  if (
    page.nextAfterWorkspaceId !== null
    && cursorLowerBound !== null
    && page.nextAfterWorkspaceId.localeCompare(cursorLowerBound) < 0
  ) throw new LeadScoreRecoverySweepError();
  if (
    page.nextAfterWorkspaceId !== null
    && afterWorkspaceId !== null
    && page.nextAfterWorkspaceId.localeCompare(afterWorkspaceId) <= 0
  ) throw new LeadScoreRecoverySweepError();
  return page;
}

async function runRecoverySweep(
  database: LeadScoreRecoveryDatabase,
  afterWorkspaceId: string | null,
  workspaceLimit: number,
  jobsPerWorkspaceLimit: number,
): Promise<string | null> {
  const page = validateRecoveryPage(await database.listRecoveryWorkspaces({
    afterWorkspaceId,
    limit: workspaceLimit,
  }), afterWorkspaceId);
  for (const workspaceId of page.workspaceIds) {
    await database.requeueDue({ workspaceId, limit: jobsPerWorkspaceLimit });
  }
  return page.nextAfterWorkspaceId;
}

/**
 * A recursive timeout is deliberately used instead of setInterval: the next
 * bounded tenant sweep is not scheduled until the current one has completed.
 */
export function startLeadScoreRecoverySweep(
  dependencies: LeadScoreRecoveryDependencies,
  options: LeadScoreRecoveryOptions = {},
): LeadScoreRecoveryController {
  const parsedOptions = recoveryOptionsSchema.safeParse({
    ...DEFAULT_RECOVERY_OPTIONS,
    ...options,
  });
  if (!parsedOptions.success) throw new LeadScoreRecoverySweepError();
  const config = parsedOptions.data;
  let afterWorkspaceId: string | null = null;
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
        afterWorkspaceId = await runRecoverySweep(
          dependencies.database,
          afterWorkspaceId,
          config.workspaceLimit,
          config.jobsPerWorkspaceLimit,
        );
      } catch {
        stopped = true;
        const failure = new LeadScoreRecoverySweepError();
        try {
          dependencies.onFatal(failure);
        } catch {
          // A reporter must never replace the deliberately sanitized incident.
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
