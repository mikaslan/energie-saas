import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  voidDocument,
  upsertInvoicingSettings,
  InvoicingConflictError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-09 Sperre')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f809.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-09 GmbH",
      companyEmail: "office@f809.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-09 GmbH",
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
  type: "order_confirmation" | "invoice",
  name: string,
): Promise<string> {
  await ensureSettings(fixture);
  const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  const groupId = await run((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `Gruppe ${name}`,
  })).then((result) => result.id);
  return run((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type, name, groupId, projectId: null,
      contactId: null,
      dueDate: type === "invoice" ? "2026-11-30" : null,
      skontoPercentBps: null, skontoDays: null,
      deliveryDate: null, validityDate: null,
      plannedDeliveryDate: type === "order_confirmation" ? "2026-11-01" : null,
      plannedServiceDate: type === "order_confirmation" ? "2026-11-15" : null,
      creditNoteType: null,
    },
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

describe("F8-09 Eltern-Sperre (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F809-DB-01: belegte AB sperrt, Storno gibt frei", async () => {
    const orderId = await seedDocument(fixture, "order_confirmation", "AB Sperre");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 1, 800000)));
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 2, 150000)));

    const partial = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
      orderId,
      mode: "percent",
      percentBps: 3000,
      amountCents: null,
      lineIds: null,
    }));

    // Dritte Position an belegter AB → Conflict (Kettenbasis fix).
    await expect(asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 3, 50000)))).rejects
      .toBeInstanceOf(InvoicingConflictError);

    // Storno der Teilrechnung befreit die AB wieder.
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: partial.id,
      reason: "cancelled",
    }));
    const freed = await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 3, 50000)));
    expect(freed.documentId).toBe(orderId);
  });

  it("F809-DB-02: freie AB und freie Rechnung unberührt", async () => {
    const orderId = await seedDocument(fixture, "order_confirmation", "AB Frei");
    const invoiceId = await seedDocument(fixture, "invoice", "Rechnung Frei");

    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 1, 100000)));
    const second = await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(orderId, 2, 50000)));
    expect(second.documentId).toBe(orderId);

    const line = await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(invoiceId, 1, 70000)));
    expect(line.documentId).toBe(invoiceId);
  });
});
