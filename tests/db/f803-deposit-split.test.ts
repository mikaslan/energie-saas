import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
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
  listDepositCandidates,
  unlinkDeposit,
  upsertInvoicingSettings,
  InvoicingConflictError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-03 Split')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f803.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f803.test`})
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
      companyName: "F8-03 Split GmbH",
      companyEmail: "office@f803.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Splitstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-03 Split GmbH",
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
    schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
    type: "invoice" as const,
    documentId,
  };
}

function candidates(fixture: Fixture, actorId: string, documentId: string) {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => listDepositCandidates(tx, ctx, detailCommand(documentId)),
  );
}

function detail(fixture: Fixture, actorId: string, documentId: string) {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand(documentId)),
  );
}

describe("F8-03 Anzahlungs-Split (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F803-DB-01: eine Anzahlung auf zwei Finals, Allokationen + Rest am Beleg", async () => {
    // Anzahlung brutto 238,00; zwei Finals je brutto 238,00.
    const depositId = await seedIssued(fixture, "Anzahlung", 200_00);
    const finalA = await seedDraft(fixture, "Schluss A", 200_00);
    const finalB = await seedDraft(fixture, "Schluss B", 200_00);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, depositId, 119_00)),
    );
    const linkedB = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, depositId, 119_00)),
    );
    expect(linkedB.linkedDeposits).toHaveLength(1);
    expect(linkedB.remainingCents).toBe(119_00);

    const depositDetail = await detail(fixture, fixture.editorId, depositId);
    expect(depositDetail.allocatedFinals).toHaveLength(2);
    expect(depositDetail.allocatedFinals[0]).toMatchObject({ id: finalA, appliedCents: 119_00 });
    expect(depositDetail.allocatedFinals[1]).toMatchObject({ id: finalB, appliedCents: 119_00 });
    expect(depositDetail.allocatedRestCents).toBe(0);

    // Voll allokiert → kein Kandidat mehr (weder für A noch B noch neu).
    const finalC = await seedDraft(fixture, "Schluss C", 200_00);
    const remaining = await candidates(fixture, fixture.editorId, finalC);
    expect(remaining.map((candidate) => candidate.id)).not.toContain(depositId);
  });

  it("F803-DB-02: Über-Allokation und Doppel-Link fail-closed", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const finalA = await seedDraft(fixture, "Schluss A", 200_00);
    const finalB = await seedDraft(fixture, "Schluss B", 200_00);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, depositId, 100_00)),
    );
    // Rest 19,00 — 100,00 auf B überschreiten das Anzahlungs-Brutto.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, depositId, 100_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
    // Gleiches Paar erneut → Konflikt (Paar-Unique).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, depositId, 10_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Rest passt exakt: 19,00 auf B.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, depositId, 19_00)),
    );
    const depositDetail = await detail(fixture, fixture.editorId, depositId);
    expect(depositDetail.allocatedRestCents).toBe(0);
  });

  it("F803-DB-03: Unlink stellt Rest wieder her, Kandidat kehrt zurück", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 200_00);
    const finalA = await seedDraft(fixture, "Schluss A", 200_00);
    const finalB = await seedDraft(fixture, "Schluss B", 200_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalA, depositId, 238_00)),
    );
    expect(await candidates(fixture, fixture.editorId, finalB)).toHaveLength(0);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId: finalA,
        depositId,
      }),
    );
    const back = await candidates(fixture, fixture.editorId, finalB);
    expect(back.map((candidate) => candidate.id)).toContain(depositId);
    expect(back.find((candidate) => candidate.id === depositId)).toMatchObject({
      grossCents: 238_00, appliedCents: 238_00,
    });
    const depositDetail = await detail(fixture, fixture.editorId, depositId);
    expect(depositDetail.allocatedFinals).toHaveLength(0);
    expect(depositDetail.allocatedRestCents).toBe(238_00);
  });

  it("F803-DB-04: Kette bleibt gesperrt, Viewer liest Allokationen", async () => {
    const depositId = await seedIssued(fixture, "Anzahlung", 100_00);
    const middleId = await seedDraft(fixture, "Mitte", 100_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(middleId, depositId, 119_00)),
    );
    // Mitte hat Eingangs-Links → darf nicht selbst Anzahlung sein.
    const outerId = await seedDraft(fixture, "Aussen", 100_00);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(outerId, middleId, 10_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    const viewerDetail = await detail(fixture, fixture.viewerId, depositId);
    expect(viewerDetail.allocatedFinals).toHaveLength(1);
    expect(viewerDetail.allocatedRestCents).toBe(0);
  });
});
