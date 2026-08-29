import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  EXPECTED_JOB_STATES,
  expectedManagedColumns,
  expectedManagedIndexes,
  expectedManagedTables,
} from "pg-boss/dist/plans.js";
import {
  computeSchemaDrift,
  getEnumDefinition,
  getSchemaColumns,
  getSchemaIndexes,
} from "pg-boss/dist/drifter.js";
import {
  assertNoAmbientPostgresOverrides,
  parsePostgresConnectionUrl,
  postgresConnectionTransport,
  postgresConnectionTarget,
  postgresConnectionTargetKey,
} from "../lib/db/postgres-url.js";
import {
  applyDefaultPrivilegeContract,
  applyRoleContract,
  dbRoleProvisioningTopologyFromEnvironment,
  expectedDbRoleMembershipSignatures,
  type DbRoleProvisioningTopology,
  validateDbRoleProvisioningTopology,
  verifyDefaultPrivilegeContract,
} from "./db-role-contract.mjs";
import { verifyAppliedMigrationHistory } from "./migration-history.mjs";

const JOURNAL_0018 = 1_787_963_136_235;
const JOURNAL_0019 = 1_787_965_786_722;
const CUTOVER_LOCK_KEY_1 = 1_701_734_769;
const CUTOVER_LOCK_KEY_2 = 3;

const APP_OWNER = "app_owner";
const APP_WORKER = "app_worker";
const MEMBERSHIP_WRITER = "app_membership_writer";
const IDENTITY_RECONCILER = "identity_reconciler";

const PROTECTED_ROLES = new Set([
  APP_OWNER,
  "app_migrator",
  "app_runtime",
  "app_system",
  "app_auth",
  APP_WORKER,
  MEMBERSHIP_WRITER,
  IDENTITY_RECONCILER,
]);

const TARGET_SCHEMAS = ["public", "drizzle", "pgboss"] as const;

export interface LegacyCutoverSample {
  workspaceId: string;
  userId: string;
  pgBossJobId: string;
}

export interface LegacyRoleCutoverOptions {
  /** Exakter current_database()-Wert. Keine Wildcards oder Normalisierung. */
  expectedDatabase: string;
  /** Exakte, vom Target verschiedene Control-Datenbank desselben PG18-Clusters. */
  expectedControlDatabase: string;
  /**
   * Exakter, operatorbestätigter datconnlimit-Ausgangswert. Phase 1 setzt die
   * Datenbank sichtbar auf 0; erst nach bekannt erfolgreichem Target-COMMIT
   * stellt die separate Control-Verbindung diesen Wert wieder her. 0 selbst
   * ist deshalb kein zulässiger Ausgangswert.
   */
  expectedDatabaseConnectionLimit: number;
  /** Historischer Ein-Rollen-Principal, der nach dem Cutover deaktiviert wird. */
  legacyRole: string;
  /** Muss dem tatsächlichen session_user/current_user entsprechen. */
  expectedAdminRole: string;
  /**
   * Exakter Grantor der beim historischen CREATE ROLE automatisch erzeugten
   * ADMIN-Mitgliedschaft in identity_reconciler. Das ist bei PostgreSQL 18
   * der Bootstrap-Superuser und nicht zwingend der heutige Cutover-Admin.
   */
  expectedIdentityBootstrapGrantorRole: string;
  /** Optionaler, grantor-genauer PG18-Nichtsuperuser-Provisioningvertrag. */
  provisioningTopology?: DbRoleProvisioningTopology;
  /**
   * Clusterweite Änderungen sind nicht auf eine Datenbank begrenzt. Der
   * Aufrufer muss deshalb exakt beide Rollen benennen, die NOLOGIN/NOINHERIT
   * gesetzt bekommen: Legacy-Principal und identity_reconciler.
   */
  confirmedClusterWideNoLoginRoles: readonly string[];
  sample: LegacyCutoverSample;
}

export interface LegacyRoleCutoverResult {
  database: string;
  legacyRole: string;
  transferredRelations: number;
  transferredRoutines: number;
  transferredTypes: number;
  revokedAclEntries: number;
  revokedMembershipEdges: number;
  sample: LegacyCutoverSample;
}

/**
 * Verwirft nach einer mehrdeutigen Control-Grenze zuerst den übergebenen
 * PoolClient und liefert erst danach eine neue, noch nicht verwendete
 * Verbindung. Das Schließen der alten Session ist Teil des Vertrags: Eine dort
 * offene Transaktion darf den frischen Refreeze nicht per Kataloglock blockieren.
 * Der Aufrufer besitzt den neuen Client nur bis zur Reattestierung; er wird
 * danach ebenfalls verworfen.
 */
export type FreshControlClientFactory = (
  compromisedControl: PoolClient,
) => Promise<PoolClient>;

interface IdentityRow extends QueryResultRow {
  database_name: string;
  current_role: string;
  session_role: string;
  server_version_num: number;
  rolsuper: boolean;
  rolcreaterole: boolean;
}

interface ClusterAttestationRow extends QueryResultRow {
  database_name: string;
  system_identifier: string;
  server_address: string;
  server_port: number;
}

interface DatabaseStateRow extends QueryResultRow {
  database_name: string;
  datallowconn: boolean;
  datconnlimit: number;
}

interface RoleRow extends QueryResultRow {
  oid: number;
  rolname: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
}

interface SnapshotRow extends QueryResultRow {
  snapshot: string;
}

interface JournalRow extends QueryResultRow {
  migration_0018: number;
  migration_0019: number;
  later_migrations: number;
  snapshot: string;
}

interface RelationOwnerRow extends QueryResultRow {
  schema_name: string;
  object_name: string;
  relkind: string;
}

interface RoutineOwnerRow extends QueryResultRow {
  schema_name: string;
  object_name: string;
  identity_arguments: string;
  prokind: string;
}

interface TypeOwnerRow extends QueryResultRow {
  schema_name: string;
  object_name: string;
  typtype: string;
}

interface AclBaseRow extends QueryResultRow {
  privilege_type: string;
  grantee: string | null;
  grantee_oid: number | string;
  grantor: string | null;
  grantor_oid: number | string;
}

interface NamedAclRow extends AclBaseRow {
  object_name: string;
}

interface QualifiedAclRow extends NamedAclRow {
  schema_name: string;
}

interface RelationAclRow extends QualifiedAclRow {
  relkind: string;
}

interface ColumnAclRow extends RelationAclRow {
  column_name: string;
}

interface RoutineAclRow extends QualifiedAclRow {
  identity_arguments: string;
  prokind: string;
}

interface TypeAclRow extends QualifiedAclRow {
  typtype: string;
  is_standalone: boolean;
}

interface MembershipRow extends QueryResultRow {
  granted_role: string;
  member_role: string;
  grantor_role: string;
}

interface MembershipContractRow extends QueryResultRow {
  granted_role: string;
  member_role: string;
  grantor_role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

interface CountRow extends QueryResultRow {
  n: number;
}

interface OwnerDriftRow extends QueryResultRow {
  object_kind: string;
  object_name: string;
  actual_owner: string;
  expected_owner: string;
}

interface AclSignatureRow extends QueryResultRow {
  object_kind: string;
  object_name: string;
  grantee: string;
  grantor: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface CutoverSnapshots {
  workspace: string;
  user: string;
  membership: string;
  pgBossJob: string;
  journal: string;
}

type ControlCommitPhase = "freeze" | "unfreeze";

class AmbiguousControlCommitError extends Error {
  readonly phase: ControlCommitPhase;
  readonly trustedAttestation: ClusterAttestationRow;

  constructor(
    phase: ControlCommitPhase,
    cause: unknown,
    trustedAttestation: ClusterAttestationRow,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Control-${phase === "freeze" ? "Freeze" : "Unfreeze"}-COMMIT-Antwort ` +
        `ging verloren: ${detail}`,
    );
    this.name = "AmbiguousControlCommitError";
    this.phase = phase;
    this.trustedAttestation = trustedAttestation;
  }
}

function fail(message: string): never {
  throw new Error(`Legacy-Cutover abgebrochen: ${message}`);
}

function assertSafeName(label: string, value: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 63) {
    fail(`${label} ist leer, enthält NUL oder überschreitet 63 UTF-8-Bytes.`);
  }
}

function assertUuid(label: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`${label} muss eine kanonische UUID sein.`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteQualified(schema: string, object: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(object)}`;
}

function roleSpecification(
  name: string | null,
  oid: number | string,
  label: string,
): string {
  if (Number(oid) === 0) return "PUBLIC";
  if (!name) fail(`${label} verweist auf eine nicht mehr auflösbare Rollen-OID ${oid}.`);
  return quoteIdentifier(name);
}

function checkedPrivilege(
  raw: string,
  allowed: ReadonlySet<string>,
  objectKind: string,
): string {
  if (!allowed.has(raw)) {
    fail(`Unerwartetes ${objectKind}-Privileg im Katalog: ${raw}.`);
  }
  return raw;
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...new Set(actual)].sort();
  const e = [...new Set(expected)].sort();
  return JSON.stringify(a) === JSON.stringify(e) && actual.length === a.length;
}

export function expectedClusterWideNoLoginRoles(legacyRole: string): readonly string[] {
  return [legacyRole, IDENTITY_RECONCILER];
}

function validateOptions(options: LegacyRoleCutoverOptions): void {
  assertSafeName("expectedDatabase", options.expectedDatabase);
  assertSafeName("expectedControlDatabase", options.expectedControlDatabase);
  assertSafeName("legacyRole", options.legacyRole);
  assertSafeName("expectedAdminRole", options.expectedAdminRole);
  assertSafeName(
    "expectedIdentityBootstrapGrantorRole",
    options.expectedIdentityBootstrapGrantorRole,
  );
  assertUuid("sample.workspaceId", options.sample.workspaceId);
  assertUuid("sample.userId", options.sample.userId);
  assertUuid("sample.pgBossJobId", options.sample.pgBossJobId);

  if (options.expectedControlDatabase === options.expectedDatabase) {
    fail("Control- und Zieldatenbank müssen verschieden sein.");
  }

  if (
    !Number.isInteger(options.expectedDatabaseConnectionLimit) ||
    options.expectedDatabaseConnectionLimit < -1 ||
    options.expectedDatabaseConnectionLimit === 0 ||
    options.expectedDatabaseConnectionLimit > 2_147_483_647
  ) {
    fail(
      "expectedDatabaseConnectionLimit muss -1 oder eine positive " +
        "PostgreSQL-int4-Ganzzahl sein; 0 ist für die Cutover-Quarantäne reserviert.",
    );
  }

  if (PROTECTED_ROLES.has(options.legacyRole)) {
    fail(`${options.legacyRole} ist eine geschützte Zielrolle und keine zulässige Legacy-Rolle.`);
  }
  if (options.expectedAdminRole === options.legacyRole) {
    fail("Admin- und Legacy-Rolle müssen verschieden sein.");
  }
  if (options.provisioningTopology) {
    try {
      validateDbRoleProvisioningTopology(options.provisioningTopology);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (
      options.provisioningTopology.bootstrapGrantorRole !==
      options.expectedIdentityBootstrapGrantorRole
    ) {
      fail(
        "Provider-Bootstrap-Grantor und historischer identity-Bootstrap-Grantor " +
          "müssen exakt übereinstimmen.",
      );
    }
    if (options.provisioningTopology.retainedLegacyRole !== options.legacyRole) {
      fail(
        "Der Legacy-Cutover im Provider-Modus verlangt DB_ROLE_RETAINED_LEGACY_ROLE " +
          "exakt gleich der bestätigten Legacy-Rolle.",
      );
    }
  }

  const expectedScope = expectedClusterWideNoLoginRoles(options.legacyRole);
  if (!sameStrings(options.confirmedClusterWideNoLoginRoles, expectedScope)) {
    fail(
      "confirmedClusterWideNoLoginRoles muss ohne Duplikate exakt " +
        `${expectedScope.join(",")} bestätigen. ALTER ROLE wirkt clusterweit.`,
    );
  }
}

async function assertAdminAndDatabase(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
  expectedDatabase = options.expectedDatabase,
): Promise<void> {
  const result = await client.query<IdentityRow>(`
    select pg_catalog.current_database() as database_name,
           current_user as current_role,
           session_user as session_role,
           pg_catalog.current_setting('server_version_num')::int as server_version_num,
           r.rolsuper,
           r.rolcreaterole
    from pg_catalog.pg_roles r
    where r.rolname = session_user
  `);
  const identity = result.rows[0];
  if (!identity) fail("Der verbundene Admin-Principal ist nicht in pg_roles sichtbar.");
  if (identity.server_version_num < 180_000 || identity.server_version_num >= 190_000) {
    fail("Der Legacy-Cutover ist ausschließlich für PostgreSQL 18.x freigegeben.");
  }
  if (identity.database_name !== expectedDatabase) {
    fail(
      `current_database()=${identity.database_name} stimmt nicht mit ` +
        `erwarteter Datenbank ${expectedDatabase} überein.`,
    );
  }
  if (
    identity.current_role !== options.expectedAdminRole ||
    identity.session_role !== options.expectedAdminRole
  ) {
    fail(
      `current_user/session_user müssen beide ${options.expectedAdminRole} sein; ` +
        `tatsächlich ${identity.current_role}/${identity.session_role}.`,
    );
  }
  if (!identity.rolsuper) {
    fail(
      "Der Legacy-Cutover verlangt vorerst einen echten SUPERUSER; " +
        `CREATEROLE allein reicht nicht (rolcreaterole=${identity.rolcreaterole}).`,
    );
  }
}

async function loadClusterAttestation(client: PoolClient): Promise<ClusterAttestationRow> {
  const result = await client.query<ClusterAttestationRow>(`
    select pg_catalog.current_database()::text as database_name,
           control.system_identifier::text as system_identifier,
           pg_catalog.host(pg_catalog.inet_server_addr())::text as server_address,
           pg_catalog.inet_server_port()::int as server_port
    from pg_catalog.pg_control_system() control
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row?.system_identifier ||
    !row.server_address ||
    !Number.isInteger(row.server_port) ||
    row.server_port <= 0
  ) {
    fail("Cluster-/Serverattestierung ist nicht eindeutig über eine direkte TCP-Verbindung lesbar.");
  }
  return row;
}

async function assertCutoverControlPlane(
  target: PoolClient,
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
): Promise<void> {
  await assertAdminAndDatabase(target, options, options.expectedDatabase);
  await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
  const [targetAttestation, controlAttestation] = await Promise.all([
    loadClusterAttestation(target),
    loadClusterAttestation(control),
  ]);
  if (
    targetAttestation.database_name !== options.expectedDatabase ||
    controlAttestation.database_name !== options.expectedControlDatabase ||
    targetAttestation.database_name === controlAttestation.database_name ||
    targetAttestation.system_identifier !== controlAttestation.system_identifier ||
    targetAttestation.server_address !== controlAttestation.server_address ||
    targetAttestation.server_port !== controlAttestation.server_port
  ) {
    fail(
      "Target/Control attestieren nicht zwei verschiedene Datenbanken desselben " +
        "PG18-Clusters und derselben tatsächlichen Serveradresse/-port.",
    );
  }
}

function assertSameControlAttestation(
  actual: ClusterAttestationRow,
  expected: ClusterAttestationRow,
  options: LegacyRoleCutoverOptions,
): void {
  if (
    actual.database_name !== options.expectedControlDatabase ||
    actual.database_name !== expected.database_name ||
    actual.system_identifier !== expected.system_identifier ||
    actual.server_address !== expected.server_address ||
    actual.server_port !== expected.server_port
  ) {
    fail(
      "Die frische Control-Verbindung attestiert nicht exakt dieselbe " +
        "Control-Datenbank, Cluster-ID und tatsächliche Serveradresse/-port.",
    );
  }
}

async function loadDatabaseState(
  client: PoolClient,
  expectedDatabase: string,
): Promise<DatabaseStateRow> {
  const result = await client.query<DatabaseStateRow>(`
    select datname::text as database_name, datallowconn, datconnlimit
    from pg_catalog.pg_database
    where datname = $1
  `, [expectedDatabase]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.database_name !== expectedDatabase ||
    typeof row.datallowconn !== "boolean" ||
    !Number.isInteger(row.datconnlimit)
  ) {
    fail(`Datenbankzustand von ${expectedDatabase} ist nicht eindeutig lesbar.`);
  }
  return row;
}

async function assertDatabaseState(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
  expectedAllowConnections: boolean,
  expectedConnectionLimit: number,
  phase: string,
): Promise<void> {
  const state = await loadDatabaseState(client, options.expectedDatabase);
  if (
    state.datallowconn !== expectedAllowConnections ||
    state.datconnlimit !== expectedConnectionLimit
  ) {
    fail(
      `${phase}: ${options.expectedDatabase} muss ALLOW_CONNECTIONS=` +
        `${expectedAllowConnections} und CONNECTION LIMIT ${expectedConnectionLimit} sein; ` +
        `ist ${state.datallowconn}/${state.datconnlimit}.`,
    );
  }
}

async function loadDatabaseConnectionLimit(
  client: PoolClient,
  expectedDatabase: string,
): Promise<number> {
  return (await loadDatabaseState(client, expectedDatabase)).datconnlimit;
}

async function assertDatabaseConnectionLimit(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
  expected: number,
  phase: string,
): Promise<void> {
  const actual = await loadDatabaseConnectionLimit(client, options.expectedDatabase);
  if (actual !== expected) {
    fail(
      `${phase}: CONNECTION LIMIT der Zieldatenbank muss exakt ${expected} sein; ist ${actual}.`,
    );
  }
}

async function setDatabaseConnectionLimit(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
  limit: number,
): Promise<void> {
  await client.query(
    `alter database ${quoteIdentifier(options.expectedDatabase)} connection limit ${limit}`,
  );
  await assertDatabaseConnectionLimit(client, options, limit, "CONNECTION-LIMIT-Mutation");
}

async function loadRequiredRoles(
  client: PoolClient,
  legacyRole: string,
): Promise<Map<string, RoleRow>> {
  const required = [legacyRole, ...PROTECTED_ROLES];
  const result = await client.query<RoleRow>(`
    select oid,
           rolname,
           rolcanlogin,
           rolinherit,
           rolsuper,
           rolbypassrls,
           rolcreatedb,
           rolcreaterole,
           rolreplication,
           rolconnlimit
    from pg_catalog.pg_roles
    where rolname = any($1::text[])
  `, [required]);
  const roles = new Map(result.rows.map((row) => [row.rolname, row]));
  const missing = required.filter((name) => !roles.has(name));
  if (missing.length > 0) fail(`Erforderliche Rollen fehlen: ${missing.join(", ")}.`);
  return roles;
}

function assertLegacyRolesQuarantined(roles: Map<string, RoleRow>, legacyRole: string): void {
  const legacy = roles.get(legacyRole)!;
  if (legacy.rolcanlogin || legacy.rolconnlimit !== 0) {
    fail(
      `${legacyRole} muss vor dem atomaren Cutover bereits sichtbar ` +
        "NOLOGIN und CONNECTION LIMIT 0 sein.",
    );
  }
  const reconciler = roles.get(IDENTITY_RECONCILER)!;
  if (reconciler.rolcanlogin || reconciler.rolconnlimit !== -1) {
    fail(
      `${IDENTITY_RECONCILER} muss vor dem atomaren Cutover bereits sichtbar ` +
        "NOLOGIN und mit dem App-Rollen-CONNECTION-LIMIT -1 gehärtet sein.",
    );
  }
}

function hasElevatedAttributes(role: RoleRow): boolean {
  return (
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication
  );
}

function assertTargetRolePreconditions(roles: Map<string, RoleRow>, legacyRole: string): void {
  const reconciler = roles.get(IDENTITY_RECONCILER)!;
  const legacy = roles.get(legacyRole)!;
  const loginRoles = new Set([
    "app_migrator",
    "app_runtime",
    "app_system",
    "app_auth",
    APP_WORKER,
  ]);
  for (const roleName of PROTECTED_ROLES) {
    const role = roles.get(roleName)!;
    if (role.rolcanlogin !== loginRoles.has(roleName)) {
      fail(`${roleName} besitzt vor dem Cutover ein unerwartetes LOGIN-Attribut.`);
    }
    if (
      roleName !== IDENTITY_RECONCILER &&
      (role.rolinherit || hasElevatedAttributes(role))
    ) {
      fail(`${roleName} muss vor dem Cutover NOINHERIT und unprivilegiert sein.`);
    }
  }
  if (
    reconciler.rolcanlogin ||
    reconciler.rolsuper ||
    reconciler.rolbypassrls ||
    reconciler.rolcreatedb ||
    reconciler.rolcreaterole ||
    reconciler.rolreplication
  ) {
    fail("identity_reconciler besitzt vor dem Cutover unerwartete Login-/Elevated-Rechte.");
  }
  if (legacy.rolsuper || legacy.rolbypassrls || legacy.rolreplication) {
    fail("Die Legacy-Rolle ist SUPERUSER/BYPASSRLS/REPLICATION; das braucht separate Remediation.");
  }
}

async function assertNoOtherClusterScope(
  client: PoolClient,
  expectedDatabase: string,
  legacyRole: string,
): Promise<void> {
  const otherDatabaseAcls = await client.query<{
    datname: string;
    privilege_type: string;
    endpoint: string;
  }>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    )
    select d.datname,
           acl.privilege_type,
           case when acl.grantee = legacy.oid then 'grantee' else 'grantor' end as endpoint
    from pg_catalog.pg_database d
    cross join legacy
    cross join lateral pg_catalog.aclexplode(d.datacl) acl
    where d.datname <> $2
      and (acl.grantee = legacy.oid or acl.grantor = legacy.oid)
    order by d.datname, acl.privilege_type, endpoint
  `, [legacyRole, expectedDatabase]);
  if (otherDatabaseAcls.rowCount !== 0) {
    fail(
      "Die Legacy-Rolle besitzt ACL-Kanten an anderen Datenbanken: " +
        `${otherDatabaseAcls.rows.map((row) => `${row.datname}:${row.privilege_type}:${row.endpoint}`).join(", ")}.`,
    );
  }

  // pg_shdepend ist die clusterweite, datenbankübergreifende Restmengenkontrolle.
  // So bleiben auch Owner-, Policy-, Default-ACL- oder Grant-Abhängigkeiten in
  // einer anderen DB nicht unsichtbar, nur weil deren Katalog hier nicht direkt
  // abgefragt werden kann.
  const otherDatabaseDependencies = await client.query<{
    datname: string;
    catalog_name: string;
    object_oid: string;
    dependency_type: string;
  }>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    ), target as (
      select oid from pg_catalog.pg_database where datname = $2
    )
    select coalesce(d.datname, 'database_oid=' || dependency.dbid::text) as datname,
           dependency.classid::pg_catalog.regclass::text as catalog_name,
           dependency.objid::text as object_oid,
           dependency.deptype::text as dependency_type
    from pg_catalog.pg_shdepend dependency
    cross join legacy
    cross join target
    left join pg_catalog.pg_database d on d.oid = dependency.dbid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = legacy.oid
      and dependency.dbid <> 0
      and dependency.dbid <> target.oid
    order by datname, catalog_name, object_oid, dependency_type
  `, [legacyRole, expectedDatabase]);
  if (otherDatabaseDependencies.rowCount !== 0) {
    fail(
      "Die Legacy-Rolle besitzt Objekt-Abhängigkeiten in anderen Datenbanken: " +
        otherDatabaseDependencies.rows
          .slice(0, 12)
          .map((row) =>
            `${row.datname}:${row.catalog_name}:${row.object_oid}:${row.dependency_type}`,
          )
          .join(", ") + ".",
    );
  }

  const otherDatabases = await client.query<{ datname: string }>(`
    select d.datname
    from pg_catalog.pg_database d
    join pg_catalog.pg_roles owner on owner.oid = d.datdba
    where owner.rolname = $1
      and d.datname <> $2
    order by d.datname
  `, [legacyRole, expectedDatabase]);
  if (otherDatabases.rowCount !== 0) {
    fail(
      "Die Legacy-Rolle besitzt weitere Datenbanken außerhalb des bestätigten Ziels: " +
        `${otherDatabases.rows.map((row) => row.datname).join(", ")}.`,
    );
  }

  const tablespaces = await client.query<{ spcname: string }>(`
    select t.spcname
    from pg_catalog.pg_tablespace t
    join pg_catalog.pg_roles owner on owner.oid = t.spcowner
    where owner.rolname = $1
    order by t.spcname
  `, [legacyRole]);
  if (tablespaces.rowCount !== 0) {
    fail(
      "Die Legacy-Rolle besitzt clusterweite Tablespaces: " +
        `${tablespaces.rows.map((row) => row.spcname).join(", ")}.`,
    );
  }
}

async function assertNoActiveRoleSessions(
  client: PoolClient,
  roleNames: readonly string[],
): Promise<void> {
  // Statistikkataloge können innerhalb derselben SERIALIZABLE-Transaktion
  // gecacht sein. Ohne Clear würde ein zweiter Pre-COMMIT-Check eine erst nach
  // dem Preflight gestartete Legacy-Session unter Umständen nicht sehen.
  await client.query("select pg_catalog.pg_stat_clear_snapshot()");
  const sessions = await client.query<{ rolname: string; n: number }>(`
    select requested.rolname, count(activity.pid)::int as n
    from pg_catalog.unnest($1::text[]) as requested(rolname)
    left join pg_catalog.pg_stat_activity activity
      on activity.usename = requested.rolname
     and activity.pid <> pg_catalog.pg_backend_pid()
    group by requested.rolname
    having count(activity.pid) <> 0
    order by requested.rolname
  `, [roleNames]);
  if (sessions.rowCount !== 0) {
    fail(
      "Zu härtende Rollen haben noch aktive Sessions: " +
        `${sessions.rows.map((row) => `${row.rolname}=${row.n}`).join(", ")}.`,
    );
  }

  const prepared = await client.query<{ owner: string; n: number }>(`
    select owner, count(*)::int as n
    from pg_catalog.pg_prepared_xacts
    where owner = any($1::text[])
    group by owner
    order by owner
  `, [roleNames]);
  if (prepared.rowCount !== 0) {
    fail(
      "Zu härtende Rollen besitzen noch vorbereitete Transaktionen: " +
        `${prepared.rows.map((row) => `${row.owner}=${row.n}`).join(", ")}.`,
    );
  }
}

async function assertExclusiveTargetDatabaseSession(client: PoolClient): Promise<void> {
  await client.query("select pg_catalog.pg_stat_clear_snapshot()");
  const sessions = await client.query<{ rolname: string; n: number }>(`
    select activity.usename::text as rolname, count(*)::int as n
    from pg_catalog.pg_stat_activity activity
    where activity.datname = pg_catalog.current_database()
      and activity.pid <> pg_catalog.pg_backend_pid()
    group by activity.usename
    order by activity.usename
  `);
  if (sessions.rowCount !== 0) {
    fail(
      "Die Zieldatenbank ist nicht exklusiv für den Cutover gedraint; aktive Sessions: " +
        `${sessions.rows.map((row) => `${row.rolname}=${row.n}`).join(", ")}.`,
    );
  }

  const prepared = await client.query<{ owner: string; n: number }>(`
    select owner::text, count(*)::int as n
    from pg_catalog.pg_prepared_xacts
    where database = pg_catalog.current_database()
    group by owner
    order by owner
  `);
  if (prepared.rowCount !== 0) {
    fail(
      "Die Zieldatenbank besitzt noch vorbereitete Transaktionen: " +
        `${prepared.rows.map((row) => `${row.owner}=${row.n}`).join(", ")}.`,
    );
  }
}

async function lockTargetDataRelations(client: PoolClient): Promise<void> {
  const relations = await client.query<{ schema_name: string; relation_name: string }>(`
    select namespace.nspname::text as schema_name,
           relation.relname::text as relation_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  `, [TARGET_SCHEMAS]);
  if (relations.rowCount === 0) fail("Keine Zielrelationen für den Cutover-Lock gefunden.");
  const targets = relations.rows
    .map((row) => quoteQualified(row.schema_name, row.relation_name))
    .join(", ");
  await client.query(`lock table ${targets} in access exclusive mode`);
}

async function assertNoLegacyTablespaceAcls(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const result = await client.query<CountRow>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    )
    select count(*)::int as n
    from pg_catalog.pg_tablespace tablespace
    cross join legacy
    cross join lateral pg_catalog.aclexplode(tablespace.spcacl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid
  `, [legacyRole]);
  if (result.rows[0]?.n !== 0) {
    fail("Die Legacy-Rolle besitzt clusterweite Tablespace-ACL-Kanten.");
  }
}

async function assertSupportedOwnershipScope(client: PoolClient, legacyRole: string): Promise<void> {
  const unsupported = await client.query<{ object_kind: string; object_name: string }>(`
    select 'schema'::text as object_kind,
           pg_catalog.quote_ident(n.nspname) as object_name
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
    where owner.rolname = $1
      and n.nspname <> all($2::text[])

    union all

    select 'relation',
           pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    where owner.rolname = $1
      and n.nspname <> all($2::text[])
      and n.nspname !~ '^pg_(catalog|toast|temp_)'
      and n.nspname <> 'information_schema'

    union all

    select 'routine',
           pg_catalog.quote_ident(n.nspname) || '.' ||
             pg_catalog.quote_ident(p.proname) || '(' ||
             pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where owner.rolname = $1
      and n.nspname <> all($2::text[])
      and n.nspname !~ '^pg_(catalog|toast|temp_)'
      and n.nspname <> 'information_schema'

    union all

    select 'unsupported-routine-kind:' || p.prokind::text,
           pg_catalog.quote_ident(n.nspname) || '.' ||
             pg_catalog.quote_ident(p.proname) || '(' ||
             pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where owner.rolname = $1
      and n.nspname = any($2::text[])
      and p.prokind not in ('f', 'p')

    union all

    select 'type',
           pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(t.typname)
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = t.typowner
    where owner.rolname = $1
      and n.nspname <> all($2::text[])
      and n.nspname !~ '^pg_(catalog|toast|temp_)'
      and n.nspname <> 'information_schema'
    order by 1, 2
  `, [legacyRole, TARGET_SCHEMAS]);
  if (unsupported.rowCount !== 0) {
    const sample = unsupported.rows
      .slice(0, 10)
      .map((row) => `${row.object_kind}:${row.object_name}`)
      .join(", ");
    fail(`Legacy-Ownership liegt außerhalb public/drizzle/pgboss: ${sample}.`);
  }
}

async function assertNoUnsupportedRoleBoundObjects(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const unsupported = await client.query<{ object_kind: string; object_name: string }>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    )
    select 'extension'::text as object_kind,
           extension_row.extname::text as object_name
    from pg_catalog.pg_extension extension_row
    cross join legacy
    where extension_row.extowner = legacy.oid

    union all
    select 'foreign-data-wrapper', wrapper_row.fdwname
    from pg_catalog.pg_foreign_data_wrapper wrapper_row
    cross join legacy
    where wrapper_row.fdwowner = legacy.oid

    union all
    select 'foreign-server', server_row.srvname
    from pg_catalog.pg_foreign_server server_row
    cross join legacy
    where server_row.srvowner = legacy.oid

    union all
    select 'language', language_row.lanname
    from pg_catalog.pg_language language_row
    cross join legacy
    where language_row.lanowner = legacy.oid

    union all
    select 'large-object', large_object_row.oid::text
    from pg_catalog.pg_largeobject_metadata large_object_row
    cross join legacy
    where large_object_row.lomowner = legacy.oid

    union all
    select 'collation', namespace_row.nspname || '.' || collation_row.collname
    from pg_catalog.pg_collation collation_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = collation_row.collnamespace
    cross join legacy
    where collation_row.collowner = legacy.oid

    union all
    select 'conversion', namespace_row.nspname || '.' || conversion_row.conname
    from pg_catalog.pg_conversion conversion_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = conversion_row.connamespace
    cross join legacy
    where conversion_row.conowner = legacy.oid

    union all
    select 'operator', namespace_row.nspname || '.' || operator_row.oprname || ':' || operator_row.oid::text
    from pg_catalog.pg_operator operator_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = operator_row.oprnamespace
    cross join legacy
    where operator_row.oprowner = legacy.oid

    union all
    select 'operator-class', namespace_row.nspname || '.' || class_row.opcname
    from pg_catalog.pg_opclass class_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.opcnamespace
    cross join legacy
    where class_row.opcowner = legacy.oid

    union all
    select 'operator-family', namespace_row.nspname || '.' || family_row.opfname
    from pg_catalog.pg_opfamily family_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = family_row.opfnamespace
    cross join legacy
    where family_row.opfowner = legacy.oid

    union all
    select 'text-search-dictionary', namespace_row.nspname || '.' || dictionary_row.dictname
    from pg_catalog.pg_ts_dict dictionary_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = dictionary_row.dictnamespace
    cross join legacy
    where dictionary_row.dictowner = legacy.oid

    union all
    select 'text-search-configuration', namespace_row.nspname || '.' || configuration_row.cfgname
    from pg_catalog.pg_ts_config configuration_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = configuration_row.cfgnamespace
    cross join legacy
    where configuration_row.cfgowner = legacy.oid

    union all
    select 'extended-statistics', namespace_row.nspname || '.' || statistics_row.stxname
    from pg_catalog.pg_statistic_ext statistics_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = statistics_row.stxnamespace
    cross join legacy
    where statistics_row.stxowner = legacy.oid

    union all
    select 'publication', publication_row.pubname
    from pg_catalog.pg_publication publication_row
    cross join legacy
    where publication_row.pubowner = legacy.oid

    union all
    select 'subscription', subscription_row.subname
    from pg_catalog.pg_subscription subscription_row
    cross join legacy
    where subscription_row.subowner = legacy.oid

    union all
    select 'event-trigger', trigger_row.evtname
    from pg_catalog.pg_event_trigger trigger_row
    cross join legacy
    where trigger_row.evtowner = legacy.oid

    union all
    select 'row-security-policy',
           namespace_row.nspname || '.' || relation_row.relname || ':' || policy_row.polname
    from pg_catalog.pg_policy policy_row
    join pg_catalog.pg_class relation_row on relation_row.oid = policy_row.polrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
    cross join legacy
    where legacy.oid = any(policy_row.polroles)

    union all
    select 'user-mapping', server_row.srvname || ':' || mapping_row.oid::text
    from pg_catalog.pg_user_mapping mapping_row
    join pg_catalog.pg_foreign_server server_row on server_row.oid = mapping_row.umserver
    cross join legacy
    where mapping_row.umuser = legacy.oid

    union all
    select 'unsupported-routine-acl',
           namespace_row.nspname || '.' || routine_row.proname || ':' || routine_row.prokind::text
    from pg_catalog.pg_proc routine_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = routine_row.pronamespace
    cross join legacy
    cross join lateral pg_catalog.aclexplode(routine_row.proacl) acl
    where routine_row.prokind not in ('f', 'p')
      and (acl.grantee = legacy.oid or acl.grantor = legacy.oid)

    union all
    select 'language-acl', language_row.lanname
    from pg_catalog.pg_language language_row
    cross join legacy
    cross join lateral pg_catalog.aclexplode(language_row.lanacl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid

    union all
    select 'large-object-acl', large_object_row.oid::text
    from pg_catalog.pg_largeobject_metadata large_object_row
    cross join legacy
    cross join lateral pg_catalog.aclexplode(large_object_row.lomacl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid

    union all
    select 'foreign-data-wrapper-acl', wrapper_row.fdwname
    from pg_catalog.pg_foreign_data_wrapper wrapper_row
    cross join legacy
    cross join lateral pg_catalog.aclexplode(wrapper_row.fdwacl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid

    union all
    select 'foreign-server-acl', server_row.srvname
    from pg_catalog.pg_foreign_server server_row
    cross join legacy
    cross join lateral pg_catalog.aclexplode(server_row.srvacl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid

    union all
    select 'parameter-acl', parameter_row.parname
    from pg_catalog.pg_parameter_acl parameter_row
    cross join legacy
    cross join lateral pg_catalog.aclexplode(parameter_row.paracl) acl
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid

    order by 1, 2
  `, [legacyRole]);

  if (unsupported.rowCount !== 0) {
    fail(
      "Die Legacy-Rolle ist an nicht atomar unterstützte Objekte gebunden: " +
        unsupported.rows
          .slice(0, 16)
          .map((row) => `${row.object_kind}:${row.object_name}`)
          .join(", ") + ".",
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const LIVE_0018_CORE_STRUCTURE_SHA256 =
  "83b100e545387d2e749cae2bf8081053cc5c85629f7c8ef2741dceba57cc4796";

/**
 * Journalhashes belegen nur, welche SQL-Dateien einmal liefen. Dieser zweite
 * Vertrag attestiert den tatsächlich wirksamen Katalog von public/drizzle:
 * Owner, physische Relationseigenschaften, Spalten/Defaults, Constraints,
 * Indizes, Sequenzen, Vererbung/Bounds und auch interne Constraint-Trigger.
 */
async function assertLegacyCoreStructure0018(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const schemas = ["public", "drizzle"];
  const signatures: string[] = [];
  const collect = (kind: string, rows: readonly QueryResultRow[]): void => {
    for (const row of rows) signatures.push(`${kind}:${JSON.stringify(row)}`);
  };

  const relations = await client.query(`
    select namespace.nspname::text as schema_name,
           relation.relname::text,
           relation.relkind::text,
           (owner.rolname = $2)::boolean as owned_by_legacy,
           relation.relnatts,
           relation.relpersistence::text,
           relation.relispartition,
           relation.relrowsecurity,
           relation.relforcerowsecurity,
           relation.relreplident::text,
           coalesce(access_method.amname, '-')::text as access_method,
           coalesce(tablespace.spcname, 'pg_default')::text as tablespace,
           coalesce((
             select pg_catalog.array_agg(option order by option)
             from pg_catalog.unnest(relation.reloptions) option
           ), '{}'::text[])::text as reloptions,
           coalesce(pg_catalog.pg_get_partkeydef(relation.oid), '-')::text as partition_key,
           coalesce(pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, false), '-')::text
             as partition_bound
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = relation.relowner
    left join pg_catalog.pg_am access_method on access_method.oid = relation.relam
    left join pg_catalog.pg_tablespace tablespace on tablespace.oid = relation.reltablespace
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
    order by namespace.nspname, relation.relname, relation.relkind
  `, [schemas, legacyRole]);
  collect("relation", relations.rows);

  const columns = await client.query(`
    select namespace.nspname::text as schema_name,
           relation.relname::text,
           attribute.attnum,
           attribute.attname::text,
           attribute.attisdropped,
           type_namespace.nspname::text as type_schema,
           type.typname::text as type_name,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)::text as formatted_type,
           attribute.attndims,
           attribute.attnotnull,
           attribute.atthasdef,
           attribute.atthasmissing,
           attribute.attidentity::text,
           attribute.attgenerated::text,
           attribute.attinhcount,
           attribute.attislocal,
           attribute.attstorage::text,
           attribute.attcompression::text,
           attribute.attstattarget,
           coalesce(collation_namespace.nspname || '.' || collation_row.collname, '-')::text
             as collation,
           coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false), '-')::text
             as default_expression,
           coalesce(attribute.attmissingval::text, '-')::text as missing_value,
           coalesce((
             select pg_catalog.array_agg(option order by option)
             from pg_catalog.unnest(attribute.attoptions) option
           ), '{}'::text[])::text as options,
           coalesce((
             select pg_catalog.array_agg(option order by option)
             from pg_catalog.unnest(attribute.attfdwoptions) option
           ), '{}'::text[])::text as fdw_options
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_type type on type.oid = attribute.atttypid
    join pg_catalog.pg_namespace type_namespace on type_namespace.oid = type.typnamespace
    left join pg_catalog.pg_attrdef default_value
      on default_value.adrelid = attribute.attrelid
     and default_value.adnum = attribute.attnum
    left join pg_catalog.pg_collation collation_row
      on collation_row.oid = attribute.attcollation
    left join pg_catalog.pg_namespace collation_namespace
      on collation_namespace.oid = collation_row.collnamespace
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and attribute.attnum > 0
    order by namespace.nspname, relation.relname, attribute.attnum
  `, [schemas]);
  collect("column", columns.rows);

  const constraints = await client.query(`
    select relation_namespace.nspname::text as schema_name,
           relation.relname::text,
           constraint_row.conname::text,
           constraint_row.contype::text,
           constraint_row.condeferrable,
           constraint_row.condeferred,
           constraint_row.convalidated,
           constraint_row.conenforced,
           constraint_row.connoinherit,
           constraint_row.conperiod,
           constraint_row.conislocal,
           constraint_row.coninhcount,
           coalesce(constraint_row.conkey::text, '-')::text as constrained_columns,
           coalesce(constraint_row.confkey::text, '-')::text as referenced_columns,
           constraint_row.confmatchtype::text,
           constraint_row.confupdtype::text,
           constraint_row.confdeltype::text,
           coalesce(constraint_row.confdelsetcols::text, '-')::text as delete_set_columns,
           coalesce(referenced_namespace.nspname || '.' || referenced.relname, '-')::text
             as referenced_relation,
           coalesce(parent_relation_namespace.nspname || '.' || parent_relation.relname || ':' ||
             parent_constraint.conname, '-')::text
             as parent_constraint,
           coalesce(index_namespace.nspname || '.' || supporting_index.relname, '-')::text
             as supporting_index,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, false)::text as definition
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid = relation.relnamespace
    left join pg_catalog.pg_class referenced on referenced.oid = constraint_row.confrelid
    left join pg_catalog.pg_namespace referenced_namespace
      on referenced_namespace.oid = referenced.relnamespace
    left join pg_catalog.pg_constraint parent_constraint
      on parent_constraint.oid = constraint_row.conparentid
    left join pg_catalog.pg_class parent_relation
      on parent_relation.oid = parent_constraint.conrelid
    left join pg_catalog.pg_namespace parent_relation_namespace
      on parent_relation_namespace.oid = parent_relation.relnamespace
    left join pg_catalog.pg_class supporting_index
      on supporting_index.oid = constraint_row.conindid
    left join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid = supporting_index.relnamespace
    where relation_namespace.nspname = any($1::text[])
    order by relation_namespace.nspname, relation.relname, constraint_row.conname
  `, [schemas]);
  collect("constraint", constraints.rows);

  const indexes = await client.query(`
    select table_namespace.nspname::text as schema_name,
           table_relation.relname::text as table_name,
           index_namespace.nspname::text as index_schema,
           index_relation.relname::text as index_name,
           (owner.rolname = $2)::boolean as owned_by_legacy,
           index_relation.relpersistence::text,
           access_method.amname::text as access_method,
           coalesce(tablespace.spcname, 'pg_default')::text as tablespace,
           coalesce((
             select pg_catalog.array_agg(option order by option)
             from pg_catalog.unnest(index_relation.reloptions) option
           ), '{}'::text[])::text as reloptions,
           index_row.indnatts,
           index_row.indnkeyatts,
           index_row.indisunique,
           index_row.indnullsnotdistinct,
           index_row.indisprimary,
           index_row.indisexclusion,
           index_row.indimmediate,
           index_row.indisclustered,
           index_row.indisvalid,
           index_row.indcheckxmin,
           index_row.indisready,
           index_row.indislive,
           index_row.indisreplident,
           index_row.indkey::text as attribute_numbers,
           coalesce(parent_index_namespace.nspname || '.' || parent_index.relname, '-')::text
             as parent_index,
           pg_catalog.pg_get_indexdef(index_relation.oid, 0, false)::text as definition,
           coalesce(pg_catalog.pg_get_expr(index_row.indexprs, index_row.indrelid, false), '-')::text
             as expressions,
           coalesce(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false), '-')::text
             as predicate
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class table_relation on table_relation.oid = index_row.indrelid
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_relation.relnamespace
    join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
    join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid = index_relation.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = index_relation.relowner
    join pg_catalog.pg_am access_method on access_method.oid = index_relation.relam
    left join pg_catalog.pg_tablespace tablespace on tablespace.oid = index_relation.reltablespace
    left join pg_catalog.pg_inherits index_inheritance
      on index_inheritance.inhrelid = index_relation.oid
    left join pg_catalog.pg_class parent_index
      on parent_index.oid = index_inheritance.inhparent
    left join pg_catalog.pg_namespace parent_index_namespace
      on parent_index_namespace.oid = parent_index.relnamespace
    where table_namespace.nspname = any($1::text[])
    order by table_namespace.nspname, table_relation.relname, index_relation.relname
  `, [schemas, legacyRole]);
  collect("index", indexes.rows);

  const sequences = await client.query(`
    select namespace.nspname::text as schema_name,
           relation.relname::text,
           pg_catalog.format_type(sequence.seqtypid, null)::text as data_type,
           sequence.seqstart::text,
           sequence.seqincrement::text,
           sequence.seqmax::text,
           sequence.seqmin::text,
           sequence.seqcache::text,
           sequence.seqcycle,
           coalesce(owned_namespace.nspname || '.' || owned_relation.relname || '.' ||
             owned_attribute.attname, '-')::text as owned_by
    from pg_catalog.pg_sequence sequence
    join pg_catalog.pg_class relation on relation.oid = sequence.seqrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_catalog.pg_depend dependency
      on dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     and dependency.objid = relation.oid
     and dependency.objsubid = 0
     and dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
     and dependency.deptype in ('a', 'i')
    left join pg_catalog.pg_class owned_relation on owned_relation.oid = dependency.refobjid
    left join pg_catalog.pg_namespace owned_namespace
      on owned_namespace.oid = owned_relation.relnamespace
    left join pg_catalog.pg_attribute owned_attribute
      on owned_attribute.attrelid = owned_relation.oid
     and owned_attribute.attnum = dependency.refobjsubid
    where namespace.nspname = any($1::text[])
    order by namespace.nspname, relation.relname
  `, [schemas]);
  collect("sequence", sequences.rows);

  const inheritance = await client.query(`
    select child_namespace.nspname::text as child_schema,
           child.relname::text as child_name,
           parent_namespace.nspname::text as parent_schema,
           parent.relname::text as parent_name,
           inheritance.inhseqno,
           inheritance.inhdetachpending,
           coalesce(pg_catalog.pg_get_expr(child.relpartbound, child.oid, false), '-')::text
             as partition_bound
    from pg_catalog.pg_inherits inheritance
    join pg_catalog.pg_class child on child.oid = inheritance.inhrelid
    join pg_catalog.pg_namespace child_namespace on child_namespace.oid = child.relnamespace
    join pg_catalog.pg_class parent on parent.oid = inheritance.inhparent
    join pg_catalog.pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
    where child_namespace.nspname = any($1::text[])
       or parent_namespace.nspname = any($1::text[])
    order by child_namespace.nspname, child.relname, inheritance.inhseqno
  `, [schemas]);
  collect("inheritance", inheritance.rows);

  const partitionedTables = await client.query(`
    select namespace.nspname::text as schema_name,
           relation.relname::text,
           partitioned.partstrat::text,
           partitioned.partnatts,
           partitioned.partattrs::text,
           pg_catalog.pg_get_partkeydef(relation.oid)::text as partition_key,
           coalesce(default_namespace.nspname || '.' || default_partition.relname, '-')::text
             as default_partition
    from pg_catalog.pg_partitioned_table partitioned
    join pg_catalog.pg_class relation on relation.oid = partitioned.partrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_catalog.pg_class default_partition on default_partition.oid = partitioned.partdefid
    left join pg_catalog.pg_namespace default_namespace
      on default_namespace.oid = default_partition.relnamespace
    where namespace.nspname = any($1::text[])
    order by namespace.nspname, relation.relname
  `, [schemas]);
  collect("partitioned-table", partitionedTables.rows);

  const triggers = await client.query(`
    select relation_namespace.nspname::text as schema_name,
           relation.relname::text,
           case when trigger.tgisinternal then '-' else trigger.tgname end::text as trigger_name,
           trigger.tgisinternal,
           trigger.tgtype,
           trigger.tgenabled::text,
           trigger.tgdeferrable,
           trigger.tginitdeferred,
           trigger.tgattr::text as columns,
           pg_catalog.encode(trigger.tgargs, 'hex')::text as arguments,
           coalesce(pg_catalog.pg_get_expr(trigger.tgqual, trigger.tgrelid, false), '-')::text
             as when_expression,
           coalesce(trigger.tgoldtable, '-')::text as old_transition_table,
           coalesce(trigger.tgnewtable, '-')::text as new_transition_table,
           function_namespace.nspname::text as function_schema,
           function.proname::text as function_name,
           pg_catalog.pg_get_function_identity_arguments(function.oid)::text as function_arguments,
           coalesce(constraint_row.conname, '-')::text as constraint_name,
           coalesce(constraint_row.contype::text, '-')::text as constraint_type,
           coalesce(referenced_namespace.nspname || '.' || referenced.relname, '-')::text
             as referenced_relation,
           coalesce(parent_relation_namespace.nspname || '.' || parent_relation.relname || ':' ||
             parent_function_namespace.nspname || '.' || parent_function.proname || ':' ||
             parent_trigger.tgtype::text, '-')::text as parent_trigger
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.oid = relation.relnamespace
    join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid = function.pronamespace
    left join pg_catalog.pg_constraint constraint_row on constraint_row.oid = trigger.tgconstraint
    left join pg_catalog.pg_class referenced on referenced.oid = trigger.tgconstrrelid
    left join pg_catalog.pg_namespace referenced_namespace
      on referenced_namespace.oid = referenced.relnamespace
    left join pg_catalog.pg_trigger parent_trigger on parent_trigger.oid = trigger.tgparentid
    left join pg_catalog.pg_class parent_relation on parent_relation.oid = parent_trigger.tgrelid
    left join pg_catalog.pg_namespace parent_relation_namespace
      on parent_relation_namespace.oid = parent_relation.relnamespace
    left join pg_catalog.pg_proc parent_function on parent_function.oid = parent_trigger.tgfoid
    left join pg_catalog.pg_namespace parent_function_namespace
      on parent_function_namespace.oid = parent_function.pronamespace
    where relation_namespace.nspname = any($1::text[])
    order by relation_namespace.nspname, relation.relname, trigger.tgisinternal,
             constraint_row.conname, function.proname, trigger.tgtype, trigger.tgname
  `, [schemas]);
  collect("trigger", triggers.rows);

  signatures.sort();
  const actualHash = sha256(signatures.join("\n"));
  if (actualHash !== LIVE_0018_CORE_STRUCTURE_SHA256) {
    fail(
      "Live-0018-Kernstruktur weicht vor der Quarantäne ab. " +
        `Erwarteter SHA-256 ${LIVE_0018_CORE_STRUCTURE_SHA256}, ` +
        `tatsächlich ${actualHash} (${signatures.length} Katalogzeilen).`,
    );
  }
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface PgBossConstraintSignatureOptions {
  deferrable?: boolean;
  deferred?: boolean;
  validated?: boolean;
  enforced?: boolean;
  noInherit?: boolean;
  isLocal?: boolean;
  inheritCount?: number;
  period?: boolean;
  updateAction?: string;
  deleteAction?: string;
  matchType?: string;
  parent?: string;
}

function pgBossConstraintSignature(
  table: string,
  name: string,
  type: "c" | "f" | "p",
  definition: string,
  options: PgBossConstraintSignatureOptions = {},
): string {
  const foreignActions = type === "f"
    ? [
        options.updateAction ?? "a",
        options.deleteAction ?? "a",
        options.matchType ?? "s",
      ].join("/")
    : "-";
  return [
    table,
    name,
    type,
    [
      options.deferrable ?? false,
      options.deferred ?? false,
      options.validated ?? true,
      options.enforced ?? true,
      options.noInherit ?? type !== "c",
      options.isLocal ?? true,
      options.inheritCount ?? 0,
      options.period ?? false,
    ].join("/"),
    foreignActions,
    options.parent ?? "-",
    definition,
  ].join(":");
}

async function assertPgBossConstraintContract0018(
  client: PoolClient,
  queues: ReadonlyArray<{
    name: string;
    policy: string;
    partition: boolean;
    table_name: string;
  }>,
  queueStatsTables: readonly string[],
): Promise<void> {
  const live = await client.query<{ signature: string }>(`
    select relation.relname::text || ':' ||
           constraint_row.conname::text || ':' ||
           constraint_row.contype::text || ':' ||
           constraint_row.condeferrable::text || '/' ||
           constraint_row.condeferred::text || '/' ||
           constraint_row.convalidated::text || '/' ||
           constraint_row.conenforced::text || '/' ||
           constraint_row.connoinherit::text || '/' ||
           constraint_row.conislocal::text || '/' ||
           constraint_row.coninhcount::text || '/' ||
           constraint_row.conperiod::text || ':' ||
           case when constraint_row.contype = 'f'
             then constraint_row.confupdtype::text || '/' ||
                  constraint_row.confdeltype::text || '/' ||
                  constraint_row.confmatchtype::text
             else '-'
           end || ':' ||
           coalesce(
             parent_relation.relname::text || ':' || parent_constraint.conname::text,
             '-'
           ) || ':' ||
           pg_catalog.pg_get_constraintdef(constraint_row.oid, false)::text as signature
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_catalog.pg_constraint parent_constraint
      on parent_constraint.oid = constraint_row.conparentid
    left join pg_catalog.pg_class parent_relation
      on parent_relation.oid = parent_constraint.conrelid
    where namespace.nspname = 'pgboss'
      and constraint_row.contype <> 'n'
    order by relation.relname, constraint_row.conname
  `);

  const expected = [
    pgBossConstraintSignature("bam", "bam_pkey", "p", "PRIMARY KEY (id)"),
    pgBossConstraintSignature(
      "job_dependency",
      "job_dependency_pkey",
      "p",
      "PRIMARY KEY (child_name, child_id, parent_name, parent_id)",
    ),
    pgBossConstraintSignature(
      "queue_stats",
      "queue_stats_pkey",
      "p",
      "PRIMARY KEY (id, captured_on)",
    ),
    pgBossConstraintSignature(
      "queue",
      "queue_check",
      "c",
      "CHECK ((dead_letter IS DISTINCT FROM name))",
    ),
    pgBossConstraintSignature(
      "queue",
      "queue_dead_letter_fkey",
      "f",
      "FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name)",
    ),
    pgBossConstraintSignature("queue", "queue_pkey", "p", "PRIMARY KEY (name)"),
    pgBossConstraintSignature(
      "schedule",
      "schedule_name_fkey",
      "f",
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      { deleteAction: "c" },
    ),
    pgBossConstraintSignature(
      "schedule",
      "schedule_pkey",
      "p",
      "PRIMARY KEY (name, key)",
    ),
    pgBossConstraintSignature(
      "subscription",
      "subscription_name_fkey",
      "f",
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      { deleteAction: "c" },
    ),
    pgBossConstraintSignature(
      "subscription",
      "subscription_pkey",
      "p",
      "PRIMARY KEY (event, name)",
    ),
    pgBossConstraintSignature("version", "version_pkey", "p", "PRIMARY KEY (version)"),
    pgBossConstraintSignature("warning", "warning_pkey", "p", "PRIMARY KEY (id)"),
    pgBossConstraintSignature("job", "job_pkey", "p", "PRIMARY KEY (name, id)"),
    pgBossConstraintSignature(
      "job_common",
      "job_common_pkey",
      "p",
      "PRIMARY KEY (name, id)",
      { isLocal: false, inheritCount: 1, parent: "job:job_pkey" },
    ),
    pgBossConstraintSignature(
      "job_common",
      "q_fkey",
      "f",
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) " +
        "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      { deferrable: true, deferred: true, deleteAction: "r" },
    ),
    pgBossConstraintSignature(
      "job_common",
      "dlq_fkey",
      "f",
      "FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) " +
        "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
      { deferrable: true, deferred: true, deleteAction: "r" },
    ),
    pgBossConstraintSignature(
      "job_common",
      "job_key_strict_fifo_singleton_key_check",
      "c",
      "CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))",
    ),
  ];

  for (const table of queueStatsTables) {
    expected.push(pgBossConstraintSignature(
      table,
      `${table}_pkey`,
      "p",
      "PRIMARY KEY (id, captured_on)",
      {
        noInherit: false,
        isLocal: false,
        inheritCount: 1,
        parent: "queue_stats:queue_stats_pkey",
      },
    ));
  }

  for (const queue of queues.filter((row) => row.partition)) {
    expected.push(
      pgBossConstraintSignature(
        queue.table_name,
        `${queue.table_name}_pkey`,
        "p",
        "PRIMARY KEY (name, id)",
        { isLocal: false, inheritCount: 1, parent: "job:job_pkey" },
      ),
      pgBossConstraintSignature(
        queue.table_name,
        "q_fkey",
        "f",
        "FOREIGN KEY (name) REFERENCES pgboss.queue(name) " +
          "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
        { deferrable: true, deferred: true, deleteAction: "r" },
      ),
      pgBossConstraintSignature(
        queue.table_name,
        "dlq_fkey",
        "f",
        "FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) " +
          "ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
        { deferrable: true, deferred: true, deleteAction: "r" },
      ),
      pgBossConstraintSignature(
        queue.table_name,
        "cjc",
        "c",
        `CHECK ((name = ${quoteSqlLiteral(queue.name)}::text))`,
      ),
    );
    if (queue.policy === "key_strict_fifo") {
      expected.push(pgBossConstraintSignature(
        queue.table_name,
        "job_key_strict_fifo_singleton_key_check",
        "c",
        "CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))",
      ));
    }
  }

  assertExactRows(
    live.rows.map((row) => row.signature),
    expected,
    "Live-0018-pg-boss-Constraintvertrag",
  );
}

async function assertPgBossStructure0018(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const version = await client.query<{ version: number }>(`
    select version::int from pgboss.version order by version
  `);
  if (version.rows.length !== 1 || version.rows[0]?.version !== 38) {
    fail(`Live-0018-pg-boss-Version muss exakt 38 sein; ist ${JSON.stringify(version.rows)}.`);
  }
  const incompleteBam = await client.query<{ n: number }>(`
    select count(*)::int as n from pgboss.bam where status <> 'completed'
  `);
  if (incompleteBam.rows[0]?.n !== 0) {
    fail("Live-0018-pg-boss besitzt unvollständige BAM-Strukturjobs.");
  }

  const queues = await client.query<{
    name: string;
    policy: string;
    partition: boolean;
    table_name: string;
  }>(`
    select name, policy, partition, table_name
    from pgboss.queue
    order by name
  `);
  const partitionMetadata: Array<{ table: string; policy: string }> = [];
  const seenPartitionTables = new Set<string>();
  for (const queue of queues.rows) {
    const expectedTable = queue.partition
      ? `j${createHash("sha224").update(queue.name).digest("hex")}`
      : "job_common";
    if (queue.table_name !== expectedTable) {
      fail(
        `pg-boss-Queue ${queue.name} verweist auf ${queue.table_name} statt ${expectedTable}.`,
      );
    }
    if (queue.partition) {
      if (seenPartitionTables.has(queue.table_name)) {
        fail(`Mehrere pg-boss-Queues teilen unerwartet Partition ${queue.table_name}.`);
      }
      seenPartitionTables.add(queue.table_name);
      partitionMetadata.push({ table: queue.table_name, policy: queue.policy });
    }
  }

  const tableRows = await client.query<{ table_name: string }>(`
    select relation.relname::text as table_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'pgboss'
      and relation.relkind in ('r', 'p')
    order by relation.relname
  `);
  const queueStatsTables = tableRows.rows
    .map((row) => row.table_name)
    .filter((name) => /^queue_stats_[0-9]{8}$/.test(name));
  const actualManagedTables = tableRows.rows
    .map((row) => row.table_name)
    .filter((name) => !/^queue_stats_[0-9]{8}$/.test(name));
  assertExactRows(
    actualManagedTables,
    expectedManagedTables("pgboss", true, partitionMetadata),
    "Live-0018-pg-boss-Tabellenvertrag",
  );

  const topology = await client.query<{
    child_name: string;
    parent_name: string;
    child_kind: string;
    owned_by_legacy: boolean;
    detach_pending: boolean;
    partition_bound: string;
  }>(`
    select child.relname::text as child_name,
           parent.relname::text as parent_name,
           child.relkind::text as child_kind,
           (owner.rolname = $1)::boolean as owned_by_legacy,
           inheritance.inhdetachpending as detach_pending,
           pg_catalog.pg_get_expr(child.relpartbound, child.oid, false)::text as partition_bound
    from pg_catalog.pg_inherits inheritance
    join pg_catalog.pg_class child on child.oid = inheritance.inhrelid
    join pg_catalog.pg_namespace child_namespace on child_namespace.oid = child.relnamespace
    join pg_catalog.pg_class parent on parent.oid = inheritance.inhparent
    join pg_catalog.pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = child.relowner
    where child_namespace.nspname = 'pgboss'
      and parent_namespace.nspname = 'pgboss'
      and child.relkind = 'r'
    order by child.relname
  `, [legacyRole]);
  const topologyByChild = new Map(topology.rows.map((row) => [row.child_name, row]));
  if (topologyByChild.size !== topology.rows.length) {
    fail("Eine pg-boss-Tabelle besitzt mehrere unerwartete direkte Partition-Parents.");
  }
  const common = topologyByChild.get("job_common");
  if (
    !common ||
    common.parent_name !== "job" ||
    common.partition_bound !== "DEFAULT" ||
    common.child_kind !== "r" ||
    !common.owned_by_legacy ||
    common.detach_pending
  ) {
    fail(`pg-boss job_common ist keine intakte DEFAULT-Partition: ${JSON.stringify(common)}.`);
  }

  for (const queue of queues.rows.filter((row) => row.partition)) {
    const child = topologyByChild.get(queue.table_name);
    const expectedBound = `FOR VALUES IN (${quoteSqlLiteral(queue.name)})`;
    if (
      !child ||
      child.parent_name !== "job" ||
      child.partition_bound !== expectedBound ||
      child.child_kind !== "r" ||
      !child.owned_by_legacy ||
      child.detach_pending
    ) {
      fail(
        `pg-boss-Queuepartition ${queue.table_name} weicht ab. ` +
          `Erwarteter Bound ${expectedBound}; ist ${JSON.stringify(child)}.`,
      );
    }
  }

  const utcToday = new Date();
  const requiredStatsDates = new Set<string>();
  for (const offset of [0, 1]) {
    const date = new Date(Date.UTC(
      utcToday.getUTCFullYear(),
      utcToday.getUTCMonth(),
      utcToday.getUTCDate() + offset,
    ));
    requiredStatsDates.add(date.toISOString().slice(0, 10).replaceAll("-", ""));
  }
  for (const name of queueStatsTables) {
    const child = topologyByChild.get(name);
    const match = child?.partition_bound.match(
      /^FOR VALUES FROM \('([0-9]{4}-[0-9]{2}-[0-9]{2}) 00:00:00\+00'\) TO \('([0-9]{4}-[0-9]{2}-[0-9]{2}) 00:00:00\+00'\)$/,
    );
    if (
      !child ||
      child.parent_name !== "queue_stats" ||
      child.child_kind !== "r" ||
      !child.owned_by_legacy ||
      child.detach_pending ||
      !match
    ) {
      fail(`pg-boss-Statistikpartition ${name} weicht ab: ${JSON.stringify(child)}.`);
    }
    const from = new Date(`${match[1]}T00:00:00.000Z`);
    const to = new Date(`${match[2]}T00:00:00.000Z`);
    if (
      name !== `queue_stats_${match[1].replaceAll("-", "")}` ||
      to.getTime() - from.getTime() !== 86_400_000
    ) {
      fail(`pg-boss-Statistikpartition ${name} besitzt keinen exakten UTC-Tagesbound.`);
    }
  }
  for (const date of requiredStatsDates) {
    if (!queueStatsTables.includes(`queue_stats_${date}`)) {
      fail(`pg-boss-Statistikpartition queue_stats_${date} fehlt.`);
    }
  }
  const expectedTopologyChildren = new Set([
    "job_common",
    ...partitionMetadata.map((row) => row.table),
    ...queueStatsTables,
  ]);
  const unexpectedTopology = [...topologyByChild.keys()].filter(
    (name) => !expectedTopologyChildren.has(name),
  );
  if (unexpectedTopology.length > 0) {
    fail(`Unerwartete pg-boss-Partitionen: ${unexpectedTopology.join(", ")}.`);
  }

  await assertPgBossConstraintContract0018(client, queues.rows, queueStatsTables);

  const liveIndexesResult = await client.query(getSchemaIndexes("pgboss"));
  const liveColumnsResult = await client.query(getSchemaColumns("pgboss"));
  const enumResult = await client.query(getEnumDefinition("pgboss"));
  const liveIndexes = liveIndexesResult.rows
    .filter((row) => !queueStatsTables.includes(String(row.table)))
    .map((row) => ({
      name: String(row.name),
      table: String(row.table),
      valid: Boolean(row.valid),
      def: row.def == null ? undefined : String(row.def),
      constraintBacked: Boolean(row.constraintBacked),
    }));
  const report = computeSchemaDrift({
    indexes: {
      expected: expectedManagedIndexes("pgboss", true, partitionMetadata),
      live: liveIndexes,
    },
    tables: {
      expected: expectedManagedTables("pgboss", true, partitionMetadata),
      live: actualManagedTables,
    },
    columns: {
      expected: expectedManagedColumns("pgboss", true, partitionMetadata),
      live: liveColumnsResult.rows.map((row) => ({
        table: String(row.table),
        column: String(row.column),
        default: row.default == null ? null : String(row.default),
        type: String(row.type),
        notNull: Boolean(row.notNull),
      })),
    },
    enum: {
      name: "job_state",
      expected: EXPECTED_JOB_STATES,
      actual: enumResult.rows.map((row) => String(row.label)),
    },
  });
  if (
    !report.ok ||
    report.extraIndexes.length > 0 ||
    report.building.length > 0
  ) {
    fail(`Live-0018-pg-boss-Manifest driftet: ${JSON.stringify(report)}.`);
  }

  const jobColumns = await client.query<{
    table_name: string;
    signature: string;
  }>(`
    select relation.relname::text as table_name,
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_array(
               attribute.attnum,
               attribute.attname,
               pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
               attribute.attnotnull,
               attribute.attidentity,
               attribute.attgenerated,
               coalesce(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false), '-')
             ) order by attribute.attnum
           )::text as signature
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
    left join pg_catalog.pg_attrdef default_value
      on default_value.adrelid = attribute.attrelid
     and default_value.adnum = attribute.attnum
    where namespace.nspname = 'pgboss'
      and relation.relname = any($1::text[])
      and attribute.attnum > 0
      and not attribute.attisdropped
    group by relation.relname
    order by relation.relname
  `, [["job", "job_common", ...partitionMetadata.map((row) => row.table)]]);
  const template = jobColumns.rows.find((row) => row.table_name === "job")?.signature;
  if (
    !template ||
    jobColumns.rows.length !== 2 + partitionMetadata.length ||
    jobColumns.rows.some((row) => row.signature !== template)
  ) {
    fail(`pg-boss-Jobpartitionen weichen vom Job-Spaltentemplate ab: ${JSON.stringify(jobColumns.rows)}.`);
  }
}

async function assertLegacyLive0018Contract(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const databaseAndSchemas = await client.query<{
    object_kind: string;
    object_name: string;
    owner: string;
  }>(`
    select 'database'::text as object_kind,
           database.datname::text as object_name,
           owner.rolname::text as owner
    from pg_catalog.pg_database database
    join pg_catalog.pg_roles owner on owner.oid = database.datdba
    where database.datname = pg_catalog.current_database()

    union all
    select 'schema', namespace.nspname, owner.rolname
    from pg_catalog.pg_namespace namespace
    join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
    where namespace.nspname !~ '^pg_'
      and namespace.nspname <> 'information_schema'
    order by 1, 2
  `);
  assertExactRows(
    databaseAndSchemas.rows.map((row) =>
      `${row.object_kind}:${row.object_name}:${row.owner}`,
    ),
    [
      `database:${String(databaseAndSchemas.rows.find((row) => row.object_kind === "database")?.object_name)}:${legacyRole}`,
      `schema:drizzle:${legacyRole}`,
      `schema:pgboss:${legacyRole}`,
      `schema:public:${legacyRole}`,
    ],
    "Live-0018-Datenbank-/Schemainventar",
  );

  const relations = await client.query<{
    schema_name: string;
    relkind: string;
    relname: string;
  }>(`
    select namespace.nspname as schema_name,
           relation.relkind,
           relation.relname
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
    order by namespace.nspname, relation.relkind, relation.relname
  `, [TARGET_SCHEMAS]);
  const publicAndDrizzle = relations.rows
    .filter((row) => row.schema_name !== "pgboss")
    .map((row) => `${row.schema_name}:${row.relkind}:${row.relname}`);
  assertExactRows(
    publicAndDrizzle,
    [
      "drizzle:S:__drizzle_migrations_id_seq",
      "drizzle:r:__drizzle_migrations",
      "public:r:audit_log",
      "public:r:auth_account",
      "public:r:auth_rate_limit",
      "public:r:auth_session",
      "public:r:auth_user",
      "public:r:auth_verification",
      "public:r:domain_events",
      "public:r:membership",
      "public:r:site",
      "public:r:user_identity",
      "public:r:workspace",
    ],
    "Live-0018-Public-/Drizzle-Relationsinventar",
  );
  const pgbossRelations = relations.rows
    .filter((row) => row.schema_name === "pgboss")
    .map((row) => `${row.relkind}:${row.relname}`);
  const requiredPgbossRelations = [
    "p:job",
    "p:queue_stats",
    "r:bam",
    "r:job_common",
    "r:job_dependency",
    "r:queue",
    "r:schedule",
    "r:subscription",
    "r:version",
    "r:warning",
  ];
  const unexpectedPgbossRelations = pgbossRelations.filter((entry) => {
    if (requiredPgbossRelations.includes(entry)) return false;
    return !/^r:(?:queue_stats_[0-9]{8}|j[0-9a-f]{56})$/.test(entry);
  });
  const missingPgbossRelations = requiredPgbossRelations.filter(
    (entry) => !pgbossRelations.includes(entry),
  );
  if (unexpectedPgbossRelations.length > 0 || missingPgbossRelations.length > 0) {
    fail(
      "Live-0018-pg-boss-Relationsinventar weicht ab. " +
        `Fehlend: ${missingPgbossRelations.join(", ") || "-"}; ` +
        `unerwartet: ${unexpectedPgbossRelations.join(", ") || "-"}.`,
    );
  }

  const routines = await client.query<{
    schema_name: string;
    proname: string;
    args: string;
    result_type: string;
    proretset: boolean;
    full_args: string;
    owner: string;
    language: string;
    prokind: string;
    provolatile: string;
    prosecdef: boolean;
    proleakproof: boolean;
    proisstrict: boolean;
    proparallel: string;
    proconfig: string[] | null;
    prosqlbody: string | null;
    prosrc: string;
  }>(`
    select namespace.nspname as schema_name,
           routine.proname,
           pg_catalog.oidvectortypes(routine.proargtypes) as args,
           pg_catalog.pg_get_function_result(routine.oid)::text as result_type,
           routine.proretset,
           coalesce((
             select pg_catalog.string_agg(
               coalesce(routine.proargmodes[argument.ordinality]::text, 'i') || ':' ||
                 pg_catalog.format_type(argument.type_oid, null),
               ',' order by argument.ordinality
             )
             from pg_catalog.unnest(
               coalesce(routine.proallargtypes, routine.proargtypes::oid[])
             ) with ordinality as argument(type_oid, ordinality)
           ), '-')::text as full_args,
           owner.rolname as owner,
           language.lanname as language,
           routine.prokind,
           routine.provolatile,
           routine.prosecdef,
           routine.proleakproof,
           routine.proisstrict,
           routine.proparallel,
           routine.proconfig,
           routine.prosqlbody::text as prosqlbody,
           routine.prosrc
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = routine.proowner
    join pg_catalog.pg_language language on language.oid = routine.prolang
    where namespace.nspname = any($1::text[])
    order by namespace.nspname, routine.proname, routine.oid
  `, [TARGET_SCHEMAS]);
  const routineSignatures = routines.rows.map((row) => [
    `${row.schema_name}.${row.proname}(${row.args})`,
    row.result_type,
    String(row.proretset),
    row.full_args,
    row.owner,
    row.language,
    row.prokind,
    row.provolatile,
    String(row.prosecdef),
    String(row.proleakproof),
    String(row.proisstrict),
    row.proparallel,
    row.proconfig?.join("|") ?? "-",
    row.prosqlbody === null ? "-" : sha256(row.prosqlbody),
    sha256(row.prosrc),
  ].join(":"));
  assertExactRows(
    routineSignatures,
    [
      `public.app_actor_id():uuid:false:-:${legacyRole}:sql:f:s:false:false:false:s:` +
        "search_path=pg_catalog:-:" +
        "acca23aaae3a91eda3aa424256de1527e1bb61d02fdd4b0d2c0803ecd6a37542",
      `public.forbid_mutation():trigger:false:-:${legacyRole}:plpgsql:f:v:false:false:false:u:-:-:` +
        "df89b0c65f44ffae87695685fca411fb8ad998cff6768bb8a176024d331910f3",
      `public.guard_membership_dml():trigger:false:-:${legacyRole}:plpgsql:f:v:` +
        "false:false:false:u:search_path=pg_catalog:-:" +
        "89cb000d7bca739fe2bd23b737ffc5153b494f9f7eb80790dbeef4e6ab95a057",
      `public.guard_membership_statement():trigger:false:-:${legacyRole}:plpgsql:f:v:` +
        "false:false:false:u:search_path=pg_catalog:-:" +
        "2945bbd3509c77926f0ea3b424d348419834fc16640d851acbed0ce07251fa30",
      "public.reconcile_user_identity(text, text):uuid:false:i:text,i:text:" +
        "identity_reconciler:plpgsql:f:v:true:false:false:u:search_path=public, pg_temp:-:" +
        "ae576295ddea09162013c29d5828512764cecbe3c39bbcaa0cdd5d45307f2ac3",
      `public.user_identity_link_auth_only():trigger:false:-:${legacyRole}:` +
        "plpgsql:f:v:false:false:false:u:-:-:" +
        "642035f502409bec26defa74b308e8825d613a5592ae23d228aaabd76115ccfb",
      `pgboss.create_queue(text, jsonb):void:false:i:text,i:jsonb:${legacyRole}:` +
        "plpgsql:f:v:false:false:false:u:-:-:" +
        "d8126cdf509c7fcff7701491d94a507e5eab4ae17dcad7c544364f1c6b46057d",
      `pgboss.delete_queue(text):void:false:i:text:${legacyRole}:` +
        "plpgsql:f:v:false:false:false:u:-:-:" +
        "7e727a172c70c3d5e66d347e611b6435f1679c9b662f41fb40cbad9a092f6d3a",
      `pgboss.job_table_format(text, text):text:false:i:text,i:text:${legacyRole}:` +
        "sql:f:i:false:false:false:u:-:-:" +
        "d6babe6b02e8f16f4ecb4856ee307e45023198f68556acde6c5f9a8b6af51fb3",
      `pgboss.job_table_run(text, text, text):void:false:i:text,i:text,i:text:${legacyRole}:` +
        "plpgsql:f:v:false:false:false:u:-:-:" +
        "ff6a13aaa9c4c94e2002064fc52fe41ca5224d8eda8ae923a897d27853457215",
      "pgboss.job_table_run_async(text, integer, text, text, text):void:false:" +
        `i:text,i:integer,i:text,i:text,i:text:${legacyRole}:` +
        "plpgsql:f:v:false:false:false:u:-:-:" +
        "1fdd88529e1979f20d319b0d5feac3bff6950461956a5a11871405452a66b171",
    ],
    "Live-0018-Routinenvertrag",
  );

  const rls = await client.query<{
    schema_name: string;
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(`
    select namespace.nspname as schema_name,
           relation.relname,
           relation.relrowsecurity,
           relation.relforcerowsecurity
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  `, [TARGET_SCHEMAS]);
  const publicRls = rls.rows
    .filter((row) => row.schema_name === "public")
    .map((row) => `${row.relname}:${row.relrowsecurity}:${row.relforcerowsecurity}`);
  assertExactRows(
    publicRls,
    [
      "audit_log:true:true",
      "auth_account:false:false",
      "auth_rate_limit:false:false",
      "auth_session:false:false",
      "auth_user:false:false",
      "auth_verification:false:false",
      "domain_events:true:true",
      "membership:true:true",
      "site:true:true",
      "user_identity:true:true",
      "workspace:true:true",
    ],
    "Live-0018-RLS/FORCE-Vertrag",
  );
  const nonPublicRls = rls.rows.filter(
    (row) =>
      row.schema_name !== "public" &&
      (row.relrowsecurity || row.relforcerowsecurity),
  );
  if (nonPublicRls.length > 0) {
    fail(`Unerwartetes RLS in drizzle/pgboss: ${JSON.stringify(nonPublicRls)}.`);
  }

  const policies = await client.query<{
    schema_name: string;
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string;
    cmd: string;
    qual: string;
    with_check: string;
  }>(`
    select schemaname as schema_name,
           tablename,
           policyname,
           permissive,
           roles::text,
           cmd,
           coalesce(qual, '-') as qual,
           coalesce(with_check, '-') as with_check
    from pg_catalog.pg_policies
    where schemaname = any($1::text[])
    order by schemaname, tablename, policyname
  `, [TARGET_SCHEMAS]);
  assertExactRows(
    policies.rows.map((row) => {
      const value = [
        row.tablename,
        row.policyname,
        row.permissive,
        row.roles,
        row.cmd,
        row.qual,
        row.with_check,
      ].join("|");
      return `${row.schema_name}:${row.tablename}:${row.policyname}:${sha256(value)}`;
    }),
    [
      "public:audit_log:tenant_isolation:23ff85358d0c0e94974353f538c267f99f5a3e7219bf9e1cd8769f69744ae417",
      "public:domain_events:tenant_isolation:f1715696222caf43a2adc220b67b8aebdce61f5ef9659884af1c7263ccab8284",
      "public:membership:membership_actor_delete:2b0f67a6a2931b84b4610114759e61a867d45e093a85ef8094cbdc2d81b14027",
      "public:membership:membership_actor_insert:f4f58cb0a649e8bf11dec66a6047da1ad5774ac03fe5acb808297937b3d5dbf6",
      "public:membership:membership_actor_update:9b7d643976dff08ea22d7a8db439ac1a36450de1a57c256c73035a5c37119902",
      "public:membership:tenant_isolation:1a5443560d407a656bdeaff6593819d601078d1ebdc58d4d1f8e02e829a587f3",
      "public:site:tenant_isolation:26181215437698e628cbd47ab08562d51de16bb0172d907c36c75a679a555d3c",
      "public:user_identity:user_identity_insert:ed42cd7d7ab49b586488c84e375edbd0c5679444866111bc9547a6a309424131",
      "public:user_identity:user_identity_reconcile_select:fa1b9f29b8bb9a694dc41a78d8ad73dc829d2715ff8e8c91c6357f9475b240bd",
      "public:user_identity:user_identity_reconcile_update:3763319bbd0208f0554077338d247e797d6122f9c56182072e2f3735b65eecd0",
      "public:user_identity:user_identity_select:824f30ce2ed4729f0ec66928efba45844aef4f048580c636bfd0c260d76bc9f6",
      "public:workspace:tenant_isolation:efde4221654b51f3f1df5df99ffe938484bd185d6d9057c808d0b2682d7be38f",
    ],
    "Live-0018-Policyvertrag",
  );

  const triggers = await client.query<{
    schema_name: string;
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
    select relation_schema.nspname as schema_name,
           relation.relname,
           trigger.tgname,
           trigger.tgtype,
           trigger.tgenabled,
           function_schema.nspname as function_schema,
           function.proname,
           pg_catalog.encode(trigger.tgargs, 'hex') as args,
           coalesce(pg_catalog.pg_get_expr(trigger.tgqual, trigger.tgrelid, false), '-')
             as when_expression,
           trigger.tgconstraint::text
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace relation_schema on relation_schema.oid = relation.relnamespace
    join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
    join pg_catalog.pg_namespace function_schema on function_schema.oid = function.pronamespace
    where relation_schema.nspname = any($1::text[])
      and not trigger.tgisinternal
    order by relation_schema.nspname, relation.relname, trigger.tgname
  `, [TARGET_SCHEMAS]);
  assertExactRows(
    triggers.rows.map((row) => [
      row.schema_name,
      row.relname,
      row.tgname,
      String(row.tgtype),
      row.tgenabled,
      row.function_schema,
      row.proname,
      row.args,
      row.when_expression,
      row.tgconstraint,
    ].join(":")),
    [
      "public:audit_log:audit_log_append_only:27:O:public:forbid_mutation::-:0",
      "public:audit_log:audit_log_no_truncate:34:O:public:forbid_mutation::-:0",
      "public:domain_events:domain_events_append_only:27:O:public:forbid_mutation::-:0",
      "public:domain_events:domain_events_no_truncate:34:O:public:forbid_mutation::-:0",
      "public:membership:membership_dml_guard:31:O:public:guard_membership_dml::-:0",
      "public:membership:membership_dml_serialize:30:O:public:guard_membership_statement::-:0",
      "public:user_identity:user_identity_link_auth_only:19:O:public:user_identity_link_auth_only::-:0",
    ],
    "Live-0018-Triggervertrag",
  );

  const executableRuleSurface = await client.query<{
    object_kind: string;
    object_name: string;
  }>(`
    select 'rewrite-rule'::text as object_kind,
           namespace.nspname || '.' || relation.relname || ':' || rewrite.rulename
             as object_name
    from pg_catalog.pg_rewrite rewrite
    join pg_catalog.pg_class relation on relation.oid = rewrite.ev_class
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = any($1::text[])
      and rewrite.rulename <> '_RETURN'

    union all
    select 'event-trigger', trigger.evtname
    from pg_catalog.pg_event_trigger trigger
    order by 1, 2
  `, [TARGET_SCHEMAS]);
  if (executableRuleSurface.rowCount !== 0) {
    fail(
      "Live-0018 enthält unerwartete Rules/Event-Trigger: " +
        executableRuleSurface.rows
          .map((row) => `${row.object_kind}:${row.object_name}`)
          .join(", ") + ".",
    );
  }

  const standaloneTypes = await client.query<{
    schema_name: string;
    typname: string;
    typtype: string;
    owner: string;
  }>(`
    select namespace.nspname as schema_name,
           type.typname,
           type.typtype,
           owner.rolname as owner
    from pg_catalog.pg_type type
    join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = type.typowner
    left join pg_catalog.pg_class composite on composite.oid = type.typrelid
    where namespace.nspname = any($1::text[])
      and (
        (type.typtype in ('d', 'e', 'm', 'r') and type.typelem = 0 and type.typrelid = 0)
        or (type.typtype = 'c' and composite.relkind = 'c')
      )
    order by namespace.nspname, type.typtype, type.typname
  `, [TARGET_SCHEMAS]);
  assertExactRows(
    standaloneTypes.rows.map((row) =>
      `${row.schema_name}:${row.typtype}:${row.typname}:${row.owner}`,
    ),
    [`pgboss:e:job_state:${legacyRole}`],
    "Live-0018-Typinventar",
  );
  await assertLegacyCoreStructure0018(client, legacyRole);
  await assertPgBossStructure0018(client, legacyRole);
}

async function readJournal(client: PoolClient): Promise<JournalRow> {
  const exists = await client.query<{ journal: string | null }>(
    "select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as journal",
  );
  if (exists.rows[0]?.journal !== "drizzle.__drizzle_migrations") {
    fail("Das Drizzle-Journal drizzle.__drizzle_migrations fehlt.");
  }

  const result = await client.query<JournalRow>(`
    select count(*) filter (where created_at = $1::bigint)::int as migration_0018,
           count(*) filter (where created_at = $2::bigint)::int as migration_0019,
           count(*) filter (where created_at > $1::bigint)::int as later_migrations,
           coalesce(
             pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by created_at)::text,
             '[]'
           ) as snapshot
    from drizzle.__drizzle_migrations m
  `, [JOURNAL_0018, JOURNAL_0019]);
  return result.rows[0];
}

async function assertLegacyJournal(client: PoolClient): Promise<JournalRow> {
  const journal = await readJournal(client);
  if (
    journal.migration_0018 !== 1 ||
    journal.migration_0019 !== 0 ||
    journal.later_migrations !== 0
  ) {
    fail(
      "Journal-Precondition verletzt: 0018 muss genau einmal vorhanden sein; " +
        "0019 und spätere Migrationen dürfen noch nicht vorhanden sein.",
    );
  }
  return journal;
}

async function oneSnapshot(
  client: PoolClient,
  label: string,
  text: string,
  values: readonly unknown[],
): Promise<string> {
  const result = await client.query<SnapshotRow>(text, [...values]);
  if (result.rowCount !== 1 || !result.rows[0]?.snapshot) {
    fail(`${label} wurde nicht genau einmal gefunden.`);
  }
  return result.rows[0].snapshot;
}

async function readSamples(
  client: PoolClient,
  sample: LegacyCutoverSample,
  journal: JournalRow,
  lockRows: boolean,
): Promise<CutoverSnapshots> {
  const rowLock = lockRows ? " for update" : "";
  const workspace = await oneSnapshot(
    client,
    "Workspace-Stichprobe",
    `select pg_catalog.to_jsonb(w)::text as snapshot
       from public.workspace w
      where w.id = $1::uuid${rowLock}`,
    [sample.workspaceId],
  );
  const user = await oneSnapshot(
    client,
    "User-Stichprobe",
    `select pg_catalog.to_jsonb(u)::text as snapshot
       from public.user_identity u
      where u.id = $1::uuid${rowLock}`,
    [sample.userId],
  );
  const membership = await oneSnapshot(
    client,
    "Workspace/User-Membership-Stichprobe",
    `select pg_catalog.to_jsonb(m)::text as snapshot
       from public.membership m
      where m.workspace_id = $1::uuid
        and m.user_id = $2::uuid${rowLock}`,
    [sample.workspaceId, sample.userId],
  );
  const pgBossJob = await oneSnapshot(
    client,
    "pg-boss-Job-Stichprobe",
    `select pg_catalog.to_jsonb(j)::text as snapshot
       from pgboss.job j
      where j.id = $1::uuid
        and coalesce(j.name, '') <> ''${rowLock}`,
    [sample.pgBossJobId],
  );

  return { workspace, user, membership, pgBossJob, journal: journal.snapshot };
}

async function assertSamplesUnchanged(
  client: PoolClient,
  sample: LegacyCutoverSample,
  before: CutoverSnapshots,
): Promise<void> {
  const afterJournal = await readJournal(client);
  const after: CutoverSnapshots = {
    workspace: await oneSnapshot(
      client,
      "Workspace-Stichprobe nach Cutover",
      "select pg_catalog.to_jsonb(w)::text as snapshot from public.workspace w where w.id=$1::uuid",
      [sample.workspaceId],
    ),
    user: await oneSnapshot(
      client,
      "User-Stichprobe nach Cutover",
      "select pg_catalog.to_jsonb(u)::text as snapshot from public.user_identity u where u.id=$1::uuid",
      [sample.userId],
    ),
    membership: await oneSnapshot(
      client,
      "Membership-Stichprobe nach Cutover",
      `select pg_catalog.to_jsonb(m)::text as snapshot
         from public.membership m
        where m.workspace_id=$1::uuid and m.user_id=$2::uuid`,
      [sample.workspaceId, sample.userId],
    ),
    pgBossJob: await oneSnapshot(
      client,
      "pg-boss-Job-Stichprobe nach Cutover",
      "select pg_catalog.to_jsonb(j)::text as snapshot from pgboss.job j where j.id=$1::uuid",
      [sample.pgBossJobId],
    ),
    journal: afterJournal.snapshot,
  };

  for (const key of Object.keys(before) as Array<keyof CutoverSnapshots>) {
    if (before[key] !== after[key]) fail(`${key}-Stichprobe hat sich während des Cutovers verändert.`);
  }
}

async function transferOwnership(
  client: PoolClient,
  expectedDatabase: string,
  legacyRole: string,
): Promise<{ relations: number; routines: number; types: number }> {
  await client.query(`alter database ${quoteIdentifier(expectedDatabase)} owner to ${quoteIdentifier(APP_OWNER)}`);
  await client.query(`alter schema ${quoteIdentifier("public")} owner to ${quoteIdentifier(APP_OWNER)}`);
  await client.query(`alter schema ${quoteIdentifier("drizzle")} owner to ${quoteIdentifier(APP_OWNER)}`);
  await client.query(`alter schema ${quoteIdentifier("pgboss")} owner to ${quoteIdentifier(APP_WORKER)}`);

  const relations = await client.query<RelationOwnerRow>(`
    select n.nspname as schema_name, c.relname as object_name, c.relkind
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    where n.nspname = any($1::text[])
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and owner.rolname = $2
    order by case c.relkind when 'S' then 2 else 1 end, n.nspname, c.relname
  `, [TARGET_SCHEMAS, legacyRole]);
  for (const row of relations.rows) {
    const targetOwner = row.schema_name === "pgboss" ? APP_WORKER : APP_OWNER;
    const object = quoteQualified(row.schema_name, row.object_name);
    const objectKind =
      row.relkind === "S"
        ? "sequence"
        : row.relkind === "v"
          ? "view"
          : row.relkind === "m"
            ? "materialized view"
            : row.relkind === "f"
              ? "foreign table"
              : "table";
    await client.query(`alter ${objectKind} ${object} owner to ${quoteIdentifier(targetOwner)}`);
  }

  const routines = await client.query<RoutineOwnerRow>(`
    select n.nspname as schema_name,
           p.proname as object_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
           p.prokind
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where n.nspname = any($1::text[])
      and p.prokind in ('f', 'p')
      and owner.rolname = $2
    order by n.nspname, p.proname, p.oid
  `, [TARGET_SCHEMAS, legacyRole]);
  for (const row of routines.rows) {
    const targetOwner = row.schema_name === "pgboss" ? APP_WORKER : APP_OWNER;
    const objectKind = row.prokind === "p" ? "procedure" : "function";
    await client.query(
      `alter ${objectKind} ${quoteQualified(row.schema_name, row.object_name)}` +
        `(${row.identity_arguments}) owner to ${quoteIdentifier(targetOwner)}`,
    );
  }

  const types = await client.query<TypeOwnerRow>(`
    select n.nspname as schema_name, t.typname as object_name, t.typtype
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = t.typowner
    left join pg_catalog.pg_class composite on composite.oid = t.typrelid
    where n.nspname = any($1::text[])
      and owner.rolname = $2
      and (
        (
          t.typtype in ('d', 'e', 'm', 'r')
          and t.typelem = 0
          and t.typrelid = 0
        )
        or (t.typtype = 'c' and composite.relkind = 'c')
      )
    order by n.nspname, t.typname
  `, [TARGET_SCHEMAS, legacyRole]);
  for (const row of types.rows) {
    const targetOwner = row.schema_name === "pgboss" ? APP_WORKER : APP_OWNER;
    const objectKind = row.typtype === "d" ? "domain" : "type";
    await client.query(
      `alter ${objectKind} ${quoteQualified(row.schema_name, row.object_name)} ` +
        `owner to ${quoteIdentifier(targetOwner)}`,
    );
  }

  return {
    relations: relations.rowCount ?? 0,
    routines: routines.rowCount ?? 0,
    types: types.rowCount ?? 0,
  };
}

function revokeTail(row: AclBaseRow): string {
  const grantee = roleSpecification(row.grantee, row.grantee_oid, "ACL-Grantee");
  roleSpecification(row.grantor, row.grantor_oid, "ACL-Grantor");
  if (Number(row.grantor_oid) === 0) fail("PUBLIC kann kein ACL-Grantor sein.");
  return `from ${grantee} granted by current_user cascade`;
}

async function revokeAsCatalogGrantor(
  client: PoolClient,
  row: AclBaseRow,
  statement: string,
  schemaName?: string,
): Promise<void> {
  const grantor = roleSpecification(row.grantor, row.grantor_oid, "ACL-Grantor");
  let temporarySchemaUsage:
    | { schemaOwner: string; grantee: string; schemaName: string }
    | undefined;
  if (schemaName && Number(row.grantor_oid) !== 0) {
    const access = await client.query<{
      schema_owner: string;
      has_usage: boolean;
    }>(`
      select owner.rolname as schema_owner,
             pg_catalog.has_schema_privilege($2, namespace.oid, 'USAGE') as has_usage
      from pg_catalog.pg_namespace namespace
      join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
      where namespace.nspname = $1
    `, [schemaName, row.grantor]);
    const schemaAccess = access.rows[0];
    if (!schemaAccess) fail(`Schema ${schemaName} fehlt während des ACL-Cutovers.`);
    if (!schemaAccess.has_usage) {
      const grantee = roleSpecification(row.grantor, row.grantor_oid, "temporärer Schema-Grantee");
      const schemaOwner = quoteIdentifier(schemaAccess.schema_owner);
      await client.query(`set local role ${schemaOwner}`);
      await client.query(
        `grant usage on schema ${quoteIdentifier(schemaName)} to ${grantee} granted by current_user`,
      );
      await client.query("reset role");
      temporarySchemaUsage = {
        schemaOwner,
        grantee,
        schemaName,
      };
    }
  }

  await client.query(`set local role ${grantor}`);
  // PostgreSQL 18 akzeptiert GRANTED BY nur für current_user. SET LOCAL ROLE
  // bindet die Mutation an exakt den im ACL katalogisierten Grantor; bei
  // einem Fehler rollt die äußere Transaktion den Rollenwechsel mit zurück.
  await client.query(statement);
  await client.query("reset role");
  if (temporarySchemaUsage) {
    await client.query(`set local role ${temporarySchemaUsage.schemaOwner}`);
    await client.query(
      `revoke usage on schema ${quoteIdentifier(temporarySchemaUsage.schemaName)} ` +
        `from ${temporarySchemaUsage.grantee} granted by current_user`,
    );
    await client.query("reset role");
  }
}

async function revokeLegacyAcls(client: PoolClient, legacyRole: string): Promise<number> {
  let revoked = 0;
  const endpointFilter = `
    and (
      acl.grantee = (select oid from pg_catalog.pg_roles where rolname = $1)
      or acl.grantor = (select oid from pg_catalog.pg_roles where rolname = $1)
    )
  `;

  const databaseAcls = await client.query<NamedAclRow>(`
    select d.datname as object_name,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_database d
    cross join lateral pg_catalog.aclexplode(d.datacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where d.datname = pg_catalog.current_database()
      ${endpointFilter}
    order by d.datname, acl.grantor, acl.grantee, acl.privilege_type
  `, [legacyRole]);
  const databasePrivileges = new Set(["CREATE", "CONNECT", "TEMPORARY"]);
  for (const row of databaseAcls.rows) {
    const privilege = checkedPrivilege(row.privilege_type, databasePrivileges, "Datenbank");
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} on database ${quoteIdentifier(row.object_name)} ${revokeTail(row)}`,
    );
    revoked += 1;
  }

  const schemaAcls = await client.query<NamedAclRow>(`
    select n.nspname as object_name,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(n.nspacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where true ${endpointFilter}
    order by n.nspname, acl.grantor, acl.grantee, acl.privilege_type
  `, [legacyRole]);
  const schemaPrivileges = new Set(["CREATE", "USAGE"]);
  for (const row of schemaAcls.rows) {
    const privilege = checkedPrivilege(row.privilege_type, schemaPrivileges, "Schema");
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} on schema ${quoteIdentifier(row.object_name)} ${revokeTail(row)}`,
    );
    revoked += 1;
  }

  const relationAcls = await client.query<RelationAclRow>(`
    select n.nspname as schema_name,
           c.relname as object_name,
           c.relkind,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      ${endpointFilter}
    order by n.nspname, c.relname, acl.grantor, acl.grantee, acl.privilege_type
  `, [legacyRole]);
  const tablePrivileges = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ]);
  const sequencePrivileges = new Set(["USAGE", "SELECT", "UPDATE"]);
  for (const row of relationAcls.rows) {
    const sequence = row.relkind === "S";
    const privilege = checkedPrivilege(
      row.privilege_type,
      sequence ? sequencePrivileges : tablePrivileges,
      sequence ? "Sequenz" : "Relation",
    );
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} on ${sequence ? "sequence" : "table"} ` +
        `${quoteQualified(row.schema_name, row.object_name)} ${revokeTail(row)}`,
      row.schema_name,
    );
    revoked += 1;
  }

  const columnAcls = await client.query<ColumnAclRow>(`
    select n.nspname as schema_name,
           c.relname as object_name,
           c.relkind,
           a.attname as column_name,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(a.attacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where a.attnum > 0
      and not a.attisdropped
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      ${endpointFilter}
    order by n.nspname, c.relname, a.attnum, acl.grantor, acl.grantee, acl.privilege_type
  `, [legacyRole]);
  const columnPrivileges = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);
  for (const row of columnAcls.rows) {
    const privilege = checkedPrivilege(row.privilege_type, columnPrivileges, "Spalten");
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} (${quoteIdentifier(row.column_name)}) on table ` +
        `${quoteQualified(row.schema_name, row.object_name)} ${revokeTail(row)}`,
      row.schema_name,
    );
    revoked += 1;
  }

  const routineAcls = await client.query<RoutineAclRow>(`
    select n.nspname as schema_name,
           p.proname as object_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
           p.prokind,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(p.proacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where p.prokind in ('f', 'p')
      ${endpointFilter}
    order by n.nspname, p.proname, p.oid, acl.grantor, acl.grantee
  `, [legacyRole]);
  const routinePrivileges = new Set(["EXECUTE"]);
  for (const row of routineAcls.rows) {
    const privilege = checkedPrivilege(row.privilege_type, routinePrivileges, "Routine");
    const objectKind = row.prokind === "p" ? "procedure" : "function";
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} on ${objectKind} ` +
        `${quoteQualified(row.schema_name, row.object_name)}(${row.identity_arguments}) ${revokeTail(row)}`,
      row.schema_name,
    );
    revoked += 1;
  }

  const typeAcls = await client.query<TypeAclRow>(`
    select n.nspname as schema_name,
           t.typname as object_name,
           t.typtype,
           (
             (t.typtype in ('d', 'e', 'm', 'r') and t.typelem = 0 and t.typrelid = 0)
             or (t.typtype = 'c' and composite.relkind = 'c')
           ) as is_standalone,
           acl.privilege_type,
           grantee.rolname as grantee,
           acl.grantee as grantee_oid,
           grantor.rolname as grantor,
           acl.grantor as grantor_oid
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    left join pg_catalog.pg_class composite on composite.oid = t.typrelid
    cross join lateral pg_catalog.aclexplode(t.typacl) acl
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    left join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    where true ${endpointFilter}
    order by n.nspname, t.typname, acl.grantor, acl.grantee
  `, [legacyRole]);
  const typePrivileges = new Set(["USAGE"]);
  for (const row of typeAcls.rows) {
    if (!row.is_standalone) {
      fail(`Legacy-ACL auf nicht eigenständig behandelbarem Typ ${row.schema_name}.${row.object_name}.`);
    }
    const privilege = checkedPrivilege(row.privilege_type, typePrivileges, "Typ");
    const objectKind = row.typtype === "d" ? "domain" : "type";
    await revokeAsCatalogGrantor(client, row,
      `revoke ${privilege} on ${objectKind} ` +
        `${quoteQualified(row.schema_name, row.object_name)} ${revokeTail(row)}`,
      row.schema_name,
    );
    revoked += 1;
  }

  return revoked;
}

async function revokeLegacyMemberships(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
): Promise<number> {
  const legacyRole = options.legacyRole;
  const memberships = await client.query<MembershipRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
    where granted.rolname = $1
       or member.rolname = $1
       or grantor.rolname = $1
    order by case when grantor.rolname = $1 then 0 else 1 end,
             granted.rolname,
             member.rolname,
             grantor.rolname
  `, [legacyRole]);

  let revoked = 0;
  for (const row of memberships.rows) {
    if (
      options.provisioningTopology?.retainedLegacyRole === legacyRole &&
      row.granted_role === IDENTITY_RECONCILER &&
      row.member_role === legacyRole &&
      row.grantor_role === options.provisioningTopology.bootstrapGrantorRole
    ) {
      // PostgreSQL 18 legt diese Kante beim CREATE ROLE unter dem echten
      // Bootstrap-Superuser an. Ein Nichtsuperuser-Provisioning-Admin kann
      // weder SET ROLE auf diesen Grantor machen noch dessen Grant widerrufen.
      // Sie bleibt nur in diesem expliziten Providervertrag erhalten: Legacy
      // ist bereits NOLOGIN/NOINHERIT/NOCREATEROLE/CONNECTION LIMIT 0 und die
      // Kante selbst hat SET=false/INHERIT=false.
      continue;
    }
    await client.query(`set local role ${quoteIdentifier(row.grantor_role)}`);
    await client.query(
      `revoke ${quoteIdentifier(row.granted_role)} from ${quoteIdentifier(row.member_role)} ` +
        "granted by current_user cascade",
    );
    await client.query("reset role");
    revoked += 1;
  }
  return revoked;
}

async function hardenClusterRoles(client: PoolClient, legacyRole: string): Promise<void> {
  const commonHardening =
    "nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication";
  await client.query(
    `alter role ${quoteIdentifier(legacyRole)} ${commonHardening} connection limit 0`,
  );
  await client.query(
    `alter role ${quoteIdentifier(IDENTITY_RECONCILER)} ` +
      `${commonHardening} connection limit -1`,
  );
}

function recoveryConfirmation(options: LegacyRoleCutoverOptions): string {
  return (
    `${options.expectedControlDatabase}->${options.expectedDatabase}:` +
    `ALLOW-CONNECTIONS-RECOVERY:${options.expectedDatabaseConnectionLimit}`
  );
}

function failClosedFreezeError(
  error: unknown,
  options: LegacyRoleCutoverOptions,
  targetCommitSucceeded = false,
  freezeConfirmed = false,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const commitState = targetCommitSucceeded
    ? "Der atomare Target-Commit war erfolgreich; nur das Control-Unfreeze ist unvollständig. "
    : "Der Target-Cutover ist nicht als erfolgreich bestätigt. ";
  if (!freezeConfirmed) {
    return new Error(
      `${detail} ${commitState}` +
        "Zustand unbestätigt: Der tatsächliche ALLOW_CONNECTIONS-Wert des Targets " +
        "konnte über keine frische, exakt reattestierte Control-Verbindung bestätigt werden. " +
        "Phase 2 oder Recovery dürfen nicht blind fortgesetzt werden; zuerst muss ein Admin " +
        `über ${options.expectedControlDatabase} Cluster, Ziel und Verbindungsstatus neu attestieren.`,
    );
  }
  return new Error(
    `${detail} ${commitState}` +
      `${options.expectedDatabase} bleibt fail-closed mit ALLOW_CONNECTIONS=false. ` +
      "Nicht über die Target-URL wieder öffnen oder Phase 2 blind wiederholen. " +
      "Eine bewusste Admin-Recovery darf ausschließlich über die attestierte Control-Datenbank " +
      `${options.expectedControlDatabase} mit exakter Bestätigung ` +
      `${recoveryConfirmation(options)} erfolgen.`,
  );
}

async function reattestAndRefreezeTarget(
  compromisedControl: PoolClient,
  options: LegacyRoleCutoverOptions,
  trustedAttestation: ClusterAttestationRow,
  reason: unknown,
  connectFreshControl?: FreshControlClientFactory,
): Promise<{ confirmed: boolean; detail: Error }> {
  const reasonDetail = reason instanceof Error ? reason.message : String(reason);
  if (!connectFreshControl) {
    return {
      confirmed: false,
      detail: new Error(
        `${reasonDetail} Es wurde keine Factory für eine frische Control-Verbindung bereitgestellt.`,
      ),
    };
  }

  let freshControl: PoolClient | undefined;
  try {
    freshControl = await connectFreshControl(compromisedControl);
    if (freshControl === compromisedControl) {
      fail("Die Reattestierung erhielt dieselbe kompromittierte Control-Session erneut.");
    }
    await assertAdminAndDatabase(
      freshControl,
      options,
      options.expectedControlDatabase,
    );
    const freshAttestation = await loadClusterAttestation(freshControl);
    assertSameControlAttestation(
      freshAttestation,
      trustedAttestation,
      options,
    );
    await freshControl.query("set lock_timeout = '5s'");
    await freshControl.query("set statement_timeout = '300s'");

    // Autocommit ist hier absichtlich: Nach einer verlorenen COMMIT-Antwort
    // wird keine weitere mehrdeutige Control-Transaktion aufgebaut. Falls
    // schon der ALTER-Antwortpfad scheitert, ist der Zustand wieder ehrlich
    // unbestätigt und wird gerade nicht als fail-closed ausgegeben.
    await freshControl.query(
      `alter database ${quoteIdentifier(options.expectedDatabase)} allow_connections false`,
    );
    const state = await loadDatabaseState(freshControl, options.expectedDatabase);
    if (state.datallowconn) {
      fail("Die frische Control-Verbindung konnte das Target nicht erneut einfrieren.");
    }
    if (
      state.datconnlimit !== 0 &&
      state.datconnlimit !== options.expectedDatabaseConnectionLimit
    ) {
      fail(
        "Die frische Control-Verbindung sieht nach dem Refreeze einen unerwarteten " +
          `CONNECTION LIMIT ${state.datconnlimit}.`,
      );
    }
    return {
      confirmed: true,
      detail: new Error(
        `${reasonDetail} Eine neue Control-Session hat Control-Datenbank, ` +
          "Cluster-ID und Serverendpunkt reattestiert und das Target erneut eingefroren.",
      ),
    };
  } catch (error) {
    return {
      confirmed: false,
      detail: new Error(
        `${reasonDetail} Reconnect/Reattestierung scheiterte: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  } finally {
    // Ein Reattestierungsclient wird niemals in den Pool zurückgegeben. Damit
    // kann auch ein weiterer verlorener Antwortpfad nicht versehentlich als
    // vertrauenswürdige Folgesession wiederverwendet werden.
    if (freshControl && freshControl !== compromisedControl) {
      try {
        freshControl.release(true);
      } catch {
        // Der Client ist bewusst Einwegmaterial; ein Release-Fehler darf die
        // bereits ermittelte confirmed/unconfirmed-Aussage nicht überschreiben.
      }
    }
  }
}

async function freezeTargetDatabase(
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  expectedConnectionLimit: number,
): Promise<void> {
  await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
  const trustedAttestation = await loadClusterAttestation(control);
  let transactionStarted = false;
  try {
    await control.query("begin isolation level serializable");
    transactionStarted = true;
    await control.query("set local lock_timeout = '5s'");
    await control.query("set local statement_timeout = '300s'");
    await control.query("select pg_catalog.pg_advisory_xact_lock($1, $2)", [
      CUTOVER_LOCK_KEY_1,
      CUTOVER_LOCK_KEY_2,
    ]);
    await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
    await assertDatabaseState(
      control,
      options,
      true,
      expectedConnectionLimit,
      "Control-Freeze-Ausgangszustand",
    );
    await control.query(
      `alter database ${quoteIdentifier(options.expectedDatabase)} allow_connections false`,
    );
    await assertDatabaseState(
      control,
      options,
      false,
      expectedConnectionLimit,
      "Control-Freeze",
    );
    try {
      await control.query("commit");
    } catch (error) {
      // Ob COMMIT serverseitig wirksam wurde, ist nach einem verlorenen ACK
      // nicht entscheidbar. Dieselbe Session darf ab hier weder ROLLBACK noch
      // einen vermeintlichen Zustandsbeweis liefern.
      throw new AmbiguousControlCommitError("freeze", error, trustedAttestation);
    }
    transactionStarted = false;
    await assertDatabaseState(
      control,
      options,
      false,
      expectedConnectionLimit,
      "Control-Freeze nach COMMIT",
    );
  } catch (error) {
    if (transactionStarted && !(error instanceof AmbiguousControlCommitError)) {
      await control.query("rollback").catch(() => undefined);
    }
    throw error;
  }
}

async function ensureTargetFrozen(
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  trustedAttestation: ClusterAttestationRow,
): Promise<void> {
  // Ein fehlgeschlagenes ROLLBACK darf nicht verschluckt werden: Andernfalls
  // könnten die folgende Reattestierung, ALTER DATABASE und Zustandsabfrage
  // weiterhin in derselben offenen Transaktion laufen und lediglich einen
  // uncommitteten `false`-Wert sehen. Der Aufrufer verwirft diese Session bei
  // jedem ROLLBACK-Fehler und wechselt auf eine frische Control-Verbindung.
  await control.query("rollback");
  await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
  const currentAttestation = await loadClusterAttestation(control);
  assertSameControlAttestation(currentAttestation, trustedAttestation, options);
  await control.query(
    `alter database ${quoteIdentifier(options.expectedDatabase)} allow_connections false`,
  );
  const state = await loadDatabaseState(control, options.expectedDatabase);
  if (state.datallowconn) {
    fail("Fail-closed-Control konnte ALLOW_CONNECTIONS=false nicht attestieren.");
  }
}

async function confirmTargetFrozenAfterControlFailure(
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  trustedAttestation: ClusterAttestationRow,
  error: unknown,
  connectFreshControl?: FreshControlClientFactory,
): Promise<{ confirmed: boolean; detail: Error }> {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    await ensureTargetFrozen(control, options, trustedAttestation);
    return {
      confirmed: true,
      detail: new Error(
        `${detail} Die bestehende Control-Session wurde vollständig reattestiert und ` +
          "hat das Target erneut eingefroren.",
      ),
    };
  } catch (sameSessionError) {
    return reattestAndRefreezeTarget(
      control,
      options,
      trustedAttestation,
      new Error(
        `${detail} Reattestierung auf der bestehenden Control-Session scheiterte: ` +
          `${sameSessionError instanceof Error ? sameSessionError.message : String(sameSessionError)}`,
      ),
      connectFreshControl,
    );
  }
}

async function restoreTargetAvailability(
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  expectedCurrentConnectionLimit: number,
): Promise<void> {
  await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
  const trustedAttestation = await loadClusterAttestation(control);
  let transactionStarted = false;
  try {
    await control.query("begin isolation level serializable");
    transactionStarted = true;
    await control.query("set local lock_timeout = '5s'");
    await control.query("set local statement_timeout = '300s'");
    await control.query("select pg_catalog.pg_advisory_xact_lock($1, $2)", [
      CUTOVER_LOCK_KEY_1,
      CUTOVER_LOCK_KEY_2,
    ]);
    await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
    await assertDatabaseState(
      control,
      options,
      false,
      expectedCurrentConnectionLimit,
      "Control-Unfreeze-Ausgangszustand",
    );
    await control.query(
      `alter database ${quoteIdentifier(options.expectedDatabase)} ` +
        `connection limit ${options.expectedDatabaseConnectionLimit}`,
    );
    await control.query(
      `alter database ${quoteIdentifier(options.expectedDatabase)} allow_connections true`,
    );
    await assertDatabaseState(
      control,
      options,
      true,
      options.expectedDatabaseConnectionLimit,
      "Control-Unfreeze",
    );
    try {
      await control.query("commit");
    } catch (error) {
      // Ein verlorener Unfreeze-COMMIT-ACK kann bedeuten, dass das Target
      // bereits offen ist. Nur eine neue Session darf es reattestieren und
      // erneut schließen.
      throw new AmbiguousControlCommitError("unfreeze", error, trustedAttestation);
    }
    transactionStarted = false;
    await assertDatabaseState(
      control,
      options,
      true,
      options.expectedDatabaseConnectionLimit,
      "Control-Unfreeze nach COMMIT",
    );
  } catch (error) {
    if (transactionStarted && !(error instanceof AmbiguousControlCommitError)) {
      await control.query("rollback").catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Sichtbare, absichtlich separate Quarantänephase. Sie verhindert, dass ein
 * alter oder kompromittierter Client nach dem ersten Katalog-Snapshot noch in
 * das Cutover-Fenster hinein verbinden kann. Scheitert die Folgephase, bleibt
 * die Legacy-Rolle fail-closed gesperrt und muss bewusst untersucht werden.
 */
export async function quarantineLegacyRoles(
  target: PoolClient,
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  connectFreshControl?: FreshControlClientFactory,
): Promise<void> {
  validateOptions(options);
  await assertCutoverControlPlane(target, control, options);
  const trustedControlAttestation = await loadClusterAttestation(control);
  const initialState = await loadDatabaseState(control, options.expectedDatabase);
  const targetInitialState = await loadDatabaseState(target, options.expectedDatabase);
  if (
    initialState.datallowconn !== targetInitialState.datallowconn ||
    initialState.datconnlimit !== targetInitialState.datconnlimit
  ) {
    fail("Target und Control sehen vor Phase 1 keinen identischen Datenbankzustand.");
  }
  if (
    (initialState.datallowconn &&
      initialState.datconnlimit !== options.expectedDatabaseConnectionLimit) ||
    (!initialState.datallowconn &&
      initialState.datconnlimit !== options.expectedDatabaseConnectionLimit &&
      initialState.datconnlimit !== 0)
  ) {
    fail(
      "Phase 1 akzeptiert offen nur den bestätigten CONNECTION-LIMIT-Ausgangswert " +
        "und eingefroren ausschließlich diesen Wert oder 0. CONNECTION LIMIT 0 allein " +
        "gilt niemals als Exklusivitätsnachweis.",
    );
  }
  const phase1AlreadyCommitted = initialState.datconnlimit === 0;

  let transactionStarted = false;
  let beforeFreeze: CutoverSnapshots;
  try {
    await target.query("begin isolation level serializable read only");
    transactionStarted = true;
    await target.query("set local lock_timeout = '5s'");
    await target.query("set local statement_timeout = '300s'");
    await target.query("set local timezone = 'UTC'");
    await target.query("select pg_catalog.pg_advisory_xact_lock($1, $2)", [
      CUTOVER_LOCK_KEY_1,
      CUTOVER_LOCK_KEY_2,
    ]);
    ({ snapshots: beforeFreeze } = await assertCutoverReadOnlyPreflight(target, options, {
      requireQuarantined: phase1AlreadyCommitted,
      requireDrained: false,
      requireDatabaseQuarantined: phase1AlreadyCommitted,
      requireAllowConnections: initialState.datallowconn,
      lockSamples: false,
    }));
    await target.query("commit");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await target.query("rollback").catch(() => undefined);
    if (!initialState.datallowconn) {
      const recovery = await confirmTargetFrozenAfterControlFailure(
        control,
        options,
        trustedControlAttestation,
        error,
        connectFreshControl,
      );
      throw failClosedFreezeError(recovery.detail, options, false, recovery.confirmed);
    }
    throw error;
  }

  let freezeBoundaryEntered = !initialState.datallowconn;
  transactionStarted = false;
  try {
    if (initialState.datallowconn) {
      freezeBoundaryEntered = true;
      await freezeTargetDatabase(
        control,
        options,
        options.expectedDatabaseConnectionLimit,
      );
    }
    await assertDatabaseState(
      control,
      options,
      false,
      initialState.datconnlimit,
      "Control-Freeze vor Phase 1",
    );
    await assertDatabaseState(
      target,
      options,
      false,
      initialState.datconnlimit,
      "Target-Freeze vor Phase 1",
    );

    await target.query("begin isolation level serializable");
    transactionStarted = true;
    await target.query("set local lock_timeout = '5s'");
    await target.query("set local statement_timeout = '300s'");
    await target.query("set local timezone = 'UTC'");
    await target.query("select pg_catalog.pg_advisory_xact_lock($1, $2)", [
      CUTOVER_LOCK_KEY_1,
      CUTOVER_LOCK_KEY_2,
    ]);
    await assertDatabaseState(
      target,
      options,
      false,
      initialState.datconnlimit,
      "Target-Freeze im Phase-1-Commitfenster",
    );
    await assertNoActiveRoleSessions(target, [options.legacyRole, IDENTITY_RECONCILER]);
    await assertExclusiveTargetDatabaseSession(target);
    const { snapshots: afterFreeze } = await assertCutoverReadOnlyPreflight(target, options, {
      requireQuarantined: phase1AlreadyCommitted,
      requireDrained: true,
      requireDatabaseQuarantined: phase1AlreadyCommitted,
      requireAllowConnections: false,
      lockSamples: true,
    });
    assertSamePreflightSnapshots(beforeFreeze, afterFreeze);
    // ALLOW_CONNECTIONS beendet bestehende Backends nicht. Erst nachdem alle
    // davon verschwunden sind und der zweite vollständige Preflight etwaigen
    // Katalogdrift verworfen hat, wird die clusterweite Attributhärtung mit
    // der Datenbank-Quarantäne atomar committed.
    if (!phase1AlreadyCommitted) {
      await hardenClusterRoles(target, options.legacyRole);
      await setDatabaseConnectionLimit(target, options, 0);
    }
    await target.query("commit");
    transactionStarted = false;
    await assertDatabaseState(
      control,
      options,
      false,
      0,
      "Phase 1 nach COMMIT",
    );
  } catch (error) {
    if (transactionStarted) await target.query("rollback").catch(() => undefined);
    if (error instanceof AmbiguousControlCommitError) {
      const recovery = await reattestAndRefreezeTarget(
        control,
        options,
        error.trustedAttestation,
        error,
        connectFreshControl,
      );
      throw failClosedFreezeError(
        recovery.detail,
        options,
        false,
        recovery.confirmed,
      );
    }
    if (freezeBoundaryEntered) {
      const recovery = await confirmTargetFrozenAfterControlFailure(
        control,
        options,
        trustedControlAttestation,
        error,
        connectFreshControl,
      );
      throw failClosedFreezeError(recovery.detail, options, false, recovery.confirmed);
    }
    throw error;
  }
}

function assertExactRows(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label} weicht vor COMMIT ab. Erwartet: ${expectedSorted.join(", ")}; ` +
        `ist: ${actualSorted.join(", ")}.`,
    );
  }
}

async function verifyCutoverAclContract(client: PoolClient): Promise<void> {
  const databaseName = await client.query<{ name: string }>(
    "select pg_catalog.current_database() as name",
  );
  const currentDatabase = databaseName.rows[0]?.name;
  if (!currentDatabase) fail("current_database() lieferte keinen Wert für den ACL-Vertrag.");

  const result = await client.query<AclSignatureRow>(`
    select 'database'::text as object_kind,
           database.datname::text as object_name,
           coalesce(grantee.rolname, 'PUBLIC')::text as grantee,
           grantor.rolname::text as grantor,
           acl.privilege_type::text,
           acl.is_grantable
    from pg_catalog.pg_database database
    cross join lateral pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where database.datname = pg_catalog.current_database()
      and acl.grantee <> database.datdba

    union all
    select 'schema', namespace.nspname,
           coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
           acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = any($1::text[])
      and acl.grantee <> namespace.nspowner

    union all
    select 'relation', namespace.nspname || '.' || relation.relname,
           coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
           acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(relation.relacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = any($1::text[])
      and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and acl.grantee <> relation.relowner

    union all
    select 'column',
           namespace.nspname || '.' || relation.relname || '.' || attribute.attname,
           coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
           acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = any($1::text[])
      and attribute.attnum > 0
      and not attribute.attisdropped
      and acl.grantee <> relation.relowner

    union all
    select 'routine',
           namespace.nspname || '.' || routine.proname || '(' ||
             pg_catalog.oidvectortypes(routine.proargtypes) || ')',
           coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
           acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(
      case
        when namespace.nspname = 'public'
          then coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        else routine.proacl
      end
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = any($1::text[])
      and routine.prokind in ('f', 'p')
      and acl.grantee <> routine.proowner

    union all
    select 'type', namespace.nspname || '.' || type.typname,
           coalesce(grantee.rolname, 'PUBLIC'), grantor.rolname,
           acl.privilege_type, acl.is_grantable
    from pg_catalog.pg_type type
    join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
    left join pg_catalog.pg_class composite on composite.oid = type.typrelid
    cross join lateral pg_catalog.aclexplode(
      coalesce(type.typacl, pg_catalog.acldefault('T', type.typowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = any($1::text[])
      and (
        (type.typtype in ('d', 'e', 'm', 'r') and type.typelem = 0 and type.typrelid = 0)
        or (type.typtype = 'c' and composite.relkind = 'c')
      )
      and acl.grantee <> type.typowner

    order by 1, 2, 3, 5, 4
  `, [TARGET_SCHEMAS]);

  const expectedRelations = [
    "app_runtime:public.audit_log:INSERT",
    "app_runtime:public.audit_log:SELECT",
    "app_runtime:public.domain_events:INSERT",
    "app_runtime:public.domain_events:SELECT",
    "app_runtime:public.membership:SELECT",
    "app_runtime:public.site:DELETE",
    "app_runtime:public.site:INSERT",
    "app_runtime:public.site:SELECT",
    "app_runtime:public.site:UPDATE",
    "app_runtime:public.user_identity:SELECT",
    "app_runtime:public.workspace:SELECT",
    "app_system:public.audit_log:INSERT",
    "app_system:public.audit_log:SELECT",
    "app_system:public.domain_events:INSERT",
    "app_system:public.domain_events:SELECT",
    "app_system:public.membership:DELETE",
    "app_system:public.membership:INSERT",
    "app_system:public.membership:SELECT",
    "app_system:public.membership:UPDATE",
    "app_system:public.user_identity:INSERT",
    "app_system:public.user_identity:SELECT",
    "app_system:public.workspace:INSERT",
    "app_system:public.workspace:SELECT",
    "app_system:public.workspace:UPDATE",
    "identity_reconciler:public.membership:SELECT",
    "identity_reconciler:public.user_identity:INSERT",
    "identity_reconciler:public.user_identity:SELECT",
    "identity_reconciler:public.user_identity:UPDATE",
    ...["auth_account", "auth_rate_limit", "auth_session", "auth_user", "auth_verification"]
      .flatMap((table) => ["DELETE", "INSERT", "SELECT", "UPDATE"]
        .map((privilege) => `app_auth:public.${table}:${privilege}`)),
  ].map((entry) => {
    const [grantee, objectName, privilege] = entry.split(":");
    return `relation:${objectName}:${grantee}:app_owner:${privilege}:false`;
  });

  const expected = [
    `database:${currentDatabase}:PUBLIC:app_owner:CONNECT:false`,
    "schema:public:app_auth:app_owner:USAGE:false",
    "schema:public:app_runtime:app_owner:USAGE:false",
    "schema:public:app_system:app_owner:USAGE:false",
    "schema:public:identity_reconciler:app_owner:USAGE:false",
    "routine:public.app_actor_id():app_runtime:app_owner:EXECUTE:false",
    "routine:public.app_actor_id():app_system:app_owner:EXECUTE:false",
    "routine:public.reconcile_user_identity(text, text):app_auth:identity_reconciler:EXECUTE:false",
    ...expectedRelations,
  ];
  const actual = result.rows.map((row) =>
    `${row.object_kind}:${row.object_name}:${row.grantee}:${row.grantor}:` +
      `${row.privilege_type}:${row.is_grantable}`,
  );
  assertExactRows(actual, expected, "Exakter ACL-Vertrag");
}

async function assertOwnershipContract(client: PoolClient): Promise<void> {
  const drift = await client.query<OwnerDriftRow>(`
    select 'database'::text as object_kind,
           d.datname as object_name,
           owner.rolname as actual_owner,
           $1::text as expected_owner
    from pg_catalog.pg_database d
    join pg_catalog.pg_roles owner on owner.oid = d.datdba
    where d.datname = pg_catalog.current_database()
      and owner.rolname <> $1

    union all

    select 'schema',
           n.nspname,
           owner.rolname,
           case when n.nspname = 'pgboss' then $2::text else $1::text end
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
    where n.nspname = any($3::text[])
      and owner.rolname <> case when n.nspname = 'pgboss' then $2 else $1 end

    union all

    select 'relation',
           n.nspname || '.' || c.relname,
           owner.rolname,
           case when n.nspname = 'pgboss' then $2::text else $1::text end
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    where n.nspname = any($3::text[])
      and owner.rolname <> case when n.nspname = 'pgboss' then $2 else $1 end

    union all

    select 'routine',
           n.nspname || '.' || p.proname || '(' ||
             pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           owner.rolname,
           case
             when n.nspname = 'pgboss' then $2::text
             when p.oid = pg_catalog.to_regprocedure(
               'public.reconcile_user_identity(text,text)'
             )
               then $4::text
             else $1::text
           end
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where n.nspname = any($3::text[])
      and p.prokind in ('f', 'p')
      and owner.rolname <> case
        when n.nspname = 'pgboss' then $2
        when p.oid = pg_catalog.to_regprocedure(
          'public.reconcile_user_identity(text,text)'
        )
          then $4
        else $1
      end

    union all

    select 'type',
           n.nspname || '.' || t.typname,
           owner.rolname,
           case when n.nspname = 'pgboss' then $2::text else $1::text end
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = t.typowner
    where n.nspname = any($3::text[])
      and owner.rolname <> case when n.nspname = 'pgboss' then $2 else $1 end
    order by 1, 2
  `, [APP_OWNER, APP_WORKER, TARGET_SCHEMAS, IDENTITY_RECONCILER]);

  if (drift.rowCount !== 0) {
    const details = drift.rows
      .slice(0, 12)
      .map(
        (row) =>
          `${row.object_kind}:${row.object_name}=${row.actual_owner}, erwartet ${row.expected_owner}`,
      )
      .join("; ");
    fail(`Ownership-Assertion vor COMMIT fehlgeschlagen: ${details}.`);
  }
}

async function countLegacyAclEdges(client: PoolClient, legacyRole: string): Promise<number> {
  const result = await client.query<CountRow>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    ), acl_edges as (
      select acl.grantee, acl.grantor
      from pg_catalog.pg_database d
      cross join lateral pg_catalog.aclexplode(d.datacl) acl
      where d.datname = pg_catalog.current_database()

      union all

      select acl.grantee, acl.grantor
      from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(n.nspacl) acl

      union all

      select acl.grantee, acl.grantor
      from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(c.relacl) acl

      union all

      select acl.grantee, acl.grantor
      from pg_catalog.pg_attribute a
      cross join lateral pg_catalog.aclexplode(a.attacl) acl
      where a.attnum > 0 and not a.attisdropped

      union all

      select acl.grantee, acl.grantor
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(p.proacl) acl
      where p.prokind in ('f', 'p')

      union all

      select acl.grantee, acl.grantor
      from pg_catalog.pg_type t
      cross join lateral pg_catalog.aclexplode(t.typacl) acl
    )
    select count(*)::int as n
    from acl_edges acl
    cross join legacy
    where acl.grantee = legacy.oid or acl.grantor = legacy.oid
  `, [legacyRole]);
  return result.rows[0]?.n ?? -1;
}

async function assertNoLegacyDefaultAcls(client: PoolClient, legacyRole: string): Promise<void> {
  const result = await client.query<CountRow>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    )
    select count(*)::int as n
    from pg_catalog.pg_default_acl defaults
    cross join legacy
    left join lateral pg_catalog.aclexplode(defaults.defaclacl) acl on true
    where defaults.defaclrole = legacy.oid
       or acl.grantee = legacy.oid
       or acl.grantor = legacy.oid
  `, [legacyRole]);
  if (result.rows[0]?.n !== 0) {
    fail("Legacy-Default-ACLs liegen außerhalb des expliziten Objekt-ACL-Cutovers vor.");
  }
}

async function assertLegacyMembershipRemainder(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
): Promise<void> {
  const actual = await loadMembershipContract(client, [options.legacyRole]);
  const expected = options.provisioningTopology?.retainedLegacyRole
    ? [
        `identity_reconciler>${options.legacyRole}@` +
          `${options.provisioningTopology.bootstrapGrantorRole}:true/false/false`,
      ]
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "Legacy-Membership-Restvertrag weicht ab. " +
        `Erwartet: ${expected.join(", ") || "-"}; ist: ${actual.join(", ") || "-"}.`,
    );
  }
}

async function assertNoIncomingLegacyMemberships(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const result = await client.query<{
    member_role: string;
    grantor_role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(`
    select member.rolname as member_role,
           grantor.rolname as grantor_role,
           membership.admin_option,
           membership.inherit_option,
           membership.set_option
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
    where granted.rolname = $1
    order by member.rolname, grantor.rolname
  `, [legacyRole]);
  if (result.rowCount !== 0) {
    fail(
      "Eingehende Legacy-Memberships öffnen einen nach NOLOGIN unsichtbaren SET-ROLE-Pfad: " +
        result.rows.map((row) =>
          `${row.member_role}<-${row.grantor_role}:` +
          `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
        ).join(", ") + ". Diese Kanten und betroffene Sessions müssen vorab separat entfernt werden.",
    );
  }
}

async function assertNoLegacySharedDependencies(
  client: PoolClient,
  legacyRole: string,
): Promise<void> {
  const result = await client.query<{
    database_scope: string;
    catalog_name: string;
    object_oid: string;
    dependency_type: string;
  }>(`
    with legacy as (
      select oid from pg_catalog.pg_roles where rolname = $1
    )
    select case
             when dependency.dbid = 0 then 'cluster'
             else coalesce(database.datname, 'database_oid=' || dependency.dbid::text)
           end as database_scope,
           dependency.classid::pg_catalog.regclass::text as catalog_name,
           dependency.objid::text as object_oid,
           dependency.deptype::text as dependency_type
    from pg_catalog.pg_shdepend dependency
    cross join legacy
    left join pg_catalog.pg_database database on database.oid = dependency.dbid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = legacy.oid
    order by database_scope, catalog_name, object_oid, dependency_type
  `, [legacyRole]);
  if (result.rowCount !== 0) {
    fail(
      "Nach dem Cutover verbleiben clusterweite Legacy-Abhängigkeiten: " +
        result.rows
          .slice(0, 16)
          .map((row) =>
            `${row.database_scope}:${row.catalog_name}:${row.object_oid}:${row.dependency_type}`,
          )
          .join(", ") + ".",
    );
  }
}

async function loadMembershipContract(
  client: PoolClient,
  roleNames: readonly string[],
): Promise<string[]> {
  const result = await client.query<MembershipContractRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role,
           membership.admin_option,
           membership.inherit_option,
           membership.set_option
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles member on member.oid = membership.member
    join pg_catalog.pg_roles grantor on grantor.oid = membership.grantor
    where granted.rolname = any($1::text[])
       or member.rolname = any($1::text[])
       or grantor.rolname = any($1::text[])
    order by granted.rolname, member.rolname, membership.grantor
  `, [roleNames]);
  return result.rows
    .map(
      (row) =>
        `${row.granted_role}>${row.member_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    )
    .sort();
}

function targetMembershipSignatures(options: LegacyRoleCutoverOptions): string[] {
  if (options.provisioningTopology) {
    return expectedDbRoleMembershipSignatures(options.provisioningTopology);
  }
  return [
    `app_membership_writer>app_owner@${options.expectedAdminRole}:false/false/false`,
    `app_membership_writer>app_system@${options.expectedAdminRole}:false/false/false`,
    `app_owner>app_migrator@${options.expectedAdminRole}:false/false/true`,
    `identity_reconciler>app_owner@${options.expectedAdminRole}:true/false/false`,
  ].sort();
}

async function assertPreCutoverMembershipContract(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
): Promise<void> {
  const actual = await loadMembershipContract(client, [options.legacyRole, ...PROTECTED_ROLES]);
  const bootstrapEdge =
    `identity_reconciler>${options.legacyRole}@` +
    `${options.expectedIdentityBootstrapGrantorRole}:true/false/false`;
  const expected = [
    ...targetMembershipSignatures(options),
    `identity_reconciler>${options.legacyRole}@${options.legacyRole}:false/false/false`,
  ].sort();
  if (!expected.includes(bootstrapEdge)) expected.push(bootstrapEdge);
  expected.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "Pre-Cutover-Membership-Vertrag weicht vor der Quarantäne ab. " +
      `Erwartet: ${expected.join(", ")}; ist: ${actual.join(", ")}.`,
    );
  }
}

async function assertTargetMembershipContract(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
): Promise<void> {
  const actual = await loadMembershipContract(client, [options.legacyRole, ...PROTECTED_ROLES]);
  const expected = targetMembershipSignatures(options).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "Ziel-Membership-Vertrag weicht vor COMMIT ab. " +
        `Erwartet: ${expected.join(", ")}; ist: ${actual.join(", ")}.`,
    );
  }
}

async function assertHardenedRoles(client: PoolClient, legacyRole: string): Promise<void> {
  const roles = await loadRequiredRoles(client, legacyRole);
  const legacy = roles.get(legacyRole)!;
  const reconciler = roles.get(IDENTITY_RECONCILER)!;
  if (legacy.rolcanlogin || legacy.rolinherit || hasElevatedAttributes(legacy)) {
    fail("Legacy-Rolle ist vor COMMIT nicht vollständig NOLOGIN/NOINHERIT/unprivilegiert.");
  }
  if (reconciler.rolcanlogin || reconciler.rolinherit || hasElevatedAttributes(reconciler)) {
    fail("identity_reconciler ist vor COMMIT nicht vollständig NOLOGIN/NOINHERIT/unprivilegiert.");
  }
  assertTargetRolePreconditions(roles, legacyRole);
}

interface CutoverPreflightResult {
  snapshots: CutoverSnapshots;
}

function assertSamePreflightSnapshots(
  beforeFreeze: CutoverSnapshots,
  afterFreeze: CutoverSnapshots,
): void {
  if (JSON.stringify(beforeFreeze) !== JSON.stringify(afterFreeze)) {
    fail(
      "Stichproben/Journal änderten sich zwischen erstem Read-only-Preflight " +
        "und dem vollständigen Preflight nach Control-Freeze.",
    );
  }
}

async function assertCutoverReadOnlyPreflight(
  client: PoolClient,
  options: LegacyRoleCutoverOptions,
  flags: {
    requireQuarantined: boolean;
    requireDrained: boolean;
    requireDatabaseQuarantined: boolean;
    requireAllowConnections: boolean;
    lockSamples: boolean;
  },
): Promise<CutoverPreflightResult> {
  await assertAdminAndDatabase(client, options);
  await assertDatabaseState(
    client,
    options,
    flags.requireAllowConnections,
    flags.requireDatabaseQuarantined ? 0 : options.expectedDatabaseConnectionLimit,
    "Cutover-Preflight",
  );
  const roles = await loadRequiredRoles(client, options.legacyRole);
  assertTargetRolePreconditions(roles, options.legacyRole);
  if (flags.requireQuarantined) {
    assertLegacyRolesQuarantined(roles, options.legacyRole);
  }
  await assertNoIncomingLegacyMemberships(client, options.legacyRole);
  await assertPreCutoverMembershipContract(client, options);
  if (flags.requireDrained) {
    await assertNoActiveRoleSessions(client, [options.legacyRole, IDENTITY_RECONCILER]);
    await assertExclusiveTargetDatabaseSession(client);
    await lockTargetDataRelations(client);
  }
  await assertNoOtherClusterScope(client, options.expectedDatabase, options.legacyRole);
  await assertNoLegacyTablespaceAcls(client, options.legacyRole);
  await assertSupportedOwnershipScope(client, options.legacyRole);
  await assertNoUnsupportedRoleBoundObjects(client, options.legacyRole);
  await assertNoLegacyDefaultAcls(client, options.legacyRole);
  await verifyAppliedMigrationHistory(client, { requireJournal: true });
  const journal = await assertLegacyJournal(client);
  await assertLegacyLive0018Contract(client, options.legacyRole);
  const snapshots = await readSamples(client, options.sample, journal, flags.lockSamples);
  return { snapshots };
}

/**
 * Atomarer 0018-Legacy-Cutover. Der übergebene PoolClient muss idle sein und
 * darf nicht bereits in einer Transaktion stehen. Die Funktion eröffnet genau
 * eine Transaktion und rollt bei jedem Fehler vollständig zurück.
 */
export async function cutoverLegacyDatabaseRole(
  target: PoolClient,
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  connectFreshControl?: FreshControlClientFactory,
): Promise<LegacyRoleCutoverResult> {
  validateOptions(options);
  await assertCutoverControlPlane(target, control, options);
  const trustedControlAttestation = await loadClusterAttestation(control);
  await assertDatabaseState(control, options, false, 0, "Phase-2-Control-Vorgate");
  await assertDatabaseState(target, options, false, 0, "Phase-2-Target-Vorgate");
  let transactionStarted = false;
  let targetCommitSucceeded = false;

  try {
    await target.query("begin isolation level serializable");
    transactionStarted = true;
    await target.query("set local lock_timeout = '5s'");
    await target.query("set local statement_timeout = '300s'");
    await target.query("set local idle_in_transaction_session_timeout = '60s'");
    await target.query("set local timezone = 'UTC'");
    await target.query("select pg_catalog.pg_advisory_xact_lock($1, $2)", [
      CUTOVER_LOCK_KEY_1,
      CUTOVER_LOCK_KEY_2,
    ]);

    const { snapshots } = await assertCutoverReadOnlyPreflight(target, options, {
      requireQuarantined: true,
      requireDrained: true,
      requireDatabaseQuarantined: true,
      requireAllowConnections: false,
      lockSamples: true,
    });

    // ACLs müssen vor ALTER OWNER verschwinden: PostgreSQL schreibt sonst den
    // alten Grantor auf den neuen Owner um und ein Legacy→Rogue-Grant würde als
    // scheinbar legitimer app_owner-Grant weiterleben.
    const revokedAclEntries = await revokeLegacyAcls(target, options.legacyRole);
    const revokedMembershipEdges = await revokeLegacyMemberships(target, options);
    const transferred = await transferOwnership(
      target,
      options.expectedDatabase,
      options.legacyRole,
    );
    await hardenClusterRoles(target, options.legacyRole);
    await assertOwnershipContract(target);

    // Erwartete 0018-Rechte werden bewusst unter ihren Ziel-Grantors neu
    // aufgebaut. Delegierte Fremdrechte werden nicht mitmigriert.
    await target.query(`set local role ${quoteIdentifier(APP_OWNER)}`);
    await target.query(
      `grant usage, create on schema public, drizzle to ${quoteIdentifier(APP_OWNER)}`,
    );
    await target.query(
      `revoke temporary on database ${quoteIdentifier(options.expectedDatabase)} from public`,
    );
    await target.query(
      `grant connect on database ${quoteIdentifier(options.expectedDatabase)} to public`,
    );
    await target.query(
      `grant create on database ${quoteIdentifier(options.expectedDatabase)} to ${quoteIdentifier(APP_OWNER)}`,
    );
    await applyDefaultPrivilegeContract(target);
    await target.query(`set local role ${quoteIdentifier(APP_WORKER)}`);
    await target.query(
      `grant usage, create on schema pgboss to ${quoteIdentifier(APP_WORKER)}`,
    );
    // Ein NULL-typacl bedeutet bei PostgreSQL nicht "keine Rechte", sondern
    // den Default PUBLIC USAGE. Der Enum-Vertrag wird deshalb explizit eng.
    await target.query("revoke usage on type pgboss.job_state from public");
    await target.query(`set local role ${quoteIdentifier(APP_OWNER)}`);
    const manifestIdentity = await target.query<{
      current_role: string;
      schema_owner: string;
      schema_usage: boolean;
    }>(`
      select current_user as current_role,
             owner.rolname as schema_owner,
             pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE') as schema_usage
      from pg_catalog.pg_namespace namespace
      join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
      where namespace.nspname = 'public'
    `);
    const manifestPrincipal = manifestIdentity.rows[0];
    if (
      manifestPrincipal?.current_role !== APP_OWNER ||
      manifestPrincipal.schema_owner !== APP_OWNER ||
      !manifestPrincipal.schema_usage
    ) {
      fail(`app_owner kann das ACL-Manifest nicht sicher anwenden: ${JSON.stringify(manifestPrincipal)}.`);
    }
    await applyRoleContract(target);
    // Das Manifest endet absichtlich als app_owner (für den normalen Migrator).
    // Der Cutover-Admin muss für die nachgelagerten, actorlosen RLS-Stichproben
    // wieder session_user sein; sonst liefert FORCE RLS hier korrekt null Zeilen.
    await target.query("reset role");
    await verifyDefaultPrivilegeContract(target);
    await verifyCutoverAclContract(target);

    await assertOwnershipContract(target);
    const remainingAclEdges = await countLegacyAclEdges(target, options.legacyRole);
    if (remainingAclEdges !== 0) {
      fail(`${remainingAclEdges} Legacy-ACL-Kanten verbleiben vor COMMIT.`);
    }
    await assertLegacyMembershipRemainder(target, options);
    await assertNoLegacySharedDependencies(target, options.legacyRole);
    await assertTargetMembershipContract(target, options);
    await assertHardenedRoles(target, options.legacyRole);
    await assertSamplesUnchanged(target, options.sample, snapshots);
    await assertNoActiveRoleSessions(target, [options.legacyRole, IDENTITY_RECONCILER]);
    await assertExclusiveTargetDatabaseSession(target);

    // ALLOW_CONNECTIONS und der öffentliche CONNECTION LIMIT bleiben bis zum
    // bekannten erfolgreichen Target-COMMIT unverändert fail-closed. Nur die
    // separate Control-Verbindung darf sie anschließend wiederherstellen.
    await target.query("commit");
    transactionStarted = false;
    targetCommitSucceeded = true;
    const result = {
      database: options.expectedDatabase,
      legacyRole: options.legacyRole,
      transferredRelations: transferred.relations,
      transferredRoutines: transferred.routines,
      transferredTypes: transferred.types,
      revokedAclEntries,
      revokedMembershipEdges,
      sample: { ...options.sample },
    };
    await assertDatabaseState(control, options, false, 0, "Nach Target-COMMIT");
    await restoreTargetAvailability(control, options, 0);
    await assertDatabaseState(
      target,
      options,
      true,
      options.expectedDatabaseConnectionLimit,
      "Target nach Control-Unfreeze",
    );
    return result;
  } catch (error) {
    if (transactionStarted) await target.query("rollback").catch(() => undefined);
    if (error instanceof AmbiguousControlCommitError) {
      const recovery = await reattestAndRefreezeTarget(
        control,
        options,
        error.trustedAttestation,
        error,
        connectFreshControl,
      );
      throw failClosedFreezeError(
        recovery.detail,
        options,
        targetCommitSucceeded,
        recovery.confirmed,
      );
    }
    const recovery = await confirmTargetFrozenAfterControlFailure(
      control,
      options,
      trustedControlAttestation,
      error,
      connectFreshControl,
    );
    throw failClosedFreezeError(
      recovery.detail,
      options,
      targetCommitSucceeded,
      recovery.confirmed,
    );
  }
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) fail(`${name} ist nicht gesetzt.`);
  return value;
}

function assertDirectAdminUrl(label: string, url: URL): void {
  if (!url.password) fail(`${label} muss ein explizites Secret enthalten.`);
  if (url.searchParams.get("sslmode") !== "verify-full") {
    fail(`${label} muss sslmode=verify-full erzwingen.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (/(^|[.-])pooler([.-]|$)/.test(hostname) || hostname.includes("-pooler")) {
    fail(`${label} muss den direkten, ungepoolten Endpunkt verwenden.`);
  }
}

function sanitizedErrorMessage(error: unknown, rawUrls: readonly string[]): string {
  const message = error instanceof Error ? error.message : "Unbekannter Fehler";
  let sanitized = message;
  for (const rawUrl of rawUrls) {
    sanitized = sanitized.replaceAll(rawUrl, "[POSTGRES_URL_CUTOVER]");
    try {
      const url = new URL(rawUrl);
      if (url.password) {
        sanitized = sanitized
          .replaceAll(url.password, "[REDACTED]")
          .replaceAll(decodeURIComponent(url.password), "[REDACTED]");
      }
    } catch {
      // Die URL-Validierung liefert bereits eine secret-freie Fehlermeldung.
    }
  }
  return sanitized;
}

export async function recoverLegacyCutoverConnections(
  control: PoolClient,
  options: LegacyRoleCutoverOptions,
  confirmation: string,
  connectFreshControl?: FreshControlClientFactory,
): Promise<void> {
  validateOptions(options);
  if (confirmation !== recoveryConfirmation(options)) {
    fail(`Recovery-Bestätigung muss exakt ${recoveryConfirmation(options)} sein.`);
  }
  await assertAdminAndDatabase(control, options, options.expectedControlDatabase);
  const trustedControlAttestation = await loadClusterAttestation(control);
  const state = await loadDatabaseState(control, options.expectedDatabase);
  if (
    state.datallowconn ||
    (state.datconnlimit !== 0 &&
      state.datconnlimit !== options.expectedDatabaseConnectionLimit)
  ) {
    fail(
      "Recovery akzeptiert ausschließlich ein bereits fail-closed eingefrorenes Target " +
        "mit CONNECTION LIMIT 0 oder dem exakt bestätigten Ausgangswert.",
    );
  }
  try {
    await restoreTargetAvailability(control, options, state.datconnlimit);
  } catch (error) {
    if (error instanceof AmbiguousControlCommitError) {
      const recovery = await reattestAndRefreezeTarget(
        control,
        options,
        error.trustedAttestation,
        error,
        connectFreshControl,
      );
      throw failClosedFreezeError(
        recovery.detail,
        options,
        false,
        recovery.confirmed,
      );
    }
    const recovery = await confirmTargetFrozenAfterControlFailure(
      control,
      options,
      trustedControlAttestation,
      error,
      connectFreshControl,
    );
    throw failClosedFreezeError(recovery.detail, options, false, recovery.confirmed);
  }
}

export async function runLegacyRoleCutoverCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rawUrl = requireEnvironment(env, "POSTGRES_URL_CUTOVER_ADMIN");
  const rawControlUrl = requireEnvironment(env, "POSTGRES_URL_CUTOVER_CONTROL");
  try {
    assertNoAmbientPostgresOverrides("POSTGRES_URL_CUTOVER_ADMIN");
    const url = parsePostgresConnectionUrl("POSTGRES_URL_CUTOVER_ADMIN", rawUrl);
    const controlUrl = parsePostgresConnectionUrl(
      "POSTGRES_URL_CUTOVER_CONTROL",
      rawControlUrl,
    );
    assertDirectAdminUrl("POSTGRES_URL_CUTOVER_ADMIN", url);
    assertDirectAdminUrl("POSTGRES_URL_CUTOVER_CONTROL", controlUrl);

    const target = postgresConnectionTarget(url);
    const controlTarget = postgresConnectionTarget(controlUrl);
    const expectedAdminRole = decodeURIComponent(url.username);
    if (
      target.host !== controlTarget.host ||
      target.port !== controlTarget.port ||
      expectedAdminRole !== decodeURIComponent(controlUrl.username)
    ) {
      fail(
        "Target-/Control-URL müssen exakt denselben direkten Host, Port und Admin-Principal verwenden.",
      );
    }
    if (target.database === controlTarget.database) {
      fail("POSTGRES_URL_CUTOVER_CONTROL muss auf eine andere Datenbank zeigen.");
    }

    const expectedDatabase = requireEnvironment(env, "CUTOVER_EXPECTED_DATABASE");
    const expectedDatabaseConnectionLimitRaw = requireEnvironment(
      env,
      "CUTOVER_EXPECTED_DATABASE_CONNECTION_LIMIT",
    );
    if (!/^-1$|^[1-9][0-9]*$/.test(expectedDatabaseConnectionLimitRaw)) {
      fail(
        "CUTOVER_EXPECTED_DATABASE_CONNECTION_LIMIT muss -1 oder eine positive Ganzzahl sein.",
      );
    }
    const expectedDatabaseConnectionLimit = Number(expectedDatabaseConnectionLimitRaw);
    const legacyRole = requireEnvironment(env, "CUTOVER_LEGACY_ROLE");
    const targetKey = postgresConnectionTargetKey(url);
    const expectedTargetKey = requireEnvironment(env, "CUTOVER_EXPECTED_TARGET");
    if (expectedTargetKey !== targetKey) {
      fail(`CUTOVER_EXPECTED_TARGET muss exakt ${targetKey} sein.`);
    }
    const controlTargetKey = postgresConnectionTargetKey(controlUrl);
    if (requireEnvironment(env, "CUTOVER_EXPECTED_CONTROL_TARGET") !== controlTargetKey) {
      fail(`CUTOVER_EXPECTED_CONTROL_TARGET muss exakt ${controlTargetKey} sein.`);
    }
    const scopeConfirmation = requireEnvironment(
      env,
      "CUTOVER_LEGACY_ROLE_SCOPE_CONFIRMED",
    );
    const expectedScope = expectedClusterWideNoLoginRoles(legacyRole).join(",");
    if (scopeConfirmation !== expectedScope) {
      fail(`CUTOVER_LEGACY_ROLE_SCOPE_CONFIRMED muss exakt ${expectedScope} sein.`);
    }

    const expectedConfirmation = `${targetKey}:${legacyRole}:OWNERSHIP-CUTOVER`;
    if (requireEnvironment(env, "CUTOVER_CONFIRM") !== expectedConfirmation) {
      fail(`CUTOVER_CONFIRM muss exakt ${expectedConfirmation} sein.`);
    }

    if (target.database !== expectedDatabase) {
      fail(
        `URL-Datenbank ${target.database} stimmt nicht mit ` +
          `CUTOVER_EXPECTED_DATABASE=${expectedDatabase} überein.`,
      );
    }

    const provisioningTopology = dbRoleProvisioningTopologyFromEnvironment(env);
    const options: LegacyRoleCutoverOptions = {
      expectedDatabase,
      expectedControlDatabase: controlTarget.database,
      expectedDatabaseConnectionLimit,
      legacyRole,
      expectedAdminRole,
      expectedIdentityBootstrapGrantorRole: requireEnvironment(
        env,
        "CUTOVER_EXPECTED_IDENTITY_BOOTSTRAP_GRANTOR",
      ),
      ...(provisioningTopology ? { provisioningTopology } : {}),
      confirmedClusterWideNoLoginRoles: scopeConfirmation.split(","),
      sample: {
        workspaceId: requireEnvironment(env, "CUTOVER_SAMPLE_WORKSPACE_ID"),
        userId: requireEnvironment(env, "CUTOVER_SAMPLE_USER_ID"),
        pgBossJobId: requireEnvironment(env, "CUTOVER_PGBOSS_JOB_ID"),
      },
    };

    const targetPool = new Pool({
      ...postgresConnectionTransport("POSTGRES_URL_CUTOVER_ADMIN", rawUrl),
      max: 1,
      connectionTimeoutMillis: 10_000,
      lock_timeout: 5_000,
      statement_timeout: 300_000,
      idle_in_transaction_session_timeout: 60_000,
    });
    const controlPool = new Pool({
      ...postgresConnectionTransport("POSTGRES_URL_CUTOVER_CONTROL", rawControlUrl),
      // Kapazität für die Einweg-Recovery einer verlorenen Control-Antwort.
      // Die kompromittierte Session wird vor dem Fresh-Connect zerstört, damit
      // eine offene Transaktion keinen Kataloglock halten kann.
      max: 2,
      connectionTimeoutMillis: 10_000,
      lock_timeout: 5_000,
      statement_timeout: 300_000,
      idle_in_transaction_session_timeout: 60_000,
    });
    try {
      const control = await controlPool.connect();
      let controlDiscarded = false;
      const connectFreshControl: FreshControlClientFactory = async (compromised) => {
        if (compromised !== control) {
          fail("Fresh-Control-Factory erhielt nicht die ursprüngliche Control-Session.");
        }
        // Vor dem neuen Connect schließen: Ein unbestätigtes ROLLBACK kann
        // sonst weiterhin den pg_database-Kataloglock halten. Das Flag wird
        // vor release gesetzt, weil node-postgres einen zweiten Release auch
        // dann ablehnt, wenn der erste intern bereits begonnen hat.
        controlDiscarded = true;
        compromised.release(true);
        return controlPool.connect();
      };
      try {
        const recovery = env.CUTOVER_RECOVERY_CONFIRM;
        if (recovery) {
          await recoverLegacyCutoverConnections(
            control,
            options,
            recovery,
            connectFreshControl,
          );
          console.log(
            `Legacy-Cutover-Recovery verifiziert: database=${options.expectedDatabase}, ` +
              `allow_connections=true, connection_limit=${options.expectedDatabaseConnectionLimit}.`,
          );
          return;
        }
        const targetClient = await targetPool.connect();
        try {
          await quarantineLegacyRoles(
            targetClient,
            control,
            options,
            connectFreshControl,
          );
          const result = await cutoverLegacyDatabaseRole(
            targetClient,
            control,
            options,
            connectFreshControl,
          );
          console.log(
            `Legacy-Cutover verifiziert: database=${result.database}, role=${result.legacyRole}, ` +
              `relations=${result.transferredRelations}, routines=${result.transferredRoutines}, ` +
              `types=${result.transferredTypes}, acl=${result.revokedAclEntries}, ` +
              `memberships=${result.revokedMembershipEdges}.`,
          );
        } finally {
          targetClient.release();
        }
      } finally {
        if (!controlDiscarded) control.release();
      }
    } finally {
      await Promise.allSettled([targetPool.end(), controlPool.end()]);
    }
  } catch (error) {
    throw new Error(sanitizedErrorMessage(error, [rawUrl, rawControlUrl]));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runLegacyRoleCutoverCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Legacy-Cutover fehlgeschlagen.";
    console.error(message);
    process.exitCode = 1;
  });
}
