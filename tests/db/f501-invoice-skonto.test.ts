import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  issueDocument,
  listDocuments,
  setDocumentTerms,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F5-01 Skonto')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f501.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f501.test`})
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

function settingsCommand(baseRevision: number): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      companyName: "F5-01 Skonto GmbH",
      companyEmail: "office@f501.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Skontostraße 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F5-01 Skonto GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedInvoiceDraft(
  fixture: Fixture,
  name = "Skonto-Entwurf",
  terms?: { skontoPercentBps?: number | null; skontoDays?: number | null },
): Promise<string> {
  // O4: Geld-Dokumente brauchen Issuing-Details schon bei Anlage.
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
  );
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name, groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31",
        ...(terms ?? {}),
        deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
}

function termsCommand(documentId: string, skontoPercentBps: number | null, skontoDays: number | null) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_TERMS_COMMAND_VERSION,
    documentId,
    skontoPercentBps,
    skontoDays,
  };
}

describe("F5-01 Skonto-Konditionen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F501-DB-01: Entwurf setzen/lesen/loeschen; Viewer ohne Schreibrecht", async () => {
    const documentId = await seedInvoiceDraft(fixture);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 200, 10)),
    );
    expect(updated.skontoPercentBps).toBe(200);
    expect(updated.skontoDays).toBe(10);
    // Keine Summenwirkung: reine Zahlungskondition.
    expect(updated.grossCents).toBe(0);

    const cleared = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, null, null)),
    );
    expect(cleared.skontoPercentBps).toBeNull();
    expect(cleared.skontoDays).toBeNull();

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 200, 10)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F501-DB-01b: Skonto schon bei Anlage; Halbpaar und Fremdtyp abgewiesen", async () => {
    await seedInvoiceDraft(fixture, "Mit Skonto", {
      skontoPercentBps: 150,
      skontoDays: 7,
    });
    // Ruecklesen ohne Schreiben: Anlegewerte stehen.
    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDocuments(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
        type: "invoice",
        filters: { search: "Mit Skonto" },
      }),
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.skontoPercentBps).toBe(150);
    expect(listed.items[0]?.skontoDays).toBe(7);

    // Halbpaar bei Anlage -> Validierung (Settings seedet seedInvoiceDraft).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice" as const, name: "Halbpaar", groupId: null, projectId: null,
          contactId: null, dueDate: "2026-12-31", skontoPercentBps: 200,
          deliveryDate: null,
          validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
          creditNoteType: null,
        },
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F501-DB-02: Paar-Regel, Typ- und Status-Gate; Snapshot friert ein", async () => {
    const documentId = await seedInvoiceDraft(fixture);

    // Halbgesetztes Paar -> Validierung.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 200, null)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 10001, 10)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    // Kein Skonto auf Briefen.
    const letterId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Brief", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(letterId, 200, 10)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    // Ausstellung friert ein: Snapshot haelt fest, Edit -> Konflikt.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 250, 14)),
    );
    // Settings seedet seedInvoiceDraft bereits (O4); Revision nicht erneut anfassen.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentLine(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
        documentId,
        input: { position: 1, name: "Position", quantityMilli: 1000, unit: "piece", netCents: 10000, taxRateBps: 1900 },
      }),
    );
    const issued = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
        documentId,
      }),
    );
    expect(issued.skontoPercentBps).toBe(250);
    expect(issued.skontoDays).toBe(14);

    const snapshot = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => tx.execute<{ snapshot: { skontoPercentBps: number; skontoDays: number } }>(sql`
        select issued_snapshot as snapshot from commercial_document
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
      `),
    );
    expect(snapshot.rows[0]?.snapshot.skontoPercentBps).toBe(250);
    expect(snapshot.rows[0]?.snapshot.skontoDays).toBe(14);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentTerms(tx, ctx, termsCommand(documentId, 300, 7)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });
});
