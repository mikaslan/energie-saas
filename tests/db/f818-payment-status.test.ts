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
  COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  INVOICE_PAYMENT_TEMPLATE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getInvoicePdfStatus,
  issueDocument,
  listInvoicePdfs,
  readInvoicePdfArtifact,
  requestInvoicePaymentInput,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-18 GmbH",
      companyEmail: "office@f818.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-18 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

function pdfBytes(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from(marker, "latin1"),
    Buffer.alloc(128, 0x61),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
}

async function seedIssuedInvoice(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f818.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F818 Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F818-Gruppe-${randomUUID().slice(0, 8)}`,
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

async function seedSucceededJob(
  fixture: Fixture,
  documentId: string,
  track: "invoice" | "payment",
): Promise<{ jobId: string; sha256: string; bytes: Buffer }> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const job = track === "invoice"
    ? await asEditor((tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    }))
    : await asEditor((tx, ctx) => requestInvoicePaymentInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
      documentId,
    }));
  const leaseToken = randomUUID();
  const claim = await asEditor((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("F818: Claim schlug fehl");
  const bytes = pdfBytes(`f818-${track}-${job.jobId}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await asEditor((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
    attemptCount: claim.attemptCount,
    artifact: { bytes, sha256, sizeBytes: bytes.length, mimeType: "application/pdf" },
  }));
  return { jobId: job.jobId, sha256, bytes };
}

describe("F8-18 Payment-Track-Projektion (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-18 Payment')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f818.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    fixture = { workspaceId, editorId };
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);

  it("F818-DB-01: listInvoicePdfs projiziert templateVersion je Track", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F818-tracks");
    const invoice = await seedSucceededJob(fixture, documentId, "invoice");
    const payment = await seedSucceededJob(fixture, documentId, "payment");
    const jobs = await asEditor(fixture, (tx, ctx) =>
      listInvoicePdfs(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    expect(jobs).toHaveLength(2);
    const byId = new Map(jobs.map((job) => [job.jobId, job]));
    expect(byId.get(invoice.jobId)?.templateVersion).toBe(INVOICE_PDF_TEMPLATE_VERSION);
    expect(byId.get(payment.jobId)?.templateVersion).toBe(INVOICE_PAYMENT_TEMPLATE_VERSION);
    expect(byId.get(invoice.jobId)?.state).toBe("succeeded");
    expect(byId.get(payment.jobId)?.state).toBe("succeeded");
  });

  it("F818-DB-02: Payment-Artefakt liest versiegelte Bytes mit -zahlung.pdf-Dateiname", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F818-artefakt");
    await seedSucceededJob(fixture, documentId, "invoice");
    const payment = await seedSucceededJob(fixture, documentId, "payment");
    const status = await asEditor(fixture, (tx, ctx) =>
      getInvoicePdfStatus(tx, ctx, {
        workspaceId: fixture.workspaceId,
        documentId,
        jobId: payment.jobId,
      }));
    expect(status.templateVersion).toBe(INVOICE_PAYMENT_TEMPLATE_VERSION);
    const artifact = await asEditor(fixture, (tx, ctx) =>
      readInvoicePdfArtifact(tx, ctx, {
        workspaceId: fixture.workspaceId,
        documentId,
        jobId: payment.jobId,
      }));
    expect(artifact.filename).toMatch(/-zahlung\.pdf$/u);
    expect(artifact.sha256).toBe(payment.sha256);
    expect(artifact.bytes.equals(payment.bytes)).toBe(true);
    const jobs = await asEditor(fixture, (tx, ctx) =>
      listInvoicePdfs(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    const invoiceJobId = jobs.find(
      (job) => job.templateVersion === INVOICE_PDF_TEMPLATE_VERSION,
    )?.jobId;
    if (!invoiceJobId) throw new Error("F818-DB-02: Invoice-Job fehlt");
    const invoiceArtifact = await asEditor(fixture, (tx, ctx) =>
      readInvoicePdfArtifact(tx, ctx, {
        workspaceId: fixture.workspaceId,
        documentId,
        jobId: invoiceJobId,
      }));
    expect(invoiceArtifact.filename.endsWith("-zahlung.pdf")).toBe(false);
    expect(invoiceArtifact.filename.endsWith(".pdf")).toBe(true);
  });

  it("F818-DB-03: Partition ist disjunkt — kein Job traegt beide Tracks", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F818-partition");
    await seedSucceededJob(fixture, documentId, "invoice");
    await seedSucceededJob(fixture, documentId, "payment");
    const jobs = await asEditor(fixture, (tx, ctx) =>
      listInvoicePdfs(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    const invoiceJobs = jobs.filter((job) => job.templateVersion === INVOICE_PDF_TEMPLATE_VERSION);
    const paymentJobs = jobs.filter((job) => job.templateVersion === INVOICE_PAYMENT_TEMPLATE_VERSION);
    expect(invoiceJobs).toHaveLength(1);
    expect(paymentJobs).toHaveLength(1);
    expect(invoiceJobs[0]?.jobId).not.toBe(paymentJobs[0]?.jobId);
  });
});
