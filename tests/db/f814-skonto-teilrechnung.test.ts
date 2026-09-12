import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  issueDocument,
  listPartialInvoices,
  setDocumentTerms,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-14 Skonto')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f814.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f814.test`})
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
      companyName: "F8-14 GmbH",
      companyEmail: "office@f814.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-14 GmbH",
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

const percentInput = (orderId: string, percentBps: number) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  mode: "percent" as const,
  percentBps,
  amountCents: null,
  lineIds: null,
});

const termsInput = (documentId: string, skontoPercentBps: number | null, skontoDays: number | null) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
  documentId,
  skontoPercentBps,
  skontoDays,
});

const issueInput = (documentId: string) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  documentId,
});

describe("F8-14 Skonto je Teilrechnung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F814-DB-01: Kind-Kondition je Teilrechnung, Kette zeigt sie, Ausstellung friert ein", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Skonto", LINES);
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 3000)));
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 3000)));

    // Neues Kind startet ohne Skonto-Copy (null), Kette zeigt null.
    const fresh = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(fresh.partials).toHaveLength(2);
    const kind1 = fresh.partials[0]!;
    expect(kind1.skontoPercentBps).toBeNull();
    expect(kind1.skontoDays).toBeNull();
    expect(fresh.partials[1]?.skontoPercentBps).toBeNull();

    // Eigene Kondition am Kind 1: 2 % / 14 Tage.
    const updated = await asEditor(fixture, (tx, ctx) => setDocumentTerms(tx, ctx, termsInput(kind1.invoiceId, 200, 14)));
    expect(updated.skontoPercentBps).toBe(200);
    expect(updated.skontoDays).toBe(14);

    // Kette zeigt die Kind-Kondition, Geschwister + AB bleiben null.
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.partials[0]?.skontoPercentBps).toBe(200);
    expect(chain.partials[0]?.skontoDays).toBe(14);
    expect(chain.partials[1]?.skontoPercentBps).toBeNull();
    expect(chain.partials[1]?.skontoDays).toBeNull();

    // Ausstellung: Kondition bleibt erhalten und friert ein.
    const issued = await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, issueInput(kind1.invoiceId)));
    expect(issued.skontoPercentBps).toBe(200);
    expect(issued.skontoDays).toBe(14);
    await expect(asEditor(fixture, (tx, ctx) => setDocumentTerms(tx, ctx, termsInput(kind1.invoiceId, 300, 10)))).rejects
      .toBeInstanceOf(InvoicingConflictError);
  });

  it("F814-DB-02: Guards — AB nimmt keine Kondition, Halbpaar abgewiesen, Viewer-denied", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Guard", LINES);
    await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx, percentInput(orderId, 3000)));
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    const kindId = chain.partials[0]!.invoiceId;

    // AB (order_confirmation) ist kein invoice-Typ → Validation.
    await expect(asEditor(fixture, (tx, ctx) => setDocumentTerms(tx, ctx, termsInput(orderId, 200, 14)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Halb gesetzte Kondition (nur Prozent) → Validation (Refine).
    await expect(asEditor(fixture, (tx, ctx) => setDocumentTerms(tx, ctx, termsInput(kindId, 200, null)))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Viewer ohne Schreibrecht → denied (ändert nichts am Kind).
    await expect(asViewer(fixture, (tx, ctx) => setDocumentTerms(tx, ctx, termsInput(kindId, 200, 14)))).rejects
      .toBeInstanceOf(PermissionDeniedError);
    const unchanged = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(unchanged.partials[0]?.skontoPercentBps).toBeNull();
  });
});
