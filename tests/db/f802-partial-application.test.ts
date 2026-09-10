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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-02 Teilanrechnung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f802.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f802.test`})
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
      companyName: "F8-02 Teilanrechnung GmbH",
      companyEmail: "office@f802.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Teilanrechnungsstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-02 Teilanrechnung GmbH",
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

function linkCommand(finalId: string, depositId: string, appliedCents?: number) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_LINK_COMMAND_VERSION,
    finalId,
    depositId,
    ...(appliedCents === undefined ? {} : { appliedCents }),
  };
}

function detailCommand(documentId: string) {
  return {
    schemaVersion: "commercial-document-detail-command.v1" as const,
    type: "invoice" as const,
    documentId,
  };
}

describe("F8-02 Teilanrechnung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F802-DB-01: Teilbetrag belegt Rest-Math; Default = volles Brutto", async () => {
    // Anzahlung brutto 119,00; Schluss brutto 238,00.
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const finalId = await seedDraft(fixture, "Schlussrechnung", 200_00);

    const linked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 50_00)),
    );
    expect(linked.linkedDeposits).toHaveLength(1);
    expect(linked.linkedDeposits[0]).toMatchObject({
      id: depositId, grossCents: 119_00, appliedCents: 50_00,
    });
    // 238,00 − 50,00 = 188,00.
    expect(linked.remainingCents).toBe(188_00);

    // Ohne Betrag = volles Brutto (F8-01-Pfad).
    const depositB = await seedIssued(fixture, "Anzahlung B", 100_00);
    const finalB = await seedDraft(fixture, "Schluss B", 200_00);
    const linkedFull = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, depositB)),
    );
    expect(linkedFull.linkedDeposits[0]).toMatchObject({
      id: depositB, grossCents: 119_00, appliedCents: 119_00,
    });
    expect(linkedFull.remainingCents).toBe(119_00);
  });

  it("F802-DB-02: Betrag außerhalb [1, Brutto] und Über-Anrechnung fail-closed", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const finalId = await seedDraft(fixture, "Schlussrechnung", 100_00);

    // 0 auf echte 119,00 → Validation (wirkungsloser Null-Link).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 0)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    // 0 auf 0-Brutto-Anzahlung → ok (positionslose Belege, F8-01-Pfad).
    const zeroDeposit = await seedIssued(fixture, "Null-Anzahlung", 0);
    const zeroFinal = await seedDraft(fixture, "Null-Schluss", 0);
    const zeroLinked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(zeroFinal, zeroDeposit, 0)),
    );
    expect(zeroLinked.linkedDeposits[0]).toMatchObject({ id: zeroDeposit, appliedCents: 0 });
    expect(zeroLinked.remainingCents).toBe(0);

    // Mehr als das Anzahlungs-Brutto (119,00) → Validation.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 119_01)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    // 100,00 von 119,00 ok (Rest 19,00) …
    const partial = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 100_00)),
    );
    expect(partial.remainingCents).toBe(19_00);

    // … weitere 50,00 würden 150,00 > 119,00 ergeben → Conflict
    // (fail-closed statt stiller 0-Clamp).
    const depositB = await seedIssued(fixture, "Anzahlung B", 100_00);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositB, 50_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Unlink stellt den vollen Betrag wieder her.
    const unlinked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId,
        depositId,
      }),
    );
    expect(unlinked.linkedDeposits).toEqual([]);
    expect(unlinked.remainingCents).toBe(119_00);
  });

  it("F802-RBAC-01: Viewer liest Teilbetrag read-only; Schreiben nur mit Recht", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const finalId = await seedDraft(fixture, "Schlussrechnung", 200_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 50_00)),
    );

    const viewerDetail = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand(finalId)),
    );
    expect(viewerDetail.linkedDeposits).toHaveLength(1);
    expect(viewerDetail.linkedDeposits[0]).toMatchObject({ appliedCents: 50_00 });
    expect(viewerDetail.remainingCents).toBe(188_00);
    expect(viewerDetail.document.permissions.canWrite).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, depositId, 10_00)),
    )).rejects.toBeInstanceOf(Error);
  });
});
