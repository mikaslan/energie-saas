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
  COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  recordPayment,
  setPaymentStatus,
  upsertInvoicingSettings,
  voidDocument,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { sweepOverdueDocuments } from "@/modules/invoicing/overdue-service";
import { listOverdueSweepWorkspacePage } from "@/worker/overdue-sweep";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

const PAST_DUE = "2000-01-15";
const FUTURE_DUE = "2999-12-31";

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-24a GmbH",
      companyEmail: "office@f824a.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-24a GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedContact(fixture: Fixture): Promise<string> {
  const contactId = randomUUID();
  const email = `${contactId}@f824a.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F824a Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  return contactId;
}

describe("F8-24a Overdue-Sweep (PostgreSQL)", () => {
  let fixture: Fixture;
  let contactId: string;
  let groupId: string;

  const asEditor = <T>(
    fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-24a Sweep')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f824a.test`})
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
    contactId = await seedContact(fixture);
    groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `F824a-Gruppe-${randomUUID().slice(0, 8)}`,
    })).then((result) => result.id);
  });

  async function seedInvoice(name: string, dueDate: string): Promise<string> {
    const documentId = await asEditor((tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice", name, groupId, projectId: null, contactId,
        dueDate, skontoPercentBps: null, skontoDays: null,
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
    return documentId;
  }

  async function paymentStatusOf(documentId: string): Promise<string | null> {
    return asEditor(async (tx) => {
      const rows = await tx.execute<{ payment_status: string | null }>(sql`
        select payment_status from commercial_document
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${documentId}::uuid
      `);
      return rows.rows[0]?.payment_status ?? null;
    });
  }

  async function evidenceCounts(documentId: string): Promise<{ events: number; audits: number }> {
    return asEditor(async (tx) => {
      const events = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_id = ${documentId}::uuid
           and event_type = 'commercial_document.payment_updated'
           and payload->>'paymentStatus' = 'overdue'
      `);
      const audits = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'document.payment.write'
           and details->>'documentId' = ${documentId}
           and details->>'paymentStatus' = 'overdue'
      `);
      return { events: Number(events.rows[0]?.n ?? 0), audits: Number(audits.rows[0]?.n ?? 0) };
    });
  }

  it("F824A-DB-01: issued + unbezahlte Achse + faellig -> overdue mit Event/Audit", async () => {
    const unpaidId = await seedInvoice("F824a-unpaid", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: unpaidId,
    }));
    const partialId = await seedInvoice("F824a-partial", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: partialId,
    }));
    await asEditor((tx, ctx) => recordPayment(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
      documentId: partialId, paidCents: 1000,
    }));

    const result = await asEditor((tx, ctx) => sweepOverdueDocuments(tx, ctx));

    expect(result.swept).toBe(2);
    expect(new Set(result.sweptDocumentIds)).toEqual(new Set([unpaidId, partialId]));
    expect(result.truncated).toBe(false);
    expect(await paymentStatusOf(unpaidId)).toBe("overdue");
    expect(await paymentStatusOf(partialId)).toBe("overdue");
    expect(await evidenceCounts(unpaidId)).toEqual({ events: 1, audits: 1 });
    expect(await evidenceCounts(partialId)).toEqual({ events: 1, audits: 1 });
  });

  it("F824A-DB-02: paid/uncollectable/Draft/voided/nicht-faellig/bereits-overdue bleiben unberuehrt", async () => {
    const paidId = await seedInvoice("F824a-paid", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: paidId,
    }));
    await asEditor((tx, ctx) => recordPayment(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION,
      documentId: paidId, paidCents: 119000,
    }));
    const uncollId = await seedInvoice("F824a-uncoll", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: uncollId,
    }));
    await asEditor((tx, ctx) => setPaymentStatus(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
      documentId: uncollId, status: "uncollectable",
    }));
    const draftId = await seedInvoice("F824a-draft", PAST_DUE);
    const voidedId = await seedInvoice("F824a-voided", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: voidedId,
    }));
    await asEditor((tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: voidedId, reason: "cancelled",
    }));
    const futureId = await seedInvoice("F824a-future", FUTURE_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: futureId,
    }));
    const alreadyId = await seedInvoice("F824a-already", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId: alreadyId,
    }));
    await asEditor((tx, ctx) => setPaymentStatus(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION,
      documentId: alreadyId, status: "overdue",
    }));
    const before = await evidenceCounts(alreadyId);

    const result = await asEditor((tx, ctx) => sweepOverdueDocuments(tx, ctx));

    expect(result).toEqual({ swept: 0, sweptDocumentIds: [], truncated: false });
    expect(await paymentStatusOf(paidId)).toBe("paid");
    expect(await paymentStatusOf(uncollId)).toBe("uncollectable");
    expect(await paymentStatusOf(draftId)).toBe("unpaid");
    expect(await paymentStatusOf(voidedId)).toBe("unpaid");
    expect(await paymentStatusOf(futureId)).toBe("unpaid");
    expect(await paymentStatusOf(alreadyId)).toBe("overdue");
    expect(await evidenceCounts(alreadyId)).toEqual(before);
    expect(await evidenceCounts(paidId)).toEqual({ events: 0, audits: 0 });
    expect(await evidenceCounts(futureId)).toEqual({ events: 0, audits: 0 });
  });

  it("F824A-DB-03: Zweitlauf ist No-Op — idempotent, kein Rewrite, kein Doppel-Event", async () => {
    const documentId = await seedInvoice("F824a-idem", PAST_DUE);
    await asEditor((tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION, documentId,
    }));

    const first = await asEditor((tx, ctx) => sweepOverdueDocuments(tx, ctx));
    expect(first.swept).toBe(1);
    const second = await asEditor((tx, ctx) => sweepOverdueDocuments(tx, ctx));

    expect(second).toEqual({ swept: 0, sweptDocumentIds: [], truncated: false });
    expect(await paymentStatusOf(documentId)).toBe("overdue");
    expect(await evidenceCounts(documentId)).toEqual({ events: 1, audits: 1 });
  });

  it("F824A-DB-04: Spiegel-Trigger traegt jeden Workspace in den Sweep-Arbeitsvorrat ein", async () => {
    // Der beforeEach-Workspace muss bereits gespiegelt sein (Trigger).
    const mirrored = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ workspace_id: string }>(sql`
        select workspace_id from overdue_sweep_workspace
         where workspace_id = ${fixture.workspaceId}::uuid
      `);
      return result.rows;
    });
    expect(mirrored).toHaveLength(1);
    // Doppel-Insert ist idempotent (ON CONFLICT DO NOTHING).
    const extraId = randomUUID();
    await withTenantOn(testPool, extraId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${extraId}::uuid, 'F824a Spiegel')`);
      await tx.execute(sql`
        insert into overdue_sweep_workspace (workspace_id)
        values (${extraId}::uuid)
        on conflict do nothing
      `);
    });
    const count = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from overdue_sweep_workspace
         where workspace_id = ${extraId}::uuid
      `);
      return Number(result.rows[0]?.n ?? 0);
    });
    expect(count).toBe(1);
  });

  it("F824A-DB-05: Vorrat-Seite paginiert stabil ueber after+limit (kein stiller No-Op)", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of ids) {
      await withTenantOn(testPool, id, async (tx) => {
        await tx.execute(sql`insert into workspace (id, name) values (${id}::uuid, 'F824a Seite')`);
      });
    }
    const first = await listOverdueSweepWorkspacePage(testPool, {
      afterWorkspaceId: null,
      limit: 2,
    });
    // Der Vorrat enthaelt auch Fixture-Workspaces anderer Tests — die
    // Seite muss sortiert sein und exakt `limit` Zeilen liefern.
    expect(first.workspaceIds).toHaveLength(2);
    expect([...first.workspaceIds].sort()).toEqual(first.workspaceIds);
    expect(first.nextAfterWorkspaceId).toBe(first.workspaceIds[1]);
    const second = await listOverdueSweepWorkspacePage(testPool, {
      afterWorkspaceId: first.nextAfterWorkspaceId,
      limit: 2,
    });
    expect(second.workspaceIds.every((id) => id > (first.nextAfterWorkspaceId ?? ""))).toBe(true);
    expect(new Set([...first.workspaceIds, ...second.workspaceIds]).size)
      .toBe(first.workspaceIds.length + second.workspaceIds.length);
  });
});
