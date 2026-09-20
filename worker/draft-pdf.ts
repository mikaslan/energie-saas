import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  DRAFT_PDF_INPUT_VERSION,
  DRAFT_PDF_RENDERER_RECIPE_VERSION,
  DRAFT_PDF_TEMPLATE_VERSION,
  validateDraftPdfInput,
  type DraftPdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import {
  DraftPdfRenderError,
  type DraftPdfRenderer,
  type RenderedDraftPdf,
} from "./draft-pdf-renderer";

// F8-24c: eigene Queue/Version (Muster invoice-pdf, schlank: kein Recovery-
// Sweep — Vorschau ist on-demand, kein pgboss-Dispatch-Gate).
export const DRAFT_PDF_QUEUE = "draft-pdf.render" as const;
export const DRAFT_PDF_DISPATCH_SCHEMA_VERSION =
  "draft-pdf-dispatch.v1" as const;

const dispatchSchema = z.strictObject({
  schemaVersion: z.literal(DRAFT_PDF_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

export type DraftPdfDispatchPayload = z.infer<typeof dispatchSchema>;

export class DraftPdfDispatchError extends Error {
  constructor() {
    super("draft PDF dispatch payload is invalid");
    this.name = "DraftPdfDispatchError";
  }
}

export class DraftPdfIntegrityIncidentError extends Error {
  readonly code = "draft_pdf_renderer_nondeterministic" as const;

  constructor() {
    super("draft PDF renderer integrity incident");
    this.name = "DraftPdfIntegrityIncidentError";
  }
}

export function parseDraftPdfDispatchPayload(value: unknown): DraftPdfDispatchPayload {
  const parsed = dispatchSchema.safeParse(value);
  if (!parsed.success) throw new DraftPdfDispatchError();
  return parsed.data;
}

export type DraftPdfClaim = {
  workspaceId: string;
  jobId: string;
  leaseToken: string;
  attemptCount: number;
  inputVersion: string;
  templateVersion: string;
  rendererRecipeVersion: string;
  inputSha256: string;
  input: DraftPdfInputV1;
};

export type DraftPdfDatabase = {
  claim(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
  }): Promise<DraftPdfClaim | null>;
  finalizeSuccess(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    artifact: RenderedDraftPdf;
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
  database: DraftPdfDatabase;
  renderer: DraftPdfRenderer;
  onIntegrityIncident?(error: DraftPdfIntegrityIncidentError): void;
  createLeaseToken?(): string;
};

function claimIsPinned(claim: DraftPdfClaim): boolean {
  // F8-24c: exakt das Draft-Tripel, nie Kreuzmix, nie Unbekanntes.
  if (
    claim.inputVersion !== DRAFT_PDF_INPUT_VERSION
    || claim.templateVersion !== DRAFT_PDF_TEMPLATE_VERSION
    || claim.rendererRecipeVersion !== DRAFT_PDF_RENDERER_RECIPE_VERSION
  ) return false;
  const parsed = validateDraftPdfInput(claim.input);
  return parsed.ok
    && parsed.value.schemaVersion === claim.inputVersion
    && parsed.value.templateVersion === claim.templateVersion
    && parsed.value.rendererRecipeVersion === claim.rendererRecipeVersion;
}

function sanitizedFailure(error: unknown): {
  errorCode: string;
  retryable: boolean;
} {
  if (error instanceof DraftPdfRenderError) {
    return { errorCode: error.code, retryable: error.retryable };
  }
  return { errorCode: "browser_unavailable", retryable: true };
}

async function recordFailure(
  database: DraftPdfDatabase,
  claim: DraftPdfClaim,
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

export function createDraftPdfRenderHandler(
  dependencies: Dependencies,
): (jobs: unknown[]) => Promise<void> {
  const createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  return async (jobs) => {
    for (const job of jobs) {
      const dispatch = parseDraftPdfDispatchPayload(
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

      let artifact: RenderedDraftPdf;
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
          const incident = new DraftPdfIntegrityIncidentError();
          try {
            dependencies.onIntegrityIncident?.(incident);
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
