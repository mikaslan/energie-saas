import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getDocumentDetail,
  issueDocument,
  voidDocument,
  upsertInvoicingSettings,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import type { ServiceCtx } from "@/lib/permissions";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

type Fixture = { workspaceId: string; editorId: string };

// PG-Fehler stecken ggf. in der Cause-Kette (F4.1-pgCode-Praezedenz).
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

function pgMessage(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && candidate.message.includes("line_parent_")) {
      return candidate.message;
    }
    current = candidate.cause;
  }
  return undefined;
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-02a Siegel')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@m302a.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "M3-02a GmbH",
      companyEmail: "office@m302a.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-02a GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

const settingsSeeded = new Set<string>();

async function ensureSettings(fixture: Fixture): Promise<void> {
  if (settingsSeeded.has(fixture.workspaceId)) return;
  settingsSeeded.add(fixture.workspaceId);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
  );
}

type ContactSeed = {
  displayName: string;
  street?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
};

async function seedContact(fixture: Fixture, seed: ContactSeed): Promise<string> {
  const contactId = randomUUID();
  const email = `${contactId}@m302a.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, ${seed.displayName}, 'Ada', 'Lovelace',
        ${email}, ${email},
        ${seed.street ?? null}, ${seed.houseNumber ?? null}, ${seed.postalCode ?? null},
        ${seed.city ?? null}, ${seed.country ?? null}
      )
    `);
  });
  return contactId;
}

async function seedInvoice(
  fixture: Fixture,
  name: string,
  contactId: string | null = null,
): Promise<string> {
  await ensureSettings(fixture);
  const groupId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `Gruppe ${name}`,
    }),
  ).then((result) => result.id);
  return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice",
        name,
        groupId,
        projectId: null,
        contactId,
        dueDate: "2026-11-30",
        skontoPercentBps: null,
        skontoDays: null,
        deliveryDate: null,
        validityDate: null,
        plannedDeliveryDate: null,
        plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
}

const lineInput = (documentId: string, position: number, netCents: number) => ({
  schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  documentId,
  input: {
    position, name: `Position ${position}`, quantityMilli: 1000,
    unit: "piece" as const, netCents, taxRateBps: 1900 as const,
  },
});

function rawLineInsert(
  fixture: Fixture, documentId: string, position: number,
): (tx: TenantTx) => Promise<unknown> {
  return (tx) => tx.execute(sql`
    insert into commercial_document_line (
      workspace_id, document_id, position, name, quantity_milli,
      unit, net_cents, tax_cents, gross_cents, tax_rate_bps, tax_treatment
    ) values (
      ${fixture.workspaceId}::uuid, ${documentId}::uuid, ${position},
      'Roh-Position', 1000, 'piece', 10000, 1900, 11900, 1900, 'standard_19'
    )
  `);
}

describe("M3-02a Siegel-Voraussetzungen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);

  // Ast-Diskriminierung: beide Trigger-Aeste teilen 23514; die Meldung
  // unterscheidet immutable vs not_found.
  async function expectPgReject(
    fx: Fixture,
    fn: (tx: TenantTx) => Promise<unknown>,
    code: string,
    messageSnippet: string,
  ): Promise<void> {
    let seen: string | undefined;
    let message: string | undefined;
    try {
      await asEditor(fx, (tx) => fn(tx).then(() => undefined));
    } catch (error) {
      seen = pgCode(error);
      message = pgMessage(error);
    }
    expect(seen).toBe(code);
    expect(message).toContain(messageSnippet);
  }

  it("M302A-DB-01: Zeilen ausgestellter/stornierter Belege sind roh-SQL-fest; Entwurf offen", async () => {
    const invoiceId = await seedInvoice(fixture, "M302A-Frost");
    const line = await asEditor(fixture, (tx, ctx) =>
      createDocumentLine(tx, ctx, lineInput(invoiceId, 1, 100000)));
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: invoiceId,
    }));

    // Adversarial: INSERT/UPDATE am ausgestellten Beleg → immutable.
    // RED: ohne Trigger gelingt alles (kein Fehler → pgCode undefined).
    await expectPgReject(fixture, rawLineInsert(fixture, invoiceId, 2), "23514", "line_parent_immutable");
    await expectPgReject(fixture, (tx) => tx.execute(sql`
      update commercial_document_line set name = 'Manipuliert'
       where id = ${line.id}::uuid
    `), "23514", "line_parent_immutable");
    // DELETE: App-Rolle hat keine DELETE-Policy → RLS trifft 0 Zeilen
    // (still, Zeile bleibt). Der Trigger-DELETE-Ast ist fuer App-Rollen
    // strukturell unerreichbar und wird per Superuser bewiesen (der
    // einzige legitime Superuser-Fall: RLS-Umgehung ist hier die
    // Testaussage, nicht deren Umgehung).
    const noDelete = await asEditor(fixture, (tx) => tx.execute(sql`
      delete from commercial_document_line where id = ${line.id}::uuid
    `));
    expect(noDelete.rowCount).toBe(0);
    const stillThere = await asEditor(fixture, (tx) => tx.execute<{ id: string }>(sql`
      select id from commercial_document_line where id = ${line.id}::uuid limit 1
    `));
    expect(stillThere.rows).toHaveLength(1);
    let superCode: string | undefined;
    let superMessage: string | undefined;
    try {
      await superuserPool().query(
        "delete from commercial_document_line where id = $1::uuid",
        [line.id],
      );
    } catch (error) {
      superCode = pgCode(error);
      superMessage = pgMessage(error);
    }
    expect(superCode).toBe("23514");
    expect(superMessage).toContain("line_parent_immutable");

    // Orphan-Ast: INSERT an fehlendem Elternteil → not_found (fail-closed,
    // BEFORE-Trigger greift vor dem FK-Check).
    await expectPgReject(fixture, (tx) => tx.execute(sql`
      insert into commercial_document_line (
        workspace_id, document_id, position, name, quantity_milli,
        unit, net_cents, tax_cents, gross_cents, tax_rate_bps, tax_treatment
      ) values (
        ${fixture.workspaceId}::uuid, ${randomUUID()}::uuid, 1,
        'Orphan', 1000, 'piece', 10000, 1900, 11900, 1900, 'standard_19'
      )
    `), "23514", "line_parent_not_found");

    // Gegenprobe: Entwurf-Zeilen bleiben schreibbar (Service + roh).
    const draftId = await seedInvoice(fixture, "M302A-Offen");
    const draftLine = await asEditor(fixture, (tx, ctx) =>
      createDocumentLine(tx, ctx, lineInput(draftId, 1, 50000)));
    await asEditor(fixture, rawLineInsert(fixture, draftId, 2));
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_line set name = 'Roh-Update ok'
       where id = ${draftLine.id}::uuid
    `));
    const renamed = await asEditor(fixture, (tx) => tx.execute<{ name: string }>(sql`
      select name from commercial_document_line where id = ${draftLine.id}::uuid limit 1
    `));
    expect(renamed.rows[0]?.name).toBe("Roh-Update ok");

    // Umzugs-Angriffe: versiegelt→Entwurf (ALT-Eltern) und
    // Entwurf→versiegelt (NEU-Eltern) scheitern; Entwurf→Entwurf ok.
    const draftTargetId = await seedInvoice(fixture, "M302A-Ziel");
    await expectPgReject(fixture, (tx) => tx.execute(sql`
      update commercial_document_line
         set document_id = ${draftTargetId}::uuid, position = 1
       where id = ${line.id}::uuid
    `), "23514", "line_parent_immutable");
    await expectPgReject(fixture, (tx) => tx.execute(sql`
      update commercial_document_line
         set document_id = ${invoiceId}::uuid, position = 5
       where document_id = ${draftId}::uuid and position = 2
    `), "23514", "line_parent_immutable");
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_line
         set document_id = ${draftTargetId}::uuid, position = 1
       where document_id = ${draftId}::uuid and position = 2
    `));
    const moved = await asEditor(fixture, (tx) => tx.execute<{ document_id: string }>(sql`
      select document_id from commercial_document_line
       where document_id = ${draftTargetId}::uuid and position = 1 limit 1
    `));
    expect(moved.rows).toHaveLength(1);

    // Storno haelt den Frost aufrecht (INSERT + UPDATE + Superuser-DELETE).
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: invoiceId,
      reason: "cancelled",
    }));
    await expectPgReject(fixture, rawLineInsert(fixture, invoiceId, 3), "23514", "line_parent_immutable");
    await expectPgReject(fixture, (tx) => tx.execute(sql`
      update commercial_document_line set name = 'Storno-Manipuliert'
       where id = ${line.id}::uuid
    `), "23514", "line_parent_immutable");
    let voidedSuperCode: string | undefined;
    try {
      await superuserPool().query(
        "delete from commercial_document_line where id = $1::uuid",
        [line.id],
      );
    } catch (error) {
      voidedSuperCode = pgCode(error);
    }
    expect(voidedSuperCode).toBe("23514");

    // Geld des Belegs unveraendert (kein Toll-Free-Schreibpfad).
    const detail = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: invoiceId,
    }));
    expect([detail.document.netCents, detail.document.taxCents, detail.document.grossCents])
      .toEqual([100000, 19000, 119000]);
  });

  it("M302A-DB-02: Ausstellung friert Empfaengeradresse ein (Spalte + Siegel)", async () => {
    // Dekomponiertes u + U+0308 + Padding belegen NFC/Trim.
    const contactId = await seedContact(fixture, {
      displayName: "  Mu\u0308ller GmbH  ",
      street: "  Hauptstraße  ",
      houseNumber: "12a",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    });
    const invoiceId = await seedInvoice(fixture, "M302A-Empf", contactId);
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, lineInput(invoiceId, 1, 100000)));
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: invoiceId,
    }));

    const sealed = await asEditor(fixture, (tx) => tx.execute<{
      recipient_snapshot: Record<string, unknown> | null;
      issued_snapshot: Record<string, unknown>;
    }>(sql`
      select recipient_snapshot, issued_snapshot
        from commercial_document where id = ${invoiceId}::uuid limit 1
    `));
    const column = sealed.rows[0]?.recipient_snapshot;
    // RED: Spalte ist null (nie geschrieben).
    expect(column).toEqual({
      displayName: "M\u00fcller GmbH",
      street: "Hauptstraße",
      houseNumber: "12a",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    });
    expect(column?.displayName).toBe((column?.displayName as string).normalize("NFC"));
    expect(sealed.rows[0]?.issued_snapshot["recipientSnapshot"]).toEqual(column);

    // Ohne Kontakt → null (Legacy-sicher).
    const bareId = await seedInvoice(fixture, "M302A-Blank");
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: bareId,
    }));
    const bare = await asEditor(fixture, (tx) => tx.execute<{
      recipient_snapshot: unknown;
      issued_snapshot: Record<string, unknown>;
    }>(sql`
      select recipient_snapshot, issued_snapshot
        from commercial_document where id = ${bareId}::uuid limit 1
    `));
    expect(bare.rows[0]?.recipient_snapshot).toBeNull();
    expect(bare.rows[0]?.issued_snapshot["recipientSnapshot"]).toBeNull();

    // Geld des Kontakt-Belegs unveraendert (Snapshot friert nur Adresse).
    const contactDetail = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: invoiceId,
    }));
    expect([contactDetail.document.netCents, contactDetail.document.taxCents, contactDetail.document.grossCents])
      .toEqual([100000, 19000, 119000]);

    // Unvollstaendiger Kontakt (nur Name, Rest null) → Snapshot mit nulls.
    const sparseContactId = await seedContact(fixture, { displayName: "Sparse e.V." });
    const sparseId = await seedInvoice(fixture, "M302A-Sparse", sparseContactId);
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: sparseId,
    }));
    const sparse = await asEditor(fixture, (tx) => tx.execute<{
      recipient_snapshot: Record<string, unknown> | null;
      issued_snapshot: Record<string, unknown>;
    }>(sql`
      select recipient_snapshot, issued_snapshot
        from commercial_document where id = ${sparseId}::uuid limit 1
    `));
    expect(sparse.rows[0]?.recipient_snapshot).toEqual({
      displayName: "Sparse e.V.",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      country: null,
    });
    expect(sparse.rows[0]?.issued_snapshot["recipientSnapshot"])
      .toEqual(sparse.rows[0]?.recipient_snapshot);

    // Stale Referenz (Kontakt geloescht) → Validation (fail-closed).
    const staleContactId = await seedContact(fixture, { displayName: "Stale AG" });
    const staleId = await seedInvoice(fixture, "M302A-Stale", staleContactId);
    await asEditor(fixture, (tx) => tx.execute(sql`
      update contact set deleted_at = statement_timestamp() where id = ${staleContactId}::uuid
    `));
    await expect(asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: staleId,
    }))).rejects.toBeInstanceOf(InvoicingValidationError);

    // Ueberlange Adresse ist per Kontakt-CHECK unerreichbar (Service-
    // Validierung bleibt Defense-in-Depth, abgedeckt in CONTRACT-01).
    // Alle Caps an der CHECK-Grenze stellen erfolgreich aus (kein
    // False-Reject): Land non-DE, damit PLZ-20 die zweite CHECK-
    // Alternative trifft.
    const maxContactId = await seedContact(fixture, {
      displayName: "N".repeat(200),
      street: "S".repeat(200),
      houseNumber: "1".repeat(30),
      postalCode: "P".repeat(20),
      city: "C".repeat(200),
      country: "D".repeat(20),
    });
    const maxId = await seedInvoice(fixture, "M302A-Max", maxContactId);
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: maxId,
    }));
    const maxSnap = await asEditor(fixture, (tx) => tx.execute<{
      recipient_snapshot: Record<string, unknown> | null;
    }>(sql`
      select recipient_snapshot from commercial_document where id = ${maxId}::uuid limit 1
    `));
    expect(maxSnap.rows[0]?.recipient_snapshot).toEqual({
      displayName: "N".repeat(200),
      street: "S".repeat(200),
      houseNumber: "1".repeat(30),
      postalCode: "P".repeat(20),
      city: "C".repeat(200),
      country: "D".repeat(20),
    });

    // Blanke Adresse ist per Kontakt-CHECK unerreichbar (nur null oder
    // 1..Cap speicherbar) — Blank→null-Mapping bewiesen in CONTRACT-01.
  });
});
