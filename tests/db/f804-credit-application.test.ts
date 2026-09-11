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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-04 Gutschrift')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f804.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f804.test`})
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
      companyName: "F8-04 Gutschrift GmbH",
      companyEmail: "office@f804.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Gutschriftstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-04 Gutschrift GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

const settingsSeeded = new Set<string>();

type DocType = "invoice" | "credit_note";

async function seedDoc(
  fixture: Fixture,
  type: DocType,
  name: string,
  netCents: number,
): Promise<string> {
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
        type, name, groupId: null, projectId: null,
        contactId: null, dueDate: type === "invoice" ? "2026-12-31" : null,
        skontoPercentBps: null, skontoDays: null,
        deliveryDate: type === "credit_note" ? "2026-09-01" : null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: type === "credit_note" ? "minderleistung" as const : null,
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

async function seedIssued(fixture: Fixture, type: DocType, name: string, netCents: number): Promise<string> {
  const id = await seedDoc(fixture, type, name, netCents);
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

function detailCommand(documentId: string, type: DocType = "invoice") {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
    type,
    documentId,
  };
}

describe("F8-04 Gutschrift-Anrechnung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F804-DB-01: Gutschrift voll auf Rechnung, Allokation + kind am Beleg", async () => {
    // Gutschrift brutto 119,00; Rechnung brutto 238,00.
    const creditId = await seedIssued(fixture, "credit_note", "Gutschrift", 100_00);
    const finalId = await seedIssued(fixture, "invoice", "Schlussrechnung", 200_00);

    const linked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, creditId)),
    );
    expect(linked.linkedDeposits).toHaveLength(1);
    expect(linked.linkedDeposits[0]).toMatchObject({
      id: creditId, grossCents: 119_00, appliedCents: 119_00, kind: "credit",
    });
    expect(linked.remainingCents).toBe(119_00);

    const creditDetail = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand(creditId, "credit_note")),
    );
    expect(creditDetail.allocatedFinals).toHaveLength(1);
    expect(creditDetail.allocatedFinals[0]).toMatchObject({ id: finalId, appliedCents: 119_00 });
    expect(creditDetail.allocatedRestCents).toBe(0);
  });

  it("F804-DB-02: Entwurfs-Gutschrift und Über-Allokation fail-closed", async () => {
    const draftCredit = await seedDoc(fixture, "credit_note", "Entwurf", 100_00);
    const finalId = await seedIssued(fixture, "invoice", "Schlussrechnung", 200_00);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, draftCredit, 10_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    const creditId = await seedIssued(fixture, "credit_note", "Gutschrift", 100_00);
    const finalB = await seedIssued(fixture, "invoice", "Schluss B", 200_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, creditId, 100_00)),
    );
    // Rest 19,00 — 100,00 auf B überschreiten das Gutschrift-Brutto.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, creditId, 100_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
    // Fremder Typ als Geber (Brief, 0 €) → Konflikt.
    const letterId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Brief", groupId: null, projectId: null,
          contactId: null, dueDate: null,
          skontoPercentBps: null, skontoDays: null,
          deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null,
          creditNoteType: null,
        },
      }).then((result) => result.id),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalB, letterId, 0)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("F804-DB-03: Kandidaten führen Gutschriften mit Rest und kind", async () => {
    const creditId = await seedIssued(fixture, "credit_note", "Gutschrift", 100_00);
    const depositId = await seedIssued(fixture, "invoice", "Anzahlung", 100_00);
    const finalId = await seedIssued(fixture, "invoice", "Schlussrechnung", 200_00);

    const before = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDepositCandidates(tx, ctx, detailCommand(finalId)),
    );
    expect(before.find((c) => c.id === creditId)).toMatchObject({
      grossCents: 119_00, appliedCents: 119_00, kind: "credit",
    });
    expect(before.find((c) => c.id === depositId)).toMatchObject({ kind: "deposit" });

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, creditId, 119_00)),
    );
    const after = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDepositCandidates(tx, ctx, detailCommand(finalId)),
    );
    // Voll allokierte Gutschrift entfällt; Anzahlung bleibt mit Rest.
    expect(after.map((c) => c.id)).not.toContain(creditId);
    expect(after.find((c) => c.id === depositId)).toMatchObject({ appliedCents: 119_00 });

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlinkDeposit(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_UNLINK_COMMAND_VERSION,
        finalId,
        depositId: creditId,
      }),
    );
    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDepositCandidates(tx, ctx, detailCommand(finalId)),
    );
    expect(restored.find((c) => c.id === creditId)).toMatchObject({ appliedCents: 119_00 });
  });

  it("F804-DB-04: Gutschrift nie Empfänger, Viewer liest Geber-Seite", async () => {
    const depositId = await seedIssued(fixture, "invoice", "Anzahlung", 100_00);
    const creditId = await seedIssued(fixture, "credit_note", "Gutschrift", 100_00);
    // Empfänger bleibt `invoice` — Gutschrift als Final → Konflikt.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(creditId, depositId, 10_00)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    const finalId = await seedIssued(fixture, "invoice", "Schlussrechnung", 200_00);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => linkDeposit(tx, ctx, linkCommand(finalId, creditId, 119_00)),
    );
    const viewerDetail = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getDocumentDetail(tx, ctx, detailCommand(creditId, "credit_note")),
    );
    expect(viewerDetail.allocatedFinals).toHaveLength(1);
    expect(viewerDetail.allocatedFinals[0]).toMatchObject({ id: finalId, kind: "deposit" });
    expect(viewerDetail.allocatedRestCents).toBe(0);
  });
});
