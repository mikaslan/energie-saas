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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantTx } from "@/lib/db/types";
import { canonicalizeOfferJson } from "@/lib/integrations/offers/contract";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import { tenantFixtures } from "../setup/tenant-fixtures";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type SourceGraph = {
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

type SnapshotLine = {
  id: string;
  sectionId: string;
  sectionDomainId: string;
  lineDomainId: string;
  position: number;
  lineSnapshot: Record<string, unknown>;
};

type SnapshotSection = {
  id: string;
  sectionDomainId: string;
  position: number;
  title: string;
  sectionSnapshot: Record<string, unknown>;
  lines: SnapshotLine[];
};

type OfferGraph = {
  offerId: string;
  variantId: string;
  revisionId: string;
  sectionIds: string[];
  lineIds: string[];
};

type ProjectionMismatch =
  | "none"
  | "revision"
  | "section"
  | "line"
  | "offerSource"
  | "snapshotSource"
  | "priceAudience"
  | "createdBy"
  | "createdAt"
  | "missingMirrorLine"
  | "extraMirrorLine"
  | "reorderedMirrorLines"
  | "contentHash";

const PRE_M2_INDEX = 31;
const CONTACT_CONTEXT = { displayName: "M2-01 Testkontakt" };
const INSTALLATION_SITE_CONTEXT = { formattedAddress: "Testweg 1, 10115 Berlin" };
const VARIANT_DESCRIPTION = "Vollständiger M2-01 Snapshot";
const CREATED_AT = "2026-08-29T12:00:00.000Z";

function sourceBindings(source: SourceGraph) {
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

function priceAudienceDecision(source: SourceGraph) {
  return {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: source.actorId,
    confirmedAt: CREATED_AT,
  };
}

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m2-01-upgrade-"));
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
  role?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (role) await client.query(`set local role ${role}`);
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

async function prepareSourceGraph(pool: Pool, workspaceId = randomUUID()): Promise<SourceGraph> {
  await transaction(pool, workspaceId, async (client) => {
    await client.query(
      "insert into workspace (id, name) values ($1::uuid, 'M2-01 Functional')",
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
    const result = await client.query<SourceGraph & QueryResultRow>(`
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
    const row = result.rows[0];
    if (!row) throw new Error("M2-01 Source-Graph fehlt.");
    return row;
  });
}

function snapshotSections(lineCounts: number[]): SnapshotSection[] {
  return lineCounts.map((lineCount, sectionIndex) => {
    const sectionId = randomUUID();
    const sectionDomainId = randomUUID();
    const lines = Array.from({ length: lineCount }, (_, lineIndex): SnapshotLine => {
      const lineDomainId = randomUUID();
      const lineSnapshot = {
        lineDomainId,
        position: lineIndex + 1,
        componentCategory: "other",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        product: {
          kind: "custom",
          displayName: `Freie Position ${sectionIndex + 1}.${lineIndex + 1}`,
          description: null,
          unit: "piece",
        },
        source: { kind: "custom" },
        salesPricing: {
          originalUnitNetCents: 100,
          effectiveUnitNetCents: 100,
        },
        purchasePricing: {
          originalUnitNetCents: 50,
          effectiveUnitNetCents: 50,
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: { treatment: "standard_19", taxRateBps: 1_900 },
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
      return {
        id: randomUUID(),
        sectionId,
        sectionDomainId,
        lineDomainId,
        position: lineIndex + 1,
        lineSnapshot,
      };
    });
    const title = `Sektion ${sectionIndex + 1}`;
    return {
      id: sectionId,
      sectionDomainId,
      position: sectionIndex + 1,
      title,
      lines,
      sectionSnapshot: {
        sectionDomainId,
        position: sectionIndex + 1,
        category: "other",
        title,
        discountBps: 0,
        lines: lines.map((line) => line.lineSnapshot),
      },
    };
  });
}

async function insertRevisionGraph(
  client: PoolClient,
  source: SourceGraph,
  offerId: string,
  variantId: string,
  revision: number,
  lineCounts: number[],
  mismatch: ProjectionMismatch = "none",
  variantDescription: string | null = VARIANT_DESCRIPTION,
): Promise<Omit<OfferGraph, "offerId" | "variantId">> {
  const revisionId = randomUUID();
  const sections = snapshotSections(lineCounts);
  const lineCount = lineCounts.reduce((sum, count) => sum + count, 0);
  const totals = {
    basisNetCents: lineCount * 100,
    basisTaxCents: lineCount * 19,
    basisGrossCents: lineCount * 119,
    optionalNetCents: 0,
    optionalTaxCents: 0,
    optionalGrossCents: 0,
  };
  const canonicalSourceBindings = sourceBindings(source);
  const canonicalPriceAudienceDecision = priceAudienceDecision(source);
  const snapshotBody = {
    schemaVersion: "offer-variant-snapshot.v1",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: source.workspaceId,
    offerId,
    variantId,
    revision,
    sourceBindings: mismatch === "snapshotSource"
      ? { ...canonicalSourceBindings, requirementRevision: source.requirementRevision + 1 }
      : canonicalSourceBindings,
    priceAudienceDecision: mismatch === "priceAudience"
      ? { ...canonicalPriceAudienceDecision, confirmedAt: "2026-08-29T12:00:01.000Z" }
      : canonicalPriceAudienceDecision,
    contactContext: CONTACT_CONTEXT,
    installationSiteContext: INSTALLATION_SITE_CONTEXT,
    variantName: "Basis",
    description: variantDescription,
    createdBy: mismatch === "createdBy" ? randomUUID() : source.actorId,
    createdAt: mismatch === "createdAt" ? "2026-08-29T12:00:01.000Z" : CREATED_AT,
    totals,
    sections: sections.map((section) => section.sectionSnapshot),
  };
  const contentSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(snapshotBody), "utf8")
    .digest("hex");
  const snapshotSha256 = mismatch === "contentHash"
    ? createHash("sha256").update(revisionId).digest("hex")
    : contentSha256;
  const snapshot = { ...snapshotBody, snapshotSha256 };
  const relationalBasisNet = totals.basisNetCents + (mismatch === "revision" ? 1 : 0);

  await client.query(`
    insert into offer_variant_revision (
      id, workspace_id, offer_id, variant_id, project_id, revision,
      schema_version, canonicalization_version, revision_snapshot,
      snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
      basis_net_cents, basis_tax_cents, basis_gross_cents,
      optional_net_cents, optional_tax_cents, optional_gross_cents,
      created_by, created_at
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
      'offer-variant-snapshot.v1', 'offer-jcs.v1', $7::jsonb,
      decode($8, 'hex'), $9::uuid, $10, decode($11, 'hex'),
      $12, $13, $14, 0, 0, 0, $15::uuid, $16::timestamptz
    )
  `, [
    revisionId,
    source.workspaceId,
    offerId,
    variantId,
    source.projectId,
    revision,
    JSON.stringify(snapshot),
    snapshotSha256,
    source.resolutionId,
    source.resolutionRevision,
    source.resolutionSha256,
    relationalBasisNet,
    totals.basisTaxCents,
    relationalBasisNet + totals.basisTaxCents,
    source.actorId,
    CREATED_AT,
  ]);

  for (const [index, section] of sections.entries()) {
    await client.query(`
      insert into offer_variant_section (
        id, workspace_id, offer_id, variant_id, project_id,
        revision_id, revision, section_domain_id, position,
        category, title, discount_bps, section_snapshot
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        $6::uuid, $7, $8::uuid, $9, 'other', $10, 0, $11::jsonb
      )
    `, [
      section.id,
      source.workspaceId,
      offerId,
      variantId,
      source.projectId,
      revisionId,
      revision,
      section.sectionDomainId,
      section.position,
      mismatch === "section" && index === 0 ? `${section.title} manipuliert` : section.title,
      JSON.stringify(section.sectionSnapshot),
    ]);
  }

  const lines = sections.flatMap((section) => section.lines);
  let relationalLines = lines;
  if (mismatch === "missingMirrorLine") {
    relationalLines = lines.slice(1);
  } else if (mismatch === "extraMirrorLine") {
    const basisLine = lines.at(-1);
    if (!basisLine) throw new Error("Extra-Mirror-Fixture benötigt mindestens eine Zeile.");
    const lineDomainId = randomUUID();
    const position = basisLine.position + 1;
    relationalLines = [
      ...lines,
      {
        ...basisLine,
        id: randomUUID(),
        lineDomainId,
        position,
        lineSnapshot: {
          ...basisLine.lineSnapshot,
          lineDomainId,
          position,
        },
      },
    ];
  } else if (mismatch === "reorderedMirrorLines") {
    relationalLines = sections.flatMap((section) =>
      section.lines.map((line, index, sectionLines) => {
        const position = sectionLines.length - index;
        return {
          ...line,
          position,
          lineSnapshot: { ...line.lineSnapshot, position },
        };
      }));
  }
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
      sales_tax_cents, sales_gross_cents, purchase_net_cents,
      line_snapshot
    )
    select (item->>'id')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6, (item->>'sectionId')::uuid,
           (item->>'sectionDomainId')::uuid, (item->>'lineDomainId')::uuid,
           (item->>'position')::integer,
           case when $7::boolean and row_number() over () = 1
             then 'battery' else 'other' end,
           'required', false, 1000, 'piece', 'custom',
           100, 100, 50, 50, 0, 'standard_19', 1900,
           100, 100, 100, 100, 19, 119, 50,
           item->'lineSnapshot'
      from jsonb_array_elements($8::jsonb) as input(item)
  `, [
    source.workspaceId,
    offerId,
    variantId,
    source.projectId,
    revisionId,
    revision,
    mismatch === "line",
    JSON.stringify(relationalLines),
  ]);

  return {
    revisionId,
    sectionIds: sections.map((section) => section.id),
    lineIds: lines.map((line) => line.id),
  };
}

async function insertOfferGraph(
  client: PoolClient,
  source: SourceGraph,
  mismatch: ProjectionMismatch = "none",
  lineCounts: number[] = [1],
  variantDescription: string | null = VARIANT_DESCRIPTION,
): Promise<OfferGraph> {
  const offerId = randomUUID();
  const variantId = randomUUID();
  await client.query(`
    insert into offer (
      id, workspace_id, project_id, contact_id, site_id,
      offer_number, number_year, number_sequence,
      price_audience_decision, contact_context, installation_site_context, source_bindings,
      inbound_receipt_id, inbound_payload_sha256,
      requirement_id, requirement_revision,
      calculation_revision_id, calculation_revision,
      calculation_input_sha256, calculation_result_sha256,
      resolution_id, resolution_revision, resolution_sha256,
      create_digest, created_by, created_at, updated_at
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
      'ANG-2026-000001', 2026, 1,
      $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
      $10::uuid, decode($11, 'hex'), $12::uuid, $13,
      $14::uuid, $15, decode($16, 'hex'), decode($17, 'hex'),
      $18::uuid, $19, decode($20, 'hex'),
      decode(repeat('aa', 32), 'hex'), $21::uuid, $22::timestamptz, $22::timestamptz
    )
  `, [
    offerId,
    source.workspaceId,
    source.projectId,
    source.contactId,
    source.siteId,
    JSON.stringify(priceAudienceDecision(source)),
    JSON.stringify(CONTACT_CONTEXT),
    JSON.stringify(INSTALLATION_SITE_CONTEXT),
    JSON.stringify(mismatch === "offerSource"
      ? { ...sourceBindings(source), calculationRevision: source.calculationRevision + 1 }
      : sourceBindings(source)),
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
  await client.query(`
    insert into offer_variant (
      id, workspace_id, offer_id, ordinal, current_revision,
      name, description, created_by
    ) values ($1::uuid, $2::uuid, $3::uuid, 1, 1, 'Basis', $4, $5::uuid)
  `, [variantId, source.workspaceId, offerId, variantDescription, source.actorId]);
  const revision = await insertRevisionGraph(
    client,
    source,
    offerId,
    variantId,
    1,
    lineCounts,
    mismatch,
    variantDescription,
  );
  return { offerId, variantId, ...revision };
}

describe.sequential("M2-01 Offer-Migration funktional auf echtem PostgreSQL", () => {
  let embedded: EmbeddedTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    pool = new Pool({ connectionString: embedded.url, max: 4 });
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("installiert das Fresh-Schema vollständig und migrations-idempotent", async () => {
    const before = await pool.query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    const after = await pool.query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.count).toBe(migrationJournal().entries.length);

    const tables = await pool.query<{ relname: string }>(`
      select relname
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [[
      "offer",
      "offer_bom_line",
      "offer_mutation_rate_window",
      "offer_number_series",
      "offer_variant",
      "offer_variant_revision",
      "offer_variant_section",
    ]]);
    expect(tables.rows.map((row) => row.relname)).toHaveLength(7);
  });

  it("isoliert Reads und WITH CHECK als echte NOBYPASSRLS-App-Rolle", async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const sourceA = await prepareSourceGraph(pool, workspaceA);
    const sourceB = await prepareSourceGraph(pool, workspaceB);
    await transaction(pool, workspaceA, async (client) => {
      await insertOfferGraph(client, sourceA);
      await client.query(
        `insert into offer_number_series (workspace_id, series_year)
         values ($1::uuid, 2026)`,
        [workspaceA],
      );
      await client.query(
        `insert into offer_mutation_rate_window (
           workspace_id, scope, actor_id, window_start, attempts
         ) values ($1::uuid, 'actor', $2::uuid,
           timestamptz '2026-08-30 12:00:00+00', 1)`,
        [workspaceA, sourceA.actorId],
      );
    });
    await transaction(pool, workspaceB, async (client) => {
      await insertOfferGraph(client, sourceB);
      await client.query(
        `insert into offer_number_series (workspace_id, series_year)
         values ($1::uuid, 2026)`,
        [workspaceB],
      );
      await client.query(
        `insert into offer_mutation_rate_window (
           workspace_id, scope, actor_id, window_start, attempts
         ) values ($1::uuid, 'actor', $2::uuid,
           timestamptz '2026-08-30 12:00:00+00', 1)`,
        [workspaceB, sourceB.actorId],
      );
    });
    const admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    try {
      await admin.query(`
        create role app_runtime nologin noinherit nosuperuser nobypassrls
          nocreatedb nocreaterole noreplication;
        grant app_runtime to app_test with admin false, inherit false, set true;
        grant usage on schema public to app_runtime;
        grant select, update on public.offer, public.offer_bom_line,
          public.offer_mutation_rate_window, public.offer_number_series,
          public.offer_variant, public.offer_variant_revision,
          public.offer_variant_section to app_runtime;
        grant select, insert on public.offer_number_series to app_runtime;
      `);
    } finally {
      await admin.end();
    }

    await transaction(pool, workspaceA, async (client) => {
      const identity = await client.query<{
        current_user: string;
        bypasses_rls: boolean;
      }>(`
        select current_user,
               (select rolbypassrls from pg_roles where rolname = current_user)
                 as bypasses_rls
      `);
      expect(identity.rows).toEqual([{
        current_user: "app_runtime",
        bypasses_rls: false,
      }]);
      const visible = await client.query<{ relation_name: string; workspace_id: string }>(`
        select 'offer' as relation_name, workspace_id from offer
        union all select 'offer_bom_line', workspace_id from offer_bom_line
        union all select 'offer_mutation_rate_window', workspace_id
          from offer_mutation_rate_window
        union all select 'offer_number_series', workspace_id from offer_number_series
        union all select 'offer_variant', workspace_id from offer_variant
        union all select 'offer_variant_revision', workspace_id from offer_variant_revision
        union all select 'offer_variant_section', workspace_id from offer_variant_section
        order by relation_name
      `);
      expect(visible.rows).toEqual([
        "offer",
        "offer_bom_line",
        "offer_mutation_rate_window",
        "offer_number_series",
        "offer_variant",
        "offer_variant_revision",
        "offer_variant_section",
      ].map((relation_name) => ({ relation_name, workspace_id: workspaceA })));

      const crossTenantUpdates = [
        "update offer set updated_at = updated_at where workspace_id = $1::uuid",
        "update offer_bom_line set created_at = created_at where workspace_id = $1::uuid",
        "update offer_mutation_rate_window set updated_at = updated_at where workspace_id = $1::uuid",
        "update offer_number_series set updated_at = updated_at where workspace_id = $1::uuid",
        "update offer_variant set updated_at = updated_at where workspace_id = $1::uuid",
        "update offer_variant_revision set created_at = created_at where workspace_id = $1::uuid",
        "update offer_variant_section set created_at = created_at where workspace_id = $1::uuid",
      ];
      for (const statement of crossTenantUpdates) {
        const update = await client.query(statement, [workspaceB]);
        expect(update.rowCount).toBe(0);
      }
      await expect(client.query(
        `insert into offer_number_series (workspace_id, series_year)
         values ($1::uuid, 2027)`,
        [workspaceB],
      )).rejects.toThrow(/row-level security policy/iu);
    }, "app_runtime");

    await transaction(pool, "", async (client) => {
      const hidden = await client.query<{ count: number }>(`
        select (
          (select count(*) from offer)
          + (select count(*) from offer_bom_line)
          + (select count(*) from offer_mutation_rate_window)
          + (select count(*) from offer_number_series)
          + (select count(*) from offer_variant)
          + (select count(*) from offer_variant_revision)
          + (select count(*) from offer_variant_section)
        )::int as count
      `);
      expect(hidden.rows).toEqual([{ count: 0 }]);
    }, "app_runtime");
  });

  it("committet einen vollständigen Snapshot samt Section-/BOM-Mirror", async () => {
    const source = await prepareSourceGraph(pool);
    const graph = await transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source));
    const persisted = await transaction(pool, source.workspaceId, async (client) => {
      return client.query<{
        revisions: number;
        sections: number;
        lines: number;
        current_revision: number;
      }>(`
        select (select count(*)::int from offer_variant_revision
                 where variant_id = $1::uuid) as revisions,
               (select count(*)::int from offer_variant_section
                 where revision_id = $2::uuid) as sections,
               (select count(*)::int from offer_bom_line
                 where revision_id = $2::uuid) as lines,
               (select current_revision from offer_variant
                 where id = $1::uuid) as current_revision
      `, [graph.variantId, graph.revisionId]);
    });
    expect(persisted.rows).toEqual([{
      revisions: 1,
      sections: 1,
      lines: 1,
      current_revision: 1,
    }]);
  });

  it("berechnet offer-jcs.v1 in PostgreSQL bytegleich und verwirft einen bloss behaupteten Inhalts-Hash", async () => {
    const vectors = [
      { b: 2, aa: 1, a: 3, text: "Gru\u0308n" },
      { array: [0, true, null, "Zeile\nmit \"Zitat\""] },
      { nested: { z: 9_007_199_254_740_991, a: -0 } },
    ];
    for (const vector of vectors) {
      const canonical = await pool.query<{ value: string }>(
        "select public.canonicalize_offer_json_v1($1::jsonb) as value",
        [JSON.stringify(vector)],
      );
      expect(canonical.rows[0]?.value).toBe(canonicalizeOfferJson(vector));
    }

    const source = await prepareSourceGraph(pool);
    await expect(transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source, "contentHash")))
      .rejects.toThrow(/kanonischer Inhalts-Hash driftet/iu);
    const state = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ offers: number; revisions: number }>(`
        select (select count(*)::int from offer) as offers,
               (select count(*)::int from offer_variant_revision) as revisions
      `));
    expect(state.rows).toEqual([{ offers: 0, revisions: 0 }]);
  });

  it("akzeptiert die vertraglich optionale null-Beschreibung", async () => {
    const source = await prepareSourceGraph(pool);
    const graph = await transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source, "none", [1], null));
    const persisted = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ description: string | null }>(
        "select description from offer_variant where id = $1::uuid",
        [graph.variantId],
      ));
    expect(persisted.rows).toEqual([{ description: null }]);
  });

  it.each([
    ["revision", /Revisionsprojektion driftet/iu],
    ["section", /Sektionsprojektion driftet/iu],
    ["line", /BOM-Projektion driftet/iu],
  ] as const)("rollt eine manipulierte %s-Projektion atomar zurück", async (mismatch, message) => {
    const source = await prepareSourceGraph(pool);
    await expect(transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source, mismatch))).rejects.toThrow(message);
    const state = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ offers: number; revisions: number; sections: number; lines: number }>(`
        select (select count(*)::int from offer) as offers,
               (select count(*)::int from offer_variant_revision) as revisions,
               (select count(*)::int from offer_variant_section) as sections,
               (select count(*)::int from offer_bom_line) as lines
      `));
    expect(state.rows).toEqual([{ offers: 0, revisions: 0, sections: 0, lines: 0 }]);
  });

  it.each([
    ["missingMirrorLine", [1]],
    ["extraMirrorLine", [1]],
    ["reorderedMirrorLines", [2]],
  ] as const)("verwirft %s im BOM-Mirror samt gesamtem Offer atomar", async (mismatch, lineCounts) => {
    const source = await prepareSourceGraph(pool);
    await expect(transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source, mismatch, [...lineCounts])))
      .rejects.toThrow(/BOM-Zeilen/iu);
    const state = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ offers: number; revisions: number; sections: number; lines: number }>(`
        select (select count(*)::int from offer) as offers,
               (select count(*)::int from offer_variant_revision) as revisions,
               (select count(*)::int from offer_variant_section) as sections,
               (select count(*)::int from offer_bom_line) as lines
      `));
    expect(state.rows).toEqual([{ offers: 0, revisions: 0, sections: 0, lines: 0 }]);
  });

  it.each([
    ["offerSource", /Offer-Quellbindungen driften/iu],
    ["snapshotSource", /Revisionsprojektion driftet/iu],
    ["priceAudience", /Revisionsprojektion driftet/iu],
    ["createdBy", /Revisionsprojektion driftet/iu],
    ["createdAt", /Revisionsprojektion driftet/iu],
  ] as const)("verwirft manipulierte Snapshot-Provenienz (%s) vor Commit", async (mismatch, message) => {
    const source = await prepareSourceGraph(pool);
    await expect(transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source, mismatch))).rejects.toThrow(message);
    const state = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ offers: number; revisions: number }>(`
        select (select count(*)::int from offer) as offers,
               (select count(*)::int from offer_variant_revision) as revisions
      `));
    expect(state.rows).toEqual([{ offers: 0, revisions: 0 }]);
  });

  it("verwirft Revision 2 atomar, solange currentRevision auf 1 bleibt", async () => {
    const source = await prepareSourceGraph(pool);
    const graph = await transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source));
    await expect(transaction(pool, source.workspaceId, (client) =>
      insertRevisionGraph(client, source, graph.offerId, graph.variantId, 2, [1])
    )).rejects.toThrow(/current_revision ist nicht die hoechste/iu);
    const state = await transaction(pool, source.workspaceId, (client) =>
      client.query<{ current_revision: number; revisions: number }>(`
        select variant.current_revision,
               count(revision.id)::int as revisions
          from offer_variant as variant
          join offer_variant_revision as revision
            on revision.workspace_id = variant.workspace_id
           and revision.variant_id = variant.id
         where variant.id = $1::uuid
         group by variant.current_revision
      `, [graph.variantId]));
    expect(state.rows).toEqual([{ current_revision: 1, revisions: 1 }]);
  });

  it("blockiert UPDATE, DELETE und TRUNCATE auf allen drei Snapshot-Mirrors", async () => {
    const source = await prepareSourceGraph(pool);
    const graph = await transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source));
    const statements: Array<[string, unknown[]]> = [
      ["update offer_variant_revision set basis_net_cents = basis_net_cents where id = $1", [graph.revisionId]],
      ["delete from offer_variant_revision where id = $1", [graph.revisionId]],
      ["update offer_variant_section set title = title where id = $1", [graph.sectionIds[0]]],
      ["delete from offer_variant_section where id = $1", [graph.sectionIds[0]]],
      ["update offer_bom_line set position = position where id = $1", [graph.lineIds[0]]],
      ["delete from offer_bom_line where id = $1", [graph.lineIds[0]]],
      ["truncate table offer_variant_revision cascade", []],
      ["truncate table offer_variant_section cascade", []],
      ["truncate table offer_bom_line cascade", []],
    ];
    for (const [statement, values] of statements) {
      await expect(transaction(pool, source.workspaceId, (client) =>
        client.query(statement, values))).rejects.toThrow(/(?:append-only|immutable|Erasurevertrag)/iu);
    }
  });

  it("haelt Offer- und Variantenidentitaet DB-seitig unveraenderlich", async () => {
    const source = await prepareSourceGraph(pool);
    const graph = await transaction(pool, source.workspaceId, (client) =>
      insertOfferGraph(client, source));

    await expect(transaction(pool, source.workspaceId, (client) =>
      client.query(
        "update offer set contact_context = jsonb_build_object('displayName', 'Manipuliert') where id = $1::uuid",
        [graph.offerId],
      ))).rejects.toThrow(/immutable|unveraenderlich/iu);
    await expect(transaction(pool, source.workspaceId, (client) =>
      client.query(
        "update offer set offer_number = 'ANG-2026-999999' where id = $1::uuid",
        [graph.offerId],
      ))).rejects.toThrow(/immutable|unveraenderlich/iu);
    await expect(transaction(pool, source.workspaceId, (client) =>
      client.query(
        "update offer set updated_at = updated_at - interval '1 second' where id = $1::uuid",
        [graph.offerId],
      ))).rejects.toThrow(/monoton|immutable|unveraenderlich/iu);

    const touch = await transaction(pool, source.workspaceId, (client) =>
      client.query(
        "update offer set updated_at = updated_at + interval '1 second' where id = $1::uuid returning offer_number",
        [graph.offerId],
      ));
    expect(touch.rows).toEqual([{ offer_number: "ANG-2026-000001" }]);

    await expect(transaction(pool, source.workspaceId, (client) =>
      client.query(
        "update offer_variant set ordinal = ordinal + 1 where id = $1::uuid",
        [graph.variantId],
      ))).rejects.toThrow(/immutable|stabile Identitaet/iu);

    const revision = await transaction(pool, source.workspaceId, async (client) => {
      await insertRevisionGraph(client, source, graph.offerId, graph.variantId, 2, [1]);
      return client.query<{ current_revision: number }>(
        `update offer_variant
            set current_revision = 2,
                updated_at = updated_at + interval '1 second'
          where id = $1::uuid
          returning current_revision`,
        [graph.variantId],
      );
    });
    expect(revision.rows).toEqual([{ current_revision: 2 }]);
  });

  it("erlaubt Nummernserie und Mutationsfenster nur als monotone Zaehler", async () => {
    const source = await prepareSourceGraph(pool);
    await transaction(pool, source.workspaceId, async (client) => {
      await client.query(
        `insert into offer_number_series (
           workspace_id, series_year, last_sequence
         ) values ($1::uuid, 2026, 7)`,
        [source.workspaceId],
      );
      await client.query(
        `insert into offer_mutation_rate_window (
           workspace_id, scope, actor_id, window_start, attempts
         ) values (
           $1::uuid, 'actor', $2::uuid,
           timestamptz '2026-08-30 12:00:00+00', 3
         )`,
        [source.workspaceId, source.actorId],
      );
    });

    const rejected = [
      "update offer_number_series set last_sequence = 1 where workspace_id = $1::uuid",
      "update offer_number_series set series_year = 2027 where workspace_id = $1::uuid",
      "delete from offer_number_series where workspace_id = $1::uuid",
      "update offer_mutation_rate_window set attempts = 1 where workspace_id = $1::uuid",
      "update offer_mutation_rate_window set scope = 'workspace', actor_id = null where workspace_id = $1::uuid",
    ];
    for (const statement of rejected) {
      await expect(transaction(pool, source.workspaceId, (client) =>
        client.query(statement, [source.workspaceId]))).rejects.toThrow(
        /monoton|Erasure|unbekannte Tabelle/iu,
      );
    }
    for (const statement of [
      "truncate table offer_number_series",
      "truncate table offer_mutation_rate_window",
    ]) {
      await expect(transaction(pool, source.workspaceId, (client) =>
        client.query(statement))).rejects.toThrow(/append-only/iu);
    }

    const counters = await transaction(pool, source.workspaceId, async (client) => {
      await client.query(
        `update offer_number_series
            set last_sequence = last_sequence + 1,
                updated_at = updated_at + interval '1 second'
          where workspace_id = $1::uuid`,
        [source.workspaceId],
      );
      await client.query(
        `update offer_mutation_rate_window
            set attempts = attempts + 1,
                updated_at = updated_at + interval '1 second'
          where workspace_id = $1::uuid`,
        [source.workspaceId],
      );
      return client.query<{ sequence: number; attempts: number }>(`
        select series.last_sequence::int as sequence,
               rate_record.attempts::int as attempts
          from offer_number_series as series
          join offer_mutation_rate_window as rate_record
            on rate_record.workspace_id = series.workspace_id
         where series.workspace_id = $1::uuid
      `, [source.workspaceId]);
    });
    expect(counters.rows).toEqual([{ sequence: 8, attempts: 4 }]);
  });

  it("akzeptiert exakt 500 BOM-Zeilen und verwirft 501 atomar", async () => {
    const acceptedSource = await prepareSourceGraph(pool);
    const accepted = await transaction(pool, acceptedSource.workspaceId, (client) =>
      insertOfferGraph(client, acceptedSource, "none", [500]));
    const acceptedCount = await transaction(pool, acceptedSource.workspaceId, (client) =>
      client.query<{ count: number }>(`
        select count(*)::int as count from offer_bom_line
         where revision_id = $1::uuid
      `, [accepted.revisionId]));
    expect(acceptedCount.rows).toEqual([{ count: 500 }]);

    const rejectedSource = await prepareSourceGraph(pool);
    await expect(transaction(pool, rejectedSource.workspaceId, (client) =>
      insertOfferGraph(client, rejectedSource, "none", [500, 1])
    )).rejects.toThrow(/BOM-Zeilen sind unvollstaendig/iu);
    const rejectedCount = await transaction(pool, rejectedSource.workspaceId, (client) =>
      client.query<{ count: number }>("select count(*)::int as count from offer"));
    expect(rejectedCount.rows).toEqual([{ count: 0 }]);
  }, 240_000);
});

it("migriert einen echten 0031-Bestand additiv auf M2-01", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  let prefix: string | undefined;
  const workspaceId = randomUUID();
  try {
    prefix = migrationPrefixThrough(PRE_M2_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });
    await transaction(pool, workspaceId, async (client) => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, 'M2-01 Upgrade-Bestand')",
        [workspaceId],
      );
    });

    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const preserved = await transaction(pool, workspaceId, (client) =>
      client.query<{ name: string }>(
        "select name from workspace where id = $1::uuid",
        [workspaceId],
      ));
    expect(preserved.rows).toEqual([{ name: "M2-01 Upgrade-Bestand" }]);
    const empty = await transaction(pool, workspaceId, (client) =>
      client.query<{ offers: number; variants: number; revisions: number; lines: number }>(`
        select (select count(*)::int from offer) as offers,
               (select count(*)::int from offer_variant) as variants,
               (select count(*)::int from offer_variant_revision) as revisions,
               (select count(*)::int from offer_bom_line) as lines
      `));
    expect(empty.rows).toEqual([{ offers: 0, variants: 0, revisions: 0, lines: 0 }]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  }
}, 120_000);
