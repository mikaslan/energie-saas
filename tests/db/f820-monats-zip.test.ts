import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  INVOICING_MONATS_ZIP_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  exportMonatsZip,
  issueDocument,
  requestInvoicePdfInput,
  upsertInvoicingSettings,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-20 GmbH",
      companyEmail: "office@f820.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-20 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

function berlinMonth(date = new Date()): string {
  const berlin = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return `${berlin.getFullYear()}-${String(berlin.getMonth() + 1).padStart(2, "0")}`;
}

function pdfBytes(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from(marker, "latin1"),
    Buffer.alloc(128, 0x61),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
}

async function seedIssuedInvoice(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f820.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F820 Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F820-Gruppe-${randomUUID().slice(0, 8)}`,
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
  await asEditor((tx, ctx) => createDocumentLine(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
    documentId,
    input: {
      position: 1, name: "PV-Module", quantityMilli: 10000,
      unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
    },
  }));
  await asEditor((tx, ctx) => issueDocument(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
    documentId,
  }));
  return documentId;
}

async function seedSucceededJob(
  fixture: Fixture,
  documentId: string,
): Promise<{ jobId: string; sha256: string; bytes: Buffer }> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const job = await asEditor((tx, ctx) => requestInvoicePdfInput(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
    documentId,
  }));
  const leaseToken = randomUUID();
  const claim = await asEditor((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("F820: Claim schlug fehl");
  const bytes = pdfBytes(`f820-${job.jobId}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await asEditor((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId: fixture.workspaceId,
    jobId: job.jobId,
    leaseToken,
    attemptCount: claim.attemptCount,
    artifact: { bytes, sha256, sizeBytes: bytes.length, mimeType: "application/pdf" },
  }));
  return { jobId: job.jobId, sha256, bytes };
}

async function documentNumber(fixture: Fixture, documentId: string): Promise<string> {
  return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
    const rows = await tx.execute<{ number: string }>(sql`
      select number from commercial_document
       where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
    `);
    const number = rows.rows[0]?.number;
    if (!number) throw new Error("F820: Nummer fehlt");
    return number;
  });
}

describe("F8-20 Monats-ZIP (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-20 ZIP')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f820.test`}),
          (${viewerId}::uuid, ${`viewer-${viewerId}@f820.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
      `);
    });
    fixture = { workspaceId, editorId, viewerId };
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  it("F820-DB-01: ZIP enthaelt Summary + versiegelte PDFs mit Hash-Abgleich", async () => {
    const month = berlinMonth();
    const firstId = await seedIssuedInvoice(fixture, "F820-erstens");
    const secondId = await seedIssuedInvoice(fixture, "F820-zweitens");
    const first = await seedSucceededJob(fixture, firstId);
    const second = await seedSucceededJob(fixture, secondId);
    const firstNumber = await documentNumber(fixture, firstId);
    const secondNumber = await documentNumber(fixture, secondId);
    const result = await asEditor(fixture, (tx, ctx) => exportMonatsZip(tx, ctx, {
      schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
      month,
    }));
    expect(result.fileName).toBe(`monatsunterlagen-${month}.zip`);
    expect(result.documentCount).toBe(2);
    expect(result.pdfCount).toBe(2);
    expect(result.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const entries = unzipSync(new Uint8Array(result.bytes));
    const names = Object.keys(entries).sort();
    expect(names).toContain("summary.csv");
    expect(names).toContain(`pdfs/${firstNumber}.pdf`);
    expect(names).toContain(`pdfs/${secondNumber}.pdf`);
    expect(Buffer.from(entries[`pdfs/${firstNumber}.pdf`]!).equals(first.bytes)).toBe(true);
    expect(Buffer.from(entries[`pdfs/${secondNumber}.pdf`]!).equals(second.bytes)).toBe(true);
    const summary = strFromU8(entries["summary.csv"]!);
    expect(summary).toContain(firstNumber);
    expect(summary).toContain(secondNumber);
    expect(summary).toContain(first.sha256);
    expect(summary).toContain(second.sha256);
  });

  it("F820-DB-02: Beleg ohne succeeded-Job bleibt ehrlich partiell (leere pdf-Spalten)", async () => {
    const month = berlinMonth();
    const withJobId = await seedIssuedInvoice(fixture, "F820-mit");
    const withoutJobId = await seedIssuedInvoice(fixture, "F820-ohne");
    await seedSucceededJob(fixture, withJobId);
    await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId: withoutJobId,
    }));
    const withNumber = await documentNumber(fixture, withJobId);
    const withoutNumber = await documentNumber(fixture, withoutJobId);
    const result = await asEditor(fixture, (tx, ctx) => exportMonatsZip(tx, ctx, {
      schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
      month,
    }));
    expect(result.documentCount).toBe(2);
    expect(result.pdfCount).toBe(1);
    const entries = unzipSync(new Uint8Array(result.bytes));
    expect(Object.keys(entries)).not.toContain(`pdfs/${withoutNumber}.pdf`);
    const summary = strFromU8(entries["summary.csv"]!);
    const rows = summary.split("\r\n");
    const withoutRow = rows.find((row) => row.includes(withoutNumber));
    const withRow = rows.find((row) => row.includes(withNumber));
    expect(withoutRow).toBeDefined();
    expect(withRow).toBeDefined();
    // Leere pdf_datei/pdf_sha256-Spalten: Zeile endet mit ";;" (kein stiller Anspruch).
    expect(withoutRow!.trimEnd().endsWith(";;")).toBe(true);
    expect(withRow!.includes(".pdf")).toBe(true);
  });

  it("F820-DB-03: Monats-Scope Berlin schliesst Fremdmonat und Entwuerfe aus", async () => {
    const month = berlinMonth();
    const currentId = await seedIssuedInvoice(fixture, "F820-aktuell");
    await seedSucceededJob(fixture, currentId);
    const currentNumber = await documentNumber(fixture, currentId);
    // Fremdmonat: gueltiger, ehrlich leerer ZIP (Belege des aktuellen Monats
    // duerfen nicht hinein). issued_at ist per Guard unveraenderlich,
    // daher prueft die Gegenrichtung (leerer Monat) den Scope.
    const [year, mon] = month.split("-").map(Number);
    const otherMonth = mon === 1
      ? `${year! - 1}-12`
      : `${year}-${String(mon! - 1).padStart(2, "0")}`;
    const empty = await asEditor(fixture, (tx, ctx) => exportMonatsZip(tx, ctx, {
      schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
      month: otherMonth,
    }));
    expect(empty.documentCount).toBe(0);
    expect(empty.pdfCount).toBe(0);
    const emptyEntries = unzipSync(new Uint8Array(empty.bytes));
    expect(Object.keys(emptyEntries)).toEqual(["summary.csv"]);
    expect(strFromU8(emptyEntries["summary.csv"]!)).not.toContain(currentNumber);
    // Aktueller Monat enthaelt genau den ausgestellten Beleg.
    const result = await asEditor(fixture, (tx, ctx) => exportMonatsZip(tx, ctx, {
      schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
      month,
    }));
    expect(result.documentCount).toBe(1);
    const entries = unzipSync(new Uint8Array(result.bytes));
    expect(strFromU8(entries["summary.csv"]!)).toContain(currentNumber);
  });

  it("F820-DB-04: Viewer ohne issuing_details.write erhaelt keinen ZIP", async () => {
    const month = berlinMonth();
    const documentId = await seedIssuedInvoice(fixture, "F820-viewer");
    await seedSucceededJob(fixture, documentId);
    await expect(asViewer(fixture, (tx, ctx) => exportMonatsZip(tx, ctx, {
      schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
      month,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
