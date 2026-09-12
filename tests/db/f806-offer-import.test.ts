import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
  type CommercialDocumentOfferImportCommandV1,
  type InvoicingSettingsCommandV1,
} from "@/lib/integrations/invoicing/contract";
import {
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  offerVariantSnapshotV1Schema,
  type ReviseOfferVariantOperationV1,
} from "@/lib/integrations/offers/contract";
import {
  SIGNATURE_REQUEST_CREATE_VERSION,
  SIGNATURE_REQUEST_SIGN_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import {
  getDocumentDetail,
  importOfferVariantAsInvoice,
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingValidationError,
  upsertInvoicingSettings,
} from "@/modules/invoicing";
import { reviseOfferVariant } from "@/modules/offers";
import {
  createSignatureRequest,
  revokeSignatureByCustomer,
  signSignatureByToken,
} from "@/modules/signatures";
import { testPool } from "../setup/test-db";
import {
  approveIssuanceChain,
  assertUuid,
  berlinPlus14,
  readCurrentGraph,
  readSnapshotField,
  seedOfferFixtures,
  seedPdfDraftFixture,
  tenantQuery,
  TENANT_LINE_NAME,
  type OfferGraph,
  type SeedScope,
} from "../setup/f806-offer-import-seed";

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  viewerId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-06 Angebot-Import')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f806.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f806.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f806.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, adminId, viewerId };
}

function scopeOf(fixture: Fixture): SeedScope {
  return { workspaceId: fixture.workspaceId, adminId: fixture.adminId };
}

// Service-seitige Helper (vitest mockt server-only; das E2E nutzt die
// prozeduralen Zwillinge aus dem Seeder).
function settingsCommand(): InvoicingSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      companyName: "F8-06 GmbH",
      companyEmail: "office@f806.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Strasse 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: "F8-06 GmbH",
      paymentIban: "DE89370400440532013000",
      paymentBic: "MARKDEF1100",
      goebdRetentionDefaultDays: 3650,
    },
  };
}

async function ensureInvoicingSettings(fixture: Fixture): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => upsertInvoicingSettings(tx, ctx, settingsCommand()),
  );
}

async function reviseAsAdmin(
  fixture: Fixture,
  graph: OfferGraph,
  operations: ReviseOfferVariantOperationV1[],
  expectedRevision: number,
): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => reviseOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
      offerId: graph.offerId,
      variantId: graph.variantId,
      expectedRevision,
      operations,
    }),
  );
}

function addCustomLine(
  sectionDomainId: string,
  lineDomainId: string,
  position: number,
  displayName: string,
  quantityMilli: number,
  salesUnitNetCents: number,
  positionType: "required" | "additional" | "optional",
): ReviseOfferVariantOperationV1 {
  return {
    operation: "add_custom_line",
    lineDomainId,
    sectionDomainId,
    position,
    displayName,
    description: null,
    unit: "piece",
    quantityMilli,
    salesUnitNetCents,
    purchaseUnitNetCents: Math.round(salesUnitNetCents / 2),
    positionType,
    isHidden: false,
    taxTreatment: "standard_19",
  };
}

async function reviseBaseLines(
  fixture: Fixture,
  graph: OfferGraph,
  extraOps: (lines: { section: string; tenant: string; montage: string }) => ReviseOfferVariantOperationV1[] = () => [],
): Promise<{ graph: OfferGraph; montageId: string }> {
  const sectionDomainId = await readSnapshotField(testPool, fixture.workspaceId, graph.revisionId, "sections,0,sectionDomainId");
  const tenantLineId = await readSnapshotField(testPool, fixture.workspaceId, graph.revisionId, "sections,0,lines,0,lineDomainId");
  const montageId = randomUUID();
  const optionalId = randomUUID();
  const lines = {
    section: assertUuid(sectionDomainId),
    tenant: assertUuid(tenantLineId),
    montage: montageId,
  };
  await reviseAsAdmin(fixture, graph, [
    addCustomLine(lines.section, montageId, 2, "F806 Montage", 2000, 5000, "additional"),
    addCustomLine(lines.section, optionalId, 3, "F806 Wahlleistung", 1000, 99900, "optional"),
    { operation: "set_line_discount", lineDomainId: montageId, discountBps: 1000 },
    ...extraOps(lines),
  ], 1);
  return { graph: await readCurrentGraph(testPool, fixture.workspaceId), montageId };
}

async function seedSignedGraph(
  fixture: Fixture,
  extraOps: (lines: { section: string; tenant: string; montage: string }) => ReviseOfferVariantOperationV1[] = () => [],
): Promise<{ graph: OfferGraph; montageId: string }> {
  await ensureInvoicingSettings(fixture);
  const graph = await seedOfferFixtures(testPool, scopeOf(fixture));
  const revised = await reviseBaseLines(fixture, graph, extraOps);
  await seedPdfDraftFixture(testPool, scopeOf(fixture));
  await approveIssuanceChain(testPool, scopeOf(fixture), revised.graph);
  await signGraphOffer(fixture, revised.graph);
  return revised;
}

async function signGraphOffer(fixture: Fixture, graph: OfferGraph): Promise<string> {
  const created = await withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => createSignatureRequest(tx, ctx, {
      schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
      workspaceId: fixture.workspaceId,
      offerId: graph.offerId,
      variantId: graph.variantId,
      ttlDays: 14,
    }),
  );
  const signed = await signSignatureByToken(testPool, {
    schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
    token: created.token,
    mode: "click",
    artifactMimeType: null,
    artifactBytes: null,
  });
  expect(signed.status).toBe("signed");
  return created.token;
}

describe("F8-06 Angebot als Rechnung übernehmen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const importCommand = (graph: OfferGraph): CommercialDocumentOfferImportCommandV1 => ({
    schemaVersion: "commercial-document-offer-import-command.v1",
    offerId: graph.offerId,
    variantId: graph.variantId,
  });

  it("F806-DB-01: signierte Variante wird Entwurf mit Basis-Positionen, +14, Event/Audit", async () => {
    const { graph } = await seedSignedGraph(fixture);

    const result = await asEditor(fixture, (tx, ctx) => importOfferVariantAsInvoice(tx, ctx, importCommand(graph)));
    expect(result.type).toBe("invoice");
    expect(result.status).toBe("draft");
    expect(result.linesCopied).toBe(2);
    expect(result.basisNetCents).toBe(9100);

    const invoice = await asEditor(fixture, (tx, ctx) => getDocumentDetail(tx, ctx, {
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
      type: "invoice",
      documentId: result.id,
    }));
    expect(invoice.document.name).toBe(`Rechnung zu Angebot ${graph.offerNumber} – Basis`);
    expect(invoice.document.groupId).toBeNull();
    expect(invoice.document.projectId).toBe(graph.projectId);
    expect(invoice.document.contactId).toBe(graph.contactId);
    expect(invoice.document.dueDate).toBe(berlinPlus14());
    expect(invoice.document.skontoPercentBps).toBeNull();
    expect(invoice.lines.map((line) => ({
      position: line.position, name: line.name, quantityMilli: line.quantityMilli,
      unit: line.unit, netCents: line.netCents, taxRateBps: line.taxRateBps,
    }))).toEqual([
      { position: 1, name: TENANT_LINE_NAME, quantityMilli: 1000, unit: "piece", netCents: 100, taxRateBps: 1900 },
      { position: 2, name: "F806 Montage", quantityMilli: 2000, unit: "piece", netCents: 9000, taxRateBps: 1900 },
    ]);
    expect(invoice.document.netCents).toBe(9100);
    expect(invoice.document.grossCents).toBe(10829);

    const events = await tenantQuery<{ count: string }>(testPool, fixture.workspaceId, null,
      `select count(*) as count from domain_events
        where workspace_id = $1::uuid and aggregate_id = $2::uuid
          and event_type = 'commercial_document.offer_imported'`,
      [fixture.workspaceId, result.id]);
    expect(Number(events.rows[0]?.count)).toBe(1);
    const audits = await tenantQuery<{ count: string }>(testPool, fixture.workspaceId, null,
      `select count(*) as count from audit_log
        where workspace_id = $1::uuid and action = 'invoicing.document.offer_import'`,
      [fixture.workspaceId]);
    expect(Number(audits.rows[0]?.count)).toBe(1);
  });

  it("F806-DB-02: unsigniert → Validation, widerrufen → Conflict", async () => {
    await ensureInvoicingSettings(fixture);
    const graph = await seedOfferFixtures(testPool, scopeOf(fixture));
    const revised = await reviseBaseLines(fixture, graph);
    const current = revised.graph;

    // Unsigniert (kein Request) → Validation.
    await expect(asEditor(fixture, (tx, ctx) =>
      importOfferVariantAsInvoice(tx, ctx, importCommand(current)),
    )).rejects.toBeInstanceOf(InvoicingValidationError);

    await seedPdfDraftFixture(testPool, scopeOf(fixture));
    await approveIssuanceChain(testPool, scopeOf(fixture), current);
    const token = await signGraphOffer(fixture, current);

    // Vom Kunden widerrufen → Conflict.
    await revokeSignatureByCustomer(testPool, { token });
    await expect(asEditor(fixture, (tx, ctx) =>
      importOfferVariantAsInvoice(tx, ctx, importCommand(current)),
    )).rejects.toBeInstanceOf(InvoicingConflictError);
  });

  it("F806-DB-03: Override, nur-optional, fremd, Viewer", async () => {
    const invoke = (
      fx: Fixture,
      graph: OfferGraph,
      actor: "editor" | "viewer" = "editor",
      offerId: string = graph.offerId,
    ) => {
      const actorId = actor === "editor" ? fx.editorId : fx.viewerId;
      return withAuthorizedTenantOn(testPool, actorId, fx.workspaceId, (tx, ctx) =>
        importOfferVariantAsInvoice(tx, ctx, {
          schemaVersion: "commercial-document-offer-import-command.v1",
          offerId,
          variantId: graph.variantId,
        }));
    };

    // Deal-Override → Validation.
    {
      const fx = await seedFixture();
      const { graph } = await seedSignedGraph(fx);
      await tenantQuery(testPool, fx.workspaceId, null,
        `update offer set total_price_override_net_cents = 1
          where workspace_id = $1::uuid and id = $2::uuid`,
        [fx.workspaceId, graph.offerId]);
      await expect(invoke(fx, graph)).rejects.toBeInstanceOf(InvoicingValidationError);
    }

    // Nur-optionale Zeilen → Validation (eigener Graph ohne Basis).
    {
      const fx = await seedFixture();
      await ensureInvoicingSettings(fx);
      const base = await seedOfferFixtures(testPool, scopeOf(fx));
      const tenantLineId = await readSnapshotField(testPool, fx.workspaceId, base.revisionId, "sections,0,lines,0,lineDomainId");
      await reviseAsAdmin(fx, base, [
        { operation: "set_line_position_type", lineDomainId: assertUuid(tenantLineId), positionType: "optional" },
      ], 1);
      const current = await readCurrentGraph(testPool, fx.workspaceId);
      await seedPdfDraftFixture(testPool, scopeOf(fx));
      await approveIssuanceChain(testPool, scopeOf(fx), current);
      await signGraphOffer(fx, current);
      await expect(invoke(fx, current)).rejects.toBeInstanceOf(InvoicingValidationError);
    }

    // Fremdes Angebot → NotFound; Viewer → denied.
    {
      const fx = await seedFixture();
      const { graph } = await seedSignedGraph(fx);
      await expect(invoke(fx, graph, "editor", randomUUID())).rejects.toBeInstanceOf(InvoicingNotFoundError);
      await expect(invoke(fx, graph, "viewer")).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it("F806-DB-04: Siegel-Paritaet — versiegelte Snapshots parsen, manipulierte nicht", async () => {
    const { graph } = await seedSignedGraph(fixture);
    const stored = await tenantQuery<{ revision_snapshot: unknown }>(testPool, fixture.workspaceId, null,
      `select revision_snapshot from offer_variant_revision
        where workspace_id = $1::uuid and id = $2::uuid`,
      [fixture.workspaceId, graph.revisionId]);
    expect(offerVariantSnapshotV1Schema.safeParse(stored.rows[0]?.revision_snapshot).success).toBe(true);
    expect(offerVariantSnapshotV1Schema.safeParse({
      ...(stored.rows[0]?.revision_snapshot as Record<string, unknown>),
      sections: [],
    }).success).toBe(false);
  });
});
