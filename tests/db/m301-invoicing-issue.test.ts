import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentLine,
  issueDocument,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingPreconditionConflictError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-01 Issue')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@m301i.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{"invoicing":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

function settingsCommand(baseRevision: number): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      companyName: "M3-01 Issue GmbH",
      companyEmail: "office@m301i.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Issuestraße 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-01 Issue GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedInvoice(fixture: Fixture, name = "Ausstell-Entwurf"): Promise<string> {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name, groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31", deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
}

async function seedLine(fixture: Fixture, documentId: string): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: { position: 1, name: "Position", quantityMilli: 1000, unit: "piece", netCents: 10000, taxRateBps: 1900 },
    }),
  );
}

function issueCommand(documentId: string) {
  return { schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId };
}

describe("M3-01 Ausstellen + Nummernkreis (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("M301-ISSUE-01: draft→issued mit Nummer, Snapshot-SHA und Immutabilität", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const documentId = await seedInvoice(fixture);
    await seedLine(fixture, documentId);

    const issued = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(documentId)),
    );
    expect(issued.status).toBe("issued");
    expect(issued.number).toMatch(/^RE-\d{4}-\d{6}$/u);
    expect(issued.numberSequence).toBe(1);
    expect(issued.issuedAt).toBeTruthy();
    expect(issued.grossCents).toBe(11900);

    const row = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => tx.execute<{ sha_length: number; retention: string | null }>(sql`
        select octet_length(snapshot_sha256) as sha_length, goebd_retention_until::text as retention
          from commercial_document
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
      `),
    );
    expect(Number(row.rows[0]?.sha_length)).toBe(32);
    expect(row.rows[0]?.retention).toBeTruthy();

    // Immutabilität nach Ausstellung (Statusmaschine + Content-Freeze).
    const guarded = async (statement: string) => {
      try {
        await withAuthorizedTenantOn(
          testPool, fixture.editorId, fixture.workspaceId,
          async (tx) => { await tx.execute(sql.raw(statement)); },
        );
        return false;
      } catch (error) {
        const cause = (error as { cause?: Error }).cause;
        const text = `${error instanceof Error ? error.message : ""} ${cause?.message ?? ""}`;
        return /invalid_document_status_transition|issued_document_immutable/u.test(text);
      }
    };
    expect(await guarded(
      `update commercial_document set status = 'draft' where workspace_id = '${fixture.workspaceId}'::uuid and id = '${documentId}'::uuid`,
    )).toBe(true);
    expect(await guarded(
      `update commercial_document set name = 'Mutiert' where workspace_id = '${fixture.workspaceId}'::uuid and id = '${documentId}'::uuid`,
    )).toBe(true);

    // Doppeltes Ausstellen → Conflict.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(documentId)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M301-ISSUE-02: Sequenzen monoton, Rollback-in-Transaktion (Spec §6), Jahreswechsel", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const firstId = await seedInvoice(fixture, "Erste");
    const secondId = await seedInvoice(fixture, "Zweite");
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(firstId)),
    );
    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(secondId)),
    );
    expect(first.numberSequence).toBe(1);
    expect(second.numberSequence).toBe(2);

    // Jahreswechsel erzwingen: die BRIEF-Serie auf das Vorjahr zurückdatieren
    // → die nächste Brief-Ausstellung legt eine neue Jahres-Serie an und
    // startet wieder bei 1 (anderer Präfix, keine Nummern-Kollision mit den
    // Rechnungen; verbrannte Nummern bleiben verbrannt).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into commercial_document_number_series (
            id, workspace_id, type, series_year, prefix, padding, last_sequence,
            created_at, updated_at
          ) values (
            ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, 'letter',
            extract(year from statement_timestamp() at time zone 'Europe/Berlin')::integer - 1,
            'BR', 6, 7, statement_timestamp(), statement_timestamp()
          )
        `);
      },
    );
    const thirdId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Brief Rollover", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    const third = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(thirdId)),
    );
    expect(third.numberSequence).toBe(1);
    expect(third.numberYear).toBe(new Date().getFullYear());
    expect(third.number).toMatch(/^BR-\d{4}-000001$/u);
  });

  it("M301-ISSUE-03: O4-Precondition greift beim Ausstellen; Brief ohne Details ok", async () => {
    const invoiceId = randomUUID();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into commercial_document (
            id, workspace_id, type, status, name, created_by, due_date, payment_status
          ) values (
            ${invoiceId}::uuid, ${fixture.workspaceId}::uuid, 'invoice', 'draft',
            'Precondition-Entwurf', ${fixture.editorId}::uuid,
            (statement_timestamp()::date + 14), 'unpaid'
          )
        `);
      },
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(invoiceId)),
    )).rejects.toBeInstanceOf(InvoicingPreconditionConflictError);

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
    const letter = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(letterId)),
    );
    expect(letter.status).toBe("issued");
    expect(letter.number).toMatch(/^BR-\d{4}-\d{6}$/u);
  });

  it("M301-ISSUE-04: Fremdtenant sieht und mutiert nichts", async () => {
    const other = await seedFixture();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const documentId = await seedInvoice(fixture);
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(documentId)),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });

  it("M301-ISSUE-05 (Kimi-P2-6): parallele Ausstellungen erhalten disjunkte Nummern", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const ids = await Promise.all([
      seedInvoice(fixture, "Race 1"),
      seedInvoice(fixture, "Race 2"),
      seedInvoice(fixture, "Race 3"),
    ]);
    const issued = await Promise.all(ids.map((id) => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(id)),
    )));
    const sequences = issued
      .map((document) => document.numberSequence ?? 0)
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3]);
    expect(new Set(issued.map((document) => document.number)).size).toBe(3);
  });

  it("M301-ISSUE-06 (Kimi-P2-6): Snapshot-Hash ist aus der gespeicherten Form rekonstruierbar", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    const documentId = await seedInvoice(fixture);
    await seedLine(fixture, documentId);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(documentId)),
    );
    const row = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => tx.execute<{ snapshot: unknown; hash_hex: string }>(sql`
        select issued_snapshot as snapshot,
               encode(snapshot_sha256, 'hex') as hash_hex
          from commercial_document
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
      `),
    );
    // Verifikationsvertrag (Kimi-P2-2): der Hash deckt die Byteform des
    // Snapshot-Objekts in KANONISCHER FELDREIHENFOLGE (wie der Service sie
    // baut). Verifiziert wird durch Rekonstruktion aus den Spalten — nicht
    // durch Re-Serialisierung des gespeicherten jsonb (Postgres normalisiert
    // Schlüsselreihenfolge und Numerik).
    const { createHash } = await import("node:crypto");
    const { canonicalizeDocumentSnapshot } = await import("@/modules/invoicing");
    const stored = row.rows[0]?.snapshot as Record<string, unknown> | undefined;
    expect(stored).toBeTruthy();
    const rebuilt = {
      schemaVersion: stored?.schemaVersion,
      canonicalizationVersion: stored?.canonicalizationVersion,
      type: stored?.type,
      number: stored?.number,
      numberYear: stored?.numberYear,
      numberSequence: stored?.numberSequence,
      issuedAt: stored?.issuedAt,
      currency: stored?.currency,
      netCents: stored?.netCents,
      taxCents: stored?.taxCents,
      grossCents: stored?.grossCents,
      dueDate: stored?.dueDate,
      deliveryDate: stored?.deliveryDate,
      validityDate: stored?.validityDate,
      plannedDeliveryDate: stored?.plannedDeliveryDate,
      plannedServiceDate: stored?.plannedServiceDate,
      creditNoteType: stored?.creditNoteType,
      name: stored?.name,
      recipientSnapshot: stored?.recipientSnapshot ?? null,
      lines: ((stored?.lines ?? []) as Array<Record<string, unknown>>).map((line) => ({
        position: line.position,
        name: line.name,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        netCents: line.netCents,
        taxCents: line.taxCents,
        grossCents: line.grossCents,
        taxRateBps: line.taxRateBps,
      })),
    };
    const recomputed = createHash("sha256")
      .update(canonicalizeDocumentSnapshot(rebuilt), "utf8")
      .digest("hex");
    expect(recomputed).toBe(row.rows[0]?.hash_hex);
  });

  it("M301-ISSUE-07 (Kimi-P2-6): Sequenz-Überlauf wird als Konflikt abgewiesen", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
    // Serie erst via createDocument seeden (Seeding läuft im Schreibpfad),
    // dann an die Überlaufgrenze schieben.
    const documentId = await seedInvoice(fixture, "Überlauf");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          update commercial_document_number_series
             set last_sequence = 999999
           where workspace_id = ${fixture.workspaceId}::uuid and type = 'invoice'
        `);
      },
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, issueCommand(documentId)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });
});
