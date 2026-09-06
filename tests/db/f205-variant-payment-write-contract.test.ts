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
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  applyRoleContract,
  verifyRoleContract,
} from "../../scripts/db-role-contract.mjs";
import { testPool } from "../setup/test-db";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    tag: string;
    when: number;
    [key: string]: unknown;
  }>;
};

const PRE_PAYMENT_OPTIONS_INDEX = 67;
const PAYMENT_OPTIONS_INDEX = 68;
const PRE_WRITE_CONTRACT_INDEX = 73;
const WRITE_CONTRACT_INDEX = 74;
const WRITE_CONTRACT_TAG = "0074_f2_05_variant_payment_write_contract";
const LEGACY_GUARD_TAG = "0055_f2_02_varianten_vertiefung";
const LEGACY_GUARD_BODY_SHA256 =
  "bf712d55bd2fe892dbaddf0c7787eda33fa64a957dc4589864295c037065d5d4";
const WRITE_CONTRACT_BODY_SHA256 =
  "16f5ccf5efd817603406a4fe33a3df634f2e678df34a8cf5e566ebf90c8c96d4";
const WRITE_CONTRACT_COMMENT = "F2.5 Varianten-Zahlart-Schreibvertrag v1";
const FUNCTION_BODY_MARKER = "$m2_01_offer_erasure_guard$";

function journal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f205-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const fullJournal = journal();
  const entries = fullJournal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspraefix 0..${maxIndex} ist nicht lueckenlos.`);
  }
  for (const entry of entries) {
    cpSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, "meta", "_journal.json"),
    `${JSON.stringify({ ...fullJournal, entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
}

function functionBodyFromMigration(): string {
  const migration = readFileSync(resolve("drizzle", `${WRITE_CONTRACT_TAG}.sql`), "utf8");
  const start = migration.indexOf(FUNCTION_BODY_MARKER);
  const bodyStart = start + FUNCTION_BODY_MARKER.length;
  const end = migration.indexOf(FUNCTION_BODY_MARKER, bodyStart);
  if (start < 0 || end < 0) throw new Error("F2.5-Guard-Body fehlt in 0074.");
  return migration.slice(bodyStart, end);
}

function guardFunctionDdlFromMigration(tag: string): string {
  const migration = readFileSync(resolve("drizzle", `${tag}.sql`), "utf8");
  const start = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.guard_offer_erasure_mutation()",
  );
  const bodyStart = migration.indexOf(FUNCTION_BODY_MARKER, start);
  const bodyEnd = migration.indexOf(
    FUNCTION_BODY_MARKER,
    bodyStart + FUNCTION_BODY_MARKER.length,
  );
  if (start < 0 || bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`Offer-Guard-Definition fehlt in ${tag}.`);
  }
  return migration.slice(start, bodyEnd + FUNCTION_BODY_MARKER.length + 1);
}

async function guardBodySha256(client: PoolClient): Promise<string> {
  const result = await client.query<{ sha256: string }>(`
    select pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')),
             'hex'
           ) as sha256
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'guard_offer_erasure_mutation'
       and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
  `);
  const hash = result.rows[0]?.sha256;
  if (!hash) throw new Error("Offer-Guard fehlt.");
  return hash;
}

async function paymentContractState(client: PoolClient): Promise<{
  hasPaymentOptionTable: boolean;
  hasVariantPaymentOptionColumn: boolean;
  marker: string | null;
}> {
  const result = await client.query<{
    hasPaymentOptionTable: boolean;
    hasVariantPaymentOptionColumn: boolean;
    marker: string | null;
  }>(`
    select pg_catalog.to_regclass('public.payment_option') is not null
             as "hasPaymentOptionTable",
           pg_catalog.to_regclass('public.offer_variant') is not null
             and exists (
               select 1
                 from pg_catalog.pg_attribute as attribute
                where attribute.attrelid = 'public.offer_variant'::regclass
                  and attribute.attname = 'payment_option_id'
                  and attribute.attnum > 0
                  and not attribute.attisdropped
             ) as "hasVariantPaymentOptionColumn",
           case
             when pg_catalog.to_regclass('public.offer_variant') is null then null
             else (
               select pg_catalog.col_description(attribute.attrelid, attribute.attnum)
                 from pg_catalog.pg_attribute as attribute
                where attribute.attrelid = 'public.offer_variant'::regclass
                  and attribute.attname = 'payment_option_id'
                  and attribute.attnum > 0
                  and not attribute.attisdropped
             )
           end as marker
  `);
  const state = result.rows[0];
  if (!state) throw new Error("F2.5-Migrationszustand fehlt.");
  return state;
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function expectUpdateRejected(
  client: PoolClient,
  query: string,
  values: unknown[],
): Promise<void> {
  await client.query("begin");
  try {
    const error = await client.query(query, values).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).not.toBeNull();
    expect(postgresCode(error)).toBe("P0001");
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

async function createGuardProbe(client: PoolClient): Promise<void> {
  await client.query(`
    create temporary table offer_variant (
      current_revision integer not null,
      name text not null,
      description text,
      updated_at timestamptz not null,
      is_primary boolean not null,
      optional_bundles jsonb not null,
      payment_option_id uuid,
      stable_identity uuid not null
    )
  `);
  await client.query(`
    create trigger offer_variant_mutation_guard
      before update or delete on offer_variant
      for each row execute function public.guard_offer_erasure_mutation()
  `);
  await client.query(
    `insert into offer_variant (
       current_revision, name, description, updated_at, is_primary,
       optional_bundles, payment_option_id, stable_identity
     ) values (1, 'Variante', null, $1::timestamptz, true, '[]'::jsonb, null, $2)`,
    ["2026-09-06T10:00:00.000Z", randomUUID()],
  );
}

describe.sequential("F2.5 Varianten-Zahlart Write-Vertrag", () => {
  it("pinnt 0074 und den exakten Guard-Body im frisch migrierten Bestand", async () => {
    const entries = journal().entries;
    expect(entries[WRITE_CONTRACT_INDEX]).toMatchObject({
      idx: WRITE_CONTRACT_INDEX,
      tag: WRITE_CONTRACT_TAG,
    });
    expect(entries[WRITE_CONTRACT_INDEX]!.when)
      .toBeGreaterThan(entries[PRE_WRITE_CONTRACT_INDEX]!.when);
    expect(createHash("sha256").update(functionBodyFromMigration()).digest("hex"))
      .toBe(WRITE_CONTRACT_BODY_SHA256);

    const client = await testPool.connect();
    try {
      expect(await guardBodySha256(client)).toBe(WRITE_CONTRACT_BODY_SHA256);
      expect(await paymentContractState(client)).toEqual({
        hasPaymentOptionTable: true,
        hasVariantPaymentOptionColumn: true,
        marker: WRITE_CONTRACT_COMMENT,
      });
    } finally {
      client.release();
    }
  });

  it("weist fehlenden Marker plus Legacy-Guard in Apply und Verify fail-closed ab", async () => {
    const client = await testPool.connect();
    await client.query("begin");
    try {
      await client.query(guardFunctionDdlFromMigration(LEGACY_GUARD_TAG));
      await client.query(
        "comment on column public.offer_variant.payment_option_id is null",
      );

      expect(await guardBodySha256(client)).toBe(LEGACY_GUARD_BODY_SHA256);
      expect((await paymentContractState(client)).marker).toBeNull();

      const markerError = /F2-05-Schreibvertragsmarker weicht ab[\s\S]*gefunden: NULL/;
      await expect(verifyRoleContract(client)).rejects.toThrow(markerError);
      await expect(applyRoleContract(client)).rejects.toThrow(markerError);

      await client.query(
        "comment on column public.offer_variant.payment_option_id is 'manipuliert'",
      );
      const unknownMarkerError =
        /F2-05-Schreibvertragsmarker weicht ab[\s\S]*gefunden: "manipuliert"/;
      await expect(verifyRoleContract(client)).rejects.toThrow(unknownMarkerError);
      await expect(applyRoleContract(client)).rejects.toThrow(unknownMarkerError);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("bleibt vor/nach 0068 prefix-tauglich und hebt 0073 minimal auf 0074 an", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 1 });
    const prefixes: string[] = [];
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();

      const prePaymentPrefix = migrationPrefixThrough(PRE_PAYMENT_OPTIONS_INDEX);
      prefixes.push(prePaymentPrefix);
      await migrate(drizzle(client), { migrationsFolder: prePaymentPrefix });
      expect(await paymentContractState(client)).toEqual({
        hasPaymentOptionTable: false,
        hasVariantPaymentOptionColumn: false,
        marker: null,
      });
      expect(await guardBodySha256(client)).toBe(LEGACY_GUARD_BODY_SHA256);

      const paymentPrefix = migrationPrefixThrough(PAYMENT_OPTIONS_INDEX);
      prefixes.push(paymentPrefix);
      await migrate(drizzle(client), { migrationsFolder: paymentPrefix });
      expect(await paymentContractState(client)).toEqual({
        hasPaymentOptionTable: true,
        hasVariantPaymentOptionColumn: true,
        marker: null,
      });
      expect(await guardBodySha256(client)).toBe(LEGACY_GUARD_BODY_SHA256);

      const preWritePrefix = migrationPrefixThrough(PRE_WRITE_CONTRACT_INDEX);
      prefixes.push(preWritePrefix);
      await migrate(drizzle(client), { migrationsFolder: preWritePrefix });
      await createGuardProbe(client);

      await expectUpdateRejected(
        client,
        "update offer_variant set payment_option_id = $1, updated_at = $2",
        [randomUUID(), "2026-09-06T10:01:00.000Z"],
      );

      await migrate(drizzle(client), { migrationsFolder: resolve("drizzle") });
      expect(await guardBodySha256(client)).toBe(WRITE_CONTRACT_BODY_SHA256);
      expect(await paymentContractState(client)).toEqual({
        hasPaymentOptionTable: true,
        hasVariantPaymentOptionColumn: true,
        marker: WRITE_CONTRACT_COMMENT,
      });

      const paymentOptionId = randomUUID();
      const allowed = await client.query(
        `update offer_variant
            set payment_option_id = $1, updated_at = $2
          returning payment_option_id::text as "paymentOptionId"`,
        [paymentOptionId, "2026-09-06T10:02:00.000Z"],
      );
      expect(allowed.rows).toEqual([{ paymentOptionId }]);

      await expectUpdateRejected(
        client,
        "update offer_variant set stable_identity = $1, updated_at = $2",
        [randomUUID(), "2026-09-06T10:03:00.000Z"],
      );
    } finally {
      client?.release();
      try {
        await endPoolsAndStopEmbeddedPostgres(
          [pool],
          embedded,
          "F2.5-Migrations-Teardown fehlgeschlagen",
        );
      } finally {
        for (const prefix of prefixes) {
          rmSync(prefix, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);
});
