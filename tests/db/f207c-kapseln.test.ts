import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

const K1_LEDGER = "public.read_offer_approval_ledger(uuid,uuid,uuid)";
const K2_CANDIDATE = "public.read_offer_candidate_history(uuid,uuid,uuid)";
const K3_WITHDRAW = "public.read_offer_withdraw_history(uuid,uuid)";
const SIGNATURES = [K1_LEDGER, K2_CANDIDATE, K3_WITHDRAW];

const K1_COLUMNS = [
  "workspace_id",
  "issuance_id",
  "approved_at",
  "has_zero_tax_treatment",
  "approval_version",
  "recipient_and_scope_reviewed",
  "commercial_totals_reviewed",
  "legal_profile_reviewed",
  "final_pdf_for_archive_understood",
  "zero_tax_treatment_reviewed",
];
const K2_COLUMNS = [
  "workspace_id",
  "candidate_id",
  "variant_revision",
  "profile_revision",
  "recipient_revision",
  "has_zero_tax_treatment",
  "approved_at",
  "recipient_billing_reviewed",
  "commercial_content_reviewed",
  "active_profile_reviewed",
  "not_issued_status_understood",
];
const K3_COLUMNS = ["workspace_id", "issuance_id", "reason_code", "withdrawn_at"];
const FORBIDDEN_COLUMNS = [
  "approved_by",
  "withdrawn_by",
  "artifact_bytes",
  "artifact_sha256",
  "artifact_mime_type",
  "artifact_size_bytes",
  "artifact_version",
  "approval_command",
  "withdrawal_command",
];

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [actorId ?? ""],
    );
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function runtimeQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_runtime");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [actorId ?? ""],
    );
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Low-priv-Fixtur nach M201-Muster (m201-offer-migration-functional.test.ts):
// app_runtime per Superuser anlegen + SET-Recht + USAGE — dort auf eigenem
// Embedded-Cluster, hier idempotent auf dem Shared-Cluster (Rolle ist
// cluster-global, Migrationen liefen ohne sie). Das EXECUTE auf den Kapseln
// ersetzt 0330s bedingten Grant (feuerte nicht: Rolle fehlte zur
// Migrationszeit); der Migrations-Grant selbst bleibt PIN-01-gepinnt.
async function ensureRuntimeRole(): Promise<void> {
  const me = await testPool.query<{ role: string }>(
    `select current_user as role`,
  );
  const testUser = me.rows[0]?.role;
  if (!testUser || !/^[a-z_][a-z0-9_$]*$/i.test(testUser)) {
    throw new Error("Testrolle für SET-Grant fehlt.");
  }
  await superuserPool().query(
    `
    do $f207c_role$
    begin
      if pg_catalog.to_regrole('app_runtime') is null then
        create role app_runtime nologin noinherit nosuperuser nobypassrls
          nocreatedb nocreaterole noreplication;
      end if;
    end
    $f207c_role$;
    grant app_runtime to "${testUser}" with admin false, inherit false, set true;
    grant usage on schema public to app_runtime;
    grant execute on function
      public.read_offer_approval_ledger(uuid, uuid, uuid),
      public.read_offer_candidate_history(uuid, uuid, uuid),
      public.read_offer_withdraw_history(uuid, uuid)
      to app_runtime;
    `,
  );
}

async function seedWorkspaceWithOffer(role = "admin"): Promise<{
  workspaceId: string;
  actorId: string;
  offerId: string;
}> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into public.workspace (id, name)
      values (${workspaceId}::uuid, 'F2-07c Lesekapseln')
    `);
    const offerFactory = tenantFixtures.offer;
    if (!offerFactory) throw new Error("Offer-Fixture fehlt.");
    await offerFactory(tx, workspaceId);
  });
  const binding = await tenantQuery<{
    offer_id: string;
    actor_id: string;
  }>(
    workspaceId,
    null,
    `select offer_record.id as offer_id,
            offer_record.created_by as actor_id
       from public.offer as offer_record
      where offer_record.workspace_id = $1::uuid
      order by offer_record.id
      limit 1`,
    [workspaceId],
  );
  const row = binding.rows[0];
  if (!row) throw new Error("Offer-Bindung fehlt.");
  await tenantQuery(
    workspaceId,
    null,
    `update public.membership
        set role = $3::text, capabilities = '{}'::jsonb
      where workspace_id = $1::uuid and user_id = $2::uuid`,
    [workspaceId, row.actor_id, role],
  );
  return { workspaceId, actorId: row.actor_id, offerId: row.offer_id };
}

async function seedMember(
  workspaceId: string,
  role: string,
  capabilities: Record<string, boolean> = {},
): Promise<string> {
  const actorId = randomUUID();
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.user_identity (id, email)
     values ($1::uuid, $2::text)`,
    [actorId, `f207c-${actorId}@example.invalid`],
  );
  await tenantQuery(
    workspaceId,
    null,
    `insert into public.membership (workspace_id, user_id, role, capabilities)
     values ($1::uuid, $2::uuid, $3::text, $4::jsonb)`,
    [workspaceId, actorId, role, JSON.stringify(capabilities)],
  );
  return actorId;
}

describe("F2-07c Freigabe-Lesekapseln (RED)", () => {
  it("F207C-EXIST-01: legt die 3 Kapseln als STABLE DEFINER mit search_path=pg_catalog an", async () => {
    // Owner ist die Migrationsrolle der Umgebung (embedded: app_test,
    // Service-PG: app_ci) — gepinnt wird Migrator-Ownership (M202-Muster);
    // app_owner bleibt PIN-01 (Rollenvertrag) vorbehalten.
    const migrator = await testPool.query<{ role: string }>(
      `select current_user as role`,
    );
    const catalog = await testPool.query<{
      signature: string;
      owner: string;
      security_definer: boolean;
      volatility: string;
      proconfig: string[] | null;
    }>(
      `select requested.signature,
              owner_row.rolname as owner,
              routine.prosecdef as security_definer,
              routine.provolatile as volatility,
              routine.proconfig
         from pg_catalog.unnest($1::text[]) as requested(signature)
         join pg_catalog.pg_proc as routine
           on routine.oid = pg_catalog.to_regprocedure(requested.signature)
         join pg_catalog.pg_roles as owner_row
           on owner_row.oid = routine.proowner
        order by requested.signature`,
      [SIGNATURES],
    );
    expect(catalog.rows.map((row) => row.signature)).toEqual(
      [...SIGNATURES].sort(),
    );
    for (const row of catalog.rows) {
      expect(row.owner).toBe(migrator.rows[0]?.role);
      expect(row.security_definer).toBe(true);
      expect(row.volatility).toBe("s");
      expect(row.proconfig).toEqual(["search_path=pg_catalog"]);
    }
  });

  it("F207C-TENANT-01: blockt Cross-Tenant mit 42501, Fremd-Offer bleibt leer", async () => {
    const home = await seedWorkspaceWithOffer();
    const foreign = await seedWorkspaceWithOffer();
    await expect(
      tenantQuery(
        randomUUID(),
        home.actorId,
        `select * from ${K1_LEDGER.split("(")[0]}($1::uuid, $2::uuid, null)`,
        [home.workspaceId, home.offerId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      tenantQuery(
        home.workspaceId,
        home.actorId,
        `select * from ${K2_CANDIDATE.split("(")[0]}($1::uuid, $2::uuid, null)`,
        [home.workspaceId, foreign.offerId],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      tenantQuery(
        home.workspaceId,
        home.actorId,
        `select * from ${K3_WITHDRAW.split("(")[0]}($1::uuid, $2::uuid)`,
        [home.workspaceId, foreign.offerId],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("F207C-RUNTIME-01: app_runtime liest Kapseln, Direkt-SELECT bleibt verboten", async () => {
    await ensureRuntimeRole();
    const home = await seedWorkspaceWithOffer();
    const identity = await runtimeQuery<{
      current_user: string;
      bypasses_rls: boolean;
    }>(
      home.workspaceId,
      home.actorId,
      `select current_user,
              (select rolbypassrls from pg_catalog.pg_roles
                where rolname = current_user) as bypasses_rls`,
    );
    expect(identity.rows).toEqual([{
      current_user: "app_runtime",
      bypasses_rls: false,
    }]);
    const ledger = await runtimeQuery<Record<string, unknown>>(
      home.workspaceId,
      home.actorId,
      `select * from ${K1_LEDGER.split("(")[0]}($1::uuid, $2::uuid, null)`,
      [home.workspaceId, home.offerId],
    );
    expect(ledger.fields.map((field) => field.name)).toEqual(K1_COLUMNS);
    const candidate = await runtimeQuery<Record<string, unknown>>(
      home.workspaceId,
      home.actorId,
      `select * from ${K2_CANDIDATE.split("(")[0]}($1::uuid, $2::uuid, null)`,
      [home.workspaceId, home.offerId],
    );
    expect(candidate.fields.map((field) => field.name)).toEqual(K2_COLUMNS);
    const withdraw = await runtimeQuery<Record<string, unknown>>(
      home.workspaceId,
      home.actorId,
      `select * from ${K3_WITHDRAW.split("(")[0]}($1::uuid, $2::uuid)`,
      [home.workspaceId, home.offerId],
    );
    expect(withdraw.fields.map((field) => field.name)).toEqual(K3_COLUMNS);
    for (const table of [
      "offer_release_candidate_approval",
      "offer_issuance_approval",
      "offer_issuance_withdrawal",
    ]) {
      await expect(
        runtimeQuery(home.workspaceId, home.actorId, `select * from public.${table} limit 1`),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("F207C-PII-01: RETURNS-Spalten sind exakt die Whitelist, kein Actor im JSON-Dump", async () => {
    const catalog = await testPool.query<{
      signature: string;
      out_names: string[] | null;
    }>(
      `select requested.signature,
              -- RETURNS-TABLE-Spalten tragen Modus 't' (nicht 'o'): ohne ihn
              -- wäre out_names leer und der Whitelist-Vergleich falsch-rot.
              (select pg_catalog.array_agg(arg_name.name order by arg_name.ord)
                 from pg_catalog.unnest(routine.proargnames)
                  with ordinality as arg_name(name, ord)
                 join pg_catalog.unnest(
                        routine.proargmodes::pg_catalog.text[]
                      )
                  with ordinality as arg_mode(mode, ord)
                   on arg_mode.ord = arg_name.ord
                where arg_mode.mode in ('o', 'b', 't')) as out_names
         from pg_catalog.unnest($1::text[]) as requested(signature)
         join pg_catalog.pg_proc as routine
           on routine.oid = pg_catalog.to_regprocedure(requested.signature)`,
      [SIGNATURES],
    );
    expect(catalog.rows).toHaveLength(3);
    const bySignature = new Map(catalog.rows.map((row) => [row.signature, row.out_names]));
    expect(bySignature.get(K1_LEDGER)).toEqual(K1_COLUMNS);
    expect(bySignature.get(K2_CANDIDATE)).toEqual(K2_COLUMNS);
    expect(bySignature.get(K3_WITHDRAW)).toEqual(K3_COLUMNS);
    for (const names of bySignature.values()) {
      for (const forbidden of FORBIDDEN_COLUMNS) {
        expect(names ?? []).not.toContain(forbidden);
      }
      expect((names ?? []).join(",")).not.toMatch(/hash|snapshot|payload|price|address/i);
    }
    const home = await seedWorkspaceWithOffer();
    const dump = await tenantQuery<{ surface: Record<string, unknown> }>(
      home.workspaceId,
      home.actorId,
      `select pg_catalog.to_jsonb(ledger_row) as surface
         from ${K1_LEDGER.split("(")[0]}($1::uuid, $2::uuid, null) as ledger_row`,
      [home.workspaceId, home.offerId],
    );
    for (const row of dump.rows) {
      expect(JSON.stringify(row.surface)).not.toContain(home.actorId);
    }
  });

  it("F207C-RBAC-01: viewer/editor/admin lesen, external_only und Non-Member scheitern", async () => {
    const home = await seedWorkspaceWithOffer("viewer");
    const editor = await seedMember(home.workspaceId, "editor");
    const admin = await seedMember(home.workspaceId, "admin");
    const external = await seedMember(home.workspaceId, "editor", { external_only: true });
    const nonMember = randomUUID();
    for (const actorId of [home.actorId, editor, admin]) {
      await expect(
        tenantQuery(
          home.workspaceId,
          actorId,
          `select * from ${K1_LEDGER.split("(")[0]}($1::uuid, $2::uuid, null)`,
          [home.workspaceId, home.offerId],
        ),
      ).resolves.toBeDefined();
      await expect(
        tenantQuery(
          home.workspaceId,
          actorId,
          `select * from ${K2_CANDIDATE.split("(")[0]}($1::uuid, $2::uuid, null)`,
          [home.workspaceId, home.offerId],
        ),
      ).resolves.toBeDefined();
      await expect(
        tenantQuery(
          home.workspaceId,
          actorId,
          `select * from ${K3_WITHDRAW.split("(")[0]}($1::uuid, $2::uuid)`,
          [home.workspaceId, home.offerId],
        ),
      ).resolves.toBeDefined();
    }
    for (const actorId of [external, nonMember]) {
      await expect(
        tenantQuery(
          home.workspaceId,
          actorId,
          `select * from ${K1_LEDGER.split("(")[0]}($1::uuid, $2::uuid, null)`,
          [home.workspaceId, home.offerId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
