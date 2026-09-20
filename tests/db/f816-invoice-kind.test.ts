import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  duplicateOrderConfirmationAsInvoice,
  getDocumentDetail,
  issueDocument,
  listDocuments,
  voidDocument,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import type { TenantTx } from "@/lib/db/types";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-16 Kennung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f816.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f816.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-16 GmbH",
      companyEmail: "office@f816.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-16 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

const settingsSeeded = new Set<string>();

async function ensureSettings(fixture: Fixture): Promise<void> {
  if (settingsSeeded.has(fixture.workspaceId)) return;
  settingsSeeded.add(fixture.workspaceId);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
  );
}

async function seedDocument(
  fixture: Fixture,
  type: "order_confirmation" | "invoice" | "credit_note",
  name: string,
  invoiceKind?: "anzahlung" | "abschlag" | "teilrechnung" | "schlussrechnung",
): Promise<string> {
  await ensureSettings(fixture);
  const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  const groupId = await run((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `Gruppe ${name}`,
  })).then((result) => result.id);
  // Variable statt Literal: Die gewuenschte F8-16-Erweiterung darf den
  // Zod-strikt-Parser erreichen (RED: strictObject wirft sie ab).
  const input = {
    type, name, groupId, projectId: null,
    contactId: null,
    dueDate: type === "invoice" ? "2026-11-30" : null,
    skontoPercentBps: null, skontoDays: null,
    deliveryDate: type === "credit_note" ? "2026-11-20" : null,
    validityDate: null,
    plannedDeliveryDate: type === "order_confirmation" ? "2026-11-01" : null,
    plannedServiceDate: type === "order_confirmation" ? "2026-11-15" : null,
    creditNoteType: (type === "credit_note" ? "minderleistung" : null) as
      | "minderleistung"
      | null,
    ...(invoiceKind !== undefined ? { invoiceKind } : {}),
  };
  return run((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input,
  })).then((result) => result.id);
}

const lineInput = (documentId: string, position: number, netCents: number) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  documentId,
  input: {
    position, name: `Position ${position}`, quantityMilli: 1000,
    unit: "piece" as const, netCents, taxRateBps: 1900 as const,
  },
});

type SetKindFn = (
  tx: TenantTx, ctx: ServiceCtx,
  input: { schemaVersion: string; documentId: string; invoiceKind: string | null },
) => Promise<unknown>;

async function resolveSetKind(): Promise<{ fn: SetKindFn; schemaVersion: string }> {
  const mod = await import("@/modules/invoicing") as unknown as Record<string, unknown>;
  expect(typeof mod.setInvoiceKind, "setInvoiceKind fehlt (F8-16 RED)").toBe("function");
  expect(mod.COMMERCIAL_DOCUMENT_INVOICE_KIND_COMMAND_VERSION)
    .toBe("commercial-document-invoice-kind-command.v1");
  return {
    fn: mod.setInvoiceKind as SetKindFn,
    schemaVersion: mod.COMMERCIAL_DOCUMENT_INVOICE_KIND_COMMAND_VERSION as string,
  };
}

// PG-Fehler stecken ggf. in der Cause-Kette (F4.1-pgCode-Praezedenz).
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function readRawKind(fixture: Fixture, documentId: string): Promise<string | null> {
  const rows = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx) => tx.execute<{ invoice_kind: string | null }>(sql`
      select invoice_kind from commercial_document where id = ${documentId}::uuid limit 1
    `),
  );
  return rows.rows[0]?.invoice_kind ?? null;
}

describe("F8-16 Teilrechnungstypen-Kennung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  it("F816-DB-01: Kennung wird ausgestellt, versiegelt (v3) und eingefroren; Geld stabil", async () => {
    const invoiceId = await seedDocument(fixture, "invoice", "F816-Teil", "teilrechnung");
    expect(await readRawKind(fixture, invoiceId)).toBe("teilrechnung");

    // Geld aufbauen: 100.000 netto + 19.000 Steuer = 119.000 brutto.
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(invoiceId, 1, 100000)));
    const before = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: invoiceId,
    }));
    expect(before.document.invoiceKind).toBe("teilrechnung");
    expect([before.document.netCents, before.document.taxCents, before.document.grossCents])
      .toEqual([100000, 19000, 119000]);

    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: invoiceId,
    }));

    // Siegel pruefen: v3 + Kennung + Geld + 32-Byte-Hash.
    const sealed = await asEditor(fixture, (tx) => tx.execute<{
      issued_snapshot: Record<string, unknown>;
      snapshot_sha256: Buffer;
      net_cents: string; tax_cents: string; gross_cents: string;
    }>(sql`
      select issued_snapshot, snapshot_sha256, net_cents, tax_cents, gross_cents
        from commercial_document where id = ${invoiceId}::uuid limit 1
    `));
    const row = sealed.rows[0]!;
    expect(row.issued_snapshot["schemaVersion"]).toBe("document-snapshot.v3");
    expect(row.issued_snapshot["invoiceKind"]).toBe("teilrechnung");
    expect(row.issued_snapshot["netCents"]).toBe(100000);
    expect(row.issued_snapshot["grossCents"]).toBe(119000);
    expect(Buffer.byteLength(row.snapshot_sha256)).toBe(32);
    expect([Number(row.net_cents), Number(row.tax_cents), Number(row.gross_cents)])
      .toEqual([100000, 19000, 119000]);

    // Adversarial: direktes SQL-UPDATE der Kennung nach Ausstellung → 23514.
    let code: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        update commercial_document set invoice_kind = 'schlussrechnung'
         where id = ${invoiceId}::uuid
      `));
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe("23514");
    expect(await readRawKind(fixture, invoiceId)).toBe("teilrechnung");

    // Void behaelt die Kennung (eingefroren), Geld unberuehrt.
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: invoiceId,
      reason: "cancelled",
    }));
    expect(await readRawKind(fixture, invoiceId)).toBe("teilrechnung");
    const after = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: invoiceId,
    }));
    expect([after.document.netCents, after.document.taxCents, after.document.grossCents])
      .toEqual([100000, 19000, 119000]);
  });

  it("F816-DB-02: Guards — Typ-Scope, Freeze, RBAC, Tenant, Filter, kein Auto-Copy", async () => {
    // Kennung an Gutschrift → Validation. (RED-Hinweis: strictObject wirft
    // den unbekannten Key ebenfalls als Validation ab; der exakte Mechanismus
    // (invoice-only-Refine) ist in F816-CONTRACT-01 gepinnt.)
    await expect(seedDocument(fixture, "credit_note", "F816-GU-Kind", "anzahlung")).rejects
      .toBeInstanceOf(InvoicingValidationError);

    const { fn: setInvoiceKind, schemaVersion } = await resolveSetKind();
    const invoiceId = await seedDocument(fixture, "invoice", "F816-Set", "anzahlung");
    const plainId = await seedDocument(fixture, "invoice", "F816-Blank");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(plainId, 1, 100000)));
    const moneyOf = (id: string) => asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: id,
    })).then((detail) => [detail.document.netCents, detail.document.taxCents, detail.document.grossCents]);

    // Setzen im Entwurf + Loeschen (null) im Entwurf — Geld bit-identisch.
    expect(await moneyOf(plainId)).toEqual([100000, 19000, 119000]);
    await asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: plainId, invoiceKind: "abschlag",
    }));
    expect(await readRawKind(fixture, plainId)).toBe("abschlag");
    expect(await moneyOf(plainId)).toEqual([100000, 19000, 119000]);
    await asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: plainId, invoiceKind: "schlussrechnung",
    }));
    expect(await readRawKind(fixture, plainId)).toBe("schlussrechnung");
    expect(await moneyOf(plainId)).toEqual([100000, 19000, 119000]);
    await asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: plainId, invoiceKind: null,
    }));
    expect(await readRawKind(fixture, plainId)).toBeNull();
    expect(await moneyOf(plainId)).toEqual([100000, 19000, 119000]);

    // Typ-Scope: Gutschrift nimmt keine Kennung an.
    const creditId = await seedDocument(fixture, "credit_note", "F816-GU");
    await expect(asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: creditId, invoiceKind: "anzahlung",
    }))).rejects.toBeInstanceOf(InvoicingValidationError);

    // Freeze: Setzen an ausgestellter Rechnung → Conflict.
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: invoiceId,
    }));
    await expect(asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: invoiceId, invoiceKind: "schlussrechnung",
    }))).rejects.toBeInstanceOf(InvoicingConflictError);
    expect(await readRawKind(fixture, invoiceId)).toBe("anzahlung");

    // Viewer ohne Schreibrecht → denied (fail-closed, keine Aenderung).
    await expect(asViewer(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: plainId, invoiceKind: "anzahlung",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await readRawKind(fixture, plainId)).toBeNull();

    // Fremdtenant sieht das Dokument nicht (lesen + setzen).
    const foreign = await seedFixture();
    await ensureSettings(foreign);
    await expect(
      withAuthorizedTenantOn(testPool, foreign.editorId, foreign.workspaceId, (tx, ctx) =>
        getDocumentDetail(tx, ctx, {
          schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
          type: "invoice",
          documentId: invoiceId,
        })),
    ).rejects.toBeInstanceOf(InvoicingNotFoundError);
    await expect(
      withAuthorizedTenantOn(testPool, foreign.editorId, foreign.workspaceId, (tx, ctx) =>
        setInvoiceKind(tx, ctx, {
          schemaVersion, documentId: plainId, invoiceKind: "anzahlung",
        })),
    ).rejects.toBeInstanceOf(InvoicingNotFoundError);

    // Listenfilter: nur passende Kennung; Scope nur Typ invoice.
    const filters = { invoiceKind: "anzahlung" as const };
    const filtered = await asEditor(fixture, (tx, ctx) => listDocuments(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters,
    }));
    expect(filtered.totalCount).toBe(1);
    expect(filtered.items[0]?.id).toBe(invoiceId);
    await expect(asEditor(fixture, (tx, ctx) => listDocuments(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "credit_note",
      filters,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);

    // Kein Auto-Copy: Duplikat und Teilkette starten mit null.
    const orderId = await seedDocument(fixture, "order_confirmation", "F816-AB");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 1, 800000)));
    const duplicate = await asEditor(fixture, (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
      sourceDocumentId: orderId,
    }));
    expect(await readRawKind(fixture, duplicate.id)).toBeNull();
    const partial = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
      orderId,
      mode: "percent",
      percentBps: 3000,
      amountCents: null,
      lineIds: null,
    }));
    expect(await readRawKind(fixture, partial.id)).toBeNull();

    // Void-Pfad: ausgestellte Rechnung stornieren → Setzen → Conflict;
    // direktes SQL-UPDATE am stornierten Beleg → 23514 (Guard deckt
    // voided ab); Kennung bleibt erhalten.
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: invoiceId,
      reason: "cancelled",
    }));
    await expect(asEditor(fixture, (tx, ctx) => setInvoiceKind(tx, ctx, {
      schemaVersion, documentId: invoiceId, invoiceKind: "schlussrechnung",
    }))).rejects.toBeInstanceOf(InvoicingConflictError);
    let voidedCode: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        update commercial_document set invoice_kind = 'schlussrechnung'
         where id = ${invoiceId}::uuid
      `));
    } catch (error) {
      voidedCode = pgCode(error);
    }
    expect(voidedCode).toBe("23514");
    expect(await readRawKind(fixture, invoiceId)).toBe("anzahlung");
  });
});
