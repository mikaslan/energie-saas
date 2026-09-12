// F8-05 Teilrechnungen zum Auftrag (Modi percent/lines, ESTIMATE).
//
// Kette AB (order_confirmation) → Teilrechnung (invoice, gleiche Serie).
// Caps (Brutto, stornierte befreien Budget) und Folgenummer unter
// AB-Zeilensperre (kein Race, kein Revision-CAS — Erstanlage).
// Brutto-Cap wird NACH Zeilenanlage gegen zurückgelesene Summen geprüft:
// Ein Bruch wirft in derselben Transaktion (voller Rollback, keine
// doppelte Rundungslogik). Berechtigung: invoicing.read/write (KEIN
// neuer Key). Events/Audit nur IDs + Modus/Folge.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_SCHEME_TRANCHES_BPS,
  commercialDocumentLineInputV1Schema,
  commercialDocumentPartialCommandV1Schema,
  type CommercialDocumentLineInputV1,
  type CommercialDocumentPartialCommandV1,
} from "@/lib/integrations/invoicing/contract";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";
import {
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";
import { createDocument, createDocumentLine } from "./service";

function requirePartialRead(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.read")) {
    throw new PermissionDeniedError("invoicing.read", "commercial_document_partial", undefined, ctx.actor);
  }
}

function requirePartialWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError("invoicing.write", "commercial_document_partial", undefined, ctx.actor);
  }
}

type OrderRow = {
  id: string;
  type: string;
  status: string;
  group_id: string | null;
  project_id: string | null;
  contact_id: string | null;
  name: string;
  number: string | null;
  net_cents: number | string;
  gross_cents: number | string;
  [key: string]: unknown;
};

type OrderLineRow = {
  id: string;
  position: number;
  name: string;
  quantity_milli: number | string;
  unit: string;
  net_cents: number | string;
  tax_cents: number | string;
  tax_rate_bps: number | string;
  [key: string]: unknown;
};

type ActivePartialRow = {
  partial_id: string;
  ordinal: number;
  mode: string;
  percent_bps: number | null;
  invoice_id: string;
  invoice_gross: number | string;
  [key: string]: unknown;
};

async function lockOrder(tx: TenantTx, ctx: ServiceCtx, orderId: string): Promise<OrderRow> {
  const found = await tx.execute<OrderRow>(sql`
    select id, type, status, group_id, project_id, contact_id, name, number,
           net_cents, gross_cents
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${orderId}::uuid
     for update
  `);
  const order = found.rows[0];
  // NotFound ohne Orakel (fremde/fehlende AB gleich).
  if (!order) throw new InvoicingNotFoundError();
  if (order.type !== "order_confirmation") throw new InvoicingValidationError();
  if (order.status === "voided") throw new InvoicingConflictError();
  return order;
}

async function readOrderLines(tx: TenantTx, ctx: ServiceCtx, orderId: string): Promise<OrderLineRow[]> {
  const lines = await tx.execute<OrderLineRow>(sql`
    select id, position, name, quantity_milli, unit, net_cents, tax_cents,
           tax_rate_bps
      from commercial_document_line
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${orderId}::uuid
     order by position asc
  `);
  return lines.rows;
}

async function readActivePartials(
  tx: TenantTx,
  ctx: ServiceCtx,
  orderId: string,
): Promise<{ partials: ActivePartialRow[]; consumedLineIds: string[] }> {
  const partials = await tx.execute<ActivePartialRow>(sql`
    select partial.id as partial_id, partial.ordinal, partial.mode,
           partial.percent_bps, invoice.id as invoice_id,
           invoice.gross_cents as invoice_gross
      from commercial_document_partial partial
      join commercial_document invoice
        on invoice.workspace_id = partial.workspace_id
       and invoice.id = partial.partial_invoice_id
       and invoice.status <> 'voided'
     where partial.workspace_id = ${ctx.workspaceId}::uuid
       and partial.source_order_id = ${orderId}::uuid
     order by partial.ordinal asc
  `);
  const activeIds = partials.rows.map((row) => row.partial_id);
  let consumedLineIds: string[] = [];
  if (activeIds.length > 0) {
    const consumed = await tx.execute<{ source_line_id: string }>(sql`
      select source_line_id
        from commercial_document_partial_line
       where workspace_id = ${ctx.workspaceId}::uuid
         and partial_id in (${sql.join(
           activeIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
    `);
    consumedLineIds = consumed.rows.map((row) => row.source_line_id);
  }
  return { partials: partials.rows, consumedLineIds };
}

function berlinDueDateIso(): string {
  const berlinToday = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
  );
  const dueDate = new Date(berlinToday.getTime() + 14 * 24 * 60 * 60 * 1000);
  return `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}-${String(dueDate.getDate()).padStart(2, "0")}`;
}

function partialPostgresCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function roundPercentCents(netCents: number, percentBps: number): number {
  // Kimi-P1-1-Analog: Produkt in BigInt (netCents * bps bis ~9e19),
  // kaufmännisch halb auf.
  const rounded = (BigInt(netCents) * BigInt(percentBps) + BigInt(5000)) / BigInt(10000);
  return Number(rounded);
}

async function readActiveBilledNet(
  tx: TenantTx,
  ctx: ServiceCtx,
  orderId: string,
  mode: "scheme" | null,
): Promise<number> {
  // Netto-Summe der AKTIVEN Teilrechnungen (optional nur ein Modus):
  // Basis für cent-exakte Rest-Beträge (Scheme-Endtranche, Closing).
  const modeFilter = mode === null
    ? sql`and partial.mode in ('percent', 'lines', 'scheme', 'closing', 'remainder', 'amount')`
    : sql`and partial.mode = ${mode}`;
  const result = await tx.execute<{ net: number | string }>(sql`
    select coalesce(sum(line.net_cents), 0) as net
      from commercial_document_partial partial
      join commercial_document invoice
        on invoice.workspace_id = partial.workspace_id
       and invoice.id = partial.partial_invoice_id
       and invoice.status <> 'voided'
      join commercial_document_line line
        on line.workspace_id = partial.workspace_id
       and line.document_id = invoice.id
     where partial.workspace_id = ${ctx.workspaceId}::uuid
       and partial.source_order_id = ${orderId}::uuid
       ${modeFilter}
  `);
  return Number(result.rows[0]?.net ?? 0);
}

export type CreatePartialInvoiceResult = {
  id: string;
  ordinal: number;
  mode: "percent" | "lines" | "scheme" | "closing" | "remainder" | "amount";
  grossCents: number;
};

export async function createPartialInvoice(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentPartialCommandV1,
): Promise<CreatePartialInvoiceResult> {
  requirePartialWrite(ctx);
  const parsed = commercialDocumentPartialCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const command = parsed.data;

  const order = await lockOrder(tx, ctx, command.orderId);
  const orderLines = await readOrderLines(tx, ctx, command.orderId);
  if (orderLines.length === 0) throw new InvoicingValidationError();
  const { partials, consumedLineIds } = await readActivePartials(tx, ctx, command.orderId);
  const ordinal = partials.length + 1;
  const billedGross = partials.reduce((sum, row) => sum + Number(row.invoice_gross), 0);
  const orderGross = Number(order.gross_cents);
  const byId = new Map(orderLines.map((line) => [line.id, line]));

  type CopyLine = CommercialDocumentLineInputV1 & { sourceLineId: string | null };
  let linesToCopy: CopyLine[];
  let storedBps: number | null = null;
  if (command.mode === "percent") {
    // v1-Grenze: Mischsätze fail-closed (EINE Sammellinie braucht genau
    // einen Satz — createDocumentLine rechnet je Zeile genau einen).
    const rates = new Set(orderLines.map((line) => Number(line.tax_rate_bps)));
    if (rates.size !== 1) throw new InvoicingValidationError();
    const rate = [...rates][0]!;
    if (rate !== 0 && rate !== 1900) throw new InvoicingValidationError();
    const netCents = roundPercentCents(Number(order.net_cents), command.percentBps!);
    linesToCopy = [{
      position: 1,
      name: `Teilrechnung-Anteil ${ordinal} – ${command.percentBps! / 100} %`,
      quantityMilli: 1000,
      unit: "piece",
      netCents,
      taxRateBps: rate,
      sourceLineId: null,
    }];
  } else if (command.mode === "scheme") {
    // F8-07: Tranchenindex aus AKTIVEN Scheme-Tranchen (andere Modi
    // zählen nicht); Plan erschöpft → Conflict. Letzte Tranche = Rest
    // für cent-exakte Staffel. Gleiche Ein-Satz-Grenze wie percent.
    const rates = new Set(orderLines.map((line) => Number(line.tax_rate_bps)));
    if (rates.size !== 1) throw new InvoicingValidationError();
    const rate = [...rates][0]!;
    if (rate !== 0 && rate !== 1900) throw new InvoicingValidationError();
    const trancheIndex = partials.filter((row) => row.mode === "scheme").length;
    if (trancheIndex >= COMMERCIAL_DOCUMENT_SCHEME_TRANCHES_BPS.length) {
      throw new InvoicingConflictError();
    }
    storedBps = COMMERCIAL_DOCUMENT_SCHEME_TRANCHES_BPS[trancheIndex]!;
    const isLast = trancheIndex === COMMERCIAL_DOCUMENT_SCHEME_TRANCHES_BPS.length - 1;
    const netCents = isLast
      ? Number(order.net_cents) - await readActiveBilledNet(tx, ctx, command.orderId, "scheme")
      : roundPercentCents(Number(order.net_cents), storedBps);
    if (!Number.isSafeInteger(netCents) || netCents <= 0) throw new InvoicingConflictError();
    linesToCopy = [{
      position: 1,
      name: `Zahlungsplan-Tranche ${trancheIndex + 1} – ${storedBps / 100} %`,
      quantityMilli: 1000,
      unit: "piece",
      netCents,
      taxRateBps: rate,
      sourceLineId: null,
    }];
  } else if (command.mode === "closing") {
    // F8-08: Rest-Schlussrechnung — genau EINE Sammellinie über den
    // exakten Ketten-Rest. Ohne aktive Teilrechnung kein Closing
    // (kein Ersatz für F8-04b); Rest ≤ 0 → Conflict. Nominelle
    // Rest-Bps nur für Anzeige/Cap-Kette (CHECK 1..10000).
    const rates = new Set(orderLines.map((line) => Number(line.tax_rate_bps)));
    if (rates.size !== 1) throw new InvoicingValidationError();
    const rate = [...rates][0]!;
    if (rate !== 0 && rate !== 1900) throw new InvoicingValidationError();
    if (partials.length === 0) throw new InvoicingValidationError();
    const orderNet = Number(order.net_cents);
    const netCents = orderNet - await readActiveBilledNet(tx, ctx, command.orderId, null);
    if (!Number.isSafeInteger(netCents) || netCents <= 0) throw new InvoicingConflictError();
    const nominalBps = Number((BigInt(netCents) * BigInt(10000)) / BigInt(orderNet));
    storedBps = Math.min(Math.max(nominalBps, 1), 10000);
    linesToCopy = [{
      position: 1,
      name: `Restbetrag zu ${order.number ?? order.name}`,
      quantityMilli: 1000,
      unit: "piece",
      netCents,
      taxRateBps: rate,
      sourceLineId: null,
    }];
  } else if (command.mode === "remainder") {
    // F8-12: Teil-Rest — Anteil (percentBps, 1..9999, Contract-Refine)
    // am AKTUELLEN Ketten-Rest, Kette bleibt offen. Ohne aktive
    // Teilrechnung kein Remainder (kein F8-04b-Ersatz); 100 % ist
    // closing. Nominelle Bps nur für Anzeige (CHECK 1..9999).
    const rates = new Set(orderLines.map((line) => Number(line.tax_rate_bps)));
    if (rates.size !== 1) throw new InvoicingValidationError();
    const rate = [...rates][0]!;
    if (rate !== 0 && rate !== 1900) throw new InvoicingValidationError();
    if (partials.length === 0) throw new InvoicingValidationError();
    if (command.percentBps === null || command.percentBps > 9999) {
      throw new InvoicingValidationError();
    }
    const orderNet = Number(order.net_cents);
    const remainderNet = orderNet - await readActiveBilledNet(tx, ctx, command.orderId, null);
    if (!Number.isSafeInteger(remainderNet) || remainderNet <= 0) {
      throw new InvoicingConflictError();
    }
    const netCents = roundPercentCents(remainderNet, command.percentBps);
    if (!Number.isSafeInteger(netCents) || netCents <= 0) throw new InvoicingConflictError();
    storedBps = command.percentBps;
    linesToCopy = [{
      position: 1,
      name: `Teil-Restbetrag zu ${order.number ?? order.name}`,
      quantityMilli: 1000,
      unit: "piece",
      netCents,
      taxRateBps: rate,
      sourceLineId: null,
    }];
  } else if (command.mode === "amount") {
    // F8-13: Betrag-Teilrechnung — freier Netto-Centbetrag 1:1, ohne
    // Rundung. Gegen den AKTUELLEN Ketten-Rest geprüft (ohne Kette =
    // Auftrags-Netto); Betrag über Rest ist Conflict (nichts mehr zu
    // berechnen), nicht Validation. Nominelle Bps nur für Anzeige.
    const rates = new Set(orderLines.map((line) => Number(line.tax_rate_bps)));
    if (rates.size !== 1) throw new InvoicingValidationError();
    const rate = [...rates][0]!;
    if (rate !== 0 && rate !== 1900) throw new InvoicingValidationError();
    if (command.amountCents === null) throw new InvoicingValidationError();
    const orderNet = Number(order.net_cents);
    const remainderNet = orderNet - await readActiveBilledNet(tx, ctx, command.orderId, null);
    if (!Number.isSafeInteger(remainderNet) || remainderNet <= 0) {
      throw new InvoicingConflictError();
    }
    if (command.amountCents > remainderNet) throw new InvoicingConflictError();
    const netCents = command.amountCents;
    storedBps = Math.max(1, Math.min(10000, Math.floor((netCents * 10000) / orderNet)));
    linesToCopy = [{
      position: 1,
      name: `Teilbetrag zu ${order.number ?? order.name}`,
      quantityMilli: 1000,
      unit: "piece",
      netCents,
      taxRateBps: rate,
      sourceLineId: null,
    }];
  } else {
    const requested = command.lineIds!;
    if (new Set(requested).size !== requested.length) throw new InvoicingValidationError();
    linesToCopy = [];
    for (const lineId of requested) {
      const source = byId.get(lineId);
      if (!source) throw new InvoicingValidationError();
      // DB-Werte erneut durchs Eingabe-Schema (korrupte Altzeilen
      // fail-closed statt stiller Literal-Verletzung).
      const candidate = commercialDocumentLineInputV1Schema.safeParse({
        position: source.position,
        name: source.name,
        quantityMilli: Number(source.quantity_milli),
        unit: source.unit,
        netCents: Number(source.net_cents),
        taxRateBps: Number(source.tax_rate_bps),
      });
      if (!candidate.success) throw new InvoicingValidationError();
      linesToCopy.push({ ...candidate.data, sourceLineId: source.id });
    }
    // Verbrauch gegen AKTIVE Kette (stornierte geben frei).
    if (requested.some((lineId) => consumedLineIds.includes(lineId))) {
      throw new InvoicingConflictError();
    }
  }

  const created = await createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice",
      name: `Teilrechnung ${ordinal} zu ${order.number ?? order.name}`,
      groupId: order.group_id,
      projectId: order.project_id,
      contactId: order.contact_id,
      dueDate: berlinDueDateIso(),
      skontoPercentBps: null,
      skontoDays: null,
      deliveryDate: null,
      validityDate: null,
      plannedDeliveryDate: null,
      plannedServiceDate: null,
      creditNoteType: null,
    },
  });
  for (const line of linesToCopy) {
    await createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: created.id,
      input: {
        position: line.position,
        name: line.name,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        netCents: line.netCents,
        taxRateBps: line.taxRateBps,
      },
    });
  }

  // Cap gegen zurückgelesene Brutto-Summe (Bruch = Rollback der Tx).
  const fresh = await tx.execute<{ gross_cents: number | string }>(sql`
    select gross_cents
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${created.id}::uuid
  `);
  const grossCents = Number(fresh.rows[0]?.gross_cents ?? 0);
  if (billedGross + grossCents > orderGross) throw new InvoicingConflictError();

  const partialId = randomUUID();
  try {
    await tx.execute(sql`
      insert into commercial_document_partial (
        id, workspace_id, source_order_id, partial_invoice_id,
        mode, percent_bps, ordinal, created_by
      ) values (
        ${partialId}::uuid, ${ctx.workspaceId}::uuid, ${command.orderId}::uuid,
        ${created.id}::uuid, ${command.mode},
        ${command.mode === "lines" ? null : command.mode === "percent" || command.mode === "remainder" ? command.percentBps : storedBps},
        ${ordinal}, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    if (partialPostgresCode(error) === "23505") throw new InvoicingConflictError();
    throw error;
  }
  if (command.mode === "lines") {
    for (const line of linesToCopy) {
      await tx.execute(sql`
        insert into commercial_document_partial_line (
          id, workspace_id, partial_id, source_line_id
        ) values (
          ${randomUUID()}::uuid, ${ctx.workspaceId}::uuid,
          ${partialId}::uuid, ${line.sourceLineId}::uuid
        )
      `);
    }
  }

  const evidence = {
    workspaceId: ctx.workspaceId,
    orderId: command.orderId,
    partialInvoiceId: created.id,
    mode: command.mode,
    ordinal,
    grossCents,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document",
    aggregateId: created.id,
    eventType: "commercial_document.partial_created",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.document.partial_create",
    resource: "commercial_document",
    allowed: true,
    details: evidence,
  });
  return { id: created.id, ordinal, mode: command.mode, grossCents };
}

export type PartialChainEntry = {
  partialId: string;
  invoiceId: string;
  number: string | null;
  name: string;
  status: string;
  ordinal: number;
  mode: "percent" | "lines" | "scheme" | "closing" | "remainder" | "amount";
  percentBps: number | null;
  grossCents: number;
  // F8-13: Netto-Summe je Teilrechnung (ehrliche „Betrag X €“-Anzeige).
  netCents: number;
  createdAt: string;
};

export type PartialOrderLine = {
  id: string;
  position: number;
  name: string;
  grossCents: number;
  consumed: boolean;
};

export type PartialChain = {
  order: { id: string; number: string | null; name: string; grossCents: number };
  orderLines: PartialOrderLine[];
  partials: PartialChainEntry[];
  billedGrossCents: number;
  remainingGrossCents: number;
  consumedLineIds: string[];
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listPartialInvoices(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { orderId: string },
): Promise<PartialChain> {
  requirePartialRead(ctx);
  if (typeof input.orderId !== "string") throw new InvoicingValidationError();
  const order = await tx.execute<OrderRow>(sql`
    select id, type, status, group_id, project_id, contact_id, name, number,
           net_cents, gross_cents
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.orderId}::uuid
  `);
  const head = order.rows[0];
  if (!head || head.type !== "order_confirmation") throw new InvoicingNotFoundError();

  const rows = await tx.execute<{
    partial_id: string;
    ordinal: number;
    mode: string;
    percent_bps: number | null;
    created_at: Date | string;
    invoice_id: string;
    invoice_number: string | null;
    invoice_name: string;
    invoice_status: string;
    invoice_gross: number | string;
    invoice_net: number | string;
    [key: string]: unknown;
  }>(sql`
    select partial.id as partial_id, partial.ordinal, partial.mode,
           partial.percent_bps, partial.created_at,
           invoice.id as invoice_id, invoice.number as invoice_number,
           invoice.name as invoice_name, invoice.status as invoice_status,
           invoice.gross_cents as invoice_gross, invoice.net_cents as invoice_net
      from commercial_document_partial partial
      join commercial_document invoice
        on invoice.workspace_id = partial.workspace_id
       and invoice.id = partial.partial_invoice_id
     where partial.workspace_id = ${ctx.workspaceId}::uuid
       and partial.source_order_id = ${input.orderId}::uuid
     order by partial.ordinal asc
  `);
  const partials: PartialChainEntry[] = rows.rows.map((row) => ({
    partialId: row.partial_id,
    invoiceId: row.invoice_id,
    number: row.invoice_number,
    name: row.invoice_name,
    status: row.invoice_status,
    ordinal: row.ordinal,
    mode: row.mode === "lines"
      ? "lines"
      : row.mode === "scheme"
        ? "scheme"
        : row.mode === "closing"
          ? "closing"
          : row.mode === "remainder"
            ? "remainder"
            : row.mode === "amount" ? "amount" : "percent",
    percentBps: row.percent_bps,
    grossCents: Number(row.invoice_gross),
    netCents: Number(row.invoice_net),
    createdAt: toIso(row.created_at),
  }));
  const billedGrossCents = partials
    .filter((entry) => entry.status !== "voided")
    .reduce((sum, entry) => sum + entry.grossCents, 0);
  const { consumedLineIds } = await readActivePartials(tx, ctx, input.orderId);
  const consumed = new Set(consumedLineIds);
  const orderLineRows = await readOrderLines(tx, ctx, input.orderId);
  const orderLines: PartialOrderLine[] = orderLineRows.map((line) => ({
    id: line.id,
    position: line.position,
    name: line.name,
    grossCents: Number(line.net_cents) + Number(line.tax_cents),
    consumed: consumed.has(line.id),
  }));
  const orderGross = Number(head.gross_cents);
  return {
    order: { id: head.id, number: head.number, name: head.name, grossCents: orderGross },
    orderLines,
    partials,
    billedGrossCents,
    remainingGrossCents: Math.max(orderGross - billedGrossCents, 0),
    consumedLineIds,
  };
}
