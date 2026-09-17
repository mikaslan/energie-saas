import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  createDocument,
  createDocumentGroup,
  createDocumentLine,
  issueDocument,
  upsertInvoicingSettings,
  voidDocument,
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
  type InvoicingSettingsCommandV1,
} from "@/modules/invoicing";
import { requestInvoicePdfInput } from "@/modules/invoicing/pdf-service";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
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

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-02b Render')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values
        (${editorId}::uuid, ${`editor-${editorId}@m302b.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m302b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "M3-02b GmbH",
      companyEmail: "office@m302b.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "M3-02b GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function seedContact(fixture: Fixture): Promise<string> {
  const contactId = randomUUID();
  const email = `${contactId}@m302b.test`;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized,
        address_street, address_house_number, address_postal_code,
        address_city, address_country
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'Muster GmbH', 'Ada', 'Lovelace',
        ${email}, ${email},
        'Musterstrasse', '12a', '10115', 'Berlin', 'DE'
      )
    `);
  });
  return contactId;
}

async function seedIssuedInvoice(fixture: Fixture, contactId: string | null): Promise<string> {
  const groupId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `M302B-Gruppe-${randomUUID().slice(0, 8)}`,
    }),
  ).then((result) => result.id);
  const documentId = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice",
        name: "M302B-Rechnung",
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
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId,
      input: {
        position: 1, name: "Position 1", quantityMilli: 1000,
        unit: "piece" as const, netCents: 100000, taxRateBps: 1900 as const,
      },
    }));
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId,
    }));
  return documentId;
}

describe("M3-02b Render-Input (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
    );
  });

  const asEditor = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(
    fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
  ): Promise<T> => withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  async function countJobs(fx: Fixture): Promise<number> {
    // Autorisiert lesen: Actor-RLS blendet sonst alle Zeilen aus.
    return withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, async (tx) => {
      const rows = await tx.execute<{ c: number }>(sql`
        select count(*)::int as c from commercial_document_render_job
         where workspace_id = ${fx.workspaceId}::uuid
      `);
      return rows.rows[0]?.c ?? -1;
    });
  }

  it("M302B-CT-04a: versiegelt genau einen Job je Dokument; Replay idempotent", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const command = {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    } as const;
    const first = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command));
    expect(first.inputSha256Hex).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/u);
    const second = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command));
    expect(second.jobId).toBe(first.jobId);
    expect(second.inputSha256Hex).toBe(first.inputSha256Hex);
    expect(await countJobs(fixture)).toBe(1);
    // Hash-Readback: gespeicherter Hash == Rueckrechnung aus gespeichertem JSON.
    const stored = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ input_json: unknown; hex: string }>(sql`
        select input_json, encode(input_sha256, 'hex') as hex
          from commercial_document_render_job
         where id = ${first.jobId}::uuid
      `);
      return rows.rows[0];
    });
    expect(stored?.hex).toBe(first.inputSha256Hex);
    const { hashInvoicePdfInput } = await import("@/lib/integrations/invoicing/pdf-contract");
    expect(hashInvoicePdfInput(stored?.input_json)).toBe(first.inputSha256Hex);
  });

  it("M302B-CT-01: Viewer/External/Fremd-Tenant fail-closed, kein Job", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const command = {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    } as const;
    await expect(asViewer(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, command),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    // External-Editor: invoicing-Flag nützt nichts (internalOnly-Schranke).
    const externalId = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${externalId}::uuid, ${`external-${externalId}@m302b.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
                ${externalId}::uuid, 'editor',
                '{"invoicing":true,"external_only":true}'::jsonb)
      `);
    });
    await expect(
      withAuthorizedTenantOn(testPool, externalId, fixture.workspaceId, (tx, ctx) =>
        requestInvoicePdfInput(tx, ctx, command),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const foreign = await seedFixture();
    await expect(asEditor(foreign, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, command),
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
    expect(await countJobs(fixture)).toBe(0);
  });

  it("M302B-CT-04b: paralleler Doppelaufruf erzeugt genau einen Job", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const command = {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    } as const;
    const outcomes = await Promise.allSettled([
      asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command)),
      asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command)),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof requestInvoicePdfInput>>> =>
        outcome.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0]?.value.jobId).toBe(fulfilled[1]?.value.jobId);
    expect(await countJobs(fixture)).toBe(1);
  });

  it("M302B-CT-02: Entwurf/fehlender Snapshot fail-closed, kein Job", async () => {
    // Entwurf (nicht ausgestellt).
    const groupId = await asEditor(fixture, (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: "M302B-Entwurf",
    })).then((result) => result.id);
    const draftId = await asEditor(fixture, (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice", name: "M302B-Entwurf", groupId,
        projectId: null, contactId: null, dueDate: "2026-11-30",
        skontoPercentBps: null, skontoDays: null, deliveryDate: null,
        validityDate: null, plannedDeliveryDate: null,
        plannedServiceDate: null, creditNoteType: null,
      },
    })).then((result) => result.id);
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
        documentId: draftId,
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
    // Ausgestellt ohne Kontakt → Snapshot null → Fail-closed.
    const noContactId = await seedIssuedInvoice(fixture, null);
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
        documentId: noContactId,
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
    // Storniert → Fail-closed.
    const contactId = await seedContact(fixture);
    const voidedId = await seedIssuedInvoice(fixture, contactId);
    await asEditor(fixture, (tx, ctx) => voidDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION,
      documentId: voidedId,
      reason: "cancelled",
    }));
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
        documentId: voidedId,
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
    // Ausgestellter Brief → Fail-closed (Typ-Schranke).
    const letterGroupId = await asEditor(fixture, (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: "M302B-Brief",
    })).then((result) => result.id);
    const letterId = await asEditor(fixture, (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "letter", name: "M302B-Brief", groupId: letterGroupId,
        projectId: null, contactId, dueDate: null,
        skontoPercentBps: null, skontoDays: null, deliveryDate: null,
        validityDate: "2026-12-31", plannedDeliveryDate: null,
        plannedServiceDate: null, creditNoteType: null,
      },
    })).then((result) => result.id);
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: letterId,
    }));
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
        documentId: letterId,
      }),
    )).rejects.toBeInstanceOf(InvoicingValidationError);
    expect(await countJobs(fixture)).toBe(0);
  });

  it("M302B-CT-06-DB: manipulierter Speicher-Input → Replay fail-closed", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const command = {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    } as const;
    const sealed = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command));
    // Tamper: JSON aendern, Hash stehen lassen → Replay muss Integrity werfen.
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_render_job
         set input_json = '{"tampered":true}'::jsonb
       where id = ${sealed.jobId}::uuid
    `).then(() => undefined));
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, command),
    )).rejects.toBeInstanceOf(InvoicingIntegrityError);
  });

  it("M302B-CT-06-DBb: schema-valider Werte-Tamper → Hash-Mismatch fail-closed", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const command = {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    } as const;
    const sealed = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, command));
    // Schema-valider Tamper: nur ein Datumswert aendern (Parse ok, Hash tot).
    await asEditor(fixture, (tx) => tx.execute(sql`
      update commercial_document_render_job
         set input_json = jsonb_set(input_json, '{preparedAt}', '"2026-01-01T00:00:00Z"')
       where id = ${sealed.jobId}::uuid
    `).then(() => undefined));
    await expect(asEditor(fixture, (tx, ctx) =>
      requestInvoicePdfInput(tx, ctx, command),
    )).rejects.toBeInstanceOf(InvoicingIntegrityError);
  });

  it("M302B-CT-02d: Gutschrift wird versiegelt (Typ-Zweig credit_note)", async () => {
    const contactId = await seedContact(fixture);
    const groupId = await asEditor(fixture, (tx, ctx) => createDocumentGroup(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: `M302B-Gutschrift-${randomUUID().slice(0, 8)}`,
    })).then((result) => result.id);
    const creditId = await asEditor(fixture, (tx, ctx) => createDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "credit_note", name: "M302B-Gutschrift", groupId,
        projectId: null, contactId, dueDate: null,
        skontoPercentBps: null, skontoDays: null, deliveryDate: "2026-09-01",
        validityDate: null, plannedDeliveryDate: null,
        plannedServiceDate: null, creditNoteType: "minderleistung",
      },
    })).then((result) => result.id);
    await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: creditId,
      input: {
        position: 1, name: "Minderleistung", quantityMilli: 1000,
        unit: "piece" as const, netCents: 50000, taxRateBps: 1900 as const,
      },
    }));
    await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
      documentId: creditId,
    }));
    const sealed = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId: creditId,
    }));
    expect(sealed.inputSha256Hex).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await asEditor(fixture, async (tx) => {
      const rows = await tx.execute<{ input_json: { document: { type: string; creditNoteType: string | null; invoiceKind: string | null } } }>(sql`
        select input_json from commercial_document_render_job
         where id = ${sealed.jobId}::uuid
      `);
      return rows.rows[0]?.input_json;
    });
    expect(stored?.document.type).toBe("credit_note");
    expect(stored?.document.creditNoteType).toBe("minderleistung");
    expect(stored?.document.invoiceKind).toBeNull();
  });

  it("M302B-SVC-02: Leistungsdatum-Praezedenz Ist-vor-Plan", async () => {
    const contactId = await seedContact(fixture);
    async function sealWithDates(
      deliveryDate: string | null,
      plannedServiceDate: string | null,
    ): Promise<string | null> {
      const groupId = await asEditor(fixture, (tx, ctx) => createDocumentGroup(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
        name: `M302B-Datum-${randomUUID().slice(0, 8)}`,
      })).then((result) => result.id);
      const docId = await asEditor(fixture, (tx, ctx) => createDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
        input: {
          type: "invoice", name: "M302B-Datum", groupId,
          projectId: null, contactId, dueDate: "2026-11-30",
          skontoPercentBps: null, skontoDays: null, deliveryDate,
          validityDate: null, plannedDeliveryDate: null,
          plannedServiceDate, creditNoteType: null,
        },
      })).then((result) => result.id);
      await asEditor(fixture, (tx, ctx) => createDocumentLine(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
        documentId: docId,
        input: {
          position: 1, name: "P", quantityMilli: 1000,
          unit: "piece" as const, netCents: 1000, taxRateBps: 1900 as const,
        },
      }));
      await asEditor(fixture, (tx, ctx) => issueDocument(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
        documentId: docId,
      }));
      const sealed = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
        documentId: docId,
      }));
      const stored = await asEditor(fixture, async (tx) => {
        const rows = await tx.execute<{ input_json: { document: { serviceDate: string | null } } }>(sql`
          select input_json from commercial_document_render_job
           where id = ${sealed.jobId}::uuid
        `);
        return rows.rows[0]?.input_json;
      });
      return stored?.document.serviceDate ?? null;
    }
    // Beide gesetzt → Ist-Datum gewinnt.
    expect(await sealWithDates("2026-09-05", "2026-09-01")).toBe("2026-09-05");
    // Nur Plan → Plan.
    expect(await sealWithDates(null, "2026-09-01")).toBe("2026-09-01");
    // Keins → null.
    expect(await sealWithDates(null, null)).toBeNull();
  });

  it("M302B-DB-01: UNIQUE/CHECK/RLS der Job-Tabelle", async () => {
    const contactId = await seedContact(fixture);
    const documentId = await seedIssuedInvoice(fixture, contactId);
    const job = await asEditor(fixture, (tx, ctx) => requestInvoicePdfInput(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
      documentId,
    }));
    // Duplikat-Insert → UNIQUE-Violation 23505.
    let uniqueCode: string | undefined;
    try {
      await asEditor(fixture, (tx) => tx.execute(sql`
        insert into commercial_document_render_job (
          workspace_id, document_id, input_json, input_sha256,
          template_version, renderer_recipe, status, created_by
        ) select workspace_id, document_id, input_json, input_sha256,
                 template_version, renderer_recipe, status, created_by
            from commercial_document_render_job where id = ${job.jobId}::uuid
      `).then(() => undefined));
    } catch (error) {
      uniqueCode = pgCode(error);
    }
    expect(uniqueCode).toBe("23505");
    // Fremd-Tenant sieht die Zeile nicht (RLS).
    const foreign = await seedFixture();
    const seen = await withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId, async (tx) => {
        const rows = await tx.execute<{ c: number }>(sql`
          select count(*)::int as c from commercial_document_render_job
           where id = ${job.jobId}::uuid
        `);
        return rows.rows[0]?.c ?? -1;
      });
    expect(seen).toBe(0);
    // CHECK-Negativ-Inserts: Status/Template/Rezept/JSON-Objekt/SHA-32.
    // Eigener Beleg, damit nie UNIQUE (23505) statt CHECK (23514) feuert.
    const checkDocId = await seedIssuedInvoice(fixture, null);
    const badRows = [
      { status: "queued", template: "invoice-pdf-template.v1", recipe: "invoice-pdf-renderer-recipe.v1", json: "'{}'::jsonb", sha: "decode(repeat('00', 32), 'hex')" },
      { status: "requested", template: "other-template.v9", recipe: "invoice-pdf-renderer-recipe.v1", json: "'{}'::jsonb", sha: "decode(repeat('00', 32), 'hex')" },
      { status: "requested", template: "invoice-pdf-template.v1", recipe: "other-recipe.v9", json: "'{}'::jsonb", sha: "decode(repeat('00', 32), 'hex')" },
      { status: "requested", template: "invoice-pdf-template.v1", recipe: "invoice-pdf-renderer-recipe.v1", json: "'[]'::jsonb", sha: "decode(repeat('00', 32), 'hex')" },
      { status: "requested", template: "invoice-pdf-template.v1", recipe: "invoice-pdf-renderer-recipe.v1", json: "'{}'::jsonb", sha: "decode('00', 'hex')" },
    ];
    for (const bad of badRows) {
      let code: string | undefined;
      try {
        await asEditor(fixture, (tx) => tx.execute(sql.raw(`
          insert into commercial_document_render_job (
            workspace_id, document_id, input_json, input_sha256,
            template_version, renderer_recipe, status, created_by
          ) values (
            '${fixture.workspaceId}'::uuid, '${checkDocId}'::uuid, ${bad.json}, ${bad.sha},
            '${bad.template}', '${bad.recipe}', '${bad.status}', '${fixture.editorId}'::uuid
          )
        `)).then(() => undefined));
      } catch (error) {
        code = pgCode(error);
      }
      expect(code).toBe("23514");
    }
  });
});
