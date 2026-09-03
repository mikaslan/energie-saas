import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  issueDocument,
  markSentDocument,
  recordPayment,
  setDocumentArchived,
  setDocumentGroupArchived,
  setPaymentStatus,
  upsertInvoicingSettings,
  voidDocument,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-01 Achsen')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@m301a.test`})
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
      companyName: "M3-01 Achsen GmbH",
      companyEmail: "office@m301a.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Achsenstraße 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-01 Achsen GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedIssuedInvoice(fixture: Fixture, grossCents = 11900): Promise<string> {
  // Idempotent: Settings nur anlegen, wenn noch keine Zeile existiert
  // (zweiter Aufruf im selben Fixture liefe sonst in den Singleton-UNIQUE).
  const existing = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx) => tx.execute<{ c: number }>(sql`
      select count(*)::integer as c from workspace_invoicing_settings
       where workspace_id = ${fixture.workspaceId}::uuid
    `),
  );
  if (existing.rows[0]?.c === 0) {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );
  }
  const id = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice" as const, name: "Achsen-Rechnung", groupId: null, projectId: null,
        contactId: null, dueDate: "2026-12-31", deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
        creditNoteType: null,
      },
    }),
  ).then((result) => result.id);
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    async (tx) => {
      await tx.execute(sql`
        insert into commercial_document_line (
          id, workspace_id, document_id, position, name, quantity_milli, unit,
          net_cents, tax_cents, gross_cents, tax_rate_bps, line_snapshot
        ) values (
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${id}::uuid, 1,
          'Position', 1000, 'piece', ${grossCents > 0 ? 10000 : 0},
          ${grossCents > 0 ? 1900 : 0}, ${grossCents}, 1900,
          '{"schemaVersion":"commercial-document-line.v1"}'::jsonb
        )
      `);
      await tx.execute(sql`
        update commercial_document
           set net_cents = ${grossCents > 0 ? 10000 : 0},
               tax_cents = ${grossCents > 0 ? 1900 : 0},
               gross_cents = ${grossCents}
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${id}::uuid
      `);
    },
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: id,
    }),
  );
  return id;
}

describe("M3-01 Versand-/Storno-/Zahlungsachse (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("M301-AX-01: Versandachse — issued→sent einmalig, draft blockiert", async () => {
    const id = await seedIssuedInvoice(fixture);
    const sent = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => markSentDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION, documentId: id,
      }),
    );
    expect(sent.sentAt).toBeTruthy();
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => markSentDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION, documentId: id,
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Draft darf nicht als versendet markiert werden.
    const draftId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Entwurf", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => markSentDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION, documentId: draftId,
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M301-AX-02: Storno — issued→voided mit Pflichtgrund, Nummer bleibt verbrannt, terminal", async () => {
    const firstId = await seedIssuedInvoice(fixture);
    const firstNumber = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: firstId, reason: "created_in_error",
      }),
    ).then((document) => document.number);
    expect(firstNumber).toBeTruthy();

    // Nummer wird nicht freigegeben: nächste Ausstellung setzt die Sequenz fort.
    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice" as const, name: "Nach Storno", groupId: null, projectId: null,
          contactId: null, dueDate: "2026-12-31", deliveryDate: null,
          validityDate: null, plannedDeliveryDate: null, plannedServiceDate: null,
          creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into commercial_document_line (
            id, workspace_id, document_id, position, name, quantity_milli, unit,
            net_cents, tax_cents, gross_cents, tax_rate_bps, line_snapshot
          ) values (
            ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${second}::uuid, 1,
            'Position', 1000, 'piece', 10000, 1900, 11900, 1900,
            '{"schemaVersion":"commercial-document-line.v1"}'::jsonb
          )
        `);
        await tx.execute(sql`
          update commercial_document
             set net_cents = 10000, tax_cents = 1900, gross_cents = 11900
           where workspace_id = ${fixture.workspaceId}::uuid and id = ${second}::uuid
        `);
      },
    );
    const issued = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => issueDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: second,
      }),
    );
    expect(issued.numberSequence).toBe(2);

    // voided ist terminal.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: firstId, reason: "duplicate",
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Draft-Verwerfen funktioniert ebenfalls.
    const draftId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Verwerfen", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    const voidedDraft = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: draftId, reason: "cancelled",
      }),
    );
    expect(voidedDraft.status).toBe("voided");
    expect(voidedDraft.voidReason).toBe("cancelled");
  });

  it("M301-AX-03: Zahlungsachse — Ableitung aus paid_cents, paid terminal, Brief blockiert", async () => {
    const id = await seedIssuedInvoice(fixture);
    const partial = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 5000,
      }),
    );
    expect(partial.paymentStatus).toBe("partially_paid");

    const paid = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 11900,
      }),
    );
    expect(paid.paymentStatus).toBe("paid");

    // paid ist terminal: Status-Wechsel wird abgelehnt.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setPaymentStatus(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
        documentId: id, status: "overdue",
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Brief hat keine Zahlungsachse.
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
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: letterId, paidCents: 1,
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("M301-AX-04: Overdue/Uncollectable nur auf issued und nicht aus paid", async () => {
    const id = await seedIssuedInvoice(fixture);
    const overdue = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setPaymentStatus(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
        documentId: id, status: "overdue",
      }),
    );
    expect(overdue.paymentStatus).toBe("overdue");

    // uncollectable terminal.
    const uncollectable = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setPaymentStatus(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
        documentId: id, status: "uncollectable",
      }),
    );
    expect(uncollectable.paymentStatus).toBe("uncollectable");
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 11900,
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M301-AX-05 (Kimi-P1-1/P2-1): sent→voided funktioniert; bezahltes Dokument ist stornierbar (DECIDED)", async () => {
    const id = await seedIssuedInvoice(fixture);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => markSentDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION, documentId: id,
      }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 5000,
      }),
    );
    const voided = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: id, reason: "superseded",
      }),
    );
    expect(voided.status).toBe("voided");
    expect(voided.sentAt).toBeTruthy();
  });

  it("M301-AX-06 (Kimi-P2-2/P2-3): Fremdtenant scheitert; unpaid-Reset und Void-blockt-Zahlung", async () => {
    const id = await seedIssuedInvoice(fixture);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 5000,
      }),
    );
    // unpaid-Reset auf 0 — aus partially_paid (paid ist terminal).
    const reset = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 0,
      }),
    );
    expect(reset.paymentStatus).toBe("unpaid");
    // paid ist terminal: Reset aus paid wird abgelehnt (Spec M301-05).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 11900,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 0,
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Fremdtenant: NotFound/Conflict.
    const other = await seedFixture();
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: id, paidCents: 100,
      }),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: id, reason: "other",
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // voided blockt Zahlungen.
    const second = await seedIssuedInvoice(fixture);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => voidDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
        documentId: second, reason: "created_in_error",
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordPayment(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
        documentId: second, paidCents: 100,
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M301-AX-07: Archiv-Achse — reversibler Toggle über alle Status, Content bleibt unberührt", async () => {
    const id = await seedIssuedInvoice(fixture);
    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
        documentId: id, archived: true,
      }),
    );
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.status).toBe("issued");
    expect(archived.grossCents).toBe(11900);

    const reopened = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
        documentId: id, archived: false,
      }),
    );
    expect(reopened.archivedAt).toBeNull();

    // Draft lässt sich ebenfalls archivieren.
    const draftId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "letter" as const, name: "Draft-Brief", groupId: null, projectId: null,
          contactId: null, dueDate: null, deliveryDate: null, validityDate: "2026-12-31",
          plannedDeliveryDate: null, plannedServiceDate: null, creditNoteType: null,
        },
      }),
    ).then((result) => result.id);
    const draftArchived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ARCHIVE_COMMAND_VERSION,
        documentId: draftId, archived: true,
      }),
    );
    expect(draftArchived.archivedAt).toBeTruthy();
    expect(draftArchived.status).toBe("draft");
  });

  it("M301-AX-08: Gruppen-Archiv-Toggle; unbekannte Gruppen-ID → NotFound ohne Leak", async () => {
    // Settings idempotent seeden (Geld-Dokumente brauchen die O4-Precondition).
    await seedIssuedInvoice(fixture);
    const groupId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocumentGroup(tx, ctx, {
        schemaVersion: "commercial-document-group-command.v1" as const,
        name: "Archiv-Gruppe",
      }),
    ).then((result) => result.id);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentGroupArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
        groupId, archived: true,
      }),
    );
    // Archivierte Gruppe blockt neue Dokumente (M301-DB-07-Muster).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice" as const, name: "In Archiv-Gruppe", groupId,
          projectId: null, contactId: null, dueDate: "2026-12-31",
          deliveryDate: null, validityDate: null, plannedDeliveryDate: null,
          plannedServiceDate: null, creditNoteType: null,
        },
      }),
    )).rejects.toBeInstanceOf(InvoicingConflictError);

    // Reopen hebt den Block auf.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentGroupArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
        groupId, archived: false,
      }),
    );
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice" as const, name: "Nach Reopen", groupId,
          projectId: null, contactId: null, dueDate: "2026-12-31",
          deliveryDate: null, validityDate: null, plannedDeliveryDate: null,
          plannedServiceDate: null, creditNoteType: null,
        },
      }),
    );
    expect(created.id).toBeTruthy();

    // Unbekannte Gruppe im eigenen Workspace: NotFound (kein Existenz-Leak;
    // der Cross-Tenant-Negativfall der Listen liegt in M301-LIST-06).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setDocumentGroupArchived(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_ARCHIVE_COMMAND_VERSION,
        groupId: randomUUID(), archived: true,
      }),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });
});
