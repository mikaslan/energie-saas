import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  INVOICE_PAYMENT_RENDERER_RECIPE_VERSION,
  INVOICE_PAYMENT_TEMPLATE_VERSION,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  InvoicingConflictError,
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";

// Re-Export für die Fehlerabbildung in delivery-actions.ts (Spiegel des
// Barrel-Imports in pdf-actions.ts; Barrel-Export ist Owner-TODO).
export {
  InvoicingConflictError,
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";

// F8-19: Versand-Nachweis (Spiegel requestInvoicePdfInput/markSentDocument).
// v1 nur manueller/externer Versand (DECIDED — `email`/`post` reserviert
// fuer einen Transport-Slice). Sent bleibt boolesche Achse (M301-03):
// Status bleibt `issued`, `sent_at` markiert den Versand.
export const COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION =
  "commercial-document-delivery-command.v1" as const;
export const DELIVERY_CHANNELS = ["manual"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

const deliveryCommandSchema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION),
  documentId: z.string().uuid(),
  channel: z.literal("manual"),
});

export type MarkSentWithDeliveryCommand = z.infer<typeof deliveryCommandSchema>;

export interface MarkSentWithDeliveryResult {
  documentId: string;
  type: string;
  channel: DeliveryChannel;
  sentAt: string;
  invoiceJobId: string;
  invoiceArtifactSha256: string;
  paymentJobId: string | null;
  paymentArtifactSha256: string | null;
}

export interface DocumentDeliveryRecord {
  documentId: string;
  channel: DeliveryChannel;
  sentAt: string;
  sentBy: string;
  invoiceJobId: string;
  invoiceArtifactSha256: string;
  paymentJobId: string | null;
  paymentArtifactSha256: string | null;
}

const deliveryKeySchema = z.strictObject({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function requireInvoicingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError(
      "invoicing.write",
      "commercial_document_delivery",
      undefined,
      ctx.actor,
    );
  }
}

function requireDeliveryRead(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError(
      "invoicing.write",
      "commercial_document_delivery",
      undefined,
      ctx.actor,
    );
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "invoicing.write",
      "commercial_document_delivery",
      "external_only_without_assignment",
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

function asArtifactSha(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new InvoicingIntegrityError();
  }
  return value;
}

type DeliveryDocumentRow = {
  id: string;
  type: string;
  status: string;
  sent_at: Date | string | null;
  gross_cents: number | string;
  paid_cents: number | string;
};

type DeliveryJobRow = {
  id: string;
  artifact_sha256_hex: string | null;
};

type DeliveryRow = {
  document_id: string;
  channel: string;
  sent_at: Date | string;
  sent_by: string;
  invoice_job_id: string;
  invoice_sha: string | null;
  payment_job_id: string | null;
  payment_sha: string | null;
};

async function readSucceededJobArtifact(
  tx: TenantTx,
  workspaceId: string,
  documentId: string,
  templateVersion: string,
  rendererRecipe: string,
): Promise<{ jobId: string; sha256: string } | null> {
  const rows = await tx.execute<DeliveryJobRow>(sql`
    select id, encode(artifact_sha256, 'hex') as artifact_sha256_hex
      from commercial_document_render_job
     where workspace_id = ${workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and template_version = ${templateVersion}
       and renderer_recipe = ${rendererRecipe}
       and status = 'succeeded'
     limit 1
  `);
  const job = rows.rows[0];
  if (!job) return null;
  return { jobId: job.id, sha256: asArtifactSha(job.artifact_sha256_hex) };
}

export async function markSentWithDelivery(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: MarkSentWithDeliveryCommand,
): Promise<MarkSentWithDeliveryResult> {
  requireInvoicingWrite(ctx);
  const parsed = deliveryCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw new InvoicingValidationError();
  }
  const { documentId, channel } = parsed.data;

  const documentRows = await tx.execute<DeliveryDocumentRow>(sql`
    select id, type, status, sent_at, gross_cents, paid_cents
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${documentId}::uuid
  `);
  const document = documentRows.rows[0];
  if (!document) throw new InvoicingNotFoundError();
  // Gating: nur `issued` + `sent_at NULL` (kein stilles Re-Senden).
  // Status-Fehlgebrauch ist Zustandskonflikt (markSentDocument-Spiegel),
  // kein Eingabefehler.
  if (document.status !== "issued" || document.sent_at !== null) {
    throw new InvoicingConflictError();
  }

  // Kein Versand ohne unveraenderliche Bytes (DECIDED): mindestens ein
  // `succeeded`-Rechnungs-PDF-Job ist Pflicht.
  const invoiceJob = await readSucceededJobArtifact(
    tx,
    ctx.workspaceId,
    documentId,
    INVOICE_PDF_TEMPLATE_VERSION,
    INVOICE_PDF_RENDERER_RECIPE_VERSION,
  );
  if (!invoiceJob) {
    throw new InvoicingConflictError();
  }

  // Zahlungs-Job nur bei offenem Rest > 0 auf Rechnungen und nur wenn ein
  // `succeeded`-Beleg vorhanden ist (DECIDED — sonst Rechnung-ohne-Beleg).
  const openCents = asMoneyCents(document.gross_cents) - asMoneyCents(document.paid_cents);
  // Korrupter Stand (mehr bezahlt als brutto): kein stiller Versand ohne
  // Beleg — Integritaet statt Heuristik.
  if (openCents < 0) throw new InvoicingIntegrityError();
  const paymentJob = document.type === "invoice" && openCents > 0
    ? await readSucceededJobArtifact(
      tx,
      ctx.workspaceId,
      documentId,
      INVOICE_PAYMENT_TEMPLATE_VERSION,
      INVOICE_PAYMENT_RENDERER_RECIPE_VERSION,
    )
    : null;

  // Atomares Sent-Gate gegen parallele Versandversuche: nur die erste
  // Transaktion sieht `issued` + `sent_at NULL`.
  const updated = await tx.execute<{ sent_at: Date | string }>(sql`
    update commercial_document
       set sent_at = statement_timestamp(), updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${documentId}::uuid
       and status = 'issued'
       and sent_at is null
     returning sent_at
  `);
  const sentAtRow = updated.rows[0];
  if (!sentAtRow) throw new InvoicingConflictError();
  const sentAt = asIsoUtc(sentAtRow.sent_at);

  // Append-only Delivery-Zeile: UNIQUE (workspace_id, document_id) faengt
  // den Rest paralleler Versuche als `conflict` (kein Update-Pfad).
  try {
    await tx.execute(sql`
      insert into commercial_document_delivery (
        workspace_id, document_id, channel,
        invoice_job_id, invoice_artifact_sha256,
        payment_job_id, payment_artifact_sha256,
        sent_by, sent_at
      ) values (
        ${ctx.workspaceId}::uuid, ${documentId}::uuid, ${channel},
        ${invoiceJob.jobId}::uuid, decode(${invoiceJob.sha256}, 'hex'),
        ${paymentJob?.jobId ?? null}::uuid,
        ${paymentJob ? sql`decode(${paymentJob.sha256}, 'hex')` : sql`null`},
        ${ctx.actor}::uuid, ${sentAt}::timestamptz
      )
    `);
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      throw new InvoicingConflictError();
    }
    // 23503: Job-/Membership-Zeile parallel verschwunden (mikroskopisches
    // Fenster) — Zustandskonflikt, nie 500.
    if (postgresErrorCode(error) === "23503") {
      throw new InvoicingConflictError();
    }
    throw error;
  }

  const evidence = {
    documentId,
    channel,
    invoiceJobId: invoiceJob.jobId,
    paymentJobId: paymentJob?.jobId ?? null,
    invoiceArtifactSha256: invoiceJob.sha256,
    paymentArtifactSha256: paymentJob?.sha256 ?? null,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document",
    aggregateId: documentId,
    eventType: "commercial_document.sent",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "document.send",
    resource: "commercial_document",
    allowed: true,
    details: evidence,
  });

  return {
    documentId,
    type: document.type,
    channel,
    sentAt,
    invoiceJobId: invoiceJob.jobId,
    invoiceArtifactSha256: invoiceJob.sha256,
    paymentJobId: paymentJob?.jobId ?? null,
    paymentArtifactSha256: paymentJob?.sha256 ?? null,
  };
}

export async function getDocumentDelivery(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<DocumentDeliveryRecord | null> {
  // DECIDED: Write-Schranke (RLS-SELECT verlangt sie seit 0193/P1-1).
  // Viewer/External fail-closed, 404 ohne Orakel.
  requireDeliveryRead(ctx);
  const parsed = deliveryKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new InvoicingValidationError();
  }
  const { workspaceId, documentId } = parsed.data;
  if (workspaceId !== ctx.workspaceId) throw new InvoicingNotFoundError();

  const exists = await tx.execute<{ id: string }>(sql`
    select id
      from commercial_document
     where workspace_id = ${workspaceId}::uuid
       and id = ${documentId}::uuid
     limit 1
  `);
  if (exists.rows.length !== 1) throw new InvoicingNotFoundError();

  const rows = await tx.execute<DeliveryRow>(sql`
    select document_id, channel, sent_at, sent_by,
           invoice_job_id,
           encode(invoice_artifact_sha256, 'hex') as invoice_sha,
           payment_job_id,
           encode(payment_artifact_sha256, 'hex') as payment_sha
      from commercial_document_delivery
     where workspace_id = ${workspaceId}::uuid
       and document_id = ${documentId}::uuid
     limit 1
  `);
  const row = rows.rows[0];
  if (!row) return null;

  if (row.channel !== "manual") throw new InvoicingIntegrityError();
  if (row.document_id !== documentId) throw new InvoicingIntegrityError();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (!uuidPattern.test(row.sent_by) || !uuidPattern.test(row.invoice_job_id)) {
    throw new InvoicingIntegrityError();
  }
  if (
    (row.payment_job_id === null) !== (row.payment_sha === null)
    || (row.payment_job_id !== null && !uuidPattern.test(row.payment_job_id))
  ) {
    throw new InvoicingIntegrityError();
  }
  return {
    documentId: row.document_id,
    channel: "manual",
    sentAt: asIsoUtc(row.sent_at),
    sentBy: row.sent_by,
    invoiceJobId: row.invoice_job_id,
    invoiceArtifactSha256: asArtifactSha(row.invoice_sha),
    paymentJobId: row.payment_job_id,
    paymentArtifactSha256: row.payment_sha === null ? null : asArtifactSha(row.payment_sha),
  };
}
