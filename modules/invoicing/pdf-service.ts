import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { TenantTx } from "@/lib/db/types";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  buildInvoicePdfInput,
  hashInvoicePdfInput,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";

const renderCommandSchema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION),
  documentId: z.string().uuid(),
});

export type RequestInvoicePdfInputCommand = z.infer<typeof renderCommandSchema>;

export interface RequestInvoicePdfInputResult {
  jobId: string;
  inputSha256Hex: string;
  status: "requested";
}

function requireInvoicingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError(
      "invoicing.write",
      "commercial_document_render_job",
      undefined,
      ctx.actor,
    );
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// M3-02c: pgboss-Dispatch mit Test-Skip (M2-02-Muster). Ohne pgboss in
// Nicht-Test-DBs fail-closed (Persistence), in Test-DBs still skip.
export async function enqueueInvoicePdfRenderDispatch(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const parsed = z.strictObject({ workspaceId: z.uuid(), jobId: z.uuid() })
    .safeParse({ workspaceId, jobId });
  if (!parsed.success) {
    throw new InvoicingValidationError();
  }
  const gate = await tx.execute<{
    dispatch_signature: string | null;
    current_role: string;
    session_role: string;
    database_name: string;
    [key: string]: unknown;
  }>(sql`
    select pg_catalog.to_regprocedure(
             'pgboss.enqueue_invoice_pdf_render(uuid,uuid)'
           )::text as dispatch_signature,
           current_user::text as current_role,
           session_user::text as session_role,
           pg_catalog.current_database()::text as database_name
  `);
  const row = gate.rows[0];
  if (!row?.dispatch_signature) {
    const explicitTestSkip = row !== undefined
      && row.current_role === row.session_role
      && (row.current_role === "app_test" || row.current_role === "app_ci")
      && row.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new InvoicingIntegrityError();
  }
  await tx.execute(sql`
    select pgboss.enqueue_invoice_pdf_render(
      ${workspaceId}::uuid,
      ${jobId}::uuid
    )
  `);
}

type DocumentRow = {
  id: string;
  type: string;
  status: string;
  number: string | null;
  number_year: number | null;
  number_sequence: number | null;
  issued_at: Date | string | null;
  invoice_kind: string | null;
  credit_note_type: string | null;
  // Roh-SQL liefert bigint als String (Probe 2026-09-17); Coercion unten.
  net_cents: number | string;
  tax_cents: number | string;
  gross_cents: number | string;
  due_date: string | null;
  delivery_date: string | null;
  planned_service_date: string | null;
  skonto_percent_bps: number | null;
  skonto_days: number | null;
  recipient_snapshot: unknown;
};

type LineRow = {
  position: number;
  name: string;
  quantity_milli: number;
  unit: string;
  net_cents: number | string;
  tax_cents: number | string;
  gross_cents: number | string;
  tax_rate_bps: number;
};

type SettingsRow = {
  company_name: string;
  company_email: string;
  company_authority: string | null;
  company_register_number: string | null;
  company_tax_id: string | null;
  company_address_line1: string;
  company_address_line2: string | null;
  company_postal_code: string;
  company_city: string;
  company_country: string;
  payment_account_holder: string | null;
  payment_iban: string | null;
  payment_bic: string | null;
  revision: number;
};

function asIsoUtc(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new InvoicingIntegrityError();
  return new Date(time).toISOString();
}

function asMoneyCents(value: number | string): number {
  const coerced = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(coerced) || coerced < 0) throw new InvoicingIntegrityError();
  return coerced;
}

export async function requestInvoicePdfInput(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: RequestInvoicePdfInputCommand,
): Promise<RequestInvoicePdfInputResult> {
  requireInvoicingWrite(ctx);
  const parsed = renderCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw new InvoicingValidationError();
  }
  const { documentId } = parsed.data;

  const documentRows = await tx.execute<DocumentRow>(sql`
    select id, type, status, number, number_year, number_sequence,
           issued_at, invoice_kind, credit_note_type,
           net_cents, tax_cents, gross_cents,
           due_date::text as due_date,
           delivery_date::text as delivery_date,
           planned_service_date::text as planned_service_date,
           skonto_percent_bps, skonto_days, recipient_snapshot
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${documentId}::uuid
  `);
  const document = documentRows.rows[0];
  if (!document) throw new InvoicingNotFoundError();
  if (
    (document.type !== "invoice" && document.type !== "credit_note")
    || document.status !== "issued"
    || document.number === null
    || document.number_year === null
    || document.number_sequence === null
    || document.issued_at === null
    || document.recipient_snapshot === null
  ) {
    throw new InvoicingValidationError();
  }

  const lineRows = await tx.execute<LineRow>(sql`
    select position, name, quantity_milli, unit,
           net_cents, tax_cents, gross_cents, tax_rate_bps
      from commercial_document_line
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
     order by position asc
  `);
  if (lineRows.rows.length === 0) {
    throw new InvoicingValidationError();
  }

  const settingsRows = await tx.execute<SettingsRow>(sql`
    select company_name, company_email, company_authority,
           company_register_number, company_tax_id,
           company_address_line1, company_address_line2,
           company_postal_code, company_city, company_country,
           payment_account_holder, payment_iban, payment_bic, revision
      from workspace_invoicing_settings
     where workspace_id = ${ctx.workspaceId}::uuid
  `);
  const settings = settingsRows.rows[0];
  if (!settings) {
    throw new InvoicingValidationError();
  }

  const preparedRows = await tx.execute<{ now: Date }>(sql`
    select pg_catalog.transaction_timestamp() as now
  `);
  const preparedNow = preparedRows.rows[0]?.now;
  if (!preparedNow) throw new InvoicingIntegrityError();
  const preparedAt = asIsoUtc(preparedNow);

  const built = buildInvoicePdfInput({
    document: {
      type: document.type,
      invoiceKind: document.invoice_kind,
      creditNoteType: document.credit_note_type,
      number: document.number,
      numberYear: document.number_year,
      numberSequence: document.number_sequence,
      issuedAt: asIsoUtc(document.issued_at),
      dueDate: document.due_date,
      // Leistungsdatum: Ist-Datum, sonst geplantes Leistungsdatum.
      serviceDate: document.delivery_date ?? document.planned_service_date,
      skontoPercentBps: document.skonto_percent_bps,
      skontoDays: document.skonto_days,
    },
    recipient: document.recipient_snapshot,
    sender: {
      companyName: settings.company_name,
      companyEmail: settings.company_email,
      companyAuthority: settings.company_authority,
      companyRegisterNumber: settings.company_register_number,
      companyTaxId: settings.company_tax_id,
      companyAddressLine1: settings.company_address_line1,
      companyAddressLine2: settings.company_address_line2,
      companyPostalCode: settings.company_postal_code,
      companyCity: settings.company_city,
      companyCountry: settings.company_country,
      paymentAccountHolder: settings.payment_account_holder,
      paymentIban: settings.payment_iban,
      paymentBic: settings.payment_bic,
      settingsRevision: settings.revision,
    },
    lines: lineRows.rows.map((line) => ({
      position: line.position,
      title: line.name,
      quantityMilli: line.quantity_milli,
      unit: line.unit,
      netCents: asMoneyCents(line.net_cents),
      taxCents: asMoneyCents(line.tax_cents),
      grossCents: asMoneyCents(line.gross_cents),
      taxRateBps: line.tax_rate_bps,
    })),
    headTotals: {
      netCents: asMoneyCents(document.net_cents),
      taxCents: asMoneyCents(document.tax_cents),
      grossCents: asMoneyCents(document.gross_cents),
    },
    preparedAt,
  });
  if (!built.ok) {
    throw new InvoicingValidationError();
  }
  const input = built.value;
  let inputSha256Hex: string;
  try {
    inputSha256Hex = hashInvoicePdfInput(input);
  } catch {
    throw new InvoicingIntegrityError();
  }

  const jobId = randomUUID();
  try {
    // Status faellt bewusst weg: DEFAULT 'requested' (M2-02-Spiegel —
    // Runtime hat nur Spalten-INSERT ohne Status).
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into commercial_document_render_job (
        id, workspace_id, document_id, input_json, input_sha256,
        template_version, renderer_recipe, created_by
      ) values (
        ${jobId}::uuid, ${ctx.workspaceId}::uuid, ${documentId}::uuid,
        ${JSON.stringify(input)}::jsonb, decode(${inputSha256Hex}, 'hex'),
        ${INVOICE_PDF_TEMPLATE_VERSION}, ${INVOICE_PDF_RENDERER_RECIPE_VERSION},
        ${ctx.actor}::uuid
      )
      on conflict (workspace_id, document_id, template_version, renderer_recipe)
      do nothing
      returning id
    `);
    const row = inserted.rows[0];
    if (row) {
      await enqueueInvoicePdfRenderDispatch(tx, ctx.workspaceId, row.id);
      return { jobId: row.id, inputSha256Hex, status: "requested" };
    }
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      // Race unterhalb der WITH-CHECK-Sichtbarkeit: Replay lesen.
    } else {
      throw error;
    }
  }
  // Replay: existierenden versiegelten Job lesen + Hash rueckpruefen.
  const existing = await tx.execute<{ id: string; input_json: unknown; hex: string; status: string }>(sql`
    select id, input_json, encode(input_sha256, 'hex') as hex, status
      from commercial_document_render_job
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and template_version = ${INVOICE_PDF_TEMPLATE_VERSION}
       and renderer_recipe = ${INVOICE_PDF_RENDERER_RECIPE_VERSION}
  `);
  const found = existing.rows[0];
  if (!found) {
    throw new InvoicingIntegrityError();
  }
  let replayHash: string;
  try {
    replayHash = hashInvoicePdfInput(found.input_json);
  } catch {
    throw new InvoicingIntegrityError();
  }
  if (replayHash !== found.hex) {
    throw new InvoicingIntegrityError();
  }
  // M3-02c: Dispatch-Reparatur fuer nicht-terminale Jobs (M2-02-Muster).
  if (found.status !== "succeeded" && found.status !== "failed_final") {
    await enqueueInvoicePdfRenderDispatch(tx, ctx.workspaceId, found.id);
  }
  return { jobId: found.id, inputSha256Hex: found.hex, status: "requested" };
}

export class InvoicePdfValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("invoice PDF request is invalid");
    this.name = "InvoicePdfValidationError";
  }
}

export class InvoicePdfNotFoundError extends Error {
  constructor() {
    super("invoice PDF job was not found");
    this.name = "InvoicePdfNotFoundError";
  }
}

export class InvoicePdfIntegrityError extends Error {
  constructor() {
    super("invoice PDF stored data is corrupt");
    this.name = "InvoicePdfIntegrityError";
  }
}

const MAX_INVOICE_PDF_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
// Das Nummernformat ist workspace-konfigurierbar (kein gepinntes Muster wie
// ANG-…); der Service verlangt sane, dateinamenfaehigen Text, die Route
// bleibt fail-closed Gate ueber das generische Safe-Pattern.
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const documentKeySchema = z.strictObject({
  workspaceId: z.uuid(),
  documentId: z.uuid(),
});

const jobKeySchema = documentKeySchema.extend({
  jobId: z.uuid(),
});

const stateSchema = z.enum([
  "requested",
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed_final",
]);

export type InvoicePdfState = z.infer<typeof stateSchema>;

export type InvoicePdfStatusResult = {
  jobId: string;
  documentId: string;
  state: InvoicePdfState;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  canDownload: boolean;
};

export type InvoicePdfArtifactResult = {
  jobId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
};

type StoredJobRow = {
  id: string;
  workspace_id: string;
  document_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | string;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error_code: string | null;
  [key: string]: unknown;
};

type ArtifactRow = {
  id: string;
  document_id: string;
  document_number: string | null;
  status: string;
  artifact_mime_type: string | null;
  artifact_sha256_hex: string | null;
  artifact_size_bytes: number | null;
  artifact_bytes: unknown;
  [key: string]: unknown;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

function parseKey<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvoicePdfValidationError(issuePaths(parsed.error));
  return parsed.data;
}

function requireReadAccess(ctx: ServiceCtx, action: Action, resource: string): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      action,
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function requireSameWorkspace(ctx: ServiceCtx, workspaceId: string): void {
  if (workspaceId !== ctx.workspaceId) throw new InvoicePdfNotFoundError();
}

function asIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new InvoicePdfIntegrityError();
  return parsed.toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : asIso(value);
}

function parseState(value: unknown): InvoicePdfState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new InvoicePdfIntegrityError();
  return parsed.data;
}

function safeErrorCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,79}$/u.test(value)) {
    throw new InvoicePdfIntegrityError();
  }
  return value;
}

function statusResult(row: StoredJobRow): InvoicePdfStatusResult {
  const state = parseState(row.status);
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > 3) {
    throw new InvoicePdfIntegrityError();
  }
  return {
    jobId: row.id,
    documentId: row.document_id,
    state,
    attemptCount: row.attempt_count,
    nextAttemptAt: asIso(row.next_attempt_at),
    createdAt: asIso(row.created_at),
    startedAt: optionalIso(row.started_at),
    finishedAt: optionalIso(row.finished_at),
    errorCode: safeErrorCode(row.error_code),
    canDownload: state === "succeeded",
  };
}

export async function listInvoicePdfs(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<InvoicePdfStatusResult[]> {
  requireReadAccess(ctx, "invoicing.write", "commercial_document_render_job");
  const key = parseKey(documentKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const exists = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from commercial_document
     where workspace_id = ${key.workspaceId}::uuid
       and id = ${key.documentId}::uuid
     limit 1
  `);
  if (exists.rows.length !== 1) throw new InvoicePdfNotFoundError();
  const result = await tx.execute<StoredJobRow>(sql`
    select id, workspace_id, document_id, status, attempt_count,
           next_attempt_at, created_at, started_at, finished_at, error_code
      from commercial_document_render_job
     where workspace_id = ${key.workspaceId}::uuid
       and document_id = ${key.documentId}::uuid
     order by created_at desc, id desc
  `);
  return result.rows.map(statusResult);
}

export async function getInvoicePdfStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<InvoicePdfStatusResult> {
  requireReadAccess(ctx, "invoicing.write", "commercial_document_render_job");
  const key = parseKey(jobKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const result = await tx.execute<StoredJobRow>(sql`
    select id, workspace_id, document_id, status, attempt_count,
           next_attempt_at, created_at, started_at, finished_at, error_code
      from commercial_document_render_job
     where workspace_id = ${key.workspaceId}::uuid
       and document_id = ${key.documentId}::uuid
       and id = ${key.jobId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) throw new InvoicePdfNotFoundError();
  return statusResult(row);
}

export async function readInvoicePdfArtifact(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<InvoicePdfArtifactResult> {
  requireReadAccess(ctx, "invoicing.issuing_details.write", "invoice_pdf_artifact");
  const key = parseKey(jobKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const result = await tx.execute<ArtifactRow>(sql`
    select job.id, job.document_id, document.number as document_number,
           job.status, job.artifact_mime_type,
           encode(job.artifact_sha256, 'hex') as artifact_sha256_hex,
           job.artifact_size_bytes, job.artifact_bytes
      from commercial_document_render_job job
      join commercial_document document
        on document.workspace_id = job.workspace_id
       and document.id = job.document_id
     where job.workspace_id = ${key.workspaceId}::uuid
       and job.document_id = ${key.documentId}::uuid
       and job.id = ${key.jobId}::uuid
       and job.status = 'succeeded'
     limit 1
  `);
  const row = result.rows[0];
  if (!row) throw new InvoicePdfNotFoundError();
  if (
    row.status !== "succeeded"
    || row.artifact_mime_type !== "application/pdf"
    || typeof row.artifact_sha256_hex !== "string"
    || !SHA256_PATTERN.test(row.artifact_sha256_hex)
    || !Number.isSafeInteger(row.artifact_size_bytes)
    || (row.artifact_size_bytes as number) < 100
    || (row.artifact_size_bytes as number) > MAX_INVOICE_PDF_ARTIFACT_BYTES
    || !Buffer.isBuffer(row.artifact_bytes)
    || row.artifact_bytes.length !== row.artifact_size_bytes
    || typeof row.document_number !== "string"
    || !DOCUMENT_NUMBER_PATTERN.test(row.document_number)
  ) throw new InvoicePdfIntegrityError();
  const actual = createHash("sha256").update(row.artifact_bytes).digest();
  const expected = Buffer.from(row.artifact_sha256_hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvoicePdfIntegrityError();
  }
  return {
    jobId: row.id,
    documentId: row.document_id,
    filename: `${row.document_number}.pdf`,
    mimeType: "application/pdf",
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
    bytes: Buffer.from(row.artifact_bytes),
  };
}
