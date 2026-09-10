import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  getDocumentDetail,
  upsertInvoicingSettings,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F5-02 Detail')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f502.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f502.test`})
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
      companyName: "F5-02 Detail GmbH",
      companyEmail: "office@f502.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Detailstraße 2",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F5-02 Detail GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedInvoiceDraft(fixture: Fixture, name = "Detail-Entwurf"): Promise<string> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
  );
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name, groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31",
        skontoPercentBps: 200, skontoDays: 10,
        deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
}

async function seedLine(
  fixture: Fixture,
  documentId: string,
  position: number,
  name: string,
  netCents: number,
): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position, name, quantityMilli: 1000, unit: "piece",
        netCents, taxRateBps: 1900,
      },
    }),
  );
}

function detailCommand(type: string, documentId: string) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
    type,
    documentId,
  } as { schemaVersion: typeof COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION; type: "invoice"; documentId: string };
}

describe("F5-02 Rechnungsdetail (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F502-DB-01: Detail belegt Kopf, Skonto und positionsgeordnete Zeilen", async () => {
    const documentId = await seedInvoiceDraft(fixture);
    await seedLine(fixture, documentId, 2, "Wechselrichter", 200_00);
    await seedLine(fixture, documentId, 1, "Module", 100_00);

    const detail = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand("invoice", documentId)),
    );
    expect(detail.document.id).toBe(documentId);
    expect(detail.document.status).toBe("draft");
    expect(detail.document.skontoPercentBps).toBe(200);
    expect(detail.document.skontoDays).toBe(10);
    expect(detail.document.grossCents).toBe(300_00 + 57_00);
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]).toMatchObject({ position: 1, name: "Module" });
    expect(detail.lines[1]).toMatchObject({ position: 2, name: "Wechselrichter" });
    // 19 % von 100,00 EUR = 19,00 EUR.
    expect(detail.lines[0]).toMatchObject({ netCents: 100_00, taxCents: 19_00, grossCents: 119_00 });

    // Typ-Mismatch fail-closed ohne Orakel (identisch zu fehlend).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand("credit_note", documentId)),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);

    // Ungueltige ID fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand("invoice", "keine-uuid")),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F502-RBAC-01: Viewer liest read-only; Fremdtenant sieht nichts", async () => {
    const documentId = await seedInvoiceDraft(fixture);
    const viewerDetail = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand("invoice", documentId)),
    );
    expect(viewerDetail.document.id).toBe(documentId);
    expect(viewerDetail.document.permissions.canWrite).toBe(false);

    const otherWorkspace = randomUUID();
    const otherEditor = randomUUID();
    await withTenantOn(testPool, otherWorkspace, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${otherWorkspace}::uuid, 'Fremd')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values (${otherEditor}::uuid, ${`other-${otherEditor}@f502.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${otherWorkspace}::uuid, ${otherEditor}::uuid,
          'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, otherEditor, otherWorkspace,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand("invoice", documentId)),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });
});
