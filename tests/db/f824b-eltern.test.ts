import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  issueDocument,
  listPartialInvoices,
  recordPayment,
  voidDocument,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-24b Eltern-Zahlstatus')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f824b.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f824b.test`})
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
      companyName: "F8-24b GmbH",
      companyEmail: "office@f824b.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-24b GmbH",
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

// AB: netto 950.000 ct, 19 % → brutto 1.130.500 ct; 30 % → 339.150 ct brutto.
const LINES: LineSeed[] = [
  { position: 1, name: "PV-Module", quantityMilli: 20000, unit: "piece", netCents: 800000, taxRateBps: 1900 },
  { position: 2, name: "Montage", quantityMilli: 1000, unit: "set", netCents: 150000, taxRateBps: 1900 },
];

const partialInput = (orderId: string, percentBps: number) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "percent" as const,
  percentBps,
  lineIds: null,
  amountCents: null,
});

describe("F8-24b Eltern-Zahlungsstatus (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  async function seedChain(fx: Fixture, percents: number[]): Promise<{ orderId: string; childIds: string[] }> {
    const orderId = await seedOrderConfirmation(fx, "AB Eltern", LINES);
    const childIds: string[] = [];
    for (const percentBps of percents) {
      const created = await asEditor(fx, (tx, ctx) =>
        createPartialInvoice(tx, ctx, partialInput(orderId, percentBps)));
      childIds.push(created.id);
    }
    return { orderId, childIds };
  }

  async function issue(fx: Fixture, documentId: string): Promise<void> {
    await asEditor(fx, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId,
    }));
  }

  async function pay(fx: Fixture, documentId: string, paidCents: number): Promise<void> {
    await asEditor(fx, (tx, ctx) => recordPayment(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION, documentId, paidCents,
    }));
  }

  it("F824B-DB-01: leere Kette — paid 0, open 0, Status unpaid (0-EUR-Regel)", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Leer", LINES);
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.billedGrossCents).toBe(0);
    expect(chain.paidGrossCents).toBe(0);
    expect(chain.openGrossCents).toBe(0);
    expect(chain.parentPaymentStatus).toBe("unpaid");
  });

  it("F824B-DB-02: Kette ohne Zahlungen — paid 0, open = billed, Status unpaid", async () => {
    const { orderId } = await seedChain(fixture, [3000, 3000]);
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.billedGrossCents).toBe(678300);
    expect(chain.paidGrossCents).toBe(0);
    expect(chain.openGrossCents).toBe(678300);
    expect(chain.parentPaymentStatus).toBe("unpaid");
  });

  it("F824B-DB-03: Teilzahlung auf ein Kind — paid/open anteilig, Status partially_paid", async () => {
    const { orderId, childIds } = await seedChain(fixture, [3000, 3000]);
    await issue(fixture, childIds[0]!);
    await pay(fixture, childIds[0]!, 100000);
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.billedGrossCents).toBe(678300);
    expect(chain.paidGrossCents).toBe(100000);
    expect(chain.openGrossCents).toBe(578300);
    expect(chain.parentPaymentStatus).toBe("partially_paid");
  });

  it("F824B-DB-04: Vollzahlung aller Kinder — open 0, Status paid", async () => {
    const { orderId, childIds } = await seedChain(fixture, [3000, 3000]);
    for (const childId of childIds) {
      await issue(fixture, childId);
      await pay(fixture, childId, 339150);
    }
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.billedGrossCents).toBe(678300);
    expect(chain.paidGrossCents).toBe(678300);
    expect(chain.openGrossCents).toBe(0);
    expect(chain.parentPaymentStatus).toBe("paid");
  });

  it("F824B-DB-05: storniertes Kind zaehlt weder bei paid noch bei billed", async () => {
    const { orderId, childIds } = await seedChain(fixture, [3000, 3000]);
    await issue(fixture, childIds[0]!);
    await pay(fixture, childIds[0]!, 100000);
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: childIds[0]!, reason: "cancelled",
    }));
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.partials).toHaveLength(2);
    expect(chain.billedGrossCents).toBe(339150);
    expect(chain.paidGrossCents).toBe(0);
    expect(chain.openGrossCents).toBe(339150);
    expect(chain.parentPaymentStatus).toBe("unpaid");
  });
});
