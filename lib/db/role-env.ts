import type { PoolClient, PoolConfig, QueryResultRow } from "pg";
import {
  assertDestructiveTestDatabase,
  assertNoAmbientPostgresOverrides,
  parsePostgresConnectionUrl,
  postgresConnectionTarget,
  postgresConnectionTargetKey,
  postgresConnectionTransport,
} from "./postgres-url";

export type ServiceDatabaseRole = "app_runtime" | "app_auth" | "app_worker";
export type ServiceDatabaseEnv = "POSTGRES_URL" | "POSTGRES_URL_AUTH" | "POSTGRES_URL_WORKER";

const STRICT_MODE = "strict";
const TEST_MODE = "test-legacy-single";

const WEB_SERVICE_ROLES = {
  POSTGRES_URL: "app_runtime",
  POSTGRES_URL_AUTH: "app_auth",
} as const satisfies Partial<Record<ServiceDatabaseEnv, ServiceDatabaseRole>>;

export interface NeonDatabaseIdentity {
  tenantId: string;
  timelineId: string;
}

export interface ServicePoolTimeouts {
  connectionMs: number;
  lockMs: number;
  statementMs: number;
  queryMs: number;
  idleInTransactionMs: number;
}

const DEFAULT_SERVICE_TIMEOUTS: ServicePoolTimeouts = {
  connectionMs: 5_000,
  lockMs: 3_000,
  statementMs: 15_000,
  queryMs: 17_000,
  idleInTransactionMs: 30_000,
};

interface ServiceRoleIdentityRow extends QueryResultRow {
  database_name: string;
  database_owner: string;
  session_role: string;
  current_role: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
  password_never_expires: boolean;
  role_setting_count: number;
  neon_tenant_id: string | null;
  neon_timeline_id: string | null;
}

interface ServiceMembershipRow extends QueryResultRow {
  granted_role: string;
  grantor_role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

type RoleContractClient = Pick<PoolClient, "query">;

function connectionUsername(label: string, url: URL): string {
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error(`${label} enthält einen ungültig percent-codierten Benutzernamen.`);
  }
}

function isNeonHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname === "neon.tech" || hostname.endsWith(".neon.tech");
}

function isNeonPoolerHost(url: URL): boolean {
  return isNeonHost(url) && url.hostname.toLowerCase().split(".")[0]?.endsWith("-pooler") === true;
}

function optionalNeonIdentity(): NeonDatabaseIdentity | undefined {
  const tenantId = process.env.POSTGRES_EXPECTED_NEON_TENANT_ID;
  const timelineId = process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID;
  if (!tenantId && !timelineId) return undefined;
  if (!tenantId || !timelineId) {
    throw new Error(
      "POSTGRES_EXPECTED_NEON_TENANT_ID und POSTGRES_EXPECTED_NEON_TIMELINE_ID " +
        "müssen immer gemeinsam gesetzt sein.",
    );
  }
  for (const [name, value] of [
    ["POSTGRES_EXPECTED_NEON_TENANT_ID", tenantId],
    ["POSTGRES_EXPECTED_NEON_TIMELINE_ID", timelineId],
  ] as const) {
    if (!/^[0-9a-f]{32}$/.test(value)) {
      throw new Error(`${name} muss exakt ein kleingeschriebener 32-stelliger Hexwert sein.`);
    }
  }
  return { tenantId, timelineId };
}

function requiredNeonIdentity(url: URL): NeonDatabaseIdentity | undefined {
  const identity = optionalNeonIdentity();
  if (isNeonHost(url) && !identity) {
    throw new Error(
      "Neon-Dienstverbindungen brauchen POSTGRES_EXPECTED_NEON_TENANT_ID und " +
        "POSTGRES_EXPECTED_NEON_TIMELINE_ID für die serverseitige Branch-Bindung.",
    );
  }
  if (isNeonPoolerHost(url)) {
    throw new Error(
      "Dienstrollen brauchen für den Live-Principal-/Branch-Vertrag den direkten Neon-Endpunkt; " +
        "ein -pooler-Host kann zwischen Verifikation und Arbeit den Backend wechseln.",
    );
  }
  return identity;
}

function assertWebServiceTarget(
  envName: ServiceDatabaseEnv,
  url: URL,
): void {
  if (!(envName in WEB_SERVICE_ROLES)) return;
  const otherEnvName = envName === "POSTGRES_URL" ? "POSTGRES_URL_AUTH" : "POSTGRES_URL";
  const otherRaw = process.env[otherEnvName];
  if (!otherRaw) return;

  const otherUrl = parsePostgresConnectionUrl(otherEnvName, otherRaw);
  const otherExpectedRole = WEB_SERVICE_ROLES[otherEnvName];
  if (connectionUsername(otherEnvName, otherUrl) !== otherExpectedRole) {
    throw new Error(`${otherEnvName} muss im Strict-Modus als ${otherExpectedRole} verbinden.`);
  }
  if (postgresConnectionTargetKey(url) !== postgresConnectionTargetKey(otherUrl)) {
    throw new Error(
      "POSTGRES_URL und POSTGRES_URL_AUTH müssen im Web-Prozess exakt dasselbe " +
        "Postgres-Ziel (Host, Port und Datenbank) verwenden.",
    );
  }
}

function assertTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error(`${TEST_MODE} ist ausschließlich unter NODE_ENV=test/Vitest erlaubt.`);
  }
}

function assertTestOnly(url: URL): void {
  assertTestEnvironment();
  assertDestructiveTestDatabase(TEST_MODE, url);
}

/**
 * Löst genau EINE Dienst-URL auf. Es gibt absichtlich keinerlei Fallback
 * zwischen Runtime, Auth und Worker: Ein fehlendes Secret muss beim ersten
 * Gebrauch sichtbar scheitern, statt den Ein-Rollen-Zustand fortzusetzen.
 */
export function requireServiceDatabaseUrl(
  envName: ServiceDatabaseEnv,
  expectedRole: ServiceDatabaseRole,
): string {
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} ist nicht gesetzt.`);
  assertNoAmbientPostgresOverrides(envName);
  const url = parsePostgresConnectionUrl(envName, raw);

  const mode = process.env.DB_ROLE_MODE ?? STRICT_MODE;
  if (mode === TEST_MODE) {
    assertTestOnly(url);
    return raw;
  }
  if (mode !== STRICT_MODE) throw new Error(`Unbekannter DB_ROLE_MODE: ${mode}`);

  const actualRole = connectionUsername(envName, url);
  if (actualRole !== expectedRole) {
    throw new Error(`${envName} muss im Strict-Modus als ${expectedRole} verbinden.`);
  }
  assertWebServiceTarget(envName, url);
  requiredNeonIdentity(url);
  return raw;
}

/**
 * Prüft den tatsächlich authentifizierten Principal jeder neu aufgebauten
 * Dienstverbindung. Eine korrekte URL allein reicht nicht: Rollenattribute,
 * Memberships oder providerseitiges Routing können nach Secret-Erzeugung
 * driften. Der Callback ist der `pg-pool`-Verify-Gate und läuft, bevor der
 * Client erstmals an Anwendungscode ausgegeben wird.
 */
export async function verifyServiceDatabaseSession(
  client: RoleContractClient,
  expectedRole: ServiceDatabaseRole,
  expectedDatabase: string,
  expectedNeonIdentity: NeonDatabaseIdentity | undefined = optionalNeonIdentity(),
): Promise<void> {
  const identityResult = await client.query<ServiceRoleIdentityRow>(`
    select database_row.datname::text as database_name,
           database_owner.rolname::text as database_owner,
           session_user::text as session_role,
           current_user::text as current_role,
           role_row.rolcanlogin,
           role_row.rolinherit,
           role_row.rolsuper,
           role_row.rolbypassrls,
           role_row.rolcreatedb,
           role_row.rolcreaterole,
           role_row.rolreplication,
           role_row.rolconnlimit,
           role_row.rolvaliduntil is null as password_never_expires,
           coalesce(pg_catalog.cardinality(role_row.rolconfig), 0)::int
             as role_setting_count,
           pg_catalog.current_setting('neon.tenant_id', true) as neon_tenant_id,
           pg_catalog.current_setting('neon.timeline_id', true) as neon_timeline_id
    from pg_catalog.pg_roles role_row
    join pg_catalog.pg_database database_row
      on database_row.datname = pg_catalog.current_database()
    join pg_catalog.pg_roles database_owner
      on database_owner.oid = database_row.datdba
    where role_row.rolname = session_user
  `);
  const role = identityResult.rows[0];
  if (
    !role ||
    role.database_name !== expectedDatabase ||
    role.session_role !== expectedRole ||
    role.current_role !== expectedRole
  ) {
    throw new Error(
      `Falsches Live-DB-Ziel/Principal für ${expectedRole}: ` +
        `database=${role?.database_name ?? "?"}, session_user=${role?.session_role ?? "?"}, ` +
        `current_user=${role?.current_role ?? "?"}.`,
    );
  }
  if (
    !role.rolcanlogin ||
    role.rolinherit ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolconnlimit !== -1 ||
    !role.password_never_expires ||
    role.role_setting_count !== 0 ||
    role.database_owner === expectedRole
  ) {
    throw new Error(
      `${expectedRole} besitzt live ein verbotenes Rollenattribut, Rollen-Setting ` +
        "oder die implizite pg_database_owner-Mitgliedschaft.",
    );
  }

  if (
    expectedNeonIdentity &&
    (role.neon_tenant_id !== expectedNeonIdentity.tenantId ||
      role.neon_timeline_id !== expectedNeonIdentity.timelineId)
  ) {
    throw new Error(
      `Neon-Serveridentität für ${expectedRole} weicht ab: ` +
        `tenant=${role.neon_tenant_id ?? "?"}, timeline=${role.neon_timeline_id ?? "?"}.`,
    );
  }

  const memberships = await client.query<ServiceMembershipRow>(`
    select granted.rolname::text as granted_role,
           grantor.rolname::text as grantor_role,
           membership.admin_option,
           membership.inherit_option,
           membership.set_option
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
    where member.rolname = $1
    order by granted.rolname, grantor.rolname
  `, [expectedRole]);
  if ((memberships.rowCount ?? memberships.rows.length) !== 0) {
    const edges = memberships.rows.map(
      (row) =>
        `${row.granted_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    );
    throw new Error(`${expectedRole} besitzt live unerwartete Memberships: ${edges.join(", ")}.`);
  }

  const roleSettings = await client.query<{ setting_value: string }>(`
    select pg_catalog.unnest(setting.setconfig)::text as setting_value
    from pg_catalog.pg_db_role_setting setting
    cross join pg_catalog.pg_roles role_row
    cross join pg_catalog.pg_database database_row
    where role_row.rolname = $1
      and database_row.datname = pg_catalog.current_database()
      and setting.setrole in (0, role_row.oid)
      and setting.setdatabase in (0, database_row.oid)
    order by setting.setdatabase, setting.setrole, setting_value
  `, [expectedRole]);
  if ((roleSettings.rowCount ?? roleSettings.rows.length) !== 0) {
    throw new Error(
      `${expectedRole} wird live durch unerwartete Rollen- oder Datenbank-Settings beeinflusst.`,
    );
  }

  if (expectedNeonIdentity) {
    const neonSettings = await client.query<{
      name: string;
      setting: string;
      context: string;
    }>(`
      select name::text, setting::text, context::text
      from pg_catalog.pg_settings
      where name in ('neon.tenant_id', 'neon.timeline_id')
      order by name
    `);
    const signature = neonSettings.rows.map(
      (row) => `${row.name}=${row.setting}:${row.context}`,
    );
    const expectedSignature = [
      `neon.tenant_id=${expectedNeonIdentity.tenantId}:postmaster`,
      `neon.timeline_id=${expectedNeonIdentity.timelineId}:postmaster`,
    ];
    if (JSON.stringify(signature) !== JSON.stringify(expectedSignature)) {
      throw new Error(
        "Neon-Tenant-/Timeline-GUCs sind nicht als unveränderliche Postmaster-Settings attestiert.",
      );
    }
  }
}

async function configureServiceDatabaseSession(
  client: RoleContractClient,
  timeouts: ServicePoolTimeouts,
): Promise<void> {
  await client.query(
    `select pg_catalog.set_config('search_path', 'pg_catalog,public', false),
            pg_catalog.set_config('row_security', 'on', false),
            pg_catalog.set_config('lock_timeout', $1, false),
            pg_catalog.set_config('statement_timeout', $2, false),
            pg_catalog.set_config('idle_in_transaction_session_timeout', $3, false)`,
    [
      `${timeouts.lockMs}ms`,
      `${timeouts.statementMs}ms`,
      `${timeouts.idleInTransactionMs}ms`,
    ],
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function servicePoolConfig(
  connectionString: string,
  expectedRole: ServiceDatabaseRole,
  max = 5,
  timeouts: ServicePoolTimeouts = DEFAULT_SERVICE_TIMEOUTS,
): PoolConfig {
  const parsedUrl = parsePostgresConnectionUrl("Postgres-Dienst-URL", connectionString);
  const expectedDatabase = postgresConnectionTarget(parsedUrl).database;
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Ungültiger Dienst-Pool-Timeout ${name}: ${value}.`);
    }
  }
  const mode = process.env.DB_ROLE_MODE ?? STRICT_MODE;
  let verify: PoolConfig["verify"];
  if (mode === STRICT_MODE) {
    if (connectionUsername("Postgres-Dienst-URL", parsedUrl) !== expectedRole) {
      throw new Error(`Postgres-Dienst-URL muss im Strict-Modus als ${expectedRole} verbinden.`);
    }
    const expectedNeonIdentity = requiredNeonIdentity(parsedUrl);
    verify = (client, done) => {
      void configureServiceDatabaseSession(client, timeouts)
        .then(() =>
          verifyServiceDatabaseSession(
            client,
            expectedRole,
            expectedDatabase,
            expectedNeonIdentity,
          ),
        )
        .then(() => done(), (error: unknown) => done(asError(error)));
    };
  } else if (mode === TEST_MODE) {
    // Die Poolkonfiguration selbst mutiert nichts und wird von Health-Tests
    // absichtlich auch gegen tote/schweigende Dummy-Ziele gebaut. Der echte
    // Dienst-URL-Einstieg oben bleibt zusätzlich exakt an die bestätigte
    // destruktive Testdatenbank gebunden.
    assertTestEnvironment();
    verify = (client, done) => {
      void configureServiceDatabaseSession(client, timeouts).then(
        () => done(),
        (error: unknown) => done(asError(error)),
      );
    };
  } else {
    throw new Error(`Unbekannter DB_ROLE_MODE: ${mode}`);
  }

  return {
    ...postgresConnectionTransport("Postgres-Dienst-URL", connectionString),
    max,
    connectionTimeoutMillis: timeouts.connectionMs,
    query_timeout: timeouts.queryMs,
    maxLifetimeSeconds: 300,
    // node-postgres ignoriert ein leeres options="" und würde dann ein später
    // mutiertes PGOPTIONS erneut lesen. Ein Whitespace ist dagegen ein echter,
    // serverseitig leerer Wert und bindet den Pool unabhängig von ambient Env.
    options: " ",
    verify,
  };
}
