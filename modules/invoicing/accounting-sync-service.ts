import "server-only";

import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  ACCOUNTING_SYNC_LIST_VERSION,
  ACCOUNTING_SYNC_VERSION,
  accountingSyncCommandV1Schema,
  accountingSyncListV1Schema,
  accountingSyncV1Schema,
  assertAccountingSyncTransition,
  buildAccountingExportPayload,
  hashAccountingExportPayload,
  toVendorPayload,
  AccountingExportError,
  AccountingSyncTransitionError,
  type AccountingSyncCommandV1,
  type AccountingSyncListV1,
  type AccountingSyncState,
  type AccountingSyncV1,
  type AccountingVendor,
} from "@/lib/integrations/invoicing/accounting-contract";
import {
  AccountingProviderError,
  type AccountingProvider,
} from "@/lib/integrations/invoicing/accounting-provider";
import {
  InvoicingConflictError,
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";

function requireAccountingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError("invoicing.write", "accounting_sync_record", undefined, ctx.actor);
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

type SyncRow = {
  document_id: string;
  vendor: string;
  state: string;
  payload_sha256: string;
  external_id: string | null;
  attempts: number;
  last_error: string | null;
  updated_at: Date | string;
  [key: string]: unknown;
};

type DocumentRow = {
  id: string;
  type: string;
  status: string;
  number: string | null;
  currency: string;
  issued_date: string | null;
  contact_name: string | null;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  [key: string]: unknown;
};

type SyncLineRow = {
  tax_rate_bps: number;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  [key: string]: unknown;
};

function toIsoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSyncDto(row: SyncRow): AccountingSyncV1 {
  // CHECK-gestuetzte Zeilen passieren immer; scheitert das DTO trotzdem
  // (manueller DB-Eingriff), ist das Integritaet, nie 500-Rohfehler.
  try {
    return accountingSyncV1Schema.parse({
      schemaVersion: ACCOUNTING_SYNC_VERSION,
      documentId: row.document_id,
      vendor: row.vendor,
      state: row.state,
      payloadSha256: row.payload_sha256,
      externalId: row.external_id,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      updatedAt: toIsoDateTime(row.updated_at),
    });
  } catch (error) {
    if (error instanceof InvoicingIntegrityError) throw error;
    throw new InvoicingIntegrityError();
  }
}

function parseCommand(input: AccountingSyncCommandV1): { documentId: string; vendor: AccountingVendor } {
  const parsed = accountingSyncCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  return parsed.data;
}

function capError(detail: string): string {
  // Code-Point-Schnitt (kein UTF-16-slice): sonst spaltet ein astrales
  // Zeichen und der INSERT scheitert an der Textkodierung.
  return [...detail].slice(0, 500).join("");
}

// SQL-Reihenfolge je Funktion (fix, für stubbare Contract-Tests):
// queue: 1) Beleg, 2) Zeilen, 3) Sync-Satz lesen, 4) Insert/Update.
// get: 1) Sync-Satz lesen. list: 1) Sync-Sätze lesen.
// run: 1) Sync-Satz, 2) Beleg, 3) Zeilen, 4) Update.

async function readDocument(tx: TenantTx, ctx: ServiceCtx, documentId: string): Promise<DocumentRow> {
  const result = await tx.execute<DocumentRow>(sql`
    select doc.id, doc.type, doc.status, doc.number, doc.currency,
           (doc.issued_at at time zone 'Europe/Berlin')::date::text as issued_date,
           contact.display_name as contact_name,
           doc.net_cents, doc.tax_cents, doc.gross_cents
      from commercial_document as doc
      left join contact
        on contact.workspace_id = doc.workspace_id
       and contact.id = doc.contact_id
     where doc.workspace_id = ${ctx.workspaceId}::uuid
       and doc.id = ${documentId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  // Kein Orakel: fehlender, nicht ausgestellter oder fachfremder Beleg
  // meldet unterschiedslos not_found (kein Existenz-Leak).
  if (
    row === undefined
    || row.status !== "issued"
    || (row.type !== "invoice" && row.type !== "credit_note")
  ) {
    throw new InvoicingNotFoundError();
  }
  return row;
}

async function readLines(tx: TenantTx, ctx: ServiceCtx, documentId: string): Promise<SyncLineRow[]> {
  const result = await tx.execute<SyncLineRow>(sql`
    select tax_rate_bps, net_cents, tax_cents, gross_cents
      from commercial_document_line
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
     order by position asc
  `);
  return result.rows;
}

function payloadForDocument(row: DocumentRow, lines: SyncLineRow[]): {
  payload: ReturnType<typeof buildAccountingExportPayload>;
  payloadSha256: string;
} {
  let payload: ReturnType<typeof buildAccountingExportPayload>;
  try {
    payload = buildAccountingExportPayload({
      kind: row.type,
      status: row.status,
      number: row.number ?? "",
      issueDate: row.issued_date ?? "",
      contactName: row.contact_name ?? "",
      currency: row.currency,
      lines: lines.map((line) => ({
        taxRateBps: Number(line.tax_rate_bps),
        netCents: Number(line.net_cents),
        taxCents: Number(line.tax_cents),
        grossCents: Number(line.gross_cents),
      })),
      netCents: Number(row.net_cents),
      taxCents: Number(row.tax_cents),
      grossCents: Number(row.gross_cents),
    });
  } catch (error) {
    if (error instanceof AccountingExportError) throw new InvoicingValidationError();
    throw error;
  }
  // Der Hash wirft TypeError auf unsicheren Ganzzahlen/Surrogaten
  // (DB-CHECKs schliessen das aus; faellt er doch, sind die
  // gespeicherten Daten korrupt — Integritaet, nie 500).
  try {
    return { payload, payloadSha256: hashAccountingExportPayload(payload) };
  } catch (error) {
    if (error instanceof TypeError) throw new InvoicingIntegrityError();
    throw error;
  }
}

async function readSync(
  tx: TenantTx,
  ctx: ServiceCtx,
  documentId: string,
  vendor: AccountingVendor,
): Promise<SyncRow | undefined> {
  const result = await tx.execute<SyncRow>(sql`
    select document_id, vendor, state, payload_sha256, external_id,
           attempts, last_error, updated_at
      from accounting_sync_record
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and vendor = ${vendor}
     limit 1
  `);
  return result.rows[0];
}

/**
 * F8-21 Queue: legt den Sync-Satz je (Beleg, Vendor) an oder gibt den
 * bestehenden zurück. Idempotenz-Key = Vendor + Payload-Hash: gleicher
 * Stand → gleicher Satz; neuer Stand → Hash-Auffrischung nur aus queued
 * (CAS), Re-Queue aus failed. exported + Drift verweigert Konflikt
 * (exported→queued ist kein Maschinen-Uebergang; Pfad: run markiert
 * failed mit Drift-Hinweis, dann Re-Queue). acknowledged ist terminal.
 */
export async function queueAccountingSync(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: AccountingSyncCommandV1,
): Promise<AccountingSyncV1> {
  requireAccountingWrite(ctx);
  const { documentId, vendor } = parseCommand(input);
  const doc = await readDocument(tx, ctx, documentId);
  const lines = await readLines(tx, ctx, documentId);
  const { payloadSha256 } = payloadForDocument(doc, lines);
  const existing = await readSync(tx, ctx, documentId, vendor);

  if (existing === undefined) {
    try {
      const inserted = await tx.execute<SyncRow>(sql`
        insert into accounting_sync_record (
          workspace_id, document_id, vendor, state, payload_sha256,
          external_id, attempts, last_error
        ) values (
          ${ctx.workspaceId}::uuid, ${documentId}::uuid, ${vendor},
          'queued', ${payloadSha256}, null, 0, null
        )
        returning document_id, vendor, state, payload_sha256, external_id,
                  attempts, last_error, updated_at
      `);
      const row = inserted.rows[0];
      if (!row) throw new InvoicingConflictError();
      return toSyncDto(row);
    } catch (error) {
      // UNIQUE (workspace, document, vendor): Nebenläufigkeit meldet
      // Konflikt statt Doppelsatz.
      if (error instanceof InvoicingConflictError) throw error;
      if (postgresErrorCode(error) === "23505") throw new InvoicingConflictError();
      throw error;
    }
  }

  const state = existing.state as AccountingSyncState;
  if (state === "acknowledged") {
    if (existing.payload_sha256 !== payloadSha256) throw new InvoicingConflictError();
    return toSyncDto(existing);
  }
  if (state === "failed") {
    // Retry-Pfad: Re-Queue mit attempts+1.
    try {
      assertAccountingSyncTransition("failed", "queued");
    } catch (error) {
      if (error instanceof AccountingSyncTransitionError) throw new InvoicingConflictError();
      throw error;
    }
    const updated = await tx.execute<SyncRow>(sql`
      update accounting_sync_record
         set state = 'queued',
             payload_sha256 = ${payloadSha256},
             attempts = attempts + 1,
             last_error = null,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and vendor = ${vendor}
         and state = 'failed'
      returning document_id, vendor, state, payload_sha256, external_id,
                attempts, last_error, updated_at
    `);
    const row = updated.rows[0];
    if (!row) throw new InvoicingConflictError();
    return toSyncDto(row);
  }
  if (existing.payload_sha256 === payloadSha256) return toSyncDto(existing);
  // Hier nur noch queued/exported mit Drift: exported→queued ist kein
  // Maschinen-Uebergang (ACCOUNTING_SYNC_TRANSITIONS) — der alte
  // external_id wuerde sonst auf die neue Payload zeigen (GoBD-Drift).
  if (state !== "queued") throw new InvoicingConflictError();
  const updated = await tx.execute<SyncRow>(sql`
    update accounting_sync_record
       set payload_sha256 = ${payloadSha256},
           last_error = null,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and vendor = ${vendor}
       and state = 'queued'
    returning document_id, vendor, state, payload_sha256, external_id,
              attempts, last_error, updated_at
  `);
  const row = updated.rows[0];
  if (!row) throw new InvoicingConflictError();
  return toSyncDto(row);
}

/** F8-21 Status-Read eines Sync-Satzes (Capability invoicing.write). */
export async function getAccountingSyncStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: AccountingSyncCommandV1,
): Promise<AccountingSyncV1> {
  requireAccountingWrite(ctx);
  const { documentId, vendor } = parseCommand(input);
  const existing = await readSync(tx, ctx, documentId, vendor);
  if (existing === undefined) throw new InvoicingNotFoundError();
  return toSyncDto(existing);
}

/** F8-21 Listen-Read aller Sync-Sätze, optional je Beleg gefiltert. */
export async function listAccountingSyncs(
  tx: TenantTx,
  ctx: ServiceCtx,
  filter: { documentId?: string } = {},
): Promise<AccountingSyncListV1> {
  requireAccountingWrite(ctx);
  if (filter.documentId !== undefined && !isUuid(filter.documentId)) {
    throw new InvoicingValidationError();
  }
  const result = filter.documentId === undefined
    ? await tx.execute<SyncRow>(sql`
      select document_id, vendor, state, payload_sha256, external_id,
             attempts, last_error, updated_at
        from accounting_sync_record
       where workspace_id = ${ctx.workspaceId}::uuid
       order by updated_at desc, document_id asc, vendor asc
    `)
    : await tx.execute<SyncRow>(sql`
      select document_id, vendor, state, payload_sha256, external_id,
             attempts, last_error, updated_at
        from accounting_sync_record
       where workspace_id = ${ctx.workspaceId}::uuid
         and document_id = ${filter.documentId}::uuid
       order by updated_at desc, vendor asc
    `);
  return accountingSyncListV1Schema.parse({
    schemaVersion: ACCOUNTING_SYNC_LIST_VERSION,
    syncs: result.rows.map(toSyncDto),
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * F8-21 Run: führt queued/exported Sätze über den injizierten Provider aus.
 * queued → export (external_id schreiben) → exported; exported → Re-Export
 * als Bestätigung (ursprüngliche external_id bleibt) → acknowledged.
 * Jeder Fehler → failed; Retry nur über Re-Queue. failed/acknowledged
 * verweigern direkt (Konflikt). Drift zwischen Sync-Satz und Belegstand
 * bricht fail-closed ab und markiert failed.
 */
export async function runAccountingSync(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: AccountingSyncCommandV1,
  provider: AccountingProvider,
): Promise<AccountingSyncV1> {
  requireAccountingWrite(ctx);
  const { documentId, vendor } = parseCommand(input);
  if (provider.vendor !== vendor) throw new InvoicingValidationError();
  const existing = await readSync(tx, ctx, documentId, vendor);
  if (existing === undefined) throw new InvoicingNotFoundError();
  const state = existing.state as AccountingSyncState;
  if (state === "failed" || state === "acknowledged") throw new InvoicingConflictError();

  const doc = await readDocument(tx, ctx, documentId);
  const lines = await readLines(tx, ctx, documentId);
  let payload: ReturnType<typeof buildAccountingExportPayload>;
  let payloadSha256: string;
  // Failure-Semantik (Worker-Muster finalizeInvoicePdfRenderFailure):
  // Laufzeitfehler persistieren `failed` + last_error und RETURNEN den
  // Satz — ein Throw wuerde die Transaktion des Aufrufers (mit dem
  // failed-Update) zurueckrollen. Nur Aufruffehler (Validierung,
  // Vendor-Mismatch, fehlender Satz, Run aus failed/acknowledged)
  // werfen, weil es dort nichts zu persistieren gibt.
  try {
    ({ payload, payloadSha256 } = payloadForDocument(doc, lines));
  } catch (error) {
    if (error instanceof InvoicingValidationError) {
      return toSyncDto(await markFailed(tx, ctx, documentId, vendor, "belegstand ungueltig"));
    }
    throw error;
  }
  if (payloadSha256 !== existing.payload_sha256) {
    return toSyncDto(
      await markFailed(tx, ctx, documentId, vendor, "payload-drift: Belegstand abweichend, Re-Queue noetig"),
    );
  }

  // Pre-Flight: Vendor-Abbildbarkeit steht vor dem Transport; der
  // Provider erhält die neutrale Payload und mappt selbst.
  try {
    toVendorPayload(vendor, payload);
  } catch (error) {
    if (error instanceof AccountingExportError) {
      return toSyncDto(
        await markFailed(tx, ctx, documentId, vendor, "vendor-mapping ungueltig"),
      );
    }
    throw error;
  }

  let externalId: string;
  try {
    const result = await provider.exportVoucher(payload);
    externalId = result.externalId;
  } catch (error) {
    const detail = error instanceof AccountingProviderError || error instanceof Error
      ? error.message
      : "provider-fehler";
    return toSyncDto(await markFailed(tx, ctx, documentId, vendor, detail));
  }
  // Provider-Antwort ist Fremddaten: leer oder >200 Zeichen wuerde den
  // CHECK sprengen (23514 → 500) — stattdessen failed mit Hinweis.
  if (typeof externalId !== "string" || externalId.length === 0 || externalId.length > 200) {
    return toSyncDto(
      await markFailed(tx, ctx, documentId, vendor, "provider-external-id ungueltig"),
    );
  }

  const target: AccountingSyncState = state === "queued" ? "exported" : "acknowledged";
  try {
    assertAccountingSyncTransition(state, target);
  } catch (error) {
    if (error instanceof AccountingSyncTransitionError) throw new InvoicingConflictError();
    throw error;
  }
  // CAS auf den gelesenen Zustand: parallele Doppel-Runs gewinnen nur
  // einmal (sonst Doppel-Export, last-wins external_id, attempts +2).
  const updated = state === "queued"
    ? await tx.execute<SyncRow>(sql`
      update accounting_sync_record
         set state = 'exported',
             external_id = ${externalId},
             attempts = attempts + 1,
             last_error = null,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and vendor = ${vendor}
         and state = 'queued'
      returning document_id, vendor, state, payload_sha256, external_id,
                attempts, last_error, updated_at
    `)
    : await tx.execute<SyncRow>(sql`
      update accounting_sync_record
         set state = 'acknowledged',
             attempts = attempts + 1,
             last_error = null,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and vendor = ${vendor}
         and state = 'exported'
      returning document_id, vendor, state, payload_sha256, external_id,
                attempts, last_error, updated_at
    `);
  const row = updated.rows[0];
  if (!row) throw new InvoicingConflictError();
  return toSyncDto(row);
}

async function markFailed(
  tx: TenantTx,
  ctx: ServiceCtx,
  documentId: string,
  vendor: AccountingVendor,
  detail: string,
): Promise<SyncRow> {
  const updated = await tx.execute<SyncRow>(sql`
    update accounting_sync_record
       set state = 'failed',
           attempts = attempts + 1,
           last_error = ${capError(detail)},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and vendor = ${vendor}
    returning document_id, vendor, state, payload_sha256, external_id,
              attempts, last_error, updated_at
  `);
  const row = updated.rows[0];
  if (!row) throw new InvoicingConflictError();
  return row;
}
