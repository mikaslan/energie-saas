import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  exportDocumentCii,
  getDocumentDetail,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-10 CII')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f810.test`})
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
      companyName: "F8-10 GmbH",
      companyEmail: "office@f810.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-10 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedContact(
  fixture: Fixture,
  displayName: string,
  street: string | null,
): Promise<string> {
  const contactId = randomUUID();
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, ${displayName},
        'Fixture', 'Contact', 'kunde@f810.example', 'kunde@f810.example',
        ${street}, ${street === null ? null : "7"}, '10115', 'Berlin', 'DE'
      )
    `);
  });
  return contactId;
}

async function seedIssuedInvoice(fixture: Fixture, name: string, contactId: string): Promise<string> {
  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  await asEditor((tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()));
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
  const lines = [
    { position: 1, name: "PV-Module", quantityMilli: 20000, unit: "piece" as const, netCents: 800000, taxRateBps: 1900 as const },
    { position: 2, name: "Montage", quantityMilli: 1000, unit: "set" as const, netCents: 150000, taxRateBps: 1900 as const },
  ];
  for (const line of lines) {
    await asEditor((tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: id,
      input: line,
    }));
  }
  await asEditor((tx, ctx) => issueDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
    documentId: id,
  }));
  return id;
}

describe("F8-10 E-Rechnung CII-Export (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F810-DB-01: ausgestellte Rechnung exportiert Belegnummer als CII-XML", async () => {
    const contactId = await seedContact(fixture, "F810 Kundin", "Pruefweg");
    const documentId = await seedIssuedInvoice(fixture, "F810-Rechnung", contactId);
    const result = await asEditor(fixture, (tx, ctx) => exportDocumentCii(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
      type: "invoice",
      documentId,
    }));
    expect(result.contentType).toBe("application/xml");
    expect(result.fileName.endsWith(".xml")).toBe(true);
    expect(result.content).toContain("CrossIndustryInvoice");
    // Dateiname und XML tragen die vergebene Belegnummer (kein Platzhalter).
    const detail = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId,
    }));
    const number = detail.document.number;
    expect(number).not.toBeNull();
    expect(result.content).toContain(number as string);
    const sanitized = (number as string).replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    expect(result.fileName).toContain(sanitized);
  });

  it("F810-DB-02: unvollständige Käuferadresse verweigert fail-closed", async () => {
    const contactId = await seedContact(fixture, "F810 Ohne Strasse", null);
    const documentId = await seedIssuedInvoice(fixture, "F810-Rechnung-Adresse", contactId);
    await expect(asEditor(fixture, (tx, ctx) => exportDocumentCii(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
      type: "invoice",
      documentId,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
  });
});
