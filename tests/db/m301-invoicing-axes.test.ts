import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  issueDocument,
  markSentDocument,
  recordPayment,
  setPaymentStatus,
  upsertInvoicingSettings,
  voidDocument,
  InvoicingConflictError,
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
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
  );
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
});
