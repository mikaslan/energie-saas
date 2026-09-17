import { createHash, randomUUID } from "node:crypto";
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
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getInvoicePdfStatus,
  InvoicePdfIntegrityError,
  InvoicePdfNotFoundError,
  issueDocument,
  listInvoicePdfs,
  readInvoicePdfArtifact,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "M3-02d GmbH",
      companyEmail: "office@m302d.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-02d GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedSucceededJob(fixture: Fixture): Promise<{
  documentId: string;
  jobId: string;
  bytes: Buffer;
  sha256: string;
}> {
  const workspaceId = fixture.workspaceId;
  const editorId = fixture.editorId;
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, editorId, workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@m302d.test`;
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
    name: `M302D-Gruppe-${randomUUID().slice(0, 8)}`,
  })).then((result) => result.id);
  const documentId = await asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice",
      name: "M302D-Rechnung",
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
  const job = await asEditor((tx, ctx) => requestInvoicePdfInput(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
    documentId,
  }));
  const leaseToken = randomUUID();
  const claim = await asEditor((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId,
    jobId: job.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("M302D: Claim schlug fehl");
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(128, 0x62),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await asEditor((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId,
    jobId: job.jobId,
    leaseToken,
    attemptCount: claim.attemptCount,
    artifact: {
      bytes,
      sha256,
      sizeBytes: bytes.length,
      mimeType: "application/pdf",
    },
  }));
  return { documentId, jobId: job.jobId, bytes, sha256 };
}

describe("M3-02d PDF-Download-Leseflaeche (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-02d Download')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@m302d.test`}),
          (${viewerId}::uuid, ${`viewer-${viewerId}@m302d.test`})
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

  it("M302D-CT-00: Download-Leseflaeche ist exportiert", () => {
    expect(typeof readInvoicePdfArtifact).toBe("function");
    expect(typeof getInvoicePdfStatus).toBe("function");
    expect(typeof listInvoicePdfs).toBe("function");
    expect(typeof InvoicePdfNotFoundError).toBe("function");
    expect(typeof InvoicePdfIntegrityError).toBe("function");
  });

  it("M302D-CT-01: Artifact-Read liefert versiegelte Bytes mit Nummer-Dateiname", async () => {
    const { documentId, jobId, bytes, sha256 } = await seedSucceededJob(fixture);
    const artifact = await asEditor(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId,
    }));
    expect(artifact.jobId).toBe(jobId);
    expect(artifact.documentId).toBe(documentId);
    expect(artifact.mimeType).toBe("application/pdf");
    expect(artifact.sha256).toBe(sha256);
    expect(artifact.sizeBytes).toBe(bytes.length);
    expect(Buffer.from(artifact.bytes)).toEqual(bytes);
    expect(artifact.filename).toMatch(/\.pdf$/u);
  });

  it("M302D-CT-01: fremde Job-ID und fremdes Dokument sind NotFound ohne Orakel", async () => {
    const { documentId, jobId } = await seedSucceededJob(fixture);
    await expect(asEditor(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId: randomUUID(),
    }))).rejects.toThrow(InvoicePdfNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId: randomUUID(),
      jobId,
    }))).rejects.toThrow(InvoicePdfNotFoundError);
  });

  it("M302D-CT-01: manipulierte Bytes scheitern am Artefakt-CHECK, Zeile bleibt versiegelt", async () => {
    const { documentId, jobId, bytes } = await seedSucceededJob(fixture);
    // Speicher-Korruption ausserhalb jeder Actor-Sicht (RLS wuerde ein
    // unautorisiertes UPDATE still auf 0 Zeilen filtern): Superuser-Pool.
    // Der DB-CHECK bindet Bytes an SHA (M2-02-Spiegel), der Service prueft
    // defense-in-depth erneut.
    await expect(superuserPool().query(
      `update public.commercial_document_render_job
          set artifact_bytes = decode('255044462d312e370a', 'hex')
        where id = $1::uuid`,
      [jobId],
    )).rejects.toThrow(/commercial_document_render_job_artifact_ck/);
    const artifact = await asEditor(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId,
    }));
    expect(Buffer.from(artifact.bytes)).toEqual(bytes);
  });

  it("M302D-CT-02: Status-Read braucht invoicing.write; Viewer fail-closed", async () => {
    const { documentId, jobId } = await seedSucceededJob(fixture);
    const status = await asEditor(fixture, (tx, ctx) => getInvoicePdfStatus(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId,
    }));
    expect(status.jobId).toBe(jobId);
    expect(status.state).toBe("succeeded");
    const jobs = await asEditor(fixture, (tx, ctx) => listInvoicePdfs(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
    }));
    expect(jobs.map((job) => job.jobId)).toContain(jobId);
    await expect(asViewer(fixture, (tx, ctx) => getInvoicePdfStatus(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId,
    }))).rejects.toThrow(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) => listInvoicePdfs(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
    }))).rejects.toThrow(PermissionDeniedError);
  });

  it("M302D-CT-01: Viewer ohne issuing_details.write laedt keine Bytes", async () => {
    const { documentId, jobId } = await seedSucceededJob(fixture);
    await expect(asViewer(fixture, (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
      workspaceId: fixture.workspaceId,
      documentId,
      jobId,
    }))).rejects.toThrow(PermissionDeniedError);
  });
});
