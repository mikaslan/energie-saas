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
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  createPartialInvoice,
  listPartialInvoices,
  voidDocument,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingNotFoundError,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-05 Teilrechnung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f805.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f805.test`})
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
      companyName: "F8-05 GmbH",
      companyEmail: "office@f805.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-05 GmbH",
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

const partialInput = (
  orderId: string,
  extra: { mode: "percent" | "lines"; percentBps: number | null; lineIds: string[] | null },
) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_PARTIAL_COMMAND_VERSION,
  orderId,
  ...extra,
});

function berlinPlus14(): string {
  const berlinToday = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const due = new Date(berlinToday.getTime() + 14 * 24 * 60 * 60 * 1000);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
}

describe("F8-05 Teilrechnungen zum Auftrag (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F805-DB-01: Prozent-Kette 30+30+40, Cap bei Überziehung", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Sonne", LINES);

    const first = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 3000, lineIds: null })));
    expect(first.ordinal).toBe(1);
    expect(first.mode).toBe("percent");
    expect(first.grossCents).toBe(339150);

    const second = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 3000, lineIds: null })));
    expect(second.ordinal).toBe(2);

    // 50 % brächen den Cap (678.300 + 565.250 > 1.130.500) — Rollback.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 5000, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingConflictError);

    const third = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 4000, lineIds: null })));
    expect(third.ordinal).toBe(3);
    expect(third.grossCents).toBe(452200);

    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.order.grossCents).toBe(1130500);
    expect(chain.partials.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(chain.billedGrossCents).toBe(1130500);
    expect(chain.remainingGrossCents).toBe(0);
    expect(chain.partials.every((entry) => entry.mode === "percent")).toBe(true);
  });

  it("F805-DB-02: Positions-Modus mit Verbrauch, Doppelverbrauch, Storno-Freigabe", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Positionen", LINES);
    // Zeilen-IDs über autorisierten Kontext (Actor-Policies auf
    // commercial_document_line, kein withTenantOn-Rohzugriff).
    const lineIds = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => tx.execute<{ id: string }>(sql`
        select line.id
          from commercial_document_line line
         where line.workspace_id = ${ctx.workspaceId}::uuid and line.document_id = ${orderId}::uuid
         order by line.position asc
      `),
    ).then((result) => result.rows.map((row) => row.id));

    const first = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "lines", percentBps: null, lineIds: [lineIds[0]] })));
    expect(first.ordinal).toBe(1);
    expect(first.grossCents).toBe(952000);

    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.consumedLineIds).toEqual([lineIds[0]]);
    expect(chain.remainingGrossCents).toBe(1130500 - 952000);

    // Doppelverbrauch derselben Position → Konflikt (kein Cap-Problem).
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "lines", percentBps: null, lineIds: [lineIds[0]] })))).rejects
      .toBeInstanceOf(InvoicingConflictError);

    // Storno gibt Position UND Budget frei.
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: first.id,
      reason: "cancelled",
    }));
    const retry = await asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "lines", percentBps: null, lineIds: [lineIds[0]] })));
    expect(retry.ordinal).toBe(1);
    const after = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(after.partials).toHaveLength(2);
    expect(after.billedGrossCents).toBe(952000);
  });

  it("F805-DB-03: Validation, NotFound, RBAC, Isolation, Race", async () => {
    const orderId = await seedOrderConfirmation(fixture, "AB Guards", LINES);
    const mixedId = await seedOrderConfirmation(fixture, "AB Mischsatz", [
      { position: 1, name: "Modul", quantityMilli: 1000, unit: "piece", netCents: 100000, taxRateBps: 1900 },
      { position: 2, name: "Kleinleistung", quantityMilli: 1000, unit: "set", netCents: 50000, taxRateBps: 0 },
    ]);

    // Modus/Parameter inkonsistent.
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: null, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "lines", percentBps: null, lineIds: [] })))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Mischsatz im Prozent-Modus fail-closed (v1-Grenze).
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(mixedId, { mode: "percent", percentBps: 5000, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    // Keine AB (Rechnung) und unbekannte ID.
    const invoiceId = await asEditor(fixture, (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice", name: "Rechnung X", groupId: null, projectId: null,
        contactId: null, dueDate: berlinPlus14(), skontoPercentBps: null, skontoDays: null,
        deliveryDate: null, validityDate: null, plannedDeliveryDate: null,
        plannedServiceDate: null, creditNoteType: null,
      },
    })).then((result) => result.id);
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(invoiceId, { mode: "percent", percentBps: 1000, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingValidationError);
    await expect(asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(randomUUID(), { mode: "percent", percentBps: 1000, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingNotFoundError);
    // Viewer ohne Schreibrecht.
    await expect(asViewer(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 1000, lineIds: null })))).rejects
      .toBeInstanceOf(PermissionDeniedError);
    // Fremdmandant: gleiche generische NotFound, kein Orakel.
    const other = await seedFixture();
    await expect(asEditor(other, (tx, ctx) => createPartialInvoice(tx, ctx,
      partialInput(orderId, { mode: "percent", percentBps: 1000, lineIds: null })))).rejects
      .toBeInstanceOf(InvoicingNotFoundError);

    // Race: zwei 60-%-Creates serialisiert — genau eines gewinnt.
    const outcomes = await Promise.allSettled([0, 1].map(() =>
      asEditor(fixture, (tx, ctx) => createPartialInvoice(tx, ctx,
        partialInput(orderId, { mode: "percent", percentBps: 6000, lineIds: null }))),
    ));
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvoicingConflictError);
    const chain = await asEditor(fixture, (tx, ctx) => listPartialInvoices(tx, ctx, { orderId }));
    expect(chain.partials.map((entry) => entry.ordinal)).toEqual([1]);
  });
});
