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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-07 Scheme')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f807.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f807.test`})
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
      companyName: "F8-07 GmbH",
      companyEmail: "office@f807.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-07 GmbH",
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

const schemeInput = (orderId: string) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "scheme" as const,
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

describe("F8-07 Zahlungsplan-Modus Scheme 30/40/30 (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F807-DB-01: volle Staffel 30/40/Rest, cent-exakt, 4. Aufruf Conflict", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Staffel", LINES);

    const first = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)));
    expect(first.ordinal).toBe(1);
    expect(first.mode).toBe("scheme");
    expect(first.grossCents).toBe(339150);

    const second = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)));
    expect(second.ordinal).toBe(2);
    expect(second.grossCents).toBe(452200);

    const third = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)));
    expect(third.ordinal).toBe(3);
    expect(third.grossCents).toBe(339150);

    // Staffel geht cent-exakt auf: kein Rest, kein Überhang.
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.order.grossCents).toBe(1130500);
    expect(chain.partials.map((entry) => entry.mode)).toEqual(["scheme", "scheme", "scheme"]);
    expect(chain.partials.map((entry) => entry.percentBps)).toEqual([3000, 4000, 3000]);
    expect(chain.billedGrossCents).toBe(1130500);
    expect(chain.remainingGrossCents).toBe(0);

    // Plan erschöpft: vierte Tranche → Conflict.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)))).rejects
      .toBeInstanceOf(InvoicingConflictError);
  });

  it("F807-DB-02: Mischkette, Validation, RBAC", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Mischkette", LINES);
    const mixedId = await seedOrderConfirmation(fixture, "AB Mischsatz", [
      { position: 1, name: "Modul", quantityMilli: 1000, unit: "piece", netCents: 100000, taxRateBps: 1900 },
      { position: 2, name: "Kleinleistung", quantityMilli: 1000, unit: "set", netCents: 50000, taxRateBps: 0 },
    ]);

    // Prozent zuerst: Scheme-Tranchen zählen nur Scheme (Ordinal 2/3).
    const base = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 1000)));
    expect(base.ordinal).toBe(1);
    const first = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)));
    expect(first.ordinal).toBe(2);
    expect(first.mode).toBe("scheme");
    const second = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)));
    expect(second.ordinal).toBe(3);
    // Rest-Tranche überschritte den Cap (10+30+40+30 > 100) → Conflict.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)))).rejects
      .toBeInstanceOf(InvoicingConflictError);

    // Scheme mit Parametern (percentBps/lineIds) → Validation.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, {
      ...schemeInput(orderId), percentBps: 3000,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
    // Mischsatz im Scheme-Modus fail-closed (v1-Grenze wie percent).
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(mixedId)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Viewer ohne Schreibrecht → denied.
    await expect(asViewer(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, schemeInput(orderId)))).rejects
      .toBeInstanceOf(PermissionDeniedError);
  });
});
