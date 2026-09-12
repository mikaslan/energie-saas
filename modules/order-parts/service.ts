// F7-12 Order Parts (Katalog F7.8, erste Hälfte): Nachbestellungen mit
// Message-Thread je Zeile. Zeilen-Referenz wird fail-closed gegen den
// gebundenen Current-Snapshot geprüft. Berechtigung: Wiederverwendung
// installation.read/write (KEINE neuen Permission-Keys — F13-01-Präzedenz).
// Modul ist server-only (Muster modules/file-requests/service.ts).
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { validateOfferVariantSnapshot } from "@/lib/integrations/offers/contract";
import { InstallationNotFoundError } from "@/modules/installations";

export class OrderPartNotFoundError extends Error {
  constructor(public readonly orderPartId: string) {
    super(`order part not found: ${orderPartId}`);
    this.name = "OrderPartNotFoundError";
  }
}

export class OrderPartValidationError extends Error {
  constructor(message = "order part validation failed") {
    super(message);
    this.name = "OrderPartValidationError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const orderPartStatuses = ["open", "ordered", "delivered", "cancelled"] as const;
export type OrderPartStatus = (typeof orderPartStatuses)[number];

const nextStatuses: Record<OrderPartStatus, readonly OrderPartStatus[]> = {
  open: ["ordered", "cancelled"],
  ordered: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

const requestOrderPartCommandSchema = z.strictObject({
  installationId: uuidSchema,
  lineDomainId: z.string().trim().min(1).max(120),
  quantityUnits: z.int().safe().min(1).max(1_000_000),
  note: z.string().trim().min(1).max(500).nullable().optional(),
});

const postMessageCommandSchema = z.strictObject({
  id: uuidSchema,
  body: z.string().trim().min(1).max(2000),
});

const setStatusCommandSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(orderPartStatuses),
});

export type OrderPartMessageDto = {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
};

export type OrderPartDto = {
  id: string;
  installationId: string;
  lineDomainId: string;
  lineLabel: string;
  quantityUnits: number;
  note: string | null;
  status: OrderPartStatus;
  createdAt: string;
  updatedAt: string;
  messages: OrderPartMessageDto[];
  permissions: { canWrite: boolean };
};

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "installation", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "installation", undefined, ctx.actor);
  }
}

type SnapshotLine = {
  lineDomainId: string;
  isHidden: boolean;
  quantityMilli: number;
  product: { kind: string; displayName?: string };
};

/**
 * Gebundene Variante + sichtbare Snapshot-Zeilen (Stückliste ohne Preise
 * genügt nicht — die Referenzprüfung braucht Domain-IDs).
 */
async function boundSnapshotLines(
  tx: TenantTx,
  ctx: ServiceCtx,
  installationId: string,
): Promise<{ installationDbId: string; lines: SnapshotLine[] } | null> {
  const installation = await tx.execute<{
    id: string; offer_id: string | null; variant_id: string | null;
  }>(sql`
    select id, offer_id, variant_id
      from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${installationId}::uuid
     limit 1
  `);
  const row = installation.rows[0];
  if (!row) {
    throw new InstallationNotFoundError(installationId);
  }
  // Lesend tolerant: ohne gebundene Variante gibt es keine Zeilen
  // (Schreiben bleibt strikt, siehe requestOrderPart).
  if (!row.offer_id || !row.variant_id) {
    return null;
  }
  const revision = await tx.execute<{ revision_snapshot: unknown }>(sql`
    select revision.revision_snapshot
      from offer_variant as variant
      join offer_variant_revision as revision
        on revision.workspace_id = variant.workspace_id
       and revision.offer_id = variant.offer_id
       and revision.variant_id = variant.id
       and revision.revision = variant.current_revision
     where variant.workspace_id = ${ctx.workspaceId}::uuid
       and variant.offer_id = ${row.offer_id}::uuid
       and variant.id = ${row.variant_id}::uuid
     limit 1
  `);
  const hit = revision.rows[0];
  if (!hit) throw new InstallationNotFoundError(installationId);
  const validated = validateOfferVariantSnapshot(hit.revision_snapshot);
  if (!validated.ok) throw new OrderPartValidationError("bound variant snapshot invalid");
  const lines = validated.value.sections.flatMap((section) => section.lines.map((line) => ({
    lineDomainId: line.lineDomainId,
    isHidden: line.isHidden,
    quantityMilli: line.quantityMilli,
    product: {
      kind: line.product.kind,
      displayName: line.product.kind === "catalog" || line.product.kind === "custom"
        ? line.product.displayName
        : undefined,
    },
  })));
  return { installationDbId: row.id, lines };
}

type OrderPartRow = {
  id: string;
  installation_id: string;
  line_domain_id: string;
  quantity_milli: number;
  note: string | null;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type OrderPartMessageRow = {
  id: string;
  order_part_id: string;
  author_id: string;
  body: string;
  created_at: string | Date;
};

function toDto(
  row: OrderPartRow,
  lineLabel: string,
  messages: OrderPartMessageDto[],
  canWrite: boolean,
): OrderPartDto {
  if (!orderPartStatuses.includes(row.status as OrderPartStatus)) {
    throw new OrderPartValidationError();
  }
  if (!Number.isSafeInteger(row.quantity_milli) || row.quantity_milli < 1000) {
    throw new OrderPartValidationError();
  }
  return {
    id: row.id,
    installationId: row.installation_id,
    lineDomainId: row.line_domain_id,
    lineLabel,
    quantityUnits: row.quantity_milli / 1000,
    note: row.note,
    status: row.status as OrderPartStatus,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    messages,
    permissions: { canWrite },
  };
}

async function readMessages(
  tx: TenantTx,
  ctx: ServiceCtx,
  orderPartId: string,
): Promise<OrderPartMessageDto[]> {
  const rows = await tx.execute<OrderPartMessageRow>(sql`
    select id, order_part_id, author_id, body, created_at
      from order_part_message
     where workspace_id = ${ctx.workspaceId}::uuid
       and order_part_id = ${orderPartId}::uuid
     order by created_at, id
  `);
  return rows.rows.map((message) => ({
    id: message.id,
    authorId: message.author_id,
    body: message.body,
    createdAt: new Date(message.created_at).toISOString(),
  }));
}

async function lineLabelFor(
  lines: SnapshotLine[],
  lineDomainId: string,
): Promise<string> {
  const line = lines.find((entry) => entry.lineDomainId === lineDomainId);
  if (!line || line.isHidden) throw new OrderPartNotFoundError(lineDomainId);
  return line.product.displayName ?? lineDomainId;
}

export async function requestOrderPart(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { installationId: string; lineDomainId: string; quantityUnits: number; note?: string | null },
): Promise<OrderPartDto> {
  requireWrite(ctx);
  const parsed = requestOrderPartCommandSchema.safeParse(input);
  if (!parsed.success) throw new OrderPartValidationError();
  const bound = await boundSnapshotLines(tx, ctx, parsed.data.installationId);
  if (!bound) throw new InstallationNotFoundError(parsed.data.installationId);
  const label = await lineLabelFor(bound.lines, parsed.data.lineDomainId);
  const inserted = await tx.execute<OrderPartRow>(sql`
    insert into order_part (
      workspace_id, installation_id, line_domain_id, quantity_milli, note, created_by
    ) values (
      ${ctx.workspaceId}::uuid,
      ${parsed.data.installationId}::uuid,
      ${parsed.data.lineDomainId},
      ${parsed.data.quantityUnits * 1000},
      ${parsed.data.note ?? null},
      ${ctx.actor}::uuid
    )
    returning id, installation_id, line_domain_id, quantity_milli, note,
              status, created_at, updated_at
  `);
  const created = inserted.rows[0];
  if (!created) throw new OrderPartValidationError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "order_part",
    aggregateId: created.id,
    eventType: "order_part.requested",
    actor: ctx.actor,
    payload: { installationId: parsed.data.installationId, lineDomainId: parsed.data.lineDomainId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "order_part.request",
    resource: "order_part",
    allowed: true,
    details: { installationId: parsed.data.installationId, lineDomainId: parsed.data.lineDomainId },
  });
  return toDto(created, label, [], true);
}

export async function listOrderParts(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { installationId: string },
): Promise<OrderPartDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ installationId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new OrderPartValidationError();
  const bound = await boundSnapshotLines(tx, ctx, parsed.data.installationId);
  if (!bound) return [];
  const { lines } = bound;
  const canWrite = can(ctx, "installation.write");
  const rows = await tx.execute<OrderPartRow>(sql`
    select id, installation_id, line_domain_id, quantity_milli, note,
           status, created_at, updated_at
      from order_part
     where workspace_id = ${ctx.workspaceId}::uuid
       and installation_id = ${parsed.data.installationId}::uuid
     order by created_at, id
  `);
  return Promise.all(rows.rows.map(async (row) => toDto(
    row,
    await lineLabelFor(lines, row.line_domain_id),
    await readMessages(tx, ctx, row.id),
    canWrite,
  )));
}

export async function postOrderPartMessage(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; body: string },
): Promise<OrderPartMessageDto> {
  requireWrite(ctx);
  const parsed = postMessageCommandSchema.safeParse(input);
  if (!parsed.success) throw new OrderPartValidationError();
  const part = await tx.execute<{ id: string }>(sql`
    select id from order_part
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
     limit 1
  `);
  if (!part.rows[0]) throw new OrderPartNotFoundError(parsed.data.id);
  const inserted = await tx.execute<OrderPartMessageRow>(sql`
    insert into order_part_message (workspace_id, order_part_id, author_id, body)
    values (
      ${ctx.workspaceId}::uuid,
      ${parsed.data.id}::uuid,
      ${ctx.actor}::uuid,
      ${parsed.data.body}
    )
    returning id, order_part_id, author_id, body, created_at
  `);
  const created = inserted.rows[0];
  if (!created) throw new OrderPartValidationError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "order_part",
    aggregateId: created.order_part_id,
    eventType: "order_part.message_posted",
    actor: ctx.actor,
    payload: { messageId: created.id },
  });
  return {
    id: created.id,
    authorId: created.author_id,
    body: created.body,
    createdAt: new Date(created.created_at).toISOString(),
  };
}

export async function setOrderPartStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; status: OrderPartStatus },
): Promise<OrderPartDto> {
  requireWrite(ctx);
  const parsed = setStatusCommandSchema.safeParse(input);
  if (!parsed.success) throw new OrderPartValidationError();
  const current = await tx.execute<{ status: string; installation_id: string }>(sql`
    select status, installation_id from order_part
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
     limit 1
  `);
  const row = current.rows[0];
  if (!row) throw new OrderPartNotFoundError(parsed.data.id);
  if (!orderPartStatuses.includes(row.status as OrderPartStatus)) {
    throw new OrderPartValidationError();
  }
  if (!nextStatuses[row.status as OrderPartStatus].includes(parsed.data.status)) {
    throw new OrderPartValidationError("illegal status transition");
  }
  const updated = await tx.execute<OrderPartRow>(sql`
    update order_part
       set status = ${parsed.data.status},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
       and status = ${row.status}
    returning id, installation_id, line_domain_id, quantity_milli, note,
              status, created_at, updated_at
  `);
  const next = updated.rows[0];
  if (!next) throw new OrderPartValidationError("concurrent status change");
  const bound = await boundSnapshotLines(tx, ctx, next.installation_id);
  if (!bound) throw new InstallationNotFoundError(next.installation_id);
  const { lines } = bound;
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "order_part",
    aggregateId: next.id,
    eventType: "order_part.status_changed",
    actor: ctx.actor,
    payload: { status: parsed.data.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "order_part.set_status",
    resource: "order_part",
    allowed: true,
    details: { orderPartId: next.id, status: parsed.data.status },
  });
  return toDto(
    next,
    await lineLabelFor(lines, next.line_domain_id),
    await readMessages(tx, ctx, next.id),
    true,
  );
}
