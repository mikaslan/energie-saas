import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  recordPayment,
  requestInvoicePaymentInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import type { ServiceCtx } from "@/lib/permissions";
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
      companyName: "F8-17 GmbH",
      companyEmail: "office@f817.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-17 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedIssuedInvoice(fixture: Fixture, name: string): Promise<string> {
  const workspaceId = fixture.workspaceId;
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f817.test`;
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'Muster GmbH', 'Ada', 'Lovelace',
        ${email}, ${email},
        'Musterstrasse', '12a', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F817-Gruppe-${randomUUID().slice(0, 8)}`,
  })).then((result) => result.id);
  const documentId = await asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice",
      name,
      groupId,
      projectId: null,
      contactId,
      dueDate: "2026-11-30",
      skontoPercentBps: null,
      skontoDays: null,
      deliveryDate: null,
      validityDate: null,
      plannedDeliveryDate: null,
      plannedServiceDate: null,
      creditNoteType: null,
    },
  })).then((result) => result.id);
  await asEditor((tx, ctx) => createDocumentLine(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
    documentId,
    input: {
      position: 1, name: "Position 1", quantityMilli: 1000,
      unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
    },
  }));
  await asEditor((tx, ctx) => issueDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
    documentId,
  }));
  return documentId;
}

describe("F8-17 Zahlungsbeleg-Anforderung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-17 Payment')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f817.test`})
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

  it("F817-CT-00: Payment-Anforderung ist exportiert", () => {
    expect(typeof requestInvoicePaymentInput).toBe("function");
    expect(COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION)
      .toBe("commercial-document-payment-render-command.v1");
  });

  it("F817-CT-02: offener Rest erzeugt versiegelten Payment-Job", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F817-offen");
    const job = await asEditor(fixture, (tx, ctx) => requestInvoicePaymentInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    expect(job.status).toBe("requested");
    expect(job.amountCents).toBe(119000);
    const stored = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ template_version: string; recipe: string }>(sql`
        select template_version, renderer_recipe as recipe
          from commercial_document_render_job
         where id = ${job.jobId}::uuid
      `);
      return rows.rows[0];
    });
    expect(stored?.template_version).toBe("invoice-payment-template.v1");
    expect(stored?.recipe).toBe("invoice-payment-renderer-recipe.v1");
  });

  it("F817-CT-02: vollbezahlte Rechnung wird abgewiesen", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F817-bezahlt");
    await asEditor(fixture, (tx, ctx) => recordPayment(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
      documentId,
      paidCents: 119000,
    }));
    await expect(asEditor(fixture, (tx, ctx) => requestInvoicePaymentInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
      documentId,
    }))).rejects.toThrow();
  });

  it("F817-CT-04: Payment-Job durchlaeuft Claim→Finalize mit eigenem Tripel", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F817-worker");
    const job = await asEditor(fixture, (tx, ctx) => requestInvoicePaymentInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    const leaseToken = randomUUID();
    const claim = await asEditor(fixture, (tx) => claimInvoicePdfRenderJob(tx, {
      workspaceId: fixture.workspaceId,
      jobId: job.jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("F817-CT-04: Payment-Claim schlug fehl");
    expect(claim.templateVersion).toBe("invoice-payment-template.v1");
    expect(claim.inputVersion).toBe("invoice-payment-input.v1");
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      Buffer.alloc(128, 0x65),
      Buffer.from("\n%%EOF", "latin1"),
    ]);
    const { createHash } = await import("node:crypto");
    const completion = await asEditor(fixture, (tx) => finalizeInvoicePdfRenderSuccess(tx, {
      workspaceId: fixture.workspaceId,
      jobId: job.jobId,
      leaseToken,
      attemptCount: claim.attemptCount,
      artifact: {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        mimeType: "application/pdf",
      },
    }));
    expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });
  });
});
