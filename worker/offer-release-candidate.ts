import { randomUUID } from "node:crypto";

import {
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  offerReleaseCandidateDispatchV1Schema,
  validateOfferReleaseCandidateInput,
  type OfferReleaseCandidateDispatchV1,
  type OfferReleaseCandidateInputV1,
} from "../lib/integrations/offers/release-contract";
import {
  OfferPdfRenderError,
  type RenderedOfferPdf,
} from "./offer-pdf-renderer";
import type {
  OfferReleaseCandidateRenderer,
} from "./offer-release-candidate-renderer";

export class OfferReleaseCandidateDispatchError extends Error {
  constructor() {
    super("offer release candidate dispatch payload is invalid");
    this.name = "OfferReleaseCandidateDispatchError";
  }
}

export class OfferReleaseCandidateIntegrityIncidentError extends Error {
  readonly code = "offer_release_candidate_renderer_nondeterministic" as const;

  constructor() {
    super("offer release candidate renderer integrity incident");
    this.name = "OfferReleaseCandidateIntegrityIncidentError";
  }
}

export class OfferReleaseCandidateRecoverySweepError extends Error {
  readonly code = "offer_release_candidate_recovery_failed" as const;

  constructor() {
    super("offer release candidate recovery sweep failed");
    this.name = "OfferReleaseCandidateRecoverySweepError";
  }
}

export function parseOfferReleaseCandidateDispatchPayload(
  value: unknown,
): OfferReleaseCandidateDispatchV1 {
  const parsed = offerReleaseCandidateDispatchV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferReleaseCandidateDispatchError();
  return parsed.data;
}

export type OfferReleaseCandidateClaim = Readonly<{
  workspaceId: string;
  candidateId: string;
  leaseToken: string;
  attemptCount: number;
  inputVersion: string;
  templateVersion: string;
  rendererRecipeVersion: string;
  inputSha256: string;
  input: OfferReleaseCandidateInputV1;
}>;

export type OfferReleaseCandidateDatabase = Readonly<{
  claim(input: {
    workspaceId: string;
    candidateId: string;
    leaseToken: string;
  }): Promise<OfferReleaseCandidateClaim | null>;
  finalizeSuccess(input: {
    workspaceId: string;
    candidateId: string;
    leaseToken: string;
    attemptCount: number;
    artifact: RenderedOfferPdf;
  }): Promise<unknown>;
  finalizeFailure(input: {
    workspaceId: string;
    candidateId: string;
    leaseToken: string;
    attemptCount: number;
    errorCode: string;
    retryable: boolean;
  }): Promise<unknown>;
}>;

export type OfferReleaseCandidateRecoveryWorkspacePage = Readonly<{
  workspaceIds: string[];
  nextAfterWorkspaceId: string | null;
}>;

export type OfferReleaseCandidateRecoveryDatabase = Readonly<{
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<OfferReleaseCandidateRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
}>;

export type OfferReleaseCandidateRecoveryController = Readonly<{
  stop(): Promise<void>;
}>;

type HandlerDependencies = Readonly<{
  database: OfferReleaseCandidateDatabase;
  renderer: OfferReleaseCandidateRenderer;
  onIntegrityIncident(error: OfferReleaseCandidateIntegrityIncidentError): void;
  createLeaseToken?(): string;
}>;

type RecoveryDependencies = Readonly<{
  database: OfferReleaseCandidateRecoveryDatabase;
  onFatal(error: OfferReleaseCandidateRecoverySweepError): void;
}>;

type RecoveryOptions = Readonly<{
  intervalMs?: number;
  workspaceLimit?: number;
  jobsPerWorkspaceLimit?: number;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_RECOVERY_OPTIONS = Object.freeze({
  intervalMs: 60_000,
  workspaceLimit: 25,
  jobsPerWorkspaceLimit: 25,
});

function claimIsPinned(claim: OfferReleaseCandidateClaim): boolean {
  if (
    claim.inputVersion !== OFFER_RELEASE_CANDIDATE_INPUT_VERSION
    || claim.templateVersion !== OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION
    || claim.rendererRecipeVersion
      !== OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION
    || !SHA256_PATTERN.test(claim.inputSha256)
  ) return false;
  const parsed = validateOfferReleaseCandidateInput(claim.input);
  return parsed.ok
    && parsed.value.schemaVersion === claim.inputVersion
    && parsed.value.templateVersion === claim.templateVersion
    && parsed.value.rendererRecipeVersion === claim.rendererRecipeVersion
    && hashOfferReleaseCandidateInput(parsed.value) === claim.inputSha256;
}

function sanitizedFailure(error: unknown): {
  errorCode: string;
  retryable: boolean;
} {
  if (error instanceof OfferPdfRenderError) {
    return { errorCode: error.code, retryable: error.retryable };
  }
  return { errorCode: "browser_unavailable", retryable: true };
}

async function recordFailure(
  database: OfferReleaseCandidateDatabase,
  claim: OfferReleaseCandidateClaim,
  failure: { errorCode: string; retryable: boolean },
): Promise<void> {
  try {
    await database.finalizeFailure({
      workspaceId: claim.workspaceId,
      candidateId: claim.candidateId,
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

export function createOfferReleaseCandidateRenderHandler(
  dependencies: HandlerDependencies,
): (jobs: unknown[]) => Promise<void> {
  const createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  return async (jobs) => {
    for (const job of jobs) {
      const dispatch = parseOfferReleaseCandidateDispatchPayload(
        job !== null && typeof job === "object" && "data" in job
          ? (job as { data?: unknown }).data
          : undefined,
      );
      const claim = await dependencies.database.claim({
        workspaceId: dispatch.workspaceId,
        candidateId: dispatch.candidateId,
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

      let artifact: RenderedOfferPdf;
      try {
        artifact = await dependencies.renderer.render(claim.input);
      } catch (error) {
        await recordFailure(dependencies.database, claim, sanitizedFailure(error));
        continue;
      }

      try {
        await dependencies.database.finalizeSuccess({
          workspaceId: claim.workspaceId,
          candidateId: claim.candidateId,
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
          const incident = new OfferReleaseCandidateIntegrityIncidentError();
          try {
            dependencies.onIntegrityIncident(incident);
          } catch {
            // The deliberately sanitized incident remains authoritative.
          }
          throw incident;
        }
        if (code === "invalid_pdf") {
          await recordFailure(dependencies.database, claim, {
            errorCode: "invalid_pdf",
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

function validateRecoveryOptions(options: RecoveryOptions) {
  const merged = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
  if (
    !Number.isSafeInteger(merged.intervalMs)
    || merged.intervalMs < 1
    || merged.intervalMs > 60 * 60_000
    || !Number.isSafeInteger(merged.workspaceLimit)
    || merged.workspaceLimit < 1
    || merged.workspaceLimit > 100
    || !Number.isSafeInteger(merged.jobsPerWorkspaceLimit)
    || merged.jobsPerWorkspaceLimit < 1
    || merged.jobsPerWorkspaceLimit > 100
  ) throw new OfferReleaseCandidateRecoverySweepError();
  return merged;
}

function validateRecoveryPage(
  value: OfferReleaseCandidateRecoveryWorkspacePage,
  afterWorkspaceId: string | null,
): OfferReleaseCandidateRecoveryWorkspacePage {
  if (
    value === null
    || typeof value !== "object"
    || !Array.isArray(value.workspaceIds)
    || value.workspaceIds.length > 100
    || (value.nextAfterWorkspaceId !== null
      && !UUID_PATTERN.test(value.nextAfterWorkspaceId))
    || value.workspaceIds.some((workspaceId) => !UUID_PATTERN.test(workspaceId))
  ) throw new OfferReleaseCandidateRecoverySweepError();
  for (let index = 0; index < value.workspaceIds.length; index += 1) {
    const current = value.workspaceIds[index]!;
    const previous = index === 0
      ? afterWorkspaceId
      : value.workspaceIds[index - 1]!;
    if (previous !== null && current.localeCompare(previous) <= 0) {
      throw new OfferReleaseCandidateRecoverySweepError();
    }
  }
  const lowerBound = value.workspaceIds.at(-1) ?? afterWorkspaceId;
  if (
    value.nextAfterWorkspaceId !== null
    && lowerBound !== null
    && value.nextAfterWorkspaceId.localeCompare(lowerBound) < 0
  ) throw new OfferReleaseCandidateRecoverySweepError();
  if (
    value.nextAfterWorkspaceId !== null
    && afterWorkspaceId !== null
    && value.nextAfterWorkspaceId.localeCompare(afterWorkspaceId) <= 0
  ) throw new OfferReleaseCandidateRecoverySweepError();
  return value;
}

async function runRecoverySweep(
  database: OfferReleaseCandidateRecoveryDatabase,
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

/** The next bounded tenant sweep starts only after the current one settles. */
export function startOfferReleaseCandidateRecoverySweep(
  dependencies: RecoveryDependencies,
  options: RecoveryOptions = {},
): OfferReleaseCandidateRecoveryController {
  const config = validateRecoveryOptions(options);
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
        const failure = new OfferReleaseCandidateRecoverySweepError();
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
