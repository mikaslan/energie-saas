import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  assertIssuingDetailsComplete,
  getInvoicingSettings,
  getNumberFormats,
  upsertInvoicingSettings,
  upsertNumberFormat,
  InvoicingConflictError,
  InvoicingPreconditionConflictError,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

const DE_IBAN = "DE89370400440532013000";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-00 Invoicing')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m300.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m300.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m300.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'admin', '{"external_only":true}'::jsonb)
    `);
  });

  return { workspaceId, editorId, viewerId, externalId };
}

function settingsCommand(
  baseRevision: number,
  overrides: Record<string, unknown> = {},
): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      companyName: "Sonnige Energie GmbH",
      companyEmail: "office@sonnige-energie.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Musterstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: null,
      paymentIban: null,
      paymentBic: null,
      goebdRetentionDefaultDays: 3650,
      ...overrides,
    },
  };
}

describe("M3-00 Workspace-Stammdaten-Service (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("M300-DB-01: legt Settings an, liest sie zurück und aktualisiert mit CAS", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0, {
        paymentAccountHolder: "Sonnige Energie GmbH",
        paymentIban: DE_IBAN,
        paymentBic: "DEUTDEBB",
      })),
    );
    expect(created).toEqual({ revision: 1, created: true });

    const read = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    );
    expect(read!.revision).toBe(1);
    expect(read!.companyTaxId).toBe("DE123456789");
    expect(read!.paymentIban).toBe(DE_IBAN);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(1, {
        companyCity: "Hamburg",
      })),
    );
    expect(updated.revision).toBe(2);

    // Stale CAS → Conflict.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(1)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("M300-DB-02: seeded 6 Default-Formate idempotent und updatet nur das Template (counter bleibt)", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getNumberFormats(tx, ctx),
    );
    expect(first.formats).toHaveLength(6);
    expect(first.formats.find((f) => f.type === "invoice")!.formatTemplate)
      .toBe("Rechnung-{YEAR}-{MONTH}-{NUMBER}");

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertNumberFormat(tx, ctx, {
        schemaVersion: WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
        type: "invoice",
        formatTemplate: "R-{YEAR}-{NUMBER}",
      }),
    );
    expect(updated.counter).toBe(0);

    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getNumberFormats(tx, ctx),
    );
    expect(second.formats).toHaveLength(6);
    expect(second.formats.find((f) => f.type === "invoice")!.formatTemplate)
      .toBe("R-{YEAR}-{NUMBER}");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertNumberFormat(tx, ctx, {
        schemaVersion: WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
        type: "invoice",
        formatTemplate: "R-{YEAR}", // {NUMBER} fehlt → invalid
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
  });

  it("M300-RACE-01: Singleton-Doppel-Insert — genau einer gewinnt", async () => {
    const results = await Promise.allSettled([
      withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
      ),
      withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvoicingConflictError);
  });

  it("M300-DB-03: Precondition-Gate — Geld-Dokument verlangt Zahlungsdaten + DE; Brief bleibt möglich", async () => {
    // Ohne Settings → PreconditionConflict für Geld UND Brief.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => assertIssuingDetailsComplete(tx, fixture.workspaceId, "invoice"),
    )).rejects.toBeInstanceOf(InvoicingPreconditionConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );

    // Ohne Zahlungsdaten: Geld blockiert, Brief ok.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => assertIssuingDetailsComplete(tx, fixture.workspaceId, "invoice"),
    )).rejects.toBeInstanceOf(InvoicingPreconditionConflictError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => assertIssuingDetailsComplete(tx, fixture.workspaceId, "letter"),
    )).resolves.toBeUndefined();

    // Nicht-DE-Land blockt Geld-Dokument, Brief bleibt möglich.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(1, {
        companyCountry: "AT",
        paymentAccountHolder: "Sonnige Energie GmbH",
        paymentIban: DE_IBAN,
        paymentBic: "DEUTDEBB",
      })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => assertIssuingDetailsComplete(tx, fixture.workspaceId, "invoice"),
    )).rejects.toBeInstanceOf(InvoicingPreconditionConflictError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx) => assertIssuingDetailsComplete(tx, fixture.workspaceId, "letter"),
    )).resolves.toBeUndefined();
  });

  it("M300-CON-01: DTO-Minimierung — Viewer ohne Issuing-Details-Recht sieht TaxId/IBAN nicht", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0, {
        paymentAccountHolder: "Sonnige Energie GmbH",
        paymentIban: DE_IBAN,
        paymentBic: "DEUTDEBB",
      })),
    );

    const editorView = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    );
    expect(editorView!.companyTaxId).toBe("DE123456789");
    expect(editorView!.paymentIban).toBe(DE_IBAN);

    const viewerView = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    );
    expect(viewerView!.companyTaxId).toBeNull();
    expect(viewerView!.paymentIban).toBeNull();
    expect(viewerView!.permissions.canWriteIssuingDetails).toBe(false);
  });

  it("M300-05: Viewer read-only, External/Fremdtenant fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(0)),
    );

    // Viewer kann lesen, aber nicht schreiben.
    const viewerRead = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    );
    expect(viewerRead).not.toBeNull();
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand(1)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // External wird abgewiesen.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremdtenant sieht nichts (RLS).
    const other = await seedFixture();
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => getInvoicingSettings(tx, ctx),
    );
    expect(foreign).toBeNull();
  });
});
