import { createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import type { TenantTx } from "../lib/db/types";
import { OFFER_CANONICALIZATION_VERSION } from "../lib/integrations/offers/contract";
import {
  OFFER_ISSUANCE_INPUT_VERSION,
  OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
  OFFER_ISSUANCE_TEMPLATE_VERSION,
  hashOfferIssuanceInput,
  validateOfferIssuanceInput,
} from "../lib/integrations/offers/issuance-contract";
import type {
  OfferIssuanceClaim,
  OfferIssuanceDatabase,
  OfferIssuanceRecoveryWorkspacePage,
} from "./offer-issuance";
import type { RenderedOfferPdf } from "./offer-pdf-renderer";

export const OFFER_ISSUANCE_MAX_ATTEMPTS = 3 as const;
export const OFFER_ISSUANCE_LEASE_SECONDS = 120 as const;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(SHA256_PATTERN);
const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return date;
  });
const workerKeySchema = z.strictObject({
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
});
const claimKeySchema = workerKeySchema.extend({ leaseToken: uuidSchema });
const finalizationKeySchema = claimKeySchema.extend({
  attemptCount: z.int().safe().min(1).max(OFFER_ISSUANCE_MAX_ATTEMPTS),
});
const failureCodeSchema = z.enum([
  "browser_unavailable",
  "render_timeout",
  "persistence_unavailable",
  "network_attempted",
  "invalid_input",
  "invalid_pdf",
  "pdf_too_large",
  "renderer_nondeterministic",
  "lease_expired",
]);
const failureInputSchema = finalizationKeySchema.extend({
  errorCode: failureCodeSchema,
  retryable: z.boolean(),
});
const recoveryInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  limit: z.int().safe().min(1).max(100),
});
const recoveryWorkspaceInputSchema = z.strictObject({
  afterWorkspaceId: uuidSchema.nullable(),
  limit: z.int().safe().min(1).max(100),
});
const functionRowSchema = z.strictObject({ result: z.unknown() });
const notClaimableSchema = z.strictObject({ status: z.literal("not_claimable") });
const workerConflictSchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.enum([
    "invalid_input",
    "stale",
    "retry_conflict",
    "invalid_pdf",
    "renderer_nondeterministic",
  ]),
});
const claimResultSchema = z.strictObject({
  status: z.literal("claimed"),
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
  leaseToken: uuidSchema,
  attemptCount: z.int().safe().min(1).max(OFFER_ISSUANCE_MAX_ATTEMPTS),
  inputVersion: z.literal(OFFER_ISSUANCE_INPUT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  templateVersion: z.literal(OFFER_ISSUANCE_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(OFFER_ISSUANCE_RENDERER_RECIPE_VERSION),
  inputSha256: sha256Schema,
  input: z.unknown(),
});
const terminalClaimResultSchema = z.strictObject({
  status: z.literal("failed_final"),
  attemptCount: z.int().safe().min(1).max(OFFER_ISSUANCE_MAX_ATTEMPTS),
  nextAttemptAt: databaseInstantSchema,
  errorCode: z.enum(["invalid_input", "lease_expired"]),
});
const successResultSchema = z.strictObject({
  status: z.literal("ready_for_approval"),
  attemptCount: z.int().safe().min(1).max(OFFER_ISSUANCE_MAX_ATTEMPTS),
  replayed: z.boolean(),
  artifactVersion: uuidSchema,
});
const failureResultSchema = z.strictObject({
  status: z.enum(["retry_wait", "failed_final"]),
  attemptCount: z.int().safe().min(1).max(OFFER_ISSUANCE_MAX_ATTEMPTS),
  nextAttemptAt: databaseInstantSchema,
  errorCode: failureCodeSchema,
});
const issuanceIdRowSchema = z.strictObject({ issuance_id: uuidSchema });
const workspaceIdRowSchema = z.strictObject({ workspace_id: uuidSchema });
const dispatchGateSchema = z.strictObject({
  dispatch_signature: z.literal("pgboss.enqueue_offer_issuance(uuid,uuid)").nullable(),
  current_role: z.string().min(1),
  session_role: z.string().min(1),
  database_name: z.string().min(1),
});

export type OfferIssuanceWorkerErrorCode =
  | "invalid_input"
  | "stale"
  | "retry_conflict"
  | "persistence_unavailable"
  | "invalid_pdf"
  | "renderer_nondeterministic";

export class OfferIssuanceWorkerError extends Error {
  constructor(public readonly code: OfferIssuanceWorkerErrorCode) {
    super("offer issuance worker database operation failed");
    this.name = "OfferIssuanceWorkerError";
  }
}

export type OfferIssuanceFailureResult = {
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date;
};

export type OfferIssuanceSuccessResult = {
  state: "ready_for_approval";
  attemptCount: number;
  replayed: boolean;
  artifactVersion: string;
};

export type OfferIssuanceDatabaseGateway = {
  database: OfferIssuanceDatabase;
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<OfferIssuanceRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
};

function workerError(code: OfferIssuanceWorkerErrorCode): never {
  throw new OfferIssuanceWorkerError(code);
}

async function executeFunction(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  let rows: unknown[];
  try {
    rows = (await tx.execute(statement)).rows;
  } catch (error) {
    const sqlState = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    return workerError(sqlState === "22023" ? "invalid_input" : "persistence_unavailable");
  }
  if (rows.length !== 1) return workerError("invalid_input");
  const row = functionRowSchema.safeParse(rows[0]);
  if (!row.success) return workerError("invalid_input");
  return row.data.result;
}

function mapConflict(value: unknown): never {
  const parsed = workerConflictSchema.safeParse(value);
  if (!parsed.success) return workerError("invalid_input");
  return workerError(parsed.data.code);
}

async function enqueueDispatch(
  tx: TenantTx,
  workspaceId: string,
  issuanceId: string,
): Promise<void> {
  let gateRows: unknown[];
  try {
    gateRows = (await tx.execute(sql`
      select pg_catalog.to_regprocedure(
               'pgboss.enqueue_offer_issuance(uuid,uuid)'
             )::text as dispatch_signature,
             current_user::text as current_role,
             session_user::text as session_role,
             pg_catalog.current_database()::text as database_name
    `)).rows;
  } catch {
    return workerError("persistence_unavailable");
  }
  if (gateRows.length !== 1) return workerError("persistence_unavailable");
  const gate = dispatchGateSchema.safeParse(gateRows[0]);
  if (!gate.success) return workerError("persistence_unavailable");
  if (gate.data.dispatch_signature === null) {
    const explicitTestSkip = gate.data.current_role === gate.data.session_role
      && (gate.data.current_role === "app_test" || gate.data.current_role === "app_ci")
      && gate.data.database_name.includes("test");
    if (explicitTestSkip) return;
    return workerError("persistence_unavailable");
  }
  try {
    await tx.execute(sql`
      select pgboss.enqueue_offer_issuance(
        ${workspaceId}::uuid,
        ${issuanceId}::uuid
      )
    `);
  } catch {
    workerError("persistence_unavailable");
  }
}

function failureIsRetryable(code: z.infer<typeof failureCodeSchema>): boolean {
  return code === "browser_unavailable"
    || code === "render_timeout"
    || code === "persistence_unavailable";
}

function validatedArtifact(value: unknown): RenderedOfferPdf {
  if (value === null || typeof value !== "object") workerError("invalid_pdf");
  const artifact = value as Partial<RenderedOfferPdf>;
  if (
    Object.keys(artifact).length !== 4
    || Object.keys(artifact).some((key) => ![
      "bytes", "sha256", "sizeBytes", "mimeType",
    ].includes(key))
    || artifact.mimeType !== "application/pdf"
    || !Buffer.isBuffer(artifact.bytes)
    || !Number.isSafeInteger(artifact.sizeBytes)
    || (artifact.sizeBytes as number) < 100
    || (artifact.sizeBytes as number) > MAX_ARTIFACT_BYTES
    || artifact.bytes.length !== artifact.sizeBytes
    || typeof artifact.sha256 !== "string"
    || !SHA256_PATTERN.test(artifact.sha256)
    || !artifact.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
    || !/%%EOF[\t\r\n ]*$/u.test(
      artifact.bytes.subarray(Math.max(0, artifact.bytes.length - 1_024))
        .toString("latin1"),
    )
  ) workerError("invalid_pdf");
  const actual = createHash("sha256").update(artifact.bytes).digest();
  const expected = Buffer.from(artifact.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    workerError("invalid_pdf");
  }
  return {
    mimeType: "application/pdf",
    bytes: Buffer.from(artifact.bytes),
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes as number,
  };
}

export async function claimOfferIssuance(
  tx: TenantTx,
  value: unknown,
): Promise<OfferIssuanceClaim | null> {
  const parsedKey = claimKeySchema.safeParse(value);
  if (!parsedKey.success) workerError("invalid_input");
  const key = parsedKey.data;
  const raw = await executeFunction(tx, sql`
    select public.claim_offer_issuance_render(
      ${key.workspaceId}::uuid,
      ${key.issuanceId}::uuid,
      ${key.leaseToken}::uuid,
      ${OFFER_ISSUANCE_LEASE_SECONDS}::integer
    ) as result
  `);
  if (notClaimableSchema.safeParse(raw).success) return null;
  if (terminalClaimResultSchema.safeParse(raw).success) return null;
  const parsed = claimResultSchema.safeParse(raw);
  if (!parsed.success) return mapConflict(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== key.workspaceId
    || result.issuanceId !== key.issuanceId
    || result.leaseToken !== key.leaseToken
  ) workerError("invalid_input");
  const input = validateOfferIssuanceInput(result.input);
  if (
    !input.ok
    || input.value.issuanceId !== result.issuanceId
    || input.value.source.workspaceId !== result.workspaceId
    || input.value.schemaVersion !== result.inputVersion
    || input.value.canonicalizationVersion !== result.canonicalizationVersion
    || input.value.templateVersion !== result.templateVersion
    || input.value.rendererRecipeVersion !== result.rendererRecipeVersion
    || hashOfferIssuanceInput(input.value) !== result.inputSha256
  ) {
    await finalizeOfferIssuanceFailure(tx, {
      workspaceId: result.workspaceId,
      issuanceId: result.issuanceId,
      leaseToken: result.leaseToken,
      attemptCount: result.attemptCount,
      errorCode: "invalid_input",
      retryable: false,
    });
    return null;
  }
  await enqueueDispatch(tx, key.workspaceId, key.issuanceId);
  return {
    workspaceId: result.workspaceId,
    issuanceId: result.issuanceId,
    leaseToken: result.leaseToken,
    attemptCount: result.attemptCount,
    inputVersion: result.inputVersion,
    canonicalizationVersion: result.canonicalizationVersion,
    templateVersion: result.templateVersion,
    rendererRecipeVersion: result.rendererRecipeVersion,
    inputSha256: result.inputSha256,
    input: structuredClone(input.value),
  };
}

export async function finalizeOfferIssuanceSuccess(
  tx: TenantTx,
  value: unknown,
): Promise<OfferIssuanceSuccessResult> {
  if (value === null || typeof value !== "object") workerError("invalid_input");
  const record = value as Record<string, unknown>;
  const parsedKey = finalizationKeySchema.safeParse({
    workspaceId: record.workspaceId,
    issuanceId: record.issuanceId,
    leaseToken: record.leaseToken,
    attemptCount: record.attemptCount,
  });
  if (
    !parsedKey.success
    || !Object.hasOwn(record, "artifact")
    || Object.keys(record).some((key) => ![
      "workspaceId", "issuanceId", "leaseToken", "attemptCount", "artifact",
    ].includes(key))
  ) workerError("invalid_input");
  const key = parsedKey.data;
  const artifact = validatedArtifact(record.artifact);
  const raw = await executeFunction(tx, sql`
    select public.finalize_offer_issuance_render_success(
      ${key.workspaceId}::uuid,
      ${key.issuanceId}::uuid,
      ${key.leaseToken}::uuid,
      ${key.attemptCount}::integer,
      ${artifact.bytes}::bytea
    ) as result
  `);
  const parsed = successResultSchema.safeParse(raw);
  if (!parsed.success) return mapConflict(raw);
  return {
    state: parsed.data.status,
    attemptCount: parsed.data.attemptCount,
    replayed: parsed.data.replayed,
    artifactVersion: parsed.data.artifactVersion,
  };
}

export async function finalizeOfferIssuanceFailure(
  tx: TenantTx,
  value: unknown,
): Promise<OfferIssuanceFailureResult> {
  const parsedInput = failureInputSchema.safeParse(value);
  if (!parsedInput.success) workerError("invalid_input");
  const input = parsedInput.data;
  if (failureIsRetryable(input.errorCode) !== input.retryable) {
    workerError("invalid_input");
  }
  const raw = await executeFunction(tx, sql`
    select public.finalize_offer_issuance_render_failure(
      ${input.workspaceId}::uuid,
      ${input.issuanceId}::uuid,
      ${input.leaseToken}::uuid,
      ${input.attemptCount}::integer,
      ${input.errorCode}::text,
      ${input.retryable}::boolean
    ) as result
  `);
  const parsed = failureResultSchema.safeParse(raw);
  if (!parsed.success) return mapConflict(raw);
  if (
    parsed.data.errorCode !== input.errorCode
    || parsed.data.attemptCount !== input.attemptCount
    || (parsed.data.status === "retry_wait" && !input.retryable)
  ) workerError("invalid_input");
  if (parsed.data.status === "retry_wait") {
    await enqueueDispatch(tx, input.workspaceId, input.issuanceId);
  }
  return {
    state: parsed.data.status,
    attemptCount: parsed.data.attemptCount,
    nextAttemptAt: parsed.data.nextAttemptAt,
  };
}

export async function recoverDueOfferIssuances(
  tx: TenantTx,
  value: unknown,
): Promise<string[]> {
  const parsedInput = recoveryInputSchema.safeParse(value);
  if (!parsedInput.success) workerError("invalid_input");
  const input = parsedInput.data;
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select issuance_id
        from public.recover_offer_issuance_renders(
          ${input.workspaceId}::uuid,
          ${input.limit}::integer
        )
       order by issuance_id
    `)).rows;
  } catch {
    return workerError("persistence_unavailable");
  }
  if (rows.length > input.limit) workerError("invalid_input");
  const issuanceIds = rows.map((row) => {
    const parsed = issuanceIdRowSchema.safeParse(row);
    if (!parsed.success) return workerError("invalid_input");
    return parsed.data.issuance_id;
  });
  if (new Set(issuanceIds).size !== issuanceIds.length) workerError("invalid_input");
  for (let index = 1; index < issuanceIds.length; index += 1) {
    if (issuanceIds[index]!.localeCompare(issuanceIds[index - 1]!) <= 0) {
      workerError("invalid_input");
    }
  }
  for (const issuanceId of issuanceIds) {
    await enqueueDispatch(tx, input.workspaceId, issuanceId);
  }
  return issuanceIds;
}

async function listRecoveryWorkspaces(
  pool: Pool,
  value: unknown,
): Promise<OfferIssuanceRecoveryWorkspacePage> {
  const parsedInput = recoveryWorkspaceInputSchema.safeParse(value);
  if (!parsedInput.success) workerError("invalid_input");
  const input = parsedInput.data;
  let rows: unknown[];
  try {
    rows = (await pool.query(
      `select workspace_id
         from public.list_offer_issuance_recovery_workspaces($1::uuid, $2::integer)
        order by workspace_id`,
      [input.afterWorkspaceId, input.limit],
    )).rows;
  } catch {
    return workerError("persistence_unavailable");
  }
  if (rows.length > input.limit) workerError("invalid_input");
  const workspaceIds = rows.map((row) => {
    const parsed = workspaceIdRowSchema.safeParse(row);
    if (!parsed.success) return workerError("invalid_input");
    return parsed.data.workspace_id;
  });
  for (let index = 0; index < workspaceIds.length; index += 1) {
    const previous = index === 0
      ? input.afterWorkspaceId
      : workspaceIds[index - 1]!;
    if (previous !== null && workspaceIds[index]!.localeCompare(previous) <= 0) {
      workerError("invalid_input");
    }
  }
  return {
    workspaceIds,
    nextAfterWorkspaceId: workspaceIds.length === input.limit
      ? workspaceIds.at(-1) ?? null
      : null,
  };
}

/** Dedicated least-privilege app_worker pool; rendering stays outside SQL. */
export function createOfferIssuanceDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): OfferIssuanceDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;
  const database: OfferIssuanceDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimOfferIssuance(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeOfferIssuanceSuccess(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeOfferIssuanceFailure(tx, input)),
  };
  return {
    database,
    listRecoveryWorkspaces: (input) => listRecoveryWorkspaces(pool, input),
    requeueDue: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      recoverDueOfferIssuances(tx, input)),
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
