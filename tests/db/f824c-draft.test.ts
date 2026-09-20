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
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  readInvoicePdfArtifact,
  requestDraftPdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { PermissionDeniedError } from "@/lib/permissions";
import { InvoicingValidationError } from "@/modules/invoicing/errors";
import {
  claimDraftPdfRenderJob,
  finalizeDraftPdfRenderSuccess,
} from "@/worker/draft-pdf-database";
import type { ServiceCtx } from "@/lib/permissions";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F824C GmbH",
      companyEmail: "office@f824c.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F824C GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedContact(fixture: Fixture): Promise<string> {
  const contactId = randomUUID();
  const email = `${contactId}@f824c.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'Muster GmbH', 'Ada', 'Lovelace',
        ${email}, ${email},
        'Musterstrasse', '12a', '10115', 'Berlin', 'DE'
      )
    `);
  });
  return contactId;
}

async function seedDraftInvoice(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = await seedContact(fixture);
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F824C-Gruppe-${randomUUID().slice(0, 8)}`,
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
  return documentId;
}

async function seedLetterDraft(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F824C-Gruppe-${randomUUID().slice(0, 8)}`,
  })).then((result) => result.id);
  return asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "letter",
      name,
      groupId,
      projectId: null,
      contactId: null,
      dueDate: null,
      skontoPercentBps: null,
      skontoDays: null,
      deliveryDate: null,
      validityDate: "2026-12-31",
      plannedDeliveryDate: null,
      plannedServiceDate: null,
      creditNoteType: null,
    },
  })).then((result) => result.id);
}

describe("F8-24c Draft-Vorschau-Anforderung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-24c Draft')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f824c.test`}),
          (${viewerId}::uuid, ${`viewer-${viewerId}@f824c.test`})
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

  it("F824C-CT-01: Draft-Anforderung ist exportiert (eigene Command-Version)", () => {
    expect(typeof requestDraftPdfInput).toBe("function");
    expect(COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION)
      .toBe("commercial-document-draft-render-command.v1");
  });

  it("F824C-CT-01: ohne invoicing.write wird verweigert", async () => {
    const documentId = await seedDraftInvoice(fixture, "F824C-denied");
    await expect(asViewer(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F824C-CT-01: Letter-Draft fail-closed (vor jedem Job-Insert)", async () => {
    const documentId = await seedLetterDraft(fixture, "F824C-Brief");
    await expect(asEditor(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F824C-CT-01: ausgestellter Beleg wird abgewiesen (nur draft)", async () => {
    const documentId = await seedDraftInvoice(fixture, "F824C-issued");
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId,
    }));
    await expect(asEditor(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F824C-CT-01: Draft erzeugt versiegelten Draft-Job", async () => {
    const documentId = await seedDraftInvoice(fixture, "F824C-offen");
    const job = await asEditor(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    expect(job.status).toBe("requested");
    expect(job.inputSha256Hex).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ template_version: string; recipe: string; schema: string }>(sql`
        select template_version, renderer_recipe as recipe,
               input_json ->> 'schemaVersion' as schema
          from commercial_document_render_job
         where id = ${job.jobId}::uuid
      `);
      return rows.rows[0];
    });
    expect(stored?.template_version).toBe("draft-pdf-template.v1");
    expect(stored?.recipe).toBe("draft-pdf-renderer-recipe.v1");
    expect(stored?.schema).toBe("draft-pdf-input.v1");
  });

  it("F824C-CT-01: Draft-Job durchlaeuft Claim→Finalize mit eigenem Tripel", async () => {
    const documentId = await seedDraftInvoice(fixture, "F824C-worker");
    const job = await asEditor(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    const jobId = job.jobId;
    const leaseToken = randomUUID();
    const claim = await asEditor(fixture, (tx) => claimDraftPdfRenderJob(tx, {
      workspaceId: fixture.workspaceId,
      jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("F824C-CT-01: Draft-Claim schlug fehl");
    expect(claim.templateVersion).toBe("draft-pdf-template.v1");
    expect(claim.inputVersion).toBe("draft-pdf-input.v1");
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      Buffer.alloc(128, 0x65),
      Buffer.from("\n%%EOF", "latin1"),
    ]);
    const { createHash } = await import("node:crypto");
    const completion = await asEditor(fixture, (tx) => finalizeDraftPdfRenderSuccess(tx, {
      workspaceId: fixture.workspaceId,
      jobId,
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

  it("F824C-CT-02: Draft-Artefakt liest mit <name>-entwurf.pdf-Dateiname", async () => {
    const documentId = await seedDraftInvoice(fixture, "F824C Müller & Söhne");
    const job = await asEditor(fixture, (tx, ctx) => requestDraftPdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    const leaseToken = randomUUID();
    const claim = await asEditor(fixture, (tx) => claimDraftPdfRenderJob(tx, {
      workspaceId: fixture.workspaceId,
      jobId: job.jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("F824C-CT-02: Draft-Claim schlug fehl");
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      Buffer.alloc(128, 0x65),
      Buffer.from("\n%%EOF", "latin1"),
    ]);
    const { createHash } = await import("node:crypto");
    await asEditor(fixture, (tx) => finalizeDraftPdfRenderSuccess(tx, {
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
    const artifact = await asEditor(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId: job.jobId,
    }));
    expect(artifact.filename).toMatch(/-entwurf\.pdf$/u);
    expect(artifact.filename).toContain("F824C-M-ller");
    expect(artifact.bytes.equals(bytes)).toBe(true);
  });
});
