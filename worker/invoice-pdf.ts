import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  INVOICE_PDF_INPUT_VERSION,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
  validateInvoicePdfInput,
  type InvoicePdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import {
  InvoicePdfRenderError,
  type InvoicePdfRenderer,
  type RenderedInvoicePdf,
} from "./invoice-pdf-renderer";

export const INVOICE_PDF_DISPATCH_SCHEMA_VERSION =
  "invoice-pdf-dispatch.v1" as const;

const dispatchSchema = z.strictObject({
  schemaVersion: z.literal(INVOICE_PDF_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

export type InvoicePdfDispatchPayload = z.infer<typeof dispatchSchema>;

export class InvoicePdfDispatchError extends Error {
  constructor() {
    super("invoice PDF dispatch payload is invalid");
    this.name = "InvoicePdfDispatchError";
  }
}

export class InvoicePdfIntegrityIncidentError extends Error {
  readonly code = "invoice_pdf_renderer_nondeterministic" as const;

  constructor() {
    super("invoice PDF renderer integrity incident");
    this.name = "InvoicePdfIntegrityIncidentError";
  }
}

export class InvoicePdfRecoverySweepError extends Error {
  readonly code = "invoice_pdf_recovery_failed" as const;

  constructor() {
    super("invoice PDF recovery sweep failed");
    this.name = "InvoicePdfRecoverySweepError";
  }
}

export function parseInvoicePdfDispatchPayload(value: unknown): InvoicePdfDispatchPayload {
  const parsed = dispatchSchema.safeParse(value);
  if (!parsed.success) throw new InvoicePdfDispatchError();
  return parsed.data;
}

export type InvoicePdfClaim = {
  workspaceId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  inputVersion: string;
  templateVersion: string;
  rendererRecipeVersion: string;
  inputSha256: string;
  input: InvoicePdfInputV1;
};

export type InvoicePdfDatabase = {
  claim(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
  }): Promise<InvoicePdfClaim | null>;
  finalizeSuccess(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    artifact: RenderedInvoicePdf;
  }): Promise<unknown>;
  finalizeFailure(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    errorCode: string;
    retryable: boolean;
  }): Promise<unknown>;
};

type Dependencies = {
  database: InvoicePdfDatabase;
  renderer: InvoicePdfRenderer;
  onIntegrityIncident(error: InvoicePdfIntegrityIncidentError): void;
  createLeaseToken?(): string;
};

export type InvoicePdfRecoveryWorkspacePage = {
  workspaceIds: string[];
  nextAfterWorkspaceId: string | null;
};

export type InvoicePdfRecoveryDatabase = {
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<InvoicePdfRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
};

export type InvoicePdfRecoveryController = {
  stop(): Promise<void>;
};

type InvoicePdfRecoveryDependencies = {
  database: InvoicePdfRecoveryDatabase;
  onFatal(error: InvoicePdfRecoverySweepError): void;
};

type InvoicePdfRecoveryOptions = {
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
): InvoicePdfRecoveryWorkspacePage {
  const parsed = recoveryPageSchema.safeParse(value);
  if (!parsed.success) throw new InvoicePdfRecoverySweepError();
  const page = parsed.data;
  for (let index = 0; index < page.workspaceIds.length; index += 1) {
    const current = page.workspaceIds[index];
    const previous = index === 0 ? afterWorkspaceId : page.workspaceIds[index - 1];
    if (previous !== null && current.localeCompare(previous) <= 0) {
      throw new InvoicePdfRecoverySweepError();
    }
  }
  const cursorLowerBound = page.workspaceIds.at(-1) ?? afterWorkspaceId;
  if (
    page.nextAfterWorkspaceId !== null
    && cursorLowerBound !== null
    && page.nextAfterWorkspaceId.localeCompare(cursorLowerBound) < 0
  ) throw new InvoicePdfRecoverySweepError();
  if (
    page.nextAfterWorkspaceId !== null
    && afterWorkspaceId !== null
    && page.nextAfterWorkspaceId.localeCompare(afterWorkspaceId) <= 0
  ) throw new InvoicePdfRecoverySweepError();
  return page;
}

async function runRecoverySweep(
  database: InvoicePdfRecoveryDatabase,
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
export function startInvoicePdfRecoverySweep(
  dependencies: InvoicePdfRecoveryDependencies,
  options: InvoicePdfRecoveryOptions = {},
): InvoicePdfRecoveryController {
  const parsedOptions = recoveryOptionsSchema.safeParse({
    ...DEFAULT_RECOVERY_OPTIONS,
    ...options,
  });
  if (!parsedOptions.success) throw new InvoicePdfRecoverySweepError();
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
        const failure = new InvoicePdfRecoverySweepError();
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

function claimIsPinned(claim: InvoicePdfClaim): boolean {
  if (
    claim.inputVersion !== INVOICE_PDF_INPUT_VERSION
    || claim.templateVersion !== INVOICE_PDF_TEMPLATE_VERSION
    || claim.rendererRecipeVersion !== INVOICE_PDF_RENDERER_RECIPE_VERSION
  ) return false;
  const parsed = validateInvoicePdfInput(claim.input);
  return parsed.ok
    && parsed.value.schemaVersion === claim.inputVersion
    && parsed.value.templateVersion === claim.templateVersion
    && parsed.value.rendererRecipeVersion === claim.rendererRecipeVersion;
}

function sanitizedFailure(error: unknown): {
  errorCode: string;
  retryable: boolean;
} {
  if (error instanceof InvoicePdfRenderError) {
    return { errorCode: error.code, retryable: error.retryable };
  }
  return { errorCode: "browser_unavailable", retryable: true };
}

async function recordFailure(
  database: InvoicePdfDatabase,
  claim: InvoicePdfClaim,
  failure: { errorCode: string; retryable: boolean },
): Promise<void> {
  try {
    await database.finalizeFailure({
      workspaceId: claim.workspaceId,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      ...failure,
    });
  } catch (error) {
    const code = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "stale" || code === "retry_conflict") return;
    throw error;
  }
}

export function createInvoicePdfRenderHandler(
  dependencies: Dependencies,
): (jobs: unknown[]) => Promise<void> {
  const createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  return async (jobs) => {
    for (const job of jobs) {
      const dispatch = parseInvoicePdfDispatchPayload(
        job !== null && typeof job === "object" && "data" in job
          ? (job as { data?: unknown }).data
          : undefined,
      );
      const claim = await dependencies.database.claim({
        workspaceId: dispatch.workspaceId,
        jobId: dispatch.jobId,
        leaseToken: createLeaseToken(),
      });
      if (claim === null) continue;
      if (!claimIsPinned(claim)) {
        await recordFailure(dependencies.database, claim, {
          errorCode: "invalid_input",
          retryable: false,
        });
        continue;
      }

      let artifact: RenderedInvoicePdf;
      try {
        artifact = await dependencies.renderer.render(claim.input);
      } catch (error) {
        await recordFailure(dependencies.database, claim, sanitizedFailure(error));
        continue;
      }

      try {
        await dependencies.database.finalizeSuccess({
          workspaceId: claim.workspaceId,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          attemptCount: claim.attemptCount,
          artifact,
        });
      } catch (error) {
        const code = error !== null && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "stale" || code === "retry_conflict") continue;
        if (code === "renderer_nondeterministic") {
          const incident = new InvoicePdfIntegrityIncidentError();
          try {
            dependencies.onIntegrityIncident(incident);
          } catch {
            // Reporter failures must not leak or replace the sanitized incident.
          }
          throw incident;
        }
        if (code === "invalid_pdf") {
          await recordFailure(dependencies.database, claim, {
            errorCode: code,
            retryable: false,
          });
          continue;
        }
        await recordFailure(dependencies.database, claim, {
          errorCode: "storage_unavailable",
          retryable: true,
        });
      }
    }
  };
}
