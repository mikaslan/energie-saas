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
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import type { ServiceCtx } from "@/lib/permissions";
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

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-02c Worker')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values
        (${editorId}::uuid, ${`editor-${editorId}@m302c.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m302c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
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
      companyName: "M3-02c GmbH",
      companyEmail: "office@m302c.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-02c GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedContact(fixture: Fixture): Promise<string> {
  const contactId = randomUUID();
  const email = `${contactId}@m302c.test`;
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

async function seedSealedJob(fixture: Fixture): Promise<{ documentId: string; jobId: string }> {
  const contactId = await seedContact(fixture);
  const groupId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `M302C-Gruppe-${randomUUID().slice(0, 8)}`,
    }),
  ).then((result) => result.id);
  const documentId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice",
        name: "M302C-Rechnung",
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
    }),
  ).then((result) => result.id);
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 1, name: "Position 1", quantityMilli: 1000,
        unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
      },
    }));
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId,
    }));
  const job = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    }),
  );
  return { documentId, jobId: job.jobId };
}

describe("M3-02c PDF-Worker-Lebenszyklus (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  it("M302C-DB-01a: Statusmaschine + Shape-CHECKs (0193)", async () => {
    const { jobId } = await seedSealedJob(fixture);
    // Status 'queued' ist zulaessig (M3-02b kannte nur 'requested').
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_render_job set status = 'queued'
       where id = ${jobId}::uuid
    `).then(() => undefined));
    // Fremd-Status → CHECK-Violation.
    let code: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        update commercial_document_render_job set status = 'drafting'
         where id = ${jobId}::uuid
      `).then(() => undefined));
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe("23514");
    // Artefakt ohne 'succeeded' → Shape-Violation.
    let shape: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        update commercial_document_render_job
           set artifact_bytes = decode('00', 'hex'),
               artifact_sha256 = decode(repeat('00', 32), 'hex'),
               artifact_size_bytes = 1,
               artifact_mime_type = 'application/pdf'
         where id = ${jobId}::uuid
      `).then(() => undefined));
    } catch (error) {
      shape = pgCode(error);
    }
    expect(shape).toBe("23514");
  });

  it("M302C-DB-01b: versiegelte Spalten sind UPDATE-fest (Trigger)", async () => {
    const { jobId } = await seedSealedJob(fixture);
    let code: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        update commercial_document_render_job
           set input_json = '{"tampered":true}'::jsonb
         where id = ${jobId}::uuid
      `).then(() => undefined));
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe("23514");
    // Status-Pfad bleibt offen.
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_render_job set status = 'queued'
       where id = ${jobId}::uuid
    `).then(() => undefined));
  });

  it("M302C-DB-01c: Viewer sieht keine Job-Zeilen (SELECT-Schranke)", async () => {
    await seedSealedJob(fixture);
    const seenByViewer = await asViewer(fixture, async (tx) => {
      const rows = await tx.execute<{ c: number }>(sql`
        select count(*)::int as c from commercial_document_render_job
      `);
      return rows.rows[0]?.c ?? -1;
    });
    expect(seenByViewer).toBe(0);
    const seenByEditor = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ c: number }>(sql`
        select count(*)::int as c from commercial_document_render_job
      `);
      return rows.rows[0]?.c ?? -1;
    });
    expect(seenByEditor).toBe(1);
  });

  it("M302C-DB-01d: pgboss-Dispatch wird in Test-DBs uebersprungen", async () => {
    // Muster 0033: ohne pgboss-Schema kehrt die Migration in Test-DBs
    // still zurueck — die Funktion existiert dort absichtlich nicht
    // (Dispatch-Gate ist per Unit-Mock abgedeckt).
    const found = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ sig: string | null }>(sql`
        select pg_catalog.to_regprocedure(
          'pgboss.enqueue_invoice_pdf_render(uuid,uuid)'
        )::text as sig
      `);
      return rows.rows[0]?.sig ?? null;
    });
    expect(found).toBeNull();
  });

  it("M302C-CT-02/04: echter Claim→Finalize-Roundtrip versiegelt Bytes", async () => {
    const { jobId } = await seedSealedJob(fixture);
    const leaseToken = randomUUID();
    const claim = await asEditor(fixture, (tx) =>
      claimInvoicePdfRenderJob(tx, {
        workspaceId: fixture.workspaceId,
        jobId,
        leaseToken,
      }));
    if (claim === null) throw new Error("M302C-CT-02: Claim schlug fehl");
    expect(claim.jobId).toBe(jobId);
    expect(claim.leaseToken).toBe(leaseToken);
    expect(claim.attemptCount).toBe(1);
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      Buffer.alloc(128, 0x61),
      Buffer.from("\n%%EOF", "latin1"),
    ]);
    const { createHash } = await import("node:crypto");
    await asEditor(fixture, (tx) =>
      finalizeInvoicePdfRenderSuccess(tx, {
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
    const stored = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ status: string; hex: string; size: number }>(sql`
        select status, encode(artifact_sha256, 'hex') as hex,
               artifact_size_bytes as size
          from commercial_document_render_job
         where id = ${jobId}::uuid
      `);
      return rows.rows[0];
    });
    expect(stored?.status).toBe("succeeded");
    expect(stored?.hex).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stored?.size).toBe(bytes.length);
  });
});
