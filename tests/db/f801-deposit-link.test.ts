import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINK_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  getDocumentDetail,
  issueDocument,
  linkDeposit,
  unlinkDeposit,
  upsertInvoicingSettings,
  InvoicingConflictError,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-01 Anrechnung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f801.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f801.test`})
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
      companyName: "F8-01 Anrechnung GmbH",
      companyEmail: "office@f801.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Anrechnungsstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-01 Anrechnung GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

const settingsSeeded = new Set<string>();

async function seedDraft(fixture: Fixture, name: string, netCents: number): Promise<string> {
  if (!settingsSeeded.has(fixture.workspaceId)) {
    settingsSeeded.add(fixture.workspaceId);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  }
  const id = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name, groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31",
        skontoPercentBps: null, skontoDays: null,
        deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: id,
      input: {
        position: 1, name: "Position", quantityMilli: 1000, unit: "piece",
        netCents, taxRateBps: 1900,
      },
    }),
  );
  return id;
}

async function seedIssued(fixture: Fixture, name: string, netCents: number): Promise<string> {
  const id = await seedDraft(fixture, name, netCents);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: id,
    }),
  );
  return id;
}

function linkCommand(finalId: string, depositId: string) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_LINK_COMMAND_VERSION,
    finalId,
    depositId,
  };
}

function detailCommand(documentId: string) {
  return {
    schemaVersion: "commercial-document-detail-command.v1" as const,
    type: "invoice" as const,
    documentId,
  };
}

describe("F8-01 Anzahlung → Schlussrechnung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F801-DB-01: Link belegt Anrechnung + Restbetrag; Unlink leert", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung 30 %", 100_00);
    const finalId = await seedDraft(fixture, "Schlussrechnung", 300_00);

    const linked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId)),
    );
    expect(linked.linkedDeposits).toHaveLength(1);
    expect(linked.linkedDeposits[0]).toMatchObject({ id: depositId, grossCents: 119_00 });
    // 357,00 − 119,00 = 238,00.
    expect(linked.remainingCents).toBe(238_00);

    // Doppel-Link identisch → Konflikt (kein stilles Duplikat).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    const unlinked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId,
        depositId,
      }),
    );
    expect(unlinked.linkedDeposits).toEqual([]);
    expect(unlinked.remainingCents).toBe(357_00);

    // Unlink ohne Link → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId,
        depositId,
      }),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });

  it("F801-DB-02: Selbst-Link, Entwurf, Kette, Zweit-Final fail-closed", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const draftId = await seedDraft(fixture, "Noch-Entwurf", 50_00);
    const finalA = await seedDraft(fixture, "Schluss A", 300_00);
    const finalB = await seedDraft(fixture, "Schluss B", 300_00);

    // Selbst-Link → Validation.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, finalA)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    // Entwurf als Anzahlung → Konflikt.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, draftId)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Kette: Anzahlung mit eigenen Links ist selbst Schlussrechnung.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, depositId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, finalA)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Zweit-Final für dieselbe Anzahlung → Konflikt (keine Doppel-Anrechnung).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, depositId)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Fehlender Beleg → NotFound ohne Orakel; ungueltige UUID → Validation.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, "00000000-0000-4000-8000-000000000000")),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, "keine-uuid")),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F801-RBAC-01: Viewer liest Anrechnung read-only; Fremdtenant sieht nichts", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const finalId = await seedDraft(fixture, "Schlussrechnung", 300_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId)),
    );

    const viewerDetail = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand(finalId)),
    );
    expect(viewerDetail.linkedDeposits).toHaveLength(1);
    expect(viewerDetail.remainingCents).toBe(238_00);
    expect(viewerDetail.document.permissions.canWrite).toBe(false);

    const otherWorkspace = randomUUID();
    const otherEditor = randomUUID();
    await withTenantOn(testPool, otherWorkspace, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${otherWorkspace}::uuid, 'Fremd')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values (${otherEditor}::uuid, ${`other-${otherEditor}@f801.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${otherWorkspace}::uuid, ${otherEditor}::uuid,
          'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, otherEditor, otherWorkspace,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId)),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });
});
