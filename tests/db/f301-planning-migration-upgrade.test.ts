import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_VARIANT_SNAPSHOT_VERSION,
  canonicalizeOfferJson,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";
import { tenantFixtures } from "../setup/tenant-fixtures";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    tag: string;
    [key: string]: unknown;
  }>;
};

type LegacySnapshotVersion =
  | "offer-variant-snapshot.v1"
  | "offer-variant-snapshot.v2"
  | "offer-variant-snapshot.v3";

type SourceGraph = QueryResultRow & {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  inboundReceiptId: string;
  inboundPayloadSha256: string;
  requirementId: string;
  requirementRevision: number;
  calculationRevisionId: string;
  calculationRevision: number;
  calculationInputSha256: string;
  calculationResultSha256: string;
  resolutionId: string;
  resolutionRevision: number;
  resolutionSha256: string;
};

type PersistedSnapshot = QueryResultRow & {
  schemaVersion: LegacySnapshotVersion;
  snapshotBytes: Buffer;
  snapshotHex: string;
  snapshotText: string;
  snapshotTextSha256: string;
  canonicalSha256: string;
  embeddedSha256: string;
  hasPlanningMode: boolean;
  snapshot: Record<string, unknown>;
};

type LegacySnapshotFixture = {
  snapshot: Record<string, unknown>;
  snapshotSha256: string;
  sectionSnapshot: Record<string, unknown>;
  lineSnapshot: Record<string, unknown>;
};

const PRE_F301_MIGRATION_INDEX = 74;
const F301_MIGRATION_INDEX = 75;
const CREATED_AT = "2026-09-06T09:15:00.000Z";
const LEGACY_VERSIONS: readonly LegacySnapshotVersion[] = [
  "offer-variant-snapshot.v1",
  "offer-variant-snapshot.v2",
  "offer-variant-snapshot.v3",
];

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f301-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });

  const journal = migrationJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspraefix 0..${maxIndex} ist nicht lueckenlos.`);
  }
  for (const entry of entries) {
    cpSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
}

async function transaction<T>(
  pool: Pool,
  workspaceId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    const value = await callback(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function prepareSourceGraph(pool: Pool): Promise<SourceGraph> {
  const workspaceId = randomUUID();
  await transaction(pool, workspaceId, async (client) => {
    await client.query(
      "insert into workspace (id, name) values ($1::uuid, 'F3.1 Legacy Upgrade')",
      [workspaceId],
    );
  });
  await transaction(pool, workspaceId, async (client) => {
    await tenantFixtures.project_catalog_resolution(
      drizzle(client) as unknown as TenantTx,
      workspaceId,
    );
  });

  return transaction(pool, workspaceId, async (client) => {
    const result = await client.query<SourceGraph>(`
      select resolution.workspace_id as "workspaceId",
             resolution.confirmed_by as "actorId",
             project.contact_id as "contactId",
             project.site_id as "siteId",
             project.id as "projectId",
             receipt.id as "inboundReceiptId",
             encode(receipt.body_sha256, 'hex') as "inboundPayloadSha256",
             resolution.requirement_id as "requirementId",
             resolution.requirement_revision as "requirementRevision",
             resolution.calculation_revision_id as "calculationRevisionId",
             resolution.calculation_revision as "calculationRevision",
             encode(resolution.calculation_input_sha256, 'hex') as "calculationInputSha256",
             encode(resolution.calculation_result_sha256, 'hex') as "calculationResultSha256",
             resolution.id as "resolutionId",
             resolution.revision as "resolutionRevision",
             encode(resolution.resolution_sha256, 'hex') as "resolutionSha256"
        from project_catalog_resolution as resolution
        join project
          on project.workspace_id = resolution.workspace_id
         and project.id = resolution.project_id
        join inbound_receipt as receipt
          on receipt.workspace_id = project.workspace_id
         and receipt.project_id = project.id
       where resolution.workspace_id = $1::uuid
       order by resolution.revision desc
       limit 1
    `, [workspaceId]);
    const source = result.rows[0];
    if (!source) throw new Error("F3.1 Upgrade-Source-Graph fehlt.");
    return source;
  });
}

function sourceBindings(source: SourceGraph): Record<string, unknown> {
  return {
    projectId: source.projectId,
    contactId: source.contactId,
    siteId: source.siteId,
    inboundReceiptId: source.inboundReceiptId,
    inboundPayloadSha256: source.inboundPayloadSha256,
    requirementId: source.requirementId,
    requirementRevision: source.requirementRevision,
    calculationRevisionId: source.calculationRevisionId,
    calculationRevision: source.calculationRevision,
    calculationInputSha256: source.calculationInputSha256,
    calculationResultSha256: source.calculationResultSha256,
    resolutionId: source.resolutionId,
    resolutionRevision: source.resolutionRevision,
    resolutionSha256: source.resolutionSha256,
  };
}

function buildLegacySnapshot(
  source: SourceGraph,
  version: LegacySnapshotVersion,
  offerId: string,
  variantId: string,
  sectionDomainId: string,
  lineDomainId: string,
  variantName: string,
): LegacySnapshotFixture {
  const taxDecision = {
    treatment: "standard_19",
    rateBps: 1_900,
    selectedBy: source.actorId,
    selectedAt: CREATED_AT,
  };
  const lineSnapshot = {
    lineDomainId,
    position: 1,
    componentCategory: "other",
    positionType: "required",
    isHidden: false,
    quantityMilli: 1_000,
    product: {
      kind: "custom",
      displayName: "Historische freie Position",
      description: null,
      unit: "piece",
    },
    source: {
      kind: "custom",
      enteredBy: source.actorId,
      enteredAt: CREATED_AT,
    },
    salesPricing: {
      originalUnitNetCents: 100,
      effectiveUnitNetCents: 100,
      provenance: {
        kind: "custom",
        enteredBy: source.actorId,
        enteredAt: CREATED_AT,
      },
    },
    purchasePricing: {
      originalUnitNetCents: 50,
      effectiveUnitNetCents: 50,
      provenance: {
        kind: "custom",
        enteredBy: source.actorId,
        enteredAt: CREATED_AT,
      },
    },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    taxDecision,
    computed: {
      lineBaseNetCents: 100,
      lineDiscountedNetCents: 100,
      sectionDiscountedNetCents: 100,
      finalSalesNetCents: 100,
      salesTaxCents: 19,
      salesGrossCents: 119,
      purchaseNetCents: 50,
    },
  };
  const sectionSnapshot = {
    sectionDomainId,
    position: 1,
    category: "other",
    title: "Historischer Bestand",
    discountBps: 0,
    lines: [lineSnapshot],
  };
  const body: Record<string, unknown> = {
    schemaVersion: version,
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: source.workspaceId,
    offerId,
    variantId,
    revision: 1,
    sourceBindings: sourceBindings(source),
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: source.actorId,
      confirmedAt: CREATED_AT,
    },
    taxDecision,
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    globalFixDiscountCents: null,
    globalDiscountCapCents: null,
    customDealNetCents: null,
    contactContext: {
      displayName: "F3.1 Legacy Upgrade",
      emailPrimary: null,
      phoneE164: null,
    },
    installationSiteContext: {
      addressRevision: 1,
      formattedAddress: "Altbestand 1, 10115 Berlin",
      street: "Altbestand",
      houseNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    variantName,
    description: `Historischer ${version}-Snapshot`,
    createdBy: source.actorId,
    createdAt: CREATED_AT,
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    sections: [sectionSnapshot],
  };
  if (version === "offer-variant-snapshot.v1") {
    delete body.globalFixDiscountCents;
    delete body.globalDiscountCapCents;
  } else if (version === "offer-variant-snapshot.v2") {
    delete body.globalDiscountCapCents;
  }
  const snapshotSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(body), "utf8")
    .digest("hex");
  const snapshot = { ...body, snapshotSha256 };
  const parsed = validateOfferVariantSnapshot(snapshot);
  if (!parsed.ok || parsed.value.planningMode !== "quick") {
    throw new Error(`Legacy-Snapshot ${version} ist nicht normalisierbar.`);
  }
  return { snapshot, snapshotSha256, sectionSnapshot, lineSnapshot };
}

async function seedLegacySnapshots(
  pool: Pool,
  source: SourceGraph,
): Promise<{ offerId: string }> {
  const offerId = randomUUID();
  const bindings = sourceBindings(source);
  const audienceDecision = {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: source.actorId,
    confirmedAt: CREATED_AT,
  };
  const contactContext = {
    displayName: "F3.1 Legacy Upgrade",
    emailPrimary: null,
    phoneE164: null,
  };
  const installationSiteContext = {
    addressRevision: 1,
    formattedAddress: "Altbestand 1, 10115 Berlin",
    street: "Altbestand",
    houseNumber: "1",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  };

  await transaction(pool, source.workspaceId, async (client) => {
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [source.actorId],
    );
    await client.query(`
      insert into offer (
        id, workspace_id, project_id, contact_id, site_id,
        offer_number, number_year, number_sequence,
        price_audience_decision, contact_context, installation_site_context,
        source_bindings, inbound_receipt_id, inbound_payload_sha256,
        requirement_id, requirement_revision,
        calculation_revision_id, calculation_revision,
        calculation_input_sha256, calculation_result_sha256,
        resolution_id, resolution_revision, resolution_sha256,
        create_digest, created_by, created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        'ANG-2026-030100', 2026, 30100,
        $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
        $10::uuid, decode($11, 'hex'), $12::uuid, $13,
        $14::uuid, $15, decode($16, 'hex'), decode($17, 'hex'),
        $18::uuid, $19, decode($20, 'hex'), decode(repeat('31', 32), 'hex'),
        $21::uuid, $22::timestamptz, $22::timestamptz
      )
    `, [
      offerId,
      source.workspaceId,
      source.projectId,
      source.contactId,
      source.siteId,
      JSON.stringify(audienceDecision),
      JSON.stringify(contactContext),
      JSON.stringify(installationSiteContext),
      JSON.stringify(bindings),
      source.inboundReceiptId,
      source.inboundPayloadSha256,
      source.requirementId,
      source.requirementRevision,
      source.calculationRevisionId,
      source.calculationRevision,
      source.calculationInputSha256,
      source.calculationResultSha256,
      source.resolutionId,
      source.resolutionRevision,
      source.resolutionSha256,
      source.actorId,
      CREATED_AT,
    ]);

    for (const [index, version] of LEGACY_VERSIONS.entries()) {
      const variantId = randomUUID();
      const revisionId = randomUUID();
      const sectionId = randomUUID();
      const sectionDomainId = randomUUID();
      const lineId = randomUUID();
      const lineDomainId = randomUUID();
      const variantName = `Legacy ${version.slice(-2)}`;
      const fixture = buildLegacySnapshot(
        source,
        version,
        offerId,
        variantId,
        sectionDomainId,
        lineDomainId,
        variantName,
      );

      await client.query(`
        insert into offer_variant (
          id, workspace_id, offer_id, ordinal, current_revision,
          name, description, created_by
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4, 1, $5, $6, $7::uuid
        )
      `, [
        variantId,
        source.workspaceId,
        offerId,
        index + 1,
        variantName,
        `Historischer ${version}-Snapshot`,
        source.actorId,
      ]);
      await client.query(`
        insert into offer_variant_revision (
          id, workspace_id, offer_id, variant_id, project_id, revision,
          schema_version, canonicalization_version, revision_snapshot,
          snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
          basis_net_cents, basis_tax_cents, basis_gross_cents,
          optional_net_cents, optional_tax_cents, optional_gross_cents,
          created_by, created_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
          $6, 'offer-jcs.v1', $7::jsonb, decode($8, 'hex'),
          $9::uuid, $10, decode($11, 'hex'), 100, 19, 119, 0, 0, 0,
          $12::uuid, $13::timestamptz
        )
      `, [
        revisionId,
        source.workspaceId,
        offerId,
        variantId,
        source.projectId,
        version,
        JSON.stringify(fixture.snapshot),
        fixture.snapshotSha256,
        source.resolutionId,
        source.resolutionRevision,
        source.resolutionSha256,
        source.actorId,
        CREATED_AT,
      ]);
      await client.query(`
        insert into offer_variant_section (
          id, workspace_id, offer_id, variant_id, project_id,
          revision_id, revision, section_domain_id, position,
          category, title, discount_bps, section_snapshot
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::uuid, 1, $7::uuid, 1, 'other', 'Historischer Bestand', 0,
          $8::jsonb
        )
      `, [
        sectionId,
        source.workspaceId,
        offerId,
        variantId,
        source.projectId,
        revisionId,
        sectionDomainId,
        JSON.stringify(fixture.sectionSnapshot),
      ]);
      await client.query(`
        insert into offer_bom_line (
          id, workspace_id, offer_id, variant_id, project_id,
          revision_id, revision, section_id, section_domain_id, line_domain_id,
          position, component_category, position_type, is_hidden,
          quantity_milli, unit, source_kind,
          original_sales_unit_net_cents, effective_sales_unit_net_cents,
          original_purchase_unit_net_cents, effective_purchase_unit_net_cents,
          line_discount_bps, tax_treatment, tax_rate_bps,
          line_base_net_cents, line_discounted_net_cents,
          section_discounted_net_cents, final_sales_net_cents,
          sales_tax_cents, sales_gross_cents, purchase_net_cents, line_snapshot
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::uuid, 1, $7::uuid, $8::uuid, $9::uuid,
          1, 'other', 'required', false, 1000, 'piece', 'custom',
          100, 100, 50, 50, 0, 'standard_19', 1900,
          100, 100, 100, 100, 19, 119, 50, $10::jsonb
        )
      `, [
        lineId,
        source.workspaceId,
        offerId,
        variantId,
        source.projectId,
        revisionId,
        sectionId,
        sectionDomainId,
        lineDomainId,
        JSON.stringify(fixture.lineSnapshot),
      ]);
    }
  });
  return { offerId };
}

async function persistedSnapshots(
  pool: Pool,
  workspaceId: string,
  offerId: string,
): Promise<PersistedSnapshot[]> {
  return transaction(pool, workspaceId, async (client) => {
    const result = await client.query<PersistedSnapshot>(`
      select schema_version as "schemaVersion",
             snapshot_sha256 as "snapshotBytes",
             encode(snapshot_sha256, 'hex') as "snapshotHex",
             revision_snapshot::text as "snapshotText",
             encode(pg_catalog.sha256(pg_catalog.convert_to(
               revision_snapshot::text, 'UTF8'
             )), 'hex') as "snapshotTextSha256",
             encode(pg_catalog.sha256(pg_catalog.convert_to(
               public.canonicalize_offer_json_v1(
                 revision_snapshot - 'snapshotSha256'
               ), 'UTF8'
             )), 'hex') as "canonicalSha256",
             revision_snapshot->>'snapshotSha256' as "embeddedSha256",
             revision_snapshot ? 'planningMode' as "hasPlanningMode",
             revision_snapshot as snapshot
        from offer_variant_revision
       where workspace_id = $1::uuid
         and offer_id = $2::uuid
       order by schema_version
    `, [workspaceId, offerId]);
    return result.rows;
  });
}

async function expectV4WithoutPlanningModeRejected(
  pool: Pool,
  source: SourceGraph,
  offerId: string,
): Promise<void> {
  const variantId = randomUUID();
  const variantName = "Malformed v4";
  const fixture = buildLegacySnapshot(
    source,
    "offer-variant-snapshot.v3",
    offerId,
    variantId,
    randomUUID(),
    randomUUID(),
    variantName,
  );
  const malformedBody = { ...fixture.snapshot };
  delete malformedBody.snapshotSha256;
  malformedBody.schemaVersion = OFFER_VARIANT_SNAPSHOT_VERSION;
  const snapshotSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(malformedBody), "utf8")
    .digest("hex");
  const malformedSnapshot = { ...malformedBody, snapshotSha256 };

  const error = await transaction(pool, source.workspaceId, async (client) => {
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [source.actorId],
    );
    await client.query(`
      insert into offer_variant (
        id, workspace_id, offer_id, ordinal, current_revision,
        name, description, created_by
      ) values ($1::uuid, $2::uuid, $3::uuid, 4, 1, $4, $5, $6::uuid)
    `, [
      variantId,
      source.workspaceId,
      offerId,
      variantName,
      `Historischer offer-variant-snapshot.v3-Snapshot`,
      source.actorId,
    ]);
    await client.query(`
      insert into offer_variant_revision (
        id, workspace_id, offer_id, variant_id, project_id, revision,
        schema_version, canonicalization_version, revision_snapshot,
        snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
        basis_net_cents, basis_tax_cents, basis_gross_cents,
        optional_net_cents, optional_tax_cents, optional_gross_cents,
        created_by, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
        'offer-variant-snapshot.v4', 'offer-jcs.v1', $6::jsonb,
        decode($7, 'hex'), $8::uuid, $9, decode($10, 'hex'),
        100, 19, 119, 0, 0, 0, $11::uuid, $12::timestamptz
      )
    `, [
      randomUUID(),
      source.workspaceId,
      offerId,
      variantId,
      source.projectId,
      JSON.stringify(malformedSnapshot),
      snapshotSha256,
      source.resolutionId,
      source.resolutionRevision,
      source.resolutionSha256,
      source.actorId,
      CREATED_AT,
    ]);
  }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({
    code: "23514",
    constraint: "offer_variant_revision_json_ck",
  });
}

describe.sequential("F3.1 Planungsmodi Migration-Upgrade", () => {
  it("erhaelt v1/v2/v3 bytegenau und verlangt planningMode erst ab v4", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;

    try {
      const journal = migrationJournal();
      expect(journal.entries[F301_MIGRATION_INDEX]).toMatchObject({
        idx: F301_MIGRATION_INDEX,
        tag: "0075_f3_01_planning_modes",
      });
      prefix = migrationPrefixThrough(PRE_F301_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });

      const source = await prepareSourceGraph(pool);
      const { offerId } = await seedLegacySnapshots(pool, source);
      const before = await persistedSnapshots(pool, source.workspaceId, offerId);
      expect(before).toHaveLength(LEGACY_VERSIONS.length);
      expect(before.map((row) => row.schemaVersion)).toEqual(LEGACY_VERSIONS);
      for (const row of before) {
        expect(row.hasPlanningMode).toBe(false);
        expect(Object.hasOwn(row.snapshot, "planningMode")).toBe(false);
        expect(row.snapshotHex).toBe(row.embeddedSha256);
        expect(row.canonicalSha256).toBe(row.snapshotHex);
        const normalized = validateOfferVariantSnapshot(row.snapshot);
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) throw new Error("Legacy-Parser lehnte Bestand ab.");
        expect(normalized.value).toMatchObject({
          schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
          planningMode: "quick",
        });
      }

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      const after = await persistedSnapshots(pool, source.workspaceId, offerId);

      expect(after).toEqual(before);
      for (const row of after) {
        expect(row.hasPlanningMode).toBe(false);
        expect(Object.hasOwn(row.snapshot, "planningMode")).toBe(false);
        const normalized = validateOfferVariantSnapshot(row.snapshot);
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) throw new Error("Legacy-Parser lehnte Upgrade ab.");
        expect(normalized.value.planningMode).toBe("quick");
      }

      const constraint = await pool.query<{ definition: string }>(`
        select pg_catalog.pg_get_constraintdef(oid) as definition
          from pg_catalog.pg_constraint
         where conrelid = 'public.offer_variant_revision'::regclass
           and conname = 'offer_variant_revision_json_ck'
      `);
      expect(constraint.rows).toHaveLength(1);
      expect(constraint.rows[0]?.definition).toContain(
        "schema_version = 'offer-variant-snapshot.v4'::text",
      );
      expect(constraint.rows[0]?.definition).toContain(
        "revision_snapshot ? 'planningMode'::text",
      );
      expect(constraint.rows[0]?.definition).toContain(
        "NOT (revision_snapshot ? 'planningMode'::text)",
      );
      await expectV4WithoutPlanningModeRejected(pool, source, offerId);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F3.1-Migrations-Upgrade-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);
});
