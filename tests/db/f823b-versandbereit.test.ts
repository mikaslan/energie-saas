import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  listDocuments,
  markSentWithDelivery,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import { testPool } from "../setup/test-db";

// F8-23b (F823B-DB-01/02): versandbereit-Preset-Semantik.
// Seed-Pfad = F819-Spiegel (Service statt SQL): Dokument + Job + Versand.
type Fixture = { workspaceId: string; editorId: string };

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F823B GmbH",
      companyEmail: "office@f823b.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F823B GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedIssuedInvoice(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f823b.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F823B Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F823B-Gruppe-${randomUUID().slice(0, 8)}`,
  })).then((result) => result.id);
  const documentId = await asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice", name, groupId, projectId: null, contactId,
      dueDate: "2026-12-31", skontoPercentBps: null, skontoDays: null,
      deliveryDate: null, validityDate: null, plannedDeliveryDate: null,
      plannedServiceDate: null, creditNoteType: null,
    },
  })).then((result) => result.id);
  await asEditor((tx, ctx) => createDocumentLine(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
    documentId,
    input: {
      position: 1, name: "PV-Module", quantityMilli: 10000,
      unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
    },
  }));
  await asEditor((tx, ctx) => issueDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
    documentId,
  }));
  return documentId;
}

async function seedSucceededInvoiceJob(fixture: Fixture, documentId: string): Promise<void> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const job = await asEditor((tx, ctx) => requestInvoicePdfInput(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
    documentId,
  }));
  const leaseToken = randomUUID();
  const claim = await asEditor((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("F823B: Claim schlug fehl");
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from(`f823b-${job.jobId}`, "latin1"),
    Buffer.alloc(128, 0x61),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await asEditor((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
    attemptCount: claim.attemptCount,
    artifact: { bytes, sha256, sizeBytes: bytes.length, mimeType: "application/pdf" },
  }));
}

describe("F823B-DB versandbereit-Preset", () => {
  let fixture: Fixture;
  let readyId = "";
  let noJobId = "";
  let sentId = "";

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F823B')`);
      await tx.execute(sql`insert into user_identity (id, email) values (${editorId}::uuid, ${`ed-${editorId}@f823b.test`})`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    fixture = { workspaceId, editorId };
    await withAuthorizedTenantOn(testPool, editorId, workspaceId, (tx, ctx) =>
      upsertInvoicingSettings(tx, ctx, settingsCommand()));
    readyId = await seedIssuedInvoice(fixture, "Bereit");
    await seedSucceededInvoiceJob(fixture, readyId);
    noJobId = await seedIssuedInvoice(fixture, "KeinJob");
    sentId = await seedIssuedInvoice(fixture, "SchonWeg");
    await seedSucceededInvoiceJob(fixture, sentId);
    await withAuthorizedTenantOn(testPool, editorId, workspaceId, (tx, ctx) =>
      markSentWithDelivery(tx, ctx, {
        schemaVersion: "commercial-document-delivery-command.v1",
        documentId: sentId,
        channel: "manual",
      }));
  });

  async function list(filters: Record<string, unknown>) {
    return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx, ctx) =>
      listDocuments(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
        type: "invoice",
        filters,
      }),
    );
  }

  it("DB-01: versandbereit=true liefert nur issued + unversendet + succeeded-Job", async () => {
    const result = await list({ versandbereit: true });
    expect(result.items.map((d) => d.id)).toEqual([readyId]);
  });

  it("DB-02: ohne Job / versendet ausgeschlossen", async () => {
    const result = await list({ versandbereit: true });
    const ids = result.items.map((d) => d.id);
    expect(ids).not.toContain(noJobId);
    expect(ids).not.toContain(sentId);
  });

  it("DB-02: versandbereit=false liefert alle", async () => {
    const result = await list({ versandbereit: false });
    expect(result.items).toHaveLength(3);
  });

  it("DB-03: hasSucceededInvoiceJob je Dokument (Job-Existenz, unabhaengig von sent)", async () => {
    const result = await list({});
    const byId = new Map(result.items.map((d) => [d.id, d.hasSucceededInvoiceJob]));
    expect(byId.get(readyId)).toBe(true);
    expect(byId.get(noJobId)).toBe(false);
    // Versendetes Dok hat succeeded-Job (Flag true), Preset schliesst via sent_at aus.
    expect(byId.get(sentId)).toBe(true);
  });
});
