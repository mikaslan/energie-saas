import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Pool } from "pg";

const ROOT = "/Users/mikail/Projects/energie-saas-m204-e-signature";
const { startEmbeddedPostgres } = await import(`${ROOT}/tests/setup/embedded-postgres.ts`);
const { parsePostgresConnectionUrl, postgresTestTargetConfirmation } = await import(
  `${ROOT}/lib/db/postgres-url.ts`
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const embedded = await startEmbeddedPostgres();
try {
  execSync("npx tsx scripts/migrate.mts", {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DB_ROLE_MODE: "test-legacy-single",
      POSTGRES_URL_MIGRATE: embedded.url,
      POSTGRES_TEST_TARGET_CONFIRM: postgresTestTargetConfirmation(
        parsePostgresConnectionUrl("POSTGRES_URL_TEST", embedded.url),
      ),
    },
    stdio: "inherit",
  });

  const pool = new Pool({ connectionString: embedded.superuserUrl });

  // 1) Function security pins (owner hardcoded to app_owner for strict mode).
  const funcs = await pool.query<Record<string, unknown>>(`
    select p.proname,
           pg_catalog.oidvectortypes(p.proargtypes) as args,
           pg_catalog.pg_get_function_result(p.oid) as result_type,
           language.lanname as language,
           p.prokind, p.provolatile, p.prosecdef, p.proleakproof,
           p.proisstrict, p.proparallel, p.proconfig, p.prosrc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language language on language.oid = p.prolang
    where n.nspname = 'public'
      and (p.proname like '\\_m204%' or p.proname in (
        'create_signature_request','resolve_signature_public_view',
        'sign_signature_by_token','revoke_signature_by_customer',
        'record_signature_view','erase_inactive_lead',
        'guard_erasure_tombstone_worm','build_inactive_lead_erasure_graph',
        'build_inactive_lead_erasure_graph_m204'
      ))
    order by p.proname, p.oid
  `);

  const pins = funcs.rows.map((row) => {
    const sha = sha256(String(row.prosrc));
    return `${row.proname}(${row.args})|${row.result_type}|${row.language}|${row.prokind}|${row.provolatile}|${row.prosecdef}|${row.proleakproof}|${row.proisstrict}|${row.proparallel}|${(row.proconfig as string[] | null)?.join("|") ?? "-"}|${sha}`;
  });

  // 2) Policy-Hashes im exakten verifyRoleContract-Format:
  //    tablename:policyname:sha256(tablename|policyname|permissive|roles|cmd|qual|with_check)
  const policies = await pool.query<{
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string | null;
    cmd: string;
    qual: string;
    with_check: string;
  }>(`
    select tablename,
           policyname,
           permissive,
           roles::text as roles,
           cmd,
           coalesce(qual, '-') as qual,
           coalesce(with_check, '-') as with_check
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('signature_request','signature_attestation','signature_view_log')
    order by tablename, policyname
  `);
  const policyLines = policies.rows.map((row) => {
    const value = [
      row.tablename,
      row.policyname,
      row.permissive,
      row.roles,
      row.cmd,
      row.qual,
      row.with_check,
    ].join("|");
    return `${row.tablename}:${row.policyname}:${sha256(value)}`;
  });

  // 3) Trigger-Contract im exakten verifyRoleContract-Format.
  const triggers = await pool.query<{
    relname: string;
    tgname: string;
    tgtype: number;
    tgenabled: string;
    function_schema: string;
    proname: string;
    args: string;
    when_expression: string;
    tgconstraint: string;
  }>(`
    select relation.relname,
           trigger.tgname,
           trigger.tgtype,
           trigger.tgenabled,
           function_schema.nspname as function_schema,
           function.proname,
           pg_catalog.encode(trigger.tgargs, 'hex') as args,
           case
             when trigger.tgqual is null then '-'
             else pg_catalog.regexp_replace(
               pg_catalog.pg_get_triggerdef(trigger.oid, false),
               '^.* WHEN \\((.*)\\) EXECUTE FUNCTION .*$',
               '\\1'
             )
           end as when_expression,
           trigger.tgconstraint::text
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace relation_schema on relation_schema.oid = relation.relnamespace
    join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
    join pg_catalog.pg_namespace function_schema on function_schema.oid = function.pronamespace
    where relation_schema.nspname = 'public'
      and not trigger.tgisinternal
      and relation.relname in ('signature_request','signature_attestation','signature_view_log')
    order by relation.relname, trigger.tgname
  `);
  const triggerLines = triggers.rows.map((row) =>
    [
      row.relname,
      row.tgname,
      String(row.tgtype),
      row.tgenabled,
      row.function_schema,
      row.proname,
      row.args,
      row.when_expression,
      row.tgconstraint === "0" ? "0" : "constraint",
    ].join(":"),
  );

  // 4) ACL-Grant-Zeilen im exakten rawFunctionAcl-Format
  //    grantee:proname(argtypes):EXECUTE:grantor:is_grantable
  const SIGNATURE_RUNTIME_ROUTINES = [
    "_m204_actor_can_read_signatures(uuid)",
    "_m204_actor_can_write_signatures(uuid)",
    "_m204_actor_signature_role(uuid)",
    "create_signature_request(uuid,uuid,uuid,integer,bytea)",
    "record_signature_view(bytea)",
    "resolve_signature_public_view(bytea)",
    "revoke_signature_by_customer(bytea)",
    "sign_signature_by_token(bytea,text,text,bytea)",
  ];
  const aclGrantLines = SIGNATURE_RUNTIME_ROUTINES.map(
    (signature) => `app_runtime:${signature}:EXECUTE:app_owner:false`,
  );

  console.log(JSON.stringify(
    { pins, policyLines, triggerLines, aclGrantLines },
    null,
    2,
  ));
  await pool.end();
} finally {
  await embedded.stop();
}
