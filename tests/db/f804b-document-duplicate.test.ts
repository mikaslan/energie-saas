import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  duplicateOrderConfirmationAsInvoice,
  getDocumentDetail,
  voidDocument,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-04b Duplicate')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f804b.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f804b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
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
      companyName: "F8-04b GmbH",
      companyEmail: "office@f804b.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-04b GmbH",
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

type LineSeed = {
  position: number; name: string; quantityMilli: number;
  unit: "piece" | "set" | "meter"; netCents: number; taxRateBps: 1900;
};

async function seedOrderConfirmation(
  fixture: Fixture,
  name: string,
  lines: LineSeed[],
): Promise<{ id: string; groupId: string }> {
  await ensureSettings(fixture);
  const groupId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `Gruppe ${name}`,
    }),
  ).then((result) => result.id);
  const id = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "order_confirmation", name, groupId, projectId: null,
        contactId: null, dueDate: null,
        skontoPercentBps: null, skontoDays: null,
        deliveryDate: null, validityDate: null,
        plannedDeliveryDate: "2026-11-01", plannedServiceDate: "2026-11-15",
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
  for (const line of lines) {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentLine(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
        documentId: id,
        input: line,
      }),
    );
  }
  return { id, groupId };
}

function berlinPlus14(): string {
  const berlinToday = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const due = new Date(berlinToday.getTime() + 14 * 24 * 60 * 60 * 1000);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
}

describe("F8-04b AB als Rechnung übernehmen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const LINES: LineSeed[] = [
    { position: 1, name: "PV-Module", quantityMilli: 20000, unit: "piece", netCents: 800000, taxRateBps: 1900 },
    { position: 2, name: "Montage", quantityMilli: 1000, unit: "set", netCents: 150000, taxRateBps: 1900 },
  ];

  it("F804B-DB-01: Positionen, Summen, Gruppe, Faelligkeit +14", async () => {
    const source = await seedOrderConfirmation(fixture, "AB-Projekt Sonne", LINES);
    const result = await asEditor(fixture, (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
      sourceDocumentId: source.id,
    }));
    expect(result.type).toBe("invoice");
    expect(result.status).toBe("draft");
    expect(result.linesCopied).toBe(2);

    const invoice = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: result.id,
    }));
    const origin = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "order_confirmation",
      documentId: source.id,
    }));
    expect(invoice.document.name).toBe("Rechnung zu AB-Projekt Sonne");
    expect(invoice.document.groupId).toBe(source.groupId);
    expect(invoice.document.dueDate).toBe(berlinPlus14());
    expect(invoice.document.skontoPercentBps).toBeNull();
    expect(invoice.lines.map((line) => ({
      position: line.position, name: line.name, quantityMilli: line.quantityMilli,
      unit: line.unit, netCents: line.netCents, taxRateBps: line.taxRateBps,
    }))).toEqual(origin.lines.map((line) => ({
      position: line.position, name: line.name, quantityMilli: line.quantityMilli,
      unit: line.unit, netCents: line.netCents, taxRateBps: line.taxRateBps,
    })));
    expect(invoice.document.netCents).toBe(origin.document.netCents);
    expect(invoice.document.grossCents).toBe(origin.document.grossCents);
    // Quelle bleibt unverändert Entwurf.
    expect(origin.document.status).toBe("draft");
  });

  it("F804B-DB-02: nur AB, nicht storniert, Editor-Recht", async () => {
    await ensureSettings(fixture);
    const invoiceId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice", name: "Keine AB", groupId: null, projectId: null,
          contactId: null, dueDate: "2026-12-31",
          skontoPercentBps: null, skontoDays: null,
          deliveryDate: null, validityDate: null,
          plannedDeliveryDate: null, plannedServiceDate: null,
          creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    await expect(asEditor(fixture, (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
      sourceDocumentId: invoiceId,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);

    const source = await seedOrderConfirmation(fixture, "AB-Storno", LINES.slice(0, 1));
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: source.id,
      reason: "cancelled",
    }));
    await expect(asEditor(fixture, (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
      sourceDocumentId: source.id,
    }))).rejects.toBeInstanceOf(InvoicingConflictError);

    const fresh = await seedOrderConfirmation(fixture, "AB-Viewer", LINES.slice(0, 1));
    await expect(asViewer(fixture, (tx, ctx) => duplicateOrderConfirmationAsInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DUPLICATE_COMMAND_VERSION,
      sourceDocumentId: fresh.id,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
