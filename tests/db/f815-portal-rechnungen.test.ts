import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  createDocument,
  createDocumentLine,
  issueDocument,
  upsertInvoicingSettings,
  voidDocument,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  residentialProjectId: string;
  commercialProjectId: string;
};

async function seedProject(
  tx: TenantTx,
  args: {
    workspaceId: string;
    projectId: string;
    label: string;
    scope: "residential" | "commercial";
  },
): Promise<void> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  await tx.execute(sql`
    insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
    values (${contactId}::uuid, ${args.workspaceId}::uuid, ${args.label}, 'F8', 'Fixture',
      ${`${contactId}@f815.test`}, ${`${contactId}@f815.test`})
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${args.workspaceId}::uuid, ${contactId}::uuid, ${`${args.label} Site`})
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    select ${args.projectId}::uuid, ${args.workspaceId}::uuid, ${contactId}::uuid,
           ${siteId}::uuid, board.id, intake_column.id,
           ${args.label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
     where board.workspace_id = ${args.workspaceId}::uuid
       and board.scope = ${args.scope}
       and board.is_default = true
       and board.archived_at is null
  `);
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const residentialProjectId = randomUUID();
  const commercialProjectId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-15 Fixture')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f815.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{"invoicing":true}'::jsonb)
    `);
    await seedProject(tx, {
      workspaceId, projectId: residentialProjectId, label: "F815 Wohnbau", scope: "residential",
    });
    await seedProject(tx, {
      workspaceId, projectId: commercialProjectId, label: "F815 Gewerbe", scope: "commercial",
    });
  });
  return { workspaceId, editorId, residentialProjectId, commercialProjectId };
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-15 GmbH",
      companyEmail: "office@f815.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-15 GmbH",
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
  projectId: string | null,
): Promise<string> {
  if (!settingsSeeded.has(fixture.workspaceId)) {
    settingsSeeded.add(fixture.workspaceId);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  }
  const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
  const id = await run((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type, name, groupId: null, projectId,
      contactId: null, dueDate: type === "invoice" ? "2026-12-31" : null,
      skontoPercentBps: null, skontoDays: null,
      deliveryDate: type === "credit_note" ? "2026-09-01" : null,
      validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
      creditNoteType: type === "credit_note" ? "minderleistung" as const : null,
    },
  })).then((result) => result.id);
  // Eine Zeile netto 10.000 ct, 19 % → brutto 11.900 ct.
  await run((tx, ctx) => createDocumentLine(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
    documentId: id,
    input: {
      position: 1, name: "Position", quantityMilli: 1000, unit: "piece",
      netCents: 10000, taxRateBps: 1900,
    },
  }));
  return id;
}

async function seedIssued(
  fixture: Fixture,
  type: DocType,
  name: string,
  projectId: string | null,
): Promise<string> {
  const id = await seedDoc(fixture, type, name, projectId);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: id,
    }),
  );
  return id;
}

describe("F8-15 Portal-Rechnungssicht (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  async function resolveFor(projectId: string) {
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }),
    );
    return resolvePortalByToken(testPool, { token: invite.token });
  }

  it("F815-DB-01: ausgestellte Rechnung sichtbar, Entwurf und Fremdprojekt unsichtbar", async () => {
    await seedIssued(fixture, "invoice", "F815-Rechnung", fixture.residentialProjectId);
    await seedDoc(fixture, "invoice", "F815-Entwurf", fixture.residentialProjectId);
    await seedIssued(fixture, "invoice", "F815-Fremdprojekt", fixture.commercialProjectId);

    const view = await resolveFor(fixture.residentialProjectId);
    expect(view.invoices).toHaveLength(1);
    const entry = view.invoices[0]!;
    expect(entry.kind).toBe("invoice");
    expect(typeof entry.number).toBe("string");
    expect(entry.grossCents).toBe(11900);
    expect(entry.paymentStatus).toBe("unpaid");
    expect(Number.isNaN(new Date(entry.issuedAt).getTime())).toBe(false);
  });

  it("F815-DB-02: Gutschrift als credit_note, Storno verschwindet, Commercial leer", async () => {
    const invoiceId = await seedIssued(fixture, "invoice", "F815-Storno", fixture.residentialProjectId);
    await seedIssued(fixture, "credit_note", "F815-Gutschrift", fixture.residentialProjectId);
    await seedIssued(fixture, "invoice", "F815-Gewerbe", fixture.commercialProjectId);

    const before = await resolveFor(fixture.residentialProjectId);
    expect(before.invoices.map((entry) => entry.kind).sort()).toEqual(["credit_note", "invoice"]);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: invoiceId,
        reason: "cancelled",
      }),
    );
    const after = await resolveFor(fixture.residentialProjectId);
    expect(after.invoices.map((entry) => entry.kind)).toEqual(["credit_note"]);

    // Commercial-Portal: kein Preis-Bereich (wie documents).
    const commercial = await resolveFor(fixture.commercialProjectId);
    expect(commercial.project.scope).toBe("commercial");
    expect(commercial.invoices).toEqual([]);
  });
});
