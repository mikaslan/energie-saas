import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getDocumentDelivery,
  issueDocument,
  markSentWithDelivery,
  requestInvoicePaymentInput,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  voidDocument,
  InvoicingConflictError,
  InvoicingNotFoundError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-19 GmbH",
      companyEmail: "office@f819.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-19 GmbH",
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
  const email = `${contactId}@f819.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F819 Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F819-Gruppe-${randomUUID().slice(0, 8)}`,
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
): Promise<{ jobId: string; sha256: string }> {
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
  if (claim === null) throw new Error("F819: Claim schlug fehl");
  const bytes = pdfBytes(`f819-${track}-${job.jobId}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await asEditor((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
    attemptCount: claim.attemptCount,
    artifact: { bytes, sha256, sizeBytes: bytes.length, mimeType: "application/pdf" },
  }));
  return { jobId: job.jobId, sha256 };
}

describe("F8-19 Versand-Nachweis (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-19 Versand')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f819.test`}),
          (${viewerId}::uuid, ${`viewer-${viewerId}@f819.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
      `);
    });
    fixture = { workspaceId, editorId, viewerId };
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  it("F819-DB-01: Versand ohne Zahlungs-Job referenziert nur den Invoice-Nachweis", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-ohne-Beleg");
    const invoice = await seedSucceededJob(fixture, documentId, "invoice");
    const before = await asEditor(fixture, (tx, ctx) =>
      getDocumentDelivery(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    expect(before).toBeNull();
    const result = await asEditor(fixture, (tx, ctx) =>
      markSentWithDelivery(tx, ctx, {
        schemaVersion: "commercial-document-delivery-command.v1",
        documentId,
        channel: "manual",
      }));
    expect(result.invoiceJobId).toBe(invoice.jobId);
    expect(result.invoiceArtifactSha256).toBe(invoice.sha256);
    expect(result.paymentJobId).toBeNull();
    expect(result.paymentArtifactSha256).toBeNull();
    const stored = await asEditor(fixture, (tx, ctx) =>
      getDocumentDelivery(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    expect(stored?.channel).toBe("manual");
    expect(stored?.invoiceJobId).toBe(invoice.jobId);
    expect(stored?.sentBy).toBe(fixture.editorId);
  });

  it("F819-DB-02: Versand mit offenem Rest referenziert beide versiegelten Jobs", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-mit-Beleg");
    const invoice = await seedSucceededJob(fixture, documentId, "invoice");
    const payment = await seedSucceededJob(fixture, documentId, "payment");
    const result = await asEditor(fixture, (tx, ctx) =>
      markSentWithDelivery(tx, ctx, {
        schemaVersion: "commercial-document-delivery-command.v1",
        documentId,
        channel: "manual",
      }));
    expect(result.invoiceJobId).toBe(invoice.jobId);
    expect(result.paymentJobId).toBe(payment.jobId);
    expect(result.paymentArtifactSha256).toBe(payment.sha256);
  });

  it("F819-DB-03: Zweitversand und Versand nach Storno sind conflict, nie still", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-doppelt");
    await seedSucceededJob(fixture, documentId, "invoice");
    await asEditor(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId,
      channel: "manual",
    }));
    await expect(asEditor(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId,
      channel: "manual",
    }))).rejects.toBeInstanceOf(InvoicingConflictError);

    const voidedId = await seedIssuedInvoice(fixture, "F819-storno");
    await seedSucceededJob(fixture, voidedId, "invoice");
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: voidedId,
      reason: "created_in_error",
    }));
    await expect(asEditor(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId: voidedId,
      channel: "manual",
    }))).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("F819-DB-04: ohne succeeded-Invoice-Job kein Versand (Gating, kein Teil-Nachweis)", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-ohne-bytes");
    await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    await expect(asEditor(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId,
      channel: "manual",
    }))).rejects.toBeInstanceOf(InvoicingConflictError);
    const stored = await asEditor(fixture, (tx, ctx) =>
      getDocumentDelivery(tx, ctx, { workspaceId: fixture.workspaceId, documentId }));
    expect(stored).toBeNull();
  });

  it("F819-DB-05: CHECKs verweigern Kanal-Fremdwerte, SHA-Bruch und Payment-Halbzeilen", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-checks");
    const invoice = await seedSucceededJob(fixture, documentId, "invoice");
    const attempt = (channel: string, paymentJob: string | null, paymentSha: string | null) =>
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
        await tx.execute(sql`
          insert into commercial_document_delivery (
            workspace_id, document_id, channel, invoice_job_id,
            invoice_artifact_sha256, payment_job_id, payment_artifact_sha256,
            sent_by, sent_at
          ) values (
            ${fixture.workspaceId}::uuid, ${documentId}::uuid, ${channel},
            ${invoice.jobId}::uuid, decode(${invoice.sha256}, 'hex'),
            ${paymentJob}::uuid,
            ${paymentSha === null ? sql`null` : sql`decode(${paymentSha}, 'hex')`},
            ${fixture.editorId}::uuid, now()
          )
        `);
      }).then(() => "inserted").catch((error: unknown) => pgCode(error));
    await expect(attempt("email", null, null)).resolves.toBe("23514");
    await expect(attempt("manual", invoice.jobId, null)).resolves.toBe("23514");
    const shortSha = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      await tx.execute(sql`
        insert into commercial_document_delivery (
          workspace_id, document_id, channel, invoice_job_id,
          invoice_artifact_sha256, payment_job_id, payment_artifact_sha256,
          sent_by, sent_at
        ) values (
          ${fixture.workspaceId}::uuid, ${documentId}::uuid, 'manual',
          ${invoice.jobId}::uuid, decode('00', 'hex'),
          null, null, ${fixture.editorId}::uuid, now()
        )
      `);
    }).then(() => "inserted").catch((error: unknown) => pgCode(error));
    expect(shortSha).toBe("23514");
  });

  it("F819-DB-06: UNIQUE faengt parallele Versuche; Viewer und Fremd-Tenant lesen nichts", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F819-unique");
    const invoice = await seedSucceededJob(fixture, documentId, "invoice");
    await asEditor(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId,
      channel: "manual",
    }));
    const direct = withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      return tx.execute(sql`
        insert into commercial_document_delivery (
          workspace_id, document_id, channel, invoice_job_id,
          invoice_artifact_sha256, payment_job_id, payment_artifact_sha256,
          sent_by, sent_at
        ) values (
          ${fixture.workspaceId}::uuid, ${documentId}::uuid, 'manual',
          ${invoice.jobId}::uuid, decode(${invoice.sha256}, 'hex'),
          null, null, ${fixture.editorId}::uuid, now()
        )
      `);
    }).then(() => "inserted").catch((error: unknown) => pgCode(error));
    await expect(direct).resolves.toBe("23505");

    await expect(asViewer(fixture, (tx, ctx) =>
      getDocumentDelivery(tx, ctx, { workspaceId: fixture.workspaceId, documentId })
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) => markSentWithDelivery(tx, ctx, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId,
      channel: "manual",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    const foreignWorkspaceId = randomUUID();
    await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F819 fremd')`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${foreignWorkspaceId}::uuid, ${fixture.editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    await expect(
      withAuthorizedTenantOn(testPool, fixture.editorId, foreignWorkspaceId, (tx, ctx) =>
        getDocumentDelivery(tx, ctx, { workspaceId: foreignWorkspaceId, documentId })),
    ).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });
});
