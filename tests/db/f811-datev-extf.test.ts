import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  INVOICING_DATEV_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  exportDatevBatch,
  issueDocument,
  upsertInvoicingSettings,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-11 DATEV')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f811.test`})
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
      companyName: "F8-11 GmbH",
      companyEmail: "office@f811.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-11 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

function berlinMonth(): string {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function seedContact(fixture: Fixture): Promise<string> {
  const contactId = randomUUID();
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F811 Kundin',
        'Fixture', 'Contact', 'kunde@f811.example', 'kunde@f811.example',
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  return contactId;
}

async function seedIssuedInvoice(
  fixture: Fixture,
  name: string,
  contactId: string,
  taxRateBps: 1900 | 0,
): Promise<void> {
  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  await asEditor((tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()));
  const netCents = 100000;
  const id = await asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice", name, groupId: null, projectId: null,
      contactId, dueDate: "2026-12-31",
      skontoPercentBps: null, skontoDays: null,
      deliveryDate: "2026-11-15", validityDate: null,
      plannedDeliveryDate: null, plannedServiceDate: null,
      creditNoteType: null,
    },
  })).then((result) => result.id);
  await asEditor((tx, ctx) => createDocumentLine(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
    documentId: id,
    input: {
      position: 1, name: "PV-Module", quantityMilli: 10000,
      unit: "piece", netCents, taxRateBps,
    },
  }));
  await asEditor((tx, ctx) => issueDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
    documentId: id,
  }));
}

describe("F8-11 DATEV-EXTF Buchungsstapel (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F811-DB-01: Monatsstapel enthält ausgestellte Rechnung (SKR03)", async () => {
    const contactId = await seedContact(fixture);
    await seedIssuedInvoice(fixture, "F811-Rechnung", contactId, 1900);
    const month = berlinMonth();
    const result = await asEditor(fixture, (tx, ctx) => exportDatevBatch(tx, ctx, {
      schemaVersion: INVOICING_DATEV_COMMAND_VERSION,
      month,
      skr: "03",
    }));
    expect(result.contentType).toBe("text/csv; charset=utf-8");
    expect(result.fileName).toBe(`datev-buchungsstapel-${month}-skr03.csv`);
    expect(result.content).toContain("EXTF;700;21;Buchungsstapel;");
    expect(result.content).toContain(";S;1400;8400;;");
    expect(result.content).toContain("1190,00");
  });

  it("F811-DB-02: 0-%-Beleg verweigert den Monatsstapel fail-closed", async () => {
    const contactId = await seedContact(fixture);
    await seedIssuedInvoice(fixture, "F811-Rechnung-Null", contactId, 0);
    await expect(asEditor(fixture, (tx, ctx) => exportDatevBatch(tx, ctx, {
      schemaVersion: INVOICING_DATEV_COMMAND_VERSION,
      month: berlinMonth(),
      skr: "04",
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
  });
});
