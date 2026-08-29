// Isolierter PG18-Regressionsnachweis fuer die grantor-genaue Semantik eines
// Nicht-Superusers mit CREATEROLE. Die Probe bootet immer eine fluechtige
// embedded-Postgres-Instanz und greift niemals auf Neon-/Service-URLs zu.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { startEmbeddedPostgres } from "../tests/setup/embedded-postgres.js";

interface MembershipEdge extends QueryResultRow {
  grantor_oid: number | string;
  grantor_name: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function expectSqlState(operation: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `SQLSTATE ${expected} erwartet, Statement wurde erlaubt.`);
  assert.equal(postgresCode(caught), expected, `Unerwarteter PostgreSQL-Fehler: ${String(caught)}`);
}

async function membershipEdges(
  superuser: Pool,
  grantedRole: string,
  memberRole: string,
): Promise<MembershipEdge[]> {
  const result = await superuser.query<MembershipEdge>(`
    select grantor.oid as grantor_oid,
           grantor.rolname as grantor_name,
           membership.admin_option,
           membership.inherit_option,
           membership.set_option
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
    where granted.rolname = $1
      and member.rolname = $2
    order by grantor.oid
  `, [grantedRole, memberRole]);
  return result.rows;
}

async function assertSetRoleDenied(client: PoolClient, role: string): Promise<void> {
  await expectSqlState(client.query(`set role ${quoteIdentifier(role)}`), "42501");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const creatorRole = `pg18_creator_${suffix}`;
const createdRole = `pg18_created_${suffix}`;
const creatorPassword = `local-${suffix}`;

const embedded = await startEmbeddedPostgres();
const superuser = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
let creatorPool: Pool | undefined;
let creatorClient: PoolClient | undefined;

try {
  await superuser.query(
    `create role ${quoteIdentifier(creatorRole)} login password ${quoteLiteral(creatorPassword)} ` +
      "noinherit nosuperuser nobypassrls nocreatedb createrole noreplication",
  );

  const creatorUrl = new URL(embedded.url);
  creatorUrl.username = creatorRole;
  creatorUrl.password = creatorPassword;
  creatorPool = new Pool({ connectionString: creatorUrl.toString(), max: 1 });
  creatorClient = await creatorPool.connect();

  const identity = await creatorClient.query<{
    server_version_num: number;
    current_role: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
  }>(`
    select pg_catalog.current_setting('server_version_num')::int as server_version_num,
           current_user as current_role,
           role.rolsuper,
           role.rolcreaterole
    from pg_catalog.pg_roles role
    where role.rolname = current_user
  `);
  const actor = identity.rows[0];
  assert(actor, "CREATEROLE-Testprincipal ist nicht sichtbar.");
  assert(
    actor.server_version_num >= 180_000 && actor.server_version_num < 190_000,
    `Exakt PostgreSQL 18 erwartet, erhalten: ${actor.server_version_num}.`,
  );
  assert.equal(actor.current_role, creatorRole);
  assert.equal(actor.rolsuper, false);
  assert.equal(actor.rolcreaterole, true);

  // Ein Umgebungs-/Rollen-Default darf den Baseline-Nachweis nicht heimlich
  // um SET oder INHERIT erweitern.
  await creatorClient.query("set createrole_self_grant = ''");
  const selfGrantSetting = await creatorClient.query<{ value: string }>(
    "select pg_catalog.current_setting('createrole_self_grant') as value",
  );
  assert.equal(selfGrantSetting.rows[0]?.value, "");

  await creatorClient.query(
    `create role ${quoteIdentifier(createdRole)} nologin noinherit nosuperuser ` +
      "nobypassrls nocreatedb nocreaterole noreplication",
  );

  let edges = await membershipEdges(superuser, createdRole, creatorRole);
  assert.equal(edges.length, 1, `Exakt eine automatische Bootstrap-Kante erwartet: ${JSON.stringify(edges)}`);
  const bootstrapEdge = edges[0]!;
  assert.equal(Number(bootstrapEdge.grantor_oid), 10, "Grantor muss BootstrapSuperuserId (OID 10) sein.");
  assert.deepEqual(
    {
      admin: bootstrapEdge.admin_option,
      inherit: bootstrapEdge.inherit_option,
      set: bootstrapEdge.set_option,
    },
    { admin: true, inherit: false, set: false },
  );
  console.log("OK   Automatische Bootstrap-Kante ist ADMIN=true, INHERIT=false, SET=false");

  await assertSetRoleDenied(creatorClient, createdRole);
  console.log("OK   Bootstrap-Kante allein erlaubt kein SET ROLE");

  await creatorClient.query(
    `grant ${quoteIdentifier(createdRole)} to ${quoteIdentifier(creatorRole)} ` +
      "with admin false, inherit false, set true",
  );
  edges = await membershipEdges(superuser, createdRole, creatorRole);
  assert.equal(edges.length, 2, `Bootstrap- und eigene SET-Kante erwartet: ${JSON.stringify(edges)}`);
  const ownSetEdge = edges.find((edge) => edge.grantor_name === creatorRole);
  assert(ownSetEdge, "Die eigene SET-Kante fehlt.");
  assert.deepEqual(
    {
      admin: ownSetEdge.admin_option,
      inherit: ownSetEdge.inherit_option,
      set: ownSetEdge.set_option,
    },
    { admin: false, inherit: false, set: true },
  );

  await creatorClient.query(`set role ${quoteIdentifier(createdRole)}`);
  const switchedIdentity = await creatorClient.query<{ current_role: string; session_role: string }>(
    "select current_user as current_role, session_user as session_role",
  );
  assert.deepEqual(switchedIdentity.rows[0], {
    current_role: createdRole,
    session_role: creatorRole,
  });
  await creatorClient.query("reset role");
  console.log("OK   Eine getrennte, selbst grantierte SET=true-Kante ermoeglicht SET ROLE");

  await expectSqlState(
    creatorClient.query(
      `revoke ${quoteIdentifier(createdRole)} from ${quoteIdentifier(creatorRole)} ` +
        `granted by ${quoteIdentifier(bootstrapEdge.grantor_name)} cascade`,
    ),
    "42501",
  );
  edges = await membershipEdges(superuser, createdRole, creatorRole);
  assert.equal(edges.length, 2, "Der fehlgeschlagene Fremd-Revoke darf keine Kante veraendern.");
  console.log("OK   Nicht-Superuser kann die fremd-grantierte Bootstrap-Kante nicht entziehen");

  // Der ausdruecklich current-user-gebundene Revoke entfernt nur die eigene
  // SET-Kante; die Bootstrap-Kante bleibt unangetastet und SET ROLE ist wieder
  // gesperrt.
  await creatorClient.query(
    `revoke ${quoteIdentifier(createdRole)} from ${quoteIdentifier(creatorRole)} ` +
      "granted by current_user cascade",
  );
  edges = await membershipEdges(superuser, createdRole, creatorRole);
  assert.equal(edges.length, 1);
  assert.equal(Number(edges[0]?.grantor_oid), 10);
  assert.deepEqual(
    {
      admin: edges[0]?.admin_option,
      inherit: edges[0]?.inherit_option,
      set: edges[0]?.set_option,
    },
    { admin: true, inherit: false, set: false },
  );
  await assertSetRoleDenied(creatorClient, createdRole);
  console.log("OK   Eigener Revoke entfernt nur die eigene SET-Kante; Bootstrap bleibt erhalten");
} finally {
  creatorClient?.release();
  await creatorPool?.end().catch(() => undefined);
  await superuser
    .query(`drop role if exists ${quoteIdentifier(createdRole)}`)
    .catch(() => undefined);
  await superuser
    .query(`drop role if exists ${quoteIdentifier(creatorRole)}`)
    .catch(() => undefined);
  await superuser.end().catch(() => undefined);
  await embedded.stop();
}

console.log("\nPG18-CREATEROLE-Regressionsprobe: 5 Pruefungen gruen.");
