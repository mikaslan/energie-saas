import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  INVOICING_DATEV_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  exportDatevBatch,
  issueDocument,
  upsertInvoicingSettings,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

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

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-22 GmbH",
      companyEmail: "office@f822.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-22 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

function berlinMonth(): string {
  const berlin = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return `${berlin.getFullYear()}-${String(berlin.getMonth() + 1).padStart(2, "0")}`;
}

async function seedDraftInvoice(
  fixture: Fixture,
  name: string,
): Promise<{ documentId: string }> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f822.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F822 Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F822-Gruppe-${randomUUID().slice(0, 8)}`,
  })).then((result) => result.id);
  const documentId = await asEditor((tx, ctx) => createDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
    input: {
      type: "invoice", name, groupId, projectId: null, contactId,
      dueDate: "2026-12-31", skontoPercentBps: null, skontoDays: null,
      deliveryDate: null, validityDate: null, plannedDeliveryDate: null,
      plannedServiceDate: null, creditNoteType: null,
    },
  })).then((result) => result.id);
  return { documentId };
}

async function lineTreatment(
  fixture: Fixture,
  documentId: string,
  position: number,
): Promise<string | null> {
  return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
    const rows = await tx.execute<{ tax_treatment: string | null }>(sql`
      select tax_treatment from commercial_document_line
       where workspace_id = ${fixture.workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and position = ${position}
    `);
    return rows.rows[0]?.tax_treatment ?? null;
  });
}

describe("F8-22 Steuerbehandlung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-22 Treatment')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f822.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    fixture = { workspaceId, editorId };
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);

  it("F822-DB-01: Zeilen-Defaults 1900→standard_19 und 0→zero_12_3 werden persistiert", async () => {
    const { documentId } = await seedDraftInvoice(fixture, "F822-defaults");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 1, name: "PV-Module", quantityMilli: 10000,
        unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
      },
    }));
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 2, name: "Kleinleistung", quantityMilli: 1000,
        unit: "piece" as const, netCents: 50000, taxRateBps: 0 as const,
      },
    }));
    expect(await lineTreatment(fixture, documentId, 1)).toBe("standard_19");
    expect(await lineTreatment(fixture, documentId, 2)).toBe("zero_12_3");
  });

  it("F822-DB-02: reverse_13b ist explizit waehlbar; Fehl-Kopplungen sind invalid", async () => {
    const { documentId } = await seedDraftInvoice(fixture, "F822-13b");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 1, name: "Bauleistung", quantityMilli: 1000,
        unit: "piece" as const, netCents: 200000, taxRateBps: 0 as const,
        taxTreatment: "reverse_13b",
      },
    }));
    expect(await lineTreatment(fixture, documentId, 1)).toBe("reverse_13b");
    await expect(asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 2, name: "Falsch-19", quantityMilli: 1000,
        unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
        taxTreatment: "zero_12_3",
      },
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
    await expect(asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 2, name: "Falsch-0", quantityMilli: 1000,
        unit: "piece" as const, netCents: 100000, taxRateBps: 0 as const,
        taxTreatment: "standard_19",
      },
    }))).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("F822-DB-03: DB-CHECK + NOT NULL sichern die Kopplung unabhaengig vom Service", async () => {
    const { documentId } = await seedDraftInvoice(fixture, "F822-check");
    const attempt = (treatment: string | null, rate: number) =>
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
        await tx.execute(sql`
          insert into commercial_document_line (
            id, workspace_id, document_id, position, name, quantity_milli, unit,
            net_cents, tax_cents, gross_cents, tax_rate_bps, tax_treatment
          ) values (
            ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${documentId}::uuid, 9,
            'Direkt', 1000, 'piece', 100000, 0, 100000, ${rate},
            ${treatment === null ? sql`null` : treatment}
          )
        `);
      }).then(() => "inserted").catch((error: unknown) => pgCode(error));
    await expect(attempt("standard_19", 0)).resolves.toBe("23514");
    await expect(attempt("zero_12_3", 1900)).resolves.toBe("23514");
    await expect(attempt(null, 1900)).resolves.toBe("23502");
    await expect(attempt("reverse_13b", 0)).resolves.toBe("inserted");
  });

  it("F822-DB-04: §13b-Rechnung bucht Ende-zu-Ende mit BU 40 und §13b-Hinweis", async () => {
    const { documentId } = await seedDraftInvoice(fixture, "F822-e2e-13b");
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 1, name: "Bauleistung", quantityMilli: 1000,
        unit: "piece" as const, netCents: 200000, taxRateBps: 0 as const,
        taxTreatment: "reverse_13b",
      },
    }));
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId,
    }));
    const result = await asEditor(fixture, (tx, ctx) => exportDatevBatch(tx, ctx, {
      schemaVersion: INVOICING_DATEV_COMMAND_VERSION,
      month: berlinMonth(),
      skr: "03",
    }));
    expect(result.content).toContain(";S;1400;8338;40;");
    expect(result.content).toContain("§13b");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.groups[0]?.taxTreatment).toBe("reverse_13b");
  });
});
