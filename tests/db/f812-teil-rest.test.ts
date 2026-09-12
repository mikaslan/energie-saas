import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  listPartialInvoices,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-12 Teil-Rest')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f812.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f812.test`})
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
      companyName: "F8-12 GmbH",
      companyEmail: "office@f812.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-12 GmbH",
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
  unit: "piece" | "set" | "meter"; netCents: number; taxRateBps: 1900 | 0;
};

async function seedOrderConfirmation(
  fixture: Fixture,
  name: string,
  lines: LineSeed[],
): Promise<string> {
  await ensureSettings(fixture);
  const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  const groupId = await run((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `Gruppe ${name}`,
  })).then((result) => result.id);
  const id = await run((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "order_confirmation", name, groupId, projectId: null,
      contactId: null, dueDate: null,
      skontoPercentBps: null, skontoDays: null,
      deliveryDate: null, validityDate: null,
      plannedDeliveryDate: "2026-11-01", plannedServiceDate: "2026-11-15",
      creditNoteType: null,
    },
  })).then((result) => result.id);
  for (const line of lines) {
    await run((tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: id,
      input: line,
    }));
  }
  return id;
}

// AB: netto 950.000 ct, 19 % → brutto 1.130.500 ct.
const LINES: LineSeed[] = [
  { position: 1, name: "PV-Module", quantityMilli: 20000, unit: "piece", netCents: 800000, taxRateBps: 1900 },
  { position: 2, name: "Montage", quantityMilli: 1000, unit: "set", netCents: 150000, taxRateBps: 1900 },
];

const closingInput = (orderId: string) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "closing" as const,
  percentBps: null,
  lineIds: null,
});

const percentInput = (orderId: string, percentBps: number) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "percent" as const,
  percentBps,
  lineIds: null,
});

const remainderInput = (orderId: string, percentBps: number | null) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "remainder" as const,
  percentBps,
  lineIds: null,
});

describe("F8-12 Teil-Rest (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F812-DB-01: Prozent 30 % → Teil-Rest 50 % vom Rest → Closing, Kette bleibt offen", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Teil-Rest", LINES);

    const base = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 3000)));
    expect(base.ordinal).toBe(1);

    // Rest netto 665.000 ct; 50 % davon = 332.500 ct netto → brutto 395.675 ct.
    const remainder = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, 5000)));
    expect(remainder.ordinal).toBe(2);
    expect(remainder.mode).toBe("remainder");
    expect(remainder.grossCents).toBe(395675);

    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.partials.map((entry) => entry.mode)).toEqual(["percent", "remainder"]);
    expect(chain.billedGrossCents).toBe(339150 + 395675);
    expect(chain.remainingGrossCents).toBe(1130500 - 339150 - 395675);

    // Kette ist OFFEN: Closing schließt über den geschrumpften Rest.
    const closing = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, closingInput(orderId)));
    expect(closing.ordinal).toBe(3);
    expect(closing.mode).toBe("closing");
    const closed = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(closed.partials.map((entry) => entry.mode)).toEqual(["percent", "remainder", "closing"]);
    expect(closed.remainingGrossCents).toBe(0);

    // Kette geschlossen: zweites Closing → Conflict (Rest 0).
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, closingInput(orderId)))).rejects
      .toBeInstanceOf(InvoicingConflictError);
  });

  it("F812-DB-02: Guards — ohne Kette, 100 %, Mischsatz, Rest 0, RBAC", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Leer", LINES);
    const mixedId = await seedOrderConfirmation(fixture, "AB Mischsatz", [
      { position: 1, name: "Modul", quantityMilli: 1000, unit: "piece", netCents: 100000, taxRateBps: 1900 },
      { position: 2, name: "Kleinleistung", quantityMilli: 1000, unit: "set", netCents: 50000, taxRateBps: 0 },
    ]);

    // Ohne aktive Teilrechnung kein Teil-Rest (kein F8-04b-Ersatz).
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, 5000)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // 100 % ist closing, kein Teil-Rest (Contract-Refine).
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 3000)));
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, 10000)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Anteil fehlt → Validation.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, null)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Mischsatz im Remainder-Modus fail-closed (v1-Grenze). Kette per
    // lines-Modus aufbauen (Positions-Kopie kennt kein Ein-Satz-Gate).
    const mixedChain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId: mixedId }));
    const mixedLineIds = mixedChain.orderLines.map((line) => line.id);
    expect(mixedLineIds).toHaveLength(2);
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
      orderId: mixedId,
      mode: "lines" as const,
      percentBps: null,
      lineIds: mixedLineIds,
    }));
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(mixedId, 5000)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Rest 0 nach Closing → Conflict.
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, closingInput(orderId)));
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, 5000)))).rejects
      .toBeInstanceOf(InvoicingConflictError);
    // Viewer ohne Schreibrecht → denied.
    await expect(asViewer(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, remainderInput(orderId, 5000)))).rejects
      .toBeInstanceOf(PermissionDeniedError);
  });
});
