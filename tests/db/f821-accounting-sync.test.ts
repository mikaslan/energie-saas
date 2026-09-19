import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  ACCOUNTING_SYNC_COMMAND_VERSION,
  type AccountingVendor,
} from "@/lib/integrations/invoicing/accounting-contract";
import { FakeAccountingProvider } from "@/lib/integrations/invoicing/accounting-provider";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  getAccountingSyncStatus,
  issueDocument,
  listAccountingSyncs,
  queueAccountingSync,
  runAccountingSync,
  upsertInvoicingSettings,
  InvoicingConflictError,
  InvoicingNotFoundError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

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
      companyName: "F8-21 GmbH",
      companyEmail: "office@f821.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-21 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedIssuedInvoice(fixture: Fixture, name: string): Promise<string> {
  const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);
  const contactId = randomUUID();
  const email = `${contactId}@f821.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'F821 Kundin',
        'Fixture', 'Contact', ${email}, ${email},
        'Pruefweg', '7', '10115', 'Berlin', 'DE'
      )
    `);
  });
  const groupId = await asEditor((tx, ctx) => createDocumentGroup(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
    name: `F821-Gruppe-${randomUUID().slice(0, 8)}`,
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

function syncCommand(documentId: string, vendor: AccountingVendor) {
  return {
    schemaVersion: ACCOUNTING_SYNC_COMMAND_VERSION,
    documentId,
    vendor,
  } as const;
}

describe("F8-21 Accounting-Sync (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-21 Sync')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values
          (${editorId}::uuid, ${`editor-${editorId}@f821.test`}),
          (${viewerId}::uuid, ${`viewer-${viewerId}@f821.test`})
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

  it("F821-DB-01: Queue→Run→Run legt queued→exported→acknowledged mit external_id zurueck", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-kette");
    const queued = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    expect(queued.state).toBe("queued");
    expect(queued.attempts).toBe(0);
    expect(queued.externalId).toBeNull();
    const provider = new FakeAccountingProvider("lexoffice");
    const exported = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider));
    expect(exported.state).toBe("exported");
    expect(exported.externalId).toBe("fake-lexoffice-000001");
    expect(exported.attempts).toBe(1);
    const acknowledged = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider));
    expect(acknowledged.state).toBe("acknowledged");
    expect(acknowledged.attempts).toBe(2);
    const status = await asEditor(fixture, (tx, ctx) =>
      getAccountingSyncStatus(tx, ctx, syncCommand(documentId, "lexoffice")));
    expect(status.state).toBe("acknowledged");
    const list = await asEditor(fixture, (tx, ctx) => listAccountingSyncs(tx, ctx, { documentId }));
    expect(list.syncs).toHaveLength(1);
  });

  it("F821-DB-02: Idempotenz am gleichen Stand; Retry aus failed zaehlt attempts+1", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-idempotent");
    const first = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "sevdesk")));
    const second = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "sevdesk")));
    expect(second.payloadSha256).toBe(first.payloadSha256);
    expect(second.attempts).toBe(0);
    const provider = new FakeAccountingProvider("sevdesk");
    provider.failNext("vendor-timeout");
    const failed = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "sevdesk"), provider));
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toContain("vendor-timeout");
    expect(failed.attempts).toBe(1);
    const retried = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "sevdesk")));
    expect(retried.state).toBe("queued");
    expect(retried.attempts).toBe(2);
    expect(retried.lastError).toBeNull();
  });

  it("F821-DB-03: terminaler Ack bestaetigt gleichen Stand, verweigert Drift", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-terminal");
    await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "bexio")));
    const provider = new FakeAccountingProvider("bexio");
    await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "bexio"), provider));
    await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "bexio"), provider));
    const same = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "bexio")));
    expect(same.state).toBe("acknowledged");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      await tx.execute(sql`
        update accounting_sync_record
           set payload_sha256 = '0000000000000000000000000000000000000000000000000000000000000000'
         where workspace_id = ${fixture.workspaceId}::uuid
           and document_id = ${documentId}::uuid
           and vendor = 'bexio'
      `);
    });
    await expect(asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "bexio"))
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("F821-DB-04: CHECKs + UNIQUE verweigern Vendor-/State-/SHA-Bruch und Doppelsaetze", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-checks");
    const queued = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    const attempt = (vendor: string, state: string, sha: string, attempts: number) =>
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
        await tx.execute(sql`
          insert into accounting_sync_record (
            workspace_id, document_id, vendor, state, payload_sha256,
            external_id, attempts, last_error
          ) values (
            ${fixture.workspaceId}::uuid, ${documentId}::uuid, ${vendor},
            ${state}, ${sha}, null, ${attempts}, null
          )
        `);
      }).then(() => "inserted").catch((error: unknown) => pgCode(error));
    expect(queued.state).toBe("queued");
    await expect(attempt("datev", "queued", "a".repeat(64), 0)).resolves.toBe("23514");
    await expect(attempt("lexoffice", "acked", "a".repeat(64), 0)).resolves.toBe("23514");
    await expect(attempt("lexoffice", "queued", "kurz", 0)).resolves.toBe("23514");
    await expect(attempt("lexoffice", "queued", "a".repeat(64), -1)).resolves.toBe("23514");
    await expect(attempt("lexoffice", "queued", queued.payloadSha256, 0)).resolves.toBe("23505");
  });

  it("F821-DB-05: Viewer fail-closed; Fremd-Tenant sieht keine Sync-Saetze", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-rls");
    await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    const provider = new FakeAccountingProvider("lexoffice");
    await expect(asViewer(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"))
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) =>
      getAccountingSyncStatus(tx, ctx, syncCommand(documentId, "lexoffice"))
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) => listAccountingSyncs(tx, ctx))
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider)
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const foreignWorkspaceId = randomUUID();
    await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F821 fremd')`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities) values
          (${randomUUID()}::uuid, ${foreignWorkspaceId}::uuid, ${fixture.editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
    });
    const foreignList = await withAuthorizedTenantOn(
      testPool, fixture.editorId, foreignWorkspaceId, (tx, ctx) => listAccountingSyncs(tx, ctx),
    );
    expect(foreignList.syncs).toHaveLength(0);
    await expect(
      withAuthorizedTenantOn(testPool, fixture.editorId, foreignWorkspaceId, (tx, ctx) =>
        getAccountingSyncStatus(tx, ctx, syncCommand(documentId, "lexoffice"))),
    ).rejects.toBeInstanceOf(InvoicingNotFoundError);
  });

  it("F821-DB-06: exported + Drift verweigert Konflikt (kein stilles exported→queued)", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-exportdrift");
    await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    const provider = new FakeAccountingProvider("lexoffice");
    const exported = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider));
    expect(exported.state).toBe("exported");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      await tx.execute(sql`
        update accounting_sync_record
           set payload_sha256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
         where workspace_id = ${fixture.workspaceId}::uuid
           and document_id = ${documentId}::uuid
           and vendor = 'lexoffice'
      `);
    });
    // exported→queued ist kein Maschinen-Uebergang: der alte external_id
    // wuerde auf die neue Payload zeigen (GoBD-Drift). Pfad: run
    // markiert failed, dann Re-Queue aus failed.
    await expect(asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"))
    )).rejects.toBeInstanceOf(InvoicingConflictError);
    const drifted = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider));
    expect(drifted.state).toBe("failed");
    expect(drifted.lastError).toContain("payload-drift");
    const requeued = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    expect(requeued.state).toBe("queued");
    expect(requeued.payloadSha256).toBe(exported.payloadSha256);
  });

  it("F821-DB-07: queued + Drift frischt den Hash auf (CAS, Zustand bleibt queued)", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-queuedrift");
    const queued = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      await tx.execute(sql`
        update accounting_sync_record
           set payload_sha256 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
         where workspace_id = ${fixture.workspaceId}::uuid
           and document_id = ${documentId}::uuid
           and vendor = 'lexoffice'
      `);
    });
    const refreshed = await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    expect(refreshed.state).toBe("queued");
    expect(refreshed.payloadSha256).toBe(queued.payloadSha256);
    expect(refreshed.attempts).toBe(0);
  });

  it("F821-DB-08: ungueltige Provider-external-id markiert failed statt 500", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-badexternal");
    await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    for (const externalId of ["", "x".repeat(201)]) {
      const badProvider = {
        vendor: "lexoffice",
        exportVoucher: async () => ({ externalId, rawStatus: "accepted" }),
      } as const;
      const failed = await asEditor(fixture, (tx, ctx) =>
        runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), badProvider));
      expect(failed.state).toBe("failed");
      expect(failed.lastError).toContain("provider-external-id ungueltig");
      await asEditor(fixture, (tx, ctx) =>
        queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    }
  });

  it("F821-DB-09: astraler Provider-Fehler wird code-point-sicher gekappt (kein Surrogat-Bruch)", async () => {
    const documentId = await seedIssuedInvoice(fixture, "F821-astral");
    await asEditor(fixture, (tx, ctx) =>
      queueAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice")));
    const provider = new FakeAccountingProvider("lexoffice");
    // 32-Zeichen-Prefix + 467 x + Emojis: UTF-16-slice(0,500) endet auf
    // dem High-Surrogat des ersten Emojis (stilles Ersatzzeichen statt
    // 💥); Code-Point-Schnitt haelt das Paar zusammen.
    provider.failNext(`${"x".repeat(467)}${"💥".repeat(100)}`);
    const failed = await asEditor(fixture, (tx, ctx) =>
      runAccountingSync(tx, ctx, syncCommand(documentId, "lexoffice"), provider));
    expect(failed.state).toBe("failed");
    expect([...(failed.lastError ?? "")].length).toBeLessThanOrEqual(500);
    expect(failed.lastError).toContain("💥");
  });
});
