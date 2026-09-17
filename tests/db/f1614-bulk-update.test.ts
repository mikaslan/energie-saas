import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
} from "@/lib/integrations/catalog/contract";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_VARIANT_BULK_UPDATE_COMMAND_VERSION,
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  type CreateOfferCommandV1,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import {
  SIGNATURE_REQUEST_CREATE_VERSION,
  SIGNATURE_REQUEST_SIGN_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import {
  activateCatalogComponent,
  resolveProjectCatalog,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";
import {
  bulkUpdateVariantsFromCurrentResolution,
  createOfferFromRequest,
  createVariantFromCurrentResolution,
  duplicateOfferVariant,
  getOfferBulkUpdate,
  OfferConflictError,
  OfferNotFoundError,
  requestOfferPdfDraft,
  reviseOfferVariant,
} from "@/modules/offers";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  createSignatureRequest,
  revokeSignatureByCustomer,
  signSignatureByToken,
} from "@/modules/signatures";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

/**
 * F16-14 Angebots-Bulk-Update (PostgreSQL, RED-first).
 *
 * Bindung: `docs/spec/F16-14-bulk-update.md` (Abschnitt Tests). Diese Datei
 * MUSS rot sein, bis die Implementierung existiert: Der Batch-Befehl
 * `bulkUpdateVariantsFromCurrentResolution` und
 * `OFFER_VARIANT_BULK_UPDATE_COMMAND_VERSION`
 * (`offer-variant-bulk-update-command.v1`) existieren noch nicht.
 *
 * Festgeschriebene Vertragsdetails (fuer die Implementierung bindend):
 * - Batch-Container heisst `rows` (Spec: "Nachfolger-Zeile", "Steuer je
 *   Zeile"); Top-Level-CAS genau einmal pro Batch.
 * - Default-Nachfolgername `<Quellname> · Kat.-Rev. <R>` (U+00B7).
 * - Skip-Gruende: `variant_signature_pending` / `variant_signed` /
 *   `variant_revoked_by_customer` / `variant_current`.
 * - Leere ausfuehrbare Menge (alles geskippt) kehrt ohne CAS/Write zurueck —
 *   sonst waere `variant_signed` auf geschlossenem Projekt nie beobachtbar
 *   (`loadCurrentBasis` verlangt `outcome = open`).
 *
 * Physik-Hinweis (F2.8b): `signed`/`revoked_by_customer` bedingen per
 * Terminal-Trigger ein geschlossenes Projekt; jede Projekt-Beruehrung
 * (auch Touch) wirft sonst. Gemischte Batches mit signierten Quellen
 * koennen daher nie erfolgreich sein (DB-13); signiert/widerrufen werden
 * als Solo-Batches getestet, gemischt nur pending/current.
 */

type Members = { workspaceId: string; operatorId: string };
type SeedProducts = Awaited<ReturnType<typeof seedM201ReadyProject>>["products"];

type BulkFixture = {
  members: Members;
  projectId: string;
  products: SeedProducts;
  offerId: string;
  basisVariantId: string;
};

type BulkRow = {
  sourceVariantId: string;
  expectedSourceRevision: number;
  name?: string;
  taxTreatment: "standard_19" | "zero_operator_confirmed";
  zeroConfirmation?: { code: "zero_tax_draft_operator_confirmed"; confirmed: true };
};

type BulkResult = {
  offerId: string;
  created: Array<{
    sourceVariantId: string;
    variantId: string;
    revision: number;
    name: string;
  }>;
  skipped: Array<{ sourceVariantId: string; reason: string }>;
};

type MutationState = {
  variants: number;
  revisions: number;
  sections: number;
  lines: number;
  events: number;
  audits: number;
  [key: string]: unknown;
};

const NEW_BATTERY_SALES_CENTS = 410_000;
const NEW_BATTERY_PURCHASE_CENTS = 255_000;
const ZERO_CONFIRMATION = {
  code: "zero_tax_draft_operator_confirmed",
  confirmed: true,
} as const;

async function createMembers(): Promise<Members> {
  const members = { workspaceId: randomUUID(), operatorId: randomUUID() };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F16-14 Bulk-Update')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${members.operatorId}::uuid, ${`${members.operatorId}@f1614.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (
        ${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
        '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
           "discounts":true,"see_purchase_prices":true}'::jsonb
      )
    `);
  });
  return members;
}

async function createBulkFixture(
  taxTreatment: "standard_19" | "zero_operator_confirmed" = "standard_19",
): Promise<BulkFixture> {
  const members = await createMembers();
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F1614-${randomUUID().slice(0, 8)}`,
  });
  const command: CreateOfferCommandV1 = taxTreatment === "standard_19"
    ? {
        schemaVersion: OFFER_CREATE_COMMAND_VERSION,
        projectId: seed.projectId,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        expectedResolutionRevision: 1,
        forecastValueNetCents: 1_250_000,
        priceAudience: "b2c",
        priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
        taxTreatment: "standard_19",
      }
    : {
        schemaVersion: OFFER_CREATE_COMMAND_VERSION,
        projectId: seed.projectId,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        expectedResolutionRevision: 1,
        forecastValueNetCents: 1_250_000,
        priceAudience: "b2c",
        priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
        taxTreatment: "zero_operator_confirmed",
        zeroConfirmation: { ...ZERO_CONFIRMATION },
      };
  const created = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => createOfferFromRequest(tx, ctx, command),
  );
  return {
    members,
    projectId: seed.projectId,
    products: seed.products,
    offerId: created.offerId,
    basisVariantId: created.variantId,
  };
}

/** Katalogdrift (Batterie Rev. 2) + Re-Resolution: alle Rev.-1-Quellen outdated. */
async function driftBatteryToRevision2(fixture: BulkFixture): Promise<void> {
  const { members } = fixture;
  const revised = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
      schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
      componentId: fixture.products.battery,
      expectedRevision: 1,
      commercial: {
        currency: "EUR",
        basis: "net",
        purchasePriceNetCents: NEW_BATTERY_PURCHASE_CENTS,
        salesPriceNetCents: NEW_BATTERY_SALES_CENTS,
        purchaseProvenance: {
          sourceKind: "supplier_price_list",
          reference: "PRIVATE-F1614-PURCHASE-battery-2",
          observedOn: "2026-08-30",
          rightsBasis: "supplier_authorized",
          sourceDocumentSha256: null,
        },
        salesProvenance: {
          sourceKind: "workspace_pricing",
          reference: "SYNTHETIC-F1614-SALES-battery-2",
          observedOn: "2026-08-30",
          rightsBasis: "workspace_owned",
          sourceDocumentSha256: null,
        },
      },
    }),
  );
  expect(revised.revision).toBe(2);
  await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => activateCatalogComponent(tx, ctx, {
      componentId: fixture.products.battery,
      expectedRevision: 2,
      expectedStatus: "draft",
    }),
  );
  await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => resolveProjectCatalog(tx, ctx, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: fixture.projectId,
      expectedResolutionRevision: 1,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: fixture.products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: fixture.products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: fixture.products.battery, expectedComponentRevision: 2, quantity: 1 },
        { componentId: fixture.products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    }),
  );
}

async function duplicateVariant(
  fixture: BulkFixture,
  sourceVariantId: string,
  name: string,
  expectedSourceRevision = 1,
): Promise<string> {
  const duplicated = await withAuthorizedTenantOn(
    testPool, fixture.members.operatorId, fixture.members.workspaceId,
    (tx, ctx) => duplicateOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
      offerId: fixture.offerId,
      sourceVariantId,
      expectedSourceRevision,
      name,
    }),
  );
  return duplicated.variantId;
}

/** "Neue Basis" auf Kat.-Rev. 2: eine garantiert aktuelle Variante. */
async function createCurrentBasisVariant(
  fixture: BulkFixture,
  name: string,
): Promise<string> {
  const created = await withAuthorizedTenantOn(
    testPool, fixture.members.operatorId, fixture.members.workspaceId,
    (tx, ctx) => createVariantFromCurrentResolution(tx, ctx, {
      schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
      offerId: fixture.offerId,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      expectedResolutionRevision: 2,
      name,
      taxTreatment: "standard_19",
    }),
  );
  expect(created.revision).toBe(1);
  return created.variantId;
}

function bulkCommand(
  fixture: BulkFixture,
  rows: BulkRow[],
  cas: { req: number; calc: number; res: number } = { req: 1, calc: 1, res: 2 },
): Record<string, unknown> {
  return {
    schemaVersion: OFFER_VARIANT_BULK_UPDATE_COMMAND_VERSION,
    offerId: fixture.offerId,
    expectedRequirementRevision: cas.req,
    expectedCalculationRevision: cas.calc,
    expectedResolutionRevision: cas.res,
    rows,
  };
}

function standardRow(sourceVariantId: string, name: string): BulkRow {
  return {
    sourceVariantId,
    expectedSourceRevision: 1,
    name,
    taxTreatment: "standard_19",
  };
}

async function runBulk(
  fixture: BulkFixture,
  command: unknown,
): Promise<BulkResult> {
  return withAuthorizedTenantOn(
    testPool, fixture.members.operatorId, fixture.members.workspaceId,
    (tx, ctx) => bulkUpdateVariantsFromCurrentResolution(tx, ctx, command) as Promise<BulkResult>,
  );
}

type DenialActors = {
  viewerId: string;
  noPriceId: string;
  externalId: string;
};

/** Review-P2: Viewer, preisrechtloser Editor und External im Fixture-Workspace. */
async function createDenialActors(fixture: BulkFixture): Promise<DenialActors> {
  const actors = {
    viewerId: randomUUID(),
    noPriceId: randomUUID(),
    externalId: randomUUID(),
  };
  await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    for (const userId of [actors.viewerId, actors.noPriceId, actors.externalId]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@f1614.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${fixture.members.workspaceId}::uuid, ${actors.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${fixture.members.workspaceId}::uuid, ${actors.noPriceId}::uuid, 'editor',
          '{"manage_catalog":true}'::jsonb),
        (${fixture.members.workspaceId}::uuid, ${actors.externalId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"external_only":true}'::jsonb)
    `);
  });
  return actors;
}

function actorCtx(
  workspaceId: string,
  actorId: string,
  role: ServiceCtx["role"],
  capabilities: ServiceCtx["capabilities"],
): ServiceCtx {
  return { workspaceId, actor: actorId, role, capabilities, featureFlags: {} };
}

async function runBulkAs(
  workspaceId: string,
  ctx: ServiceCtx,
  command: unknown,
): Promise<BulkResult> {
  return withTenantOn(testPool, workspaceId, async (tx) =>
    bulkUpdateVariantsFromCurrentResolution(tx, ctx, command) as Promise<BulkResult>);
}

async function readVariantNames(fixture: BulkFixture): Promise<Array<{ id: string; name: string }>> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string; name: string }>(sql`
      select id, name
        from offer_variant
       where workspace_id = ${fixture.members.workspaceId}::uuid
         and offer_id = ${fixture.offerId}::uuid
       order by ordinal, id
    `);
    return [...result.rows];
  });
}

async function readVariantRowsFull(fixture: BulkFixture): Promise<Array<Record<string, unknown>>> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select id, offer_id, ordinal, current_revision, name, description,
             is_primary, created_at, updated_at
        from offer_variant
       where workspace_id = ${fixture.members.workspaceId}::uuid
         and offer_id = ${fixture.offerId}::uuid
       order by id
    `);
    return [...result.rows];
  });
}

async function readRevisionSnapshots(
  fixture: BulkFixture,
): Promise<Array<Record<string, unknown>>> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select variant_id, revision, revision_snapshot::text as snapshot_text,
             encode(snapshot_sha256, 'hex') as snapshot_sha256_hex,
             basis_net_cents, basis_tax_cents, basis_gross_cents
        from offer_variant_revision
       where workspace_id = ${fixture.members.workspaceId}::uuid
         and offer_id = ${fixture.offerId}::uuid
       order by variant_id, revision
    `);
    return [...result.rows];
  });
}

type SnapshotRow = {
  revision_snapshot: OfferVariantSnapshotV1;
  snapshot_text: string;
  snapshot_sha256_hex: string;
  [key: string]: unknown;
};

async function readSnapshot(
  fixture: BulkFixture,
  variantId: string,
  revision: number,
): Promise<SnapshotRow> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<SnapshotRow>(sql`
      select revision_snapshot, revision_snapshot::text as snapshot_text,
             encode(snapshot_sha256, 'hex') as snapshot_sha256_hex
        from offer_variant_revision
       where workspace_id = ${fixture.members.workspaceId}::uuid
         and offer_id = ${fixture.offerId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwartete Angebotsrevision fehlt.");
    return row;
  });
}

async function readMutationState(fixture: BulkFixture): Promise<MutationState> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<MutationState>(sql`
      select
        (select count(*)::int
           from offer_variant
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and offer_id = ${fixture.offerId}::uuid) as variants,
        (select count(*)::int
           from offer_variant_revision
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and offer_id = ${fixture.offerId}::uuid) as revisions,
        (select count(*)::int
           from offer_variant_section
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and offer_id = ${fixture.offerId}::uuid) as sections,
        (select count(*)::int
           from offer_bom_line
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and offer_id = ${fixture.offerId}::uuid) as lines,
        (select count(*)::int
           from domain_events
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and aggregate_id = ${fixture.offerId}::uuid
            and event_type in (
              'offer.variant_created',
              'offer.variant_duplicated',
              'offer.variant_revised'
            )) as events,
        (select count(*)::int
           from audit_log
          where workspace_id = ${fixture.members.workspaceId}::uuid
            and resource = 'offer'
            and allowed = true
            and details->>'offerId' = ${fixture.offerId}) as audits
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwarteter Mutationsstand fehlt.");
    return row;
  });
}

async function readSignatureStatus(
  fixture: BulkFixture,
  variantId: string,
): Promise<{ count: number; status: string | null }> {
  // Mit Actor lesen: Die restriktive Select-Policy blendet akteur-lose
  // signature_request-Zeilen aus.
  return withAuthorizedTenantOn(
    testPool, fixture.members.operatorId, fixture.members.workspaceId,
    async (tx) => {
      const result = await tx.execute<{ count: number; status: string | null }>(sql`
        select count(*)::int as count, max(status) as status
          from signature_request
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and offer_id = ${fixture.offerId}::uuid
           and variant_id = ${variantId}::uuid
      `);
      return result.rows[0] ?? { count: 0, status: null };
    },
  );
}

async function readProjectState(
  fixture: BulkFixture,
): Promise<{ phase: string; outcome: string; closed_at: unknown }> {
  return withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
    const result = await tx.execute<{ phase: string; outcome: string; closed_at: unknown }>(sql`
      select phase, outcome, closed_at
        from project
       where workspace_id = ${fixture.members.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwartetes Projekt fehlt.");
    return row;
  });
}

function allSnapshotLines(snapshot: OfferVariantSnapshotV1) {
  return snapshot.sections.flatMap((section) => section.lines);
}

function findBatteryLine(snapshot: OfferVariantSnapshotV1, batteryId: string) {
  return allSnapshotLines(snapshot).find((line) => (
    line.source.kind === "catalog" && line.source.catalogComponentId === batteryId
  ));
}

function collectMoneyIntegers(snapshot: OfferVariantSnapshotV1): number[] {
  const values = [
    snapshot.totals.basisNetCents,
    snapshot.totals.basisTaxCents,
    snapshot.totals.basisGrossCents,
    snapshot.totals.optionalNetCents,
    snapshot.totals.optionalTaxCents,
    snapshot.totals.optionalGrossCents,
  ];
  for (const line of allSnapshotLines(snapshot)) {
    values.push(
      line.salesPricing.originalUnitNetCents,
      line.salesPricing.effectiveUnitNetCents,
      line.purchasePricing.originalUnitNetCents,
      line.purchasePricing.effectiveUnitNetCents,
      line.lineDiscountBps,
      line.taxRateBps,
      line.computed.lineBaseNetCents,
      line.computed.lineDiscountedNetCents,
      line.computed.sectionDiscountedNetCents,
      line.computed.finalSalesNetCents,
      line.computed.salesTaxCents,
      line.computed.salesGrossCents,
      line.computed.purchaseNetCents,
    );
  }
  return values;
}

/**
 * Echte Signatur-Content-Locks auf einer Variante des Fixture-Angebots
 * (M2-04-Muster: Release-Profil + Empfaenger + PDF-Entwurf + Kandidat +
 * zweifach freigegebene Issuance + Request + Token-Signatur/Widerruf).
 * `pending` laesst das Projekt offen, `signed`/`revoked` schliessen es
 * (F2.8b-Kopplung) — exakt der Produktionszustand.
 */
async function sealVariantWithLock(
  fixture: BulkFixture,
  variantId: string,
  target: "pending" | "signed" | "revoked",
): Promise<{ requestId: string; status: string }> {
  const { members } = fixture;
  const { workspaceId, operatorId } = members;
  const secondActorId = randomUUID();

  // Akteur-los (Bootstrap-Pfad wie buildApprovedIssuance): Membership-DML
  // verlangt sonst einen committeten Admin bzw. verbietet Self-Mutation.
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update project set phase = 'offer'
       where workspace_id = ${workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `);
    await tx.execute(sql`
      update membership set role = 'admin', capabilities = '{}'::jsonb
       where workspace_id = ${workspaceId}::uuid
         and user_id = ${operatorId}::uuid
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${secondActorId}::uuid, ${`f1614-${secondActorId}@example.invalid`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${workspaceId}::uuid, ${secondActorId}::uuid, 'admin', '{}'::jsonb)
    `);
  });

  const sender = {
    legalName: "F1614 Energie GmbH",
    tradingName: "F1614",
    representedBy: "F1614 Vertretung",
    address: {
      street: "Testweg",
      houseNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    email: "office@f1614.invalid",
    phoneE164: "+493000000000",
    websiteHttpsUrl: "https://f1614.invalid",
    registerCourt: "F1614 Registergericht",
    registerNumber: "HRB F1614 1",
    vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.revise_offer_release_profile(
        ${workspaceId}::uuid, 0, 'F1614 Profil',
        ${JSON.stringify(sender)}::jsonb, ${JSON.stringify(legalDocuments)}::jsonb
      )
    `);
  });
  const profile = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{
      profile_id: string;
      profile_revision_id: string;
      profile_revision: number;
    }>(sql`
      select profile.id as profile_id,
             revision.id as profile_revision_id,
             revision.revision as profile_revision
        from offer_release_profile as profile
        join offer_release_profile_revision as revision
          on revision.workspace_id = profile.workspace_id
         and revision.profile_id = profile.id
         and revision.revision = profile.current_revision
       where profile.workspace_id = ${workspaceId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1614: Release-Profil fehlt.");
    return row;
  });
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.activate_offer_release_profile(
        ${workspaceId}::uuid, ${profile.profile_id}::uuid,
        ${profile.profile_revision_id}::uuid, ${profile.profile_revision}::integer
      )
    `);
  });

  const billingAddress = {
    street: "Rechnungsweg",
    houseNumber: "8a",
    postalCode: "10999",
    city: "Berlin",
    country: "DE",
  };
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.revise_offer_recipient(
        ${workspaceId}::uuid, ${fixture.offerId}::uuid, 0,
        'F1614 Rechnungsempfaenger', 'F1614 Kundin GmbH',
        'rechnung@f1614.invalid', ${JSON.stringify(billingAddress)}::jsonb, true
      )
    `);
  });
  const recipient = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{
      recipient_revision_id: string;
      recipient_revision: number;
    }>(sql`
      select revision.id as recipient_revision_id,
             revision.revision as recipient_revision
        from offer_recipient as recipient
        join offer_recipient_revision as revision
          on revision.workspace_id = recipient.workspace_id
         and revision.recipient_id = recipient.id
         and revision.revision = recipient.current_revision
       where recipient.workspace_id = ${workspaceId}::uuid
         and recipient.offer_id = ${fixture.offerId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1614: Empfaenger fehlt.");
    return row;
  });

  const draft = await withAuthorizedTenantOn(
    testPool, operatorId, workspaceId,
    (tx, ctx) => requestOfferPdfDraft(tx, ctx, {
      workspaceId,
      offerId: fixture.offerId,
      variantId,
      expectedVariantRevision: 1,
    }),
  );
  const draftArtifact = Buffer.from(
    `%PDF-1.7\n${"f1614-release-source".repeat(8)}\n%%EOF`,
    "utf8",
  );
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'running', attempt_count = 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             started_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${draft.jobId}::uuid
         and state = 'queued'
    `);
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'succeeded', lease_token = null, lease_expires_at = null,
             artifact_mime_type = 'application/pdf',
             artifact_bytes = ${draftArtifact},
             artifact_sha256 = sha256(${draftArtifact}),
             artifact_size_bytes = octet_length(${draftArtifact}),
             finished_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${draft.jobId}::uuid
         and state = 'running'
    `);
  });

  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.prepare_offer_release_candidate(
        ${workspaceId}::uuid, ${fixture.offerId}::uuid, ${variantId}::uuid, 1,
        ${draft.jobId}::uuid, ${profile.profile_id}::uuid,
        ${profile.profile_revision_id}::uuid, ${profile.profile_revision}::integer,
        ${recipient.recipient_revision_id}::uuid, ${recipient.recipient_revision}::integer,
        ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date
      )
    `);
  });
  const candidateId = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{ candidate_id: string }>(sql`
      select id as candidate_id
        from offer_release_candidate
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${fixture.offerId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1614: Release-Kandidat fehlt.");
    return row.candidate_id;
  });
  const candidateArtifact = Buffer.from(
    `%PDF-1.7\n${"f1614-release-candidate".repeat(8)}\n%%EOF`,
    "utf8",
  );
  const artifactVersion = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update offer_release_candidate
         set state = 'running', attempt_count = 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             started_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${candidateId}::uuid
         and state = 'queued'
    `);
    await tx.execute(sql`
      update offer_release_candidate
         set state = 'ready_for_approval', lease_token = null,
             lease_expires_at = null, artifact_mime_type = 'application/pdf',
             artifact_bytes = ${candidateArtifact},
             artifact_sha256 = sha256(${candidateArtifact}),
             artifact_size_bytes = octet_length(${candidateArtifact}),
             artifact_version = ${artifactVersion}::uuid,
             finished_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${candidateId}::uuid
         and state = 'running'
    `);
  });
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.approve_offer_release_candidate(
        ${workspaceId}::uuid, ${fixture.offerId}::uuid, ${candidateId}::uuid,
        ${artifactVersion}::uuid, true, true, true, true, null
      )
    `);
  });

  const issuanceId = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{ result: { issuanceId?: unknown } }>(sql`
      select public.prepare_offer_issuance(
        ${workspaceId}::uuid, ${fixture.offerId}::uuid, ${candidateId}::uuid
      ) as result
    `);
    const id = result.rows[0]?.result.issuanceId;
    if (typeof id !== "string") throw new Error("F1614: Issuance-Reservation fehlt.");
    return id;
  });
  const lease = randomUUID();
  const issuanceArtifact = Buffer.from(
    `%PDF-1.7\n${"f1614-final-issuance".repeat(8)}\n%%EOF`,
    "utf8",
  );
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.claim_offer_issuance_render(
        ${workspaceId}::uuid, ${issuanceId}::uuid, ${lease}::uuid, 120
      ) as result
    `);
    await tx.execute(sql`
      select public.finalize_offer_issuance_render_success(
        ${workspaceId}::uuid, ${issuanceId}::uuid, ${lease}::uuid, 1, ${issuanceArtifact}
      ) as result
    `);
  });
  for (const actorId of [operatorId, secondActorId]) {
    const approval = await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
      const result = await tx.execute<{ result: { status?: unknown } }>(sql`
        select public.approve_offer_issuance(
          ${workspaceId}::uuid, ${issuanceId}::uuid, true, true, true, true, null
        ) as result
      `);
      return result.rows[0]?.result;
    });
    if (approval?.status !== "approved") throw new Error("F1614: Issuance-Freigabe fehlt.");
  }

  const created = await withAuthorizedTenantOn(
    testPool, operatorId, workspaceId,
    (tx, ctx) => createSignatureRequest(tx, ctx, {
      schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
      workspaceId,
      offerId: fixture.offerId,
      variantId,
      ttlDays: 14,
    }),
  );
  expect(created.status).toBe("pending");

  if (target !== "pending") {
    const signed = await signSignatureByToken(testPool, {
      schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
      token: created.token,
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    expect(signed.status).toBe("signed");
  }
  if (target === "revoked") {
    const revoked = await revokeSignatureByCustomer(testPool, { token: created.token });
    expect(revoked.status).toBe("revoked_by_customer");
  }

  const sealed = await readSignatureStatus(fixture, variantId);
  if (sealed.count !== 1 || !sealed.status) {
    throw new Error("F1614: erwarteter Signatur-Request fehlt.");
  }
  return { requestId: created.requestId, status: sealed.status };
}

describe("F16-14 Angebots-Bulk-Update (PostgreSQL)", () => {
  it("F1614-DB-01: 2 outdated → 2 Nachfolger mit Revision 1 und Preisen aus der neuen Resolution (Cents)", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);

    const names = new Map((await readVariantNames(fixture)).map((row) => [row.id, row.name]));
    const before = await readMutationState(fixture);

    const result = await runBulk(fixture, bulkCommand(fixture, [
      {
        sourceVariantId: fixture.basisVariantId,
        expectedSourceRevision: 1,
        name: "F1614 Nachfolger A",
        taxTreatment: "standard_19",
      },
      {
        sourceVariantId: secondSourceId,
        expectedSourceRevision: 1,
        taxTreatment: "standard_19",
      },
    ]));

    expect(result.offerId).toBe(fixture.offerId);
    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(2);
    const bySource = new Map(result.created.map((row) => [row.sourceVariantId, row]));
    const createdA = bySource.get(fixture.basisVariantId);
    const createdB = bySource.get(secondSourceId);
    expect(createdA).toMatchObject({
      sourceVariantId: fixture.basisVariantId,
      revision: 1,
      name: "F1614 Nachfolger A",
    });
    expect(createdB).toMatchObject({
      sourceVariantId: secondSourceId,
      revision: 1,
      name: `${names.get(secondSourceId)} · Kat.-Rev. 2`,
    });
    expect(createdA!.variantId).not.toBe(createdB!.variantId);
    expect([createdA!.variantId, createdB!.variantId]).not.toContain(fixture.basisVariantId);
    expect([createdA!.variantId, createdB!.variantId]).not.toContain(secondSourceId);

    for (const created of result.created) {
      const snapshot = await readSnapshot(fixture, created.variantId, 1);
      expect(snapshot.revision_snapshot.variantName).toBe(created.name);
      expect(snapshot.revision_snapshot.revision).toBe(1);
      expect(snapshot.revision_snapshot.sourceBindings.resolutionRevision).toBe(2);
      const battery = findBatteryLine(snapshot.revision_snapshot, fixture.products.battery);
      expect(battery).toBeDefined();
      expect(battery!.source).toMatchObject({
        kind: "catalog",
        catalogComponentRevision: 2,
        catalogSalesUnitNetCents: NEW_BATTERY_SALES_CENTS,
        catalogPurchaseUnitNetCents: NEW_BATTERY_PURCHASE_CENTS,
      });
      expect(battery!.salesPricing).toMatchObject({
        originalUnitNetCents: NEW_BATTERY_SALES_CENTS,
        effectiveUnitNetCents: NEW_BATTERY_SALES_CENTS,
      });
      expect(battery!.purchasePricing).toMatchObject({
        originalUnitNetCents: NEW_BATTERY_PURCHASE_CENTS,
        effectiveUnitNetCents: NEW_BATTERY_PURCHASE_CENTS,
      });
      expect(battery!.taxTreatment).toBe("standard_19");
      expect(battery!.taxRateBps).toBe(1_900);
      for (const value of collectMoneyIntegers(snapshot.revision_snapshot)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }

    // Quellen bleiben auf der alten Resolution gebunden.
    const sourceSnapshot = await readSnapshot(fixture, fixture.basisVariantId, 1);
    expect(sourceSnapshot.revision_snapshot.sourceBindings.resolutionRevision).toBe(1);

    const after = await readMutationState(fixture);
    expect(after.variants - before.variants).toBe(2);
    expect(after.revisions - before.revisions).toBe(2);
    expect(after.events - before.events).toBe(2);
    expect(after.audits - before.audits).toBe(2);
    expect(after.sections - before.sections).toBeGreaterThan(0);
    expect(after.lines - before.lines).toBeGreaterThan(0);
  });

  it("F1614-DB-02: Batch-CAS-Miss wirft OfferConflictError ohne einen einzigen Write", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);
    const rows = () => [
      standardRow(fixture.basisVariantId, "F1614 Nachfolger A"),
      standardRow(secondSourceId, "F1614 Nachfolger B"),
    ];

    const before = await readMutationState(fixture);
    const variantsBefore = await readVariantRowsFull(fixture);

    await expect(runBulk(fixture, bulkCommand(fixture, rows(), { req: 1, calc: 1, res: 999 })))
      .rejects.toBeInstanceOf(OfferConflictError);
    await expect(runBulk(fixture, bulkCommand(fixture, rows(), { req: 2, calc: 1, res: 2 })))
      .rejects.toBeInstanceOf(OfferConflictError);
    await expect(runBulk(fixture, bulkCommand(fixture, rows(), { req: 1, calc: 2, res: 2 })))
      .rejects.toBeInstanceOf(OfferConflictError);

    expect(await readMutationState(fixture)).toEqual(before);
    expect(await readVariantRowsFull(fixture)).toEqual(variantsBefore);
  });

  it("F1614-DB-03: Quell-Revisions-Race bricht den ganzen Batch ab (all-or-nothing, null Writes)", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);

    // Nebenlaeufige Revision der ersten Quelle zwischen Lesen und Batch.
    await withAuthorizedTenantOn(
      testPool, fixture.members.operatorId, fixture.members.workspaceId,
      (tx, ctx) => reviseOfferVariant(tx, ctx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: fixture.offerId,
        variantId: fixture.basisVariantId,
        expectedRevision: 1,
        operations: [{
          operation: "set_variant_description",
          description: "F1614 Nebenlaeufigkeit",
        }],
      }),
    );

    const before = await readMutationState(fixture);
    await expect(runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Race A"),
      standardRow(secondSourceId, "F1614 Race B"),
    ]))).rejects.toBeInstanceOf(OfferConflictError);

    // Auch die gesunde zweite Quelle erhaelt keinen Nachfolger.
    expect(await readMutationState(fixture)).toEqual(before);
  });

  it("F1614-DB-04: konkurrierende Batches erzeugen keine Doppel-Nachfolger", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);
    const before = await readVariantRowsFull(fixture);
    const command = () => bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Race-Nachfolger A"),
      standardRow(secondSourceId, "F1614 Race-Nachfolger B"),
    ]);

    const outcomes = await Promise.allSettled([
      runBulk(fixture, command()),
      runBulk(fixture, command()),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<BulkResult> => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(OfferConflictError);
    expect(fulfilled[0]!.value.created).toHaveLength(2);

    const after = await readVariantRowsFull(fixture);
    expect(after.length - before.length).toBe(2);
    const successorNames = after
      .filter((row) => !before.some((previous) => previous.id === row.id))
      .map((row) => row.name);
    expect(successorNames).toHaveLength(2);
    expect(new Set(successorNames).size).toBe(2);
  });

  it("F1614-DB-05: signierte Quelle wird als variant_signed uebersprungen, Snapshots bleiben byte-identisch", async () => {
    const fixture = await createBulkFixture();
    await driftBatteryToRevision2(fixture);
    const lock = await sealVariantWithLock(fixture, fixture.basisVariantId, "signed");
    expect(lock.status).toBe("signed");
    // Produktionsreal: terminale Signatur schliesst das Projekt.
    expect((await readProjectState(fixture)).outcome).toBe("won");

    const snapshotsBefore = await readRevisionSnapshots(fixture);
    const variantsBefore = await readVariantRowsFull(fixture);
    const stateBefore = await readMutationState(fixture);

    const result = await runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]));
    expect(result).toEqual({
      offerId: fixture.offerId,
      created: [],
      skipped: [{ sourceVariantId: fixture.basisVariantId, reason: "variant_signed" }],
    });

    expect(await readRevisionSnapshots(fixture)).toEqual(snapshotsBefore);
    expect(await readVariantRowsFull(fixture)).toEqual(variantsBefore);
    expect(await readMutationState(fixture)).toEqual(stateBefore);
  });

  it("F1614-DB-06: pending Quelle wird als variant_signature_pending uebersprungen (solo + gemischt)", async () => {
    const solo = await createBulkFixture();
    await driftBatteryToRevision2(solo);
    const soloLock = await sealVariantWithLock(solo, solo.basisVariantId, "pending");
    expect(soloLock.status).toBe("pending");
    const soloBefore = await readMutationState(solo);
    const soloResult = await runBulk(solo, bulkCommand(solo, [
      standardRow(solo.basisVariantId, "F1614 Unzulaessig"),
    ]));
    expect(soloResult).toEqual({
      offerId: solo.offerId,
      created: [],
      skipped: [{ sourceVariantId: solo.basisVariantId, reason: "variant_signature_pending" }],
    });
    expect(await readMutationState(solo)).toEqual(soloBefore);

    // Gemischt: pending-Skip + outdated-Nachfolger auf offenem Projekt.
    const mixed = await createBulkFixture();
    const outdatedId = await duplicateVariant(mixed, mixed.basisVariantId, "F1614 Outdated");
    await driftBatteryToRevision2(mixed);
    await sealVariantWithLock(mixed, mixed.basisVariantId, "pending");
    expect((await readProjectState(mixed)).outcome).toBe("open");
    const mixedResult = await runBulk(mixed, bulkCommand(mixed, [
      standardRow(mixed.basisVariantId, "F1614 Unzulaessig"),
      standardRow(outdatedId, "F1614 Nachfolger"),
    ]));
    expect(mixedResult.created).toHaveLength(1);
    expect(mixedResult.created[0]).toMatchObject({
      sourceVariantId: outdatedId,
      revision: 1,
      name: "F1614 Nachfolger",
    });
    expect(mixedResult.skipped).toEqual([
      { sourceVariantId: mixed.basisVariantId, reason: "variant_signature_pending" },
    ]);
  });

  it("F1614-DB-07: widerrufene Quelle wird als variant_revoked_by_customer uebersprungen (null Writes)", async () => {
    const fixture = await createBulkFixture();
    await driftBatteryToRevision2(fixture);
    const lock = await sealVariantWithLock(fixture, fixture.basisVariantId, "revoked");
    expect(lock.status).toBe("revoked_by_customer");

    const snapshotsBefore = await readRevisionSnapshots(fixture);
    const variantsBefore = await readVariantRowsFull(fixture);
    const stateBefore = await readMutationState(fixture);

    const result = await runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]));
    expect(result).toEqual({
      offerId: fixture.offerId,
      created: [],
      skipped: [{ sourceVariantId: fixture.basisVariantId, reason: "variant_revoked_by_customer" }],
    });

    expect(await readRevisionSnapshots(fixture)).toEqual(snapshotsBefore);
    expect(await readVariantRowsFull(fixture)).toEqual(variantsBefore);
    expect(await readMutationState(fixture)).toEqual(stateBefore);
  });

  it("F1614-DB-08: aktuelle Quelle wird als variant_current uebersprungen, outdated Geschwister werden erzeugt", async () => {
    const fixture = await createBulkFixture();
    const outdatedId = await duplicateVariant(fixture, fixture.basisVariantId, "F1614 Outdated");
    await driftBatteryToRevision2(fixture);
    const currentId = await createCurrentBasisVariant(fixture, "F1614 Aktuell");

    const result = await runBulk(fixture, bulkCommand(fixture, [
      standardRow(outdatedId, "F1614 Nachfolger"),
      standardRow(currentId, "F1614 Unzulaessig"),
    ]));
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      sourceVariantId: outdatedId,
      revision: 1,
      name: "F1614 Nachfolger",
    });
    expect(result.skipped).toEqual([
      { sourceVariantId: currentId, reason: "variant_current" },
    ]);

    const currentSnapshot = await readSnapshot(fixture, currentId, 1);
    expect(currentSnapshot.revision_snapshot.sourceBindings.resolutionRevision).toBe(2);
  });

  it("F1614-DB-09: 12-Cap zaehlt nur ausfuehrbare Nachfolger", async () => {
    // (a) 11 bestehende + 2 ausfuehrbare → variant_limit, null Writes.
    const full = await createBulkFixture();
    const fullIds = [full.basisVariantId];
    for (let ordinal = 2; ordinal <= 11; ordinal += 1) {
      fullIds.push(await duplicateVariant(full, full.basisVariantId, `F1614 Variante ${ordinal}`));
    }
    await driftBatteryToRevision2(full);
    const fullBefore = await readMutationState(full);
    await expect(runBulk(full, bulkCommand(full, [
      standardRow(fullIds[0]!, "F1614 Cap A"),
      standardRow(fullIds[1]!, "F1614 Cap B"),
    ]))).rejects.toMatchObject({ name: "OfferBlockedError", code: "variant_limit" });
    expect(await readMutationState(full)).toEqual(fullBefore);

    // (b) 11 bestehende + 1 ausfuehrbarer + 1 Skip → Erfolg, genau 12 Varianten.
    const capped = await createBulkFixture();
    const outdatedIds = [capped.basisVariantId];
    for (let ordinal = 2; ordinal <= 10; ordinal += 1) {
      outdatedIds.push(
        await duplicateVariant(capped, capped.basisVariantId, `F1614 Variante ${ordinal}`),
      );
    }
    await driftBatteryToRevision2(capped);
    const currentId = await createCurrentBasisVariant(capped, "F1614 Aktuell");
    const result = await runBulk(capped, bulkCommand(capped, [
      standardRow(outdatedIds[0]!, "F1614 Cap-Nachfolger"),
      standardRow(currentId, "F1614 Unzulaessig"),
    ]));
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      sourceVariantId: outdatedIds[0],
      revision: 1,
      name: "F1614 Cap-Nachfolger",
    });
    expect(result.skipped).toEqual([
      { sourceVariantId: currentId, reason: "variant_current" },
    ]);
    expect((await readVariantRowsFull(capped)).length).toBe(12);
  });

  it("F1614-DB-10: Steuer ist ausdruecklich je Zeile, keine Vererbung", async () => {
    const fixture = await createBulkFixture("zero_operator_confirmed");
    const secondSourceId = await duplicateVariant(fixture, fixture.basisVariantId, "F1614 Quelle B");
    await driftBatteryToRevision2(fixture);

    const sourceBefore = await readSnapshot(fixture, fixture.basisVariantId, 1);
    for (const line of allSnapshotLines(sourceBefore.revision_snapshot)) {
      expect(line.taxTreatment).toBe("zero_operator_confirmed");
      expect(line.taxRateBps).toBe(0);
    }

    const stateBefore = await readMutationState(fixture);
    // (a) Fehlendes taxTreatment → Validation.
    await expect(runBulk(fixture, bulkCommand(fixture, [{
      sourceVariantId: fixture.basisVariantId,
      expectedSourceRevision: 1,
      name: "F1614 Ungueltig",
    }] as unknown as BulkRow[]))).rejects.toMatchObject({ name: "OfferValidationError" });
    // (b) 0 % ohne zeroConfirmation → Validation.
    await expect(runBulk(fixture, bulkCommand(fixture, [{
      sourceVariantId: fixture.basisVariantId,
      expectedSourceRevision: 1,
      name: "F1614 Ungueltig",
      taxTreatment: "zero_operator_confirmed",
    }]))).rejects.toMatchObject({ name: "OfferValidationError" });
    // (c) 19 % mit zeroConfirmation → Validation.
    await expect(runBulk(fixture, bulkCommand(fixture, [{
      sourceVariantId: fixture.basisVariantId,
      expectedSourceRevision: 1,
      name: "F1614 Ungueltig",
      taxTreatment: "standard_19",
      zeroConfirmation: { ...ZERO_CONFIRMATION },
    }]))).rejects.toMatchObject({ name: "OfferValidationError" });
    expect(await readMutationState(fixture)).toEqual(stateBefore);

    // (d) 19-%-Nachfolger einer 0-%-Quelle + (e) positiver 0-%-Nachfolger.
    const result = await runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Neunzehn Prozent"),
      {
        sourceVariantId: secondSourceId,
        expectedSourceRevision: 1,
        name: "F1614 Null Prozent",
        taxTreatment: "zero_operator_confirmed",
        zeroConfirmation: { ...ZERO_CONFIRMATION },
      },
    ]));
    expect(result.created).toHaveLength(2);
    const bySource = new Map(result.created.map((row) => [row.sourceVariantId, row]));

    const standardSnapshot = await readSnapshot(
      fixture, bySource.get(fixture.basisVariantId)!.variantId, 1,
    );
    for (const line of allSnapshotLines(standardSnapshot.revision_snapshot)) {
      expect(line.taxTreatment).toBe("standard_19");
      expect(line.taxRateBps).toBe(1_900);
      expect(line.taxDecision).toMatchObject({ treatment: "standard_19", rateBps: 1_900 });
    }

    const zeroSnapshot = await readSnapshot(
      fixture, bySource.get(secondSourceId)!.variantId, 1,
    );
    for (const line of allSnapshotLines(zeroSnapshot.revision_snapshot)) {
      expect(line.taxTreatment).toBe("zero_operator_confirmed");
      expect(line.taxRateBps).toBe(0);
      expect(line.taxDecision).toMatchObject({
        treatment: "zero_operator_confirmed",
        rateBps: 0,
        confirmationCode: "zero_tax_draft_operator_confirmed",
      });
    }

    // Quelle unvererbt und byte-identisch (weiter 0 %).
    expect(await readSnapshot(fixture, fixture.basisVariantId, 1)).toEqual(sourceBefore);
  });

  it("F1614-DB-11: Retry mit gleichen Namen ist idempotent fail-closed", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);
    const command = bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Nachfolger A"),
      standardRow(secondSourceId, "F1614 Nachfolger B"),
    ]);

    const first = await runBulk(fixture, command);
    expect(first.created).toHaveLength(2);
    const between = await readMutationState(fixture);
    const variantsBetween = await readVariantRowsFull(fixture);

    await expect(runBulk(fixture, command)).rejects.toBeInstanceOf(OfferConflictError);
    expect(await readMutationState(fixture)).toEqual(between);
    expect(await readVariantRowsFull(fixture)).toEqual(variantsBetween);
  });

  it("F1614-DB-12: je Nachfolger ein offer.variant_created-Event + price.edit-Audit, kein UPDATE auf bestehenden Zeilen", async () => {
    const fixture = await createBulkFixture();
    const secondSourceId = await duplicateVariant(
      fixture, fixture.basisVariantId, "F1614 Quelle B",
    );
    await driftBatteryToRevision2(fixture);

    const variantsBefore = await readVariantRowsFull(fixture);
    const revisionsBefore = await readRevisionSnapshots(fixture);
    const result = await runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Nachfolger A"),
      standardRow(secondSourceId, "F1614 Nachfolger B"),
    ]));
    expect(result.created).toHaveLength(2);
    const successorIds = new Set(result.created.map((row) => row.variantId));

    // Bestehende Varianten-/Revisionszeilen unveraendert (kein UPDATE).
    const variantsAfter = await readVariantRowsFull(fixture);
    const beforeIds = new Set(variantsBefore.map((row) => row.id));
    expect(variantsAfter.filter((row) => beforeIds.has(row.id))).toEqual(variantsBefore);
    const newVariants = variantsAfter.filter((row) => !beforeIds.has(row.id));
    expect(newVariants).toHaveLength(2);
    for (const row of newVariants) {
      expect(successorIds.has(row.id as string)).toBe(true);
      expect(row).toMatchObject({ current_revision: 1, is_primary: false });
    }
    const revisionsAfter = await readRevisionSnapshots(fixture);
    const revisionKey = (row: Record<string, unknown>) => `${row.variant_id}:${row.revision}`;
    const revisionKeysBefore = new Set(revisionsBefore.map(revisionKey));
    expect(revisionsAfter.filter((row) => revisionKeysBefore.has(revisionKey(row))))
      .toEqual(revisionsBefore);
    const newRevisions = revisionsAfter.filter((row) => !revisionKeysBefore.has(revisionKey(row)));
    expect(newRevisions).toHaveLength(2);
    for (const row of newRevisions) {
      expect(successorIds.has(row.variant_id as string)).toBe(true);
      expect(row.revision).toBe(1);
    }

    // Stuecklisten nur fuer Nachfolger geschrieben.
    const bomVariants = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const lines = await tx.execute<{ variant_id: string }>(sql`
        select distinct variant_id
          from offer_bom_line
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and offer_id = ${fixture.offerId}::uuid
      `);
      const sections = await tx.execute<{ variant_id: string }>(sql`
        select distinct variant_id
          from offer_variant_section
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and offer_id = ${fixture.offerId}::uuid
      `);
      return {
        lines: lines.rows.map((row) => row.variant_id),
        sections: sections.rows.map((row) => row.variant_id),
      };
    });
    for (const successorId of successorIds) {
      expect(bomVariants.lines).toContain(successorId);
      expect(bomVariants.sections).toContain(successorId);
    }

    // Je Nachfolger exakt ein Domain-Event + ein Audit im Einzellauf-Stil.
    const events = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const result_ = await tx.execute<{
        event_type: string;
        payload: Record<string, unknown>;
      }>(sql`
        select event_type, payload
          from domain_events
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and aggregate_id = ${fixture.offerId}::uuid
           and event_type = 'offer.variant_created'
      `);
      return [...result_.rows];
    });
    // Ein Event stammt aus der Angebotsanlage (Basisvariante).
    expect(events).toHaveLength(3);
    const successorEvents = events.filter((event) => successorIds.has(event.payload.variantId as string));
    expect(successorEvents).toHaveLength(2);
    for (const event of successorEvents) {
      expect(event.payload).toMatchObject({
        offerId: fixture.offerId,
        previousRevision: null,
        newRevision: 1,
        changeClasses: ["resolution_seed"],
        previousState: "absent",
        newState: "draft",
      });
    }
    const audits = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const result_ = await tx.execute<{
        action: string;
        allowed: boolean;
        details: Record<string, unknown>;
      }>(sql`
        select action, allowed, details
          from audit_log
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and resource = 'offer'
           and allowed = true
           and details->>'offerId' = ${fixture.offerId}
      `);
      return [...result_.rows];
    });
    const successorAudits = audits.filter((audit) => successorIds.has(audit.details.variantId as string));
    expect(successorAudits).toHaveLength(2);
    for (const audit of successorAudits) {
      expect(audit).toMatchObject({ action: "price.edit", allowed: true, details: {
        offerId: fixture.offerId,
        previousRevision: null,
        newRevision: 1,
      } });
    }
  });

  it("F1614-DB-13: gemischter Batch auf geschlossenem Projekt bleibt fail-closed (project_not_eligible)", async () => {
    const fixture = await createBulkFixture();
    const outdatedId = await duplicateVariant(fixture, fixture.basisVariantId, "F1614 Outdated");
    await driftBatteryToRevision2(fixture);
    await sealVariantWithLock(fixture, fixture.basisVariantId, "signed");
    expect((await readProjectState(fixture)).outcome).toBe("won");

    const before = await readMutationState(fixture);
    await expect(runBulk(fixture, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
      standardRow(outdatedId, "F1614 Nachfolger"),
    ]))).rejects.toMatchObject({ name: "OfferBlockedError", code: "project_not_eligible" });
    expect(await readMutationState(fixture)).toEqual(before);
  });

  it("F1614-DB-14: Viewer wird abgewiesen (Bulk denied, Readmodel null, null Writes)", async () => {
    const fixture = await createBulkFixture();
    await driftBatteryToRevision2(fixture);
    const actors = await createDenialActors(fixture);
    const viewer = actorCtx(fixture.members.workspaceId, actors.viewerId, "viewer", {});
    const before = await readMutationState(fixture);
    await expect(runBulkAs(fixture.members.workspaceId, viewer, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await readMutationState(fixture)).toEqual(before);
    const bulkView = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) =>
      getOfferBulkUpdate(tx, viewer, { offerId: fixture.offerId }));
    expect(bulkView).toBeNull();
  });

  it("F1614-DB-15: ohne price.edit und external_only wird Bulk denied (null Writes)", async () => {
    const fixture = await createBulkFixture();
    await driftBatteryToRevision2(fixture);
    const actors = await createDenialActors(fixture);
    const before = await readMutationState(fixture);
    const noPrice = actorCtx(fixture.members.workspaceId, actors.noPriceId, "editor", {
      manage_catalog: true,
    });
    await expect(runBulkAs(fixture.members.workspaceId, noPrice, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]))).rejects.toBeInstanceOf(PermissionDeniedError);
    const external = actorCtx(fixture.members.workspaceId, actors.externalId, "editor", {
      manage_catalog: true,
      edit_prices: true,
      external_only: true,
    });
    await expect(runBulkAs(fixture.members.workspaceId, external, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await readMutationState(fixture)).toEqual(before);
  });

  it("F1614-DB-16: Fremd-Workspace sieht das Angebot nicht (NotFound/null, null Writes)", async () => {
    const fixture = await createBulkFixture();
    await driftBatteryToRevision2(fixture);
    const foreign = await createMembers();
    const foreignCtx = actorCtx(foreign.workspaceId, foreign.operatorId, "editor", {
      manage_catalog: true,
      edit_prices: true,
      convert_phase: true,
      discounts: true,
      see_purchase_prices: true,
    });
    const before = await readMutationState(fixture);
    await expect(runBulkAs(foreign.workspaceId, foreignCtx, bulkCommand(fixture, [
      standardRow(fixture.basisVariantId, "F1614 Unzulaessig"),
    ]))).rejects.toBeInstanceOf(OfferNotFoundError);
    const bulkView = await withTenantOn(testPool, foreign.workspaceId, async (tx) =>
      getOfferBulkUpdate(tx, foreignCtx, { offerId: fixture.offerId }));
    expect(bulkView).toBeNull();
    expect(await readMutationState(fixture)).toEqual(before);
  });
});

