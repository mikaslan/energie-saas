import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getNumberFormats,
  listDocumentGroups,
  renameDocumentGroup,
  seedNumberSeries,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingPreconditionConflictError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-01 Kern')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m301.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m301.test`})
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
      companyName: "M3-01 Energie GmbH",
      companyEmail: "office@m301.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Kernstraße 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-01 Energie GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

function groupCommand(name: string) {
  return { schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION, name };
}

describe("M3-01 Rechnungs-Kern (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("M301-DB-01: Gruppe anlegen/listen/umbenennen; Viewer read-only", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentGroup(tx, ctx, groupCommand("Angebote 2026")),
    );
    expect(created.id).toBeTruthy();

    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDocumentGroups(tx, ctx),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("Angebote 2026");

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => renameDocumentGroup(tx, ctx, created.id, groupCommand("Rechnungen 2026")),
    );
    const renamed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDocumentGroups(tx, ctx),
    );
    expect(renamed[0]?.name).toBe("Rechnungen 2026");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createDocumentGroup(tx, ctx, groupCommand("Unbefugt")),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Namens-Duplikat -> Konflikt
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentGroup(tx, ctx, groupCommand("Rechnungen 2026")),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M301-DB-02: Rechnung verlangt vollständige Issuing-Details, Brief nicht (O4)", async () => {
    const invoiceDraft = {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name: "Entwurf 1", groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31", deliveryDate: null, validityDate: null,
        plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
      },
    };
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, invoiceDraft),
    )).rejects.toBeInstanceOf(InvoicingPreconditionConflictError);

    // Brief braucht keine Issuing-Details (keine Geld-Achse).
    const letter = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter", name: "Brief", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    );
    expect(letter.status).toBe("draft");

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, invoiceDraft),
    );
    expect(created.status).toBe("draft");
    expect(created.type).toBe("invoice");
  });

  it("M301-DB-03: Nummernserien-Seeding nur im Schreibpfad; issued ist immutable", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => seedNumberSeries(tx, fixture.workspaceId),
    );
    const series = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => tx.execute<{ count: number }>(sql`
        select count(*)::integer as count
          from commercial_document_number_series
         where workspace_id = ${fixture.workspaceId}::uuid
      `),
    );
    expect(series.rows[0]?.count).toBe(6);

    // Direkter Verstoß gegen das Issued-Immutable-Gate (Typ-Wechsel) muss
    // scheitern. Fixture-Insert mit Actor-GUC (restriktive INSERT-Policy
    // verlangt einen internen Schreiber), Muster m204-tenantFn.
    const documentId = randomUUID();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into commercial_document (
            id, workspace_id, type, status, name, number, number_year,
            number_sequence, issued_at, issued_by, created_by,
            issued_snapshot, snapshot_sha256, goebd_retention_until, due_date
          ) values (
            ${documentId}::uuid, ${fixture.workspaceId}::uuid, 'invoice', 'issued',
            'Ausgestellt', 'RE-2026-000001', 2026, 1,
            statement_timestamp(), ${fixture.editorId}::uuid,
            ${fixture.editorId}::uuid,
            '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
            sha256('issued-test'::bytea),
            (statement_timestamp()::date + 3650),
            (statement_timestamp()::date + 14)
          )
        `);
      },
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          update commercial_document set type = 'letter'
           where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
        `);
      },
    )).rejects.toSatisfy((error: unknown) => {
      const cause = (error as { cause?: Error }).cause;
      const text = `${error instanceof Error ? error.message : ""} ${cause?.message ?? ""}`;
      return /issued_document_immutable/u.test(text);
    });
  });

  it("M301-DB-04: Fremdtenant sieht Gruppe nicht; Zeile an Entwurf anlegen", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentGroup(tx, ctx, groupCommand("Eigene Gruppe")),
    );
    const other = await seedFixture();
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => listDocumentGroups(tx, ctx),
    );
    expect(foreign).toHaveLength(0);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const draft = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice" as const, name: "Zeilen-Entwurf", groupId: null, projectId: null,
          contactId: null, dueDate: "2026-12-31", deliveryDate: null, validityDate: null,
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    );
    const line = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentLine(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
        documentId: draft.id,
        input: { position: 1, name: "Modul", quantityMilli: 1000, unit: "piece", netCents: 100, taxRateBps: 1900 },
      }),
    );
    expect(line.id).toBeTruthy();

    const formats = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getNumberFormats(tx, ctx),
    );
    expect(formats.formats.length).toBeGreaterThan(0);
  });
});
