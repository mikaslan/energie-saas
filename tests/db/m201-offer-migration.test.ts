import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testPool } from "../setup/test-db";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

const OFFER_TABLES = [
  "offer",
  "offer_bom_line",
  "offer_mutation_rate_window",
  "offer_number_series",
  "offer_variant",
  "offer_variant_revision",
  "offer_variant_section",
] as const;
const PRE_M2_HISTORY_SHA256 =
  "f1accff1058f12a42c851f29149737792fe8a4d521380766006af1ac69c3cbc6";

function journal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function historyHashThrough(index: number): string {
  const material = journal().entries
    .filter((entry) => entry.idx <= index)
    .map((entry) => `${entry.idx}\0${entry.tag}\0${readFileSync(
      resolve("drizzle", `${entry.tag}.sql`),
      "utf8",
    )}`)
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

describe("M2-01 offer migration", () => {
  it("ist additive 0032 und pinnt 0000 bis zur Metadatenbaseline bytegenau", () => {
    const entries = journal().entries;
    expect(entries.slice(0, 33).map((entry) => entry.idx)).toEqual(
      Array.from({ length: 33 }, (_, index) => index),
    );
    expect(entries.length).toBeGreaterThanOrEqual(33);
    expect(entries[32]?.tag).toBe("0032_m2_01_offer_schema");
    expect(historyHashThrough(31)).toBe(PRE_M2_HISTORY_SHA256);
    const migration = readFileSync(resolve("drizzle/0032_m2_01_offer_schema.sql"), "utf8");
    expect(migration).not.toMatch(/reonic|vault/iu);
    expect(migration).not.toMatch(/insert\s+into\s+public\.(catalog_component|offer)\b/iu);
  });

  it("erzwingt FORCE RLS und genau eine permissive Tenant-Policy je Offer-Tabelle", async () => {
    const relations = await testPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [OFFER_TABLES]);
    expect(relations.rows).toEqual([...OFFER_TABLES].sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const policies = await testPool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string;
    }>(`
      select tablename, policyname, permissive, roles
        from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = any($1::text[])
       order by tablename, policyname
    `, [OFFER_TABLES]);
    expect(policies.rows).toEqual([...OFFER_TABLES].sort().map((tablename) => ({
      tablename,
      policyname: "tenant_isolation",
      permissive: "PERMISSIVE",
      roles: "{public}",
    })));
  });

  it("pinnt immutable Offer-Koepfe und Mirrors mit Erasure-Guard, deferred Vollstaendigkeit und Current-Pointer", async () => {
    const triggers = await testPool.query<{
      table_name: string;
      trigger_name: string;
      function_name: string;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(`
      select class.relname as table_name,
             trigger_row.tgname as trigger_name,
             procedure.proname as function_name,
             coalesce(constraint_row.condeferrable, false) as deferrable,
             coalesce(constraint_row.condeferred, false) as initially_deferred
        from pg_catalog.pg_trigger as trigger_row
        join pg_catalog.pg_class as class on class.oid = trigger_row.tgrelid
        join pg_catalog.pg_proc as procedure on procedure.oid = trigger_row.tgfoid
        left join pg_catalog.pg_constraint as constraint_row
          on constraint_row.oid = trigger_row.tgconstraint
       where not trigger_row.tgisinternal
         and class.relname = any($1::text[])
       order by class.relname, trigger_row.tgname
    `, [[
      "offer",
      "offer_mutation_rate_window",
      "offer_number_series",
      "offer_variant",
      "offer_variant_revision",
      "offer_variant_section",
      "offer_bom_line",
    ]]);
    expect(triggers.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table_name: "offer",
        trigger_name: "offer_immutable",
        function_name: "guard_offer_erasure_mutation",
      }),
      expect.objectContaining({
        table_name: "offer_variant",
        trigger_name: "offer_variant_mutation_guard",
        function_name: "guard_offer_erasure_mutation",
      }),
      expect.objectContaining({
        table_name: "offer_number_series",
        trigger_name: "offer_number_series_mutation_guard",
        function_name: "guard_offer_erasure_mutation",
      }),
      expect.objectContaining({
        table_name: "offer_mutation_rate_window",
        trigger_name: "offer_mutation_rate_window_update_guard",
        function_name: "guard_offer_erasure_mutation",
      }),
      expect.objectContaining({
        table_name: "offer_variant_revision",
        trigger_name: "offer_variant_revision_immutable",
        function_name: "guard_offer_erasure_mutation",
      }),
      expect.objectContaining({
        table_name: "offer_variant_revision",
        trigger_name: "offer_variant_revision_complete",
        function_name: "validate_offer_variant_snapshot_mirrors",
        deferrable: true,
        initially_deferred: true,
      }),
      expect.objectContaining({
        table_name: "offer_variant_section",
        trigger_name: "offer_variant_section_complete",
        function_name: "validate_offer_variant_snapshot_mirrors",
        deferrable: true,
        initially_deferred: true,
      }),
      expect.objectContaining({
        table_name: "offer_bom_line",
        trigger_name: "offer_bom_line_complete",
        function_name: "validate_offer_variant_snapshot_mirrors",
        deferrable: true,
        initially_deferred: true,
      }),
      expect.objectContaining({
        table_name: "offer_variant",
        trigger_name: "offer_variant_current_complete",
        function_name: "validate_offer_variant_snapshot_mirrors",
        deferrable: true,
        initially_deferred: true,
      }),
    ]));

    const pointer = await testPool.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(`
      select condeferrable, condeferred
        from pg_catalog.pg_constraint
       where conname = 'offer_variant_current_revision_fk'
    `);
    expect(pointer.rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });
});
