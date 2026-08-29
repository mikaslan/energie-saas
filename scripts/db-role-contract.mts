import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

export const STRICT_DB_ROLE_MODE = "strict" as const;
export const TEST_DB_ROLE_MODE = "test-legacy-single" as const;

export type DbRoleMode = typeof STRICT_DB_ROLE_MODE | typeof TEST_DB_ROLE_MODE;

const APP_ROLES = [
  "app_owner",
  "app_migrator",
  "app_runtime",
  "app_system",
  "app_auth",
  "app_worker",
  "app_membership_writer",
  "identity_reconciler",
] as const;

const LOGIN_APP_ROLES = new Set([
  "app_migrator",
  "app_runtime",
  "app_system",
  "app_auth",
  "app_worker",
]);

const LOCAL_SUPERUSER_PROVISIONING_ROLE = "postgres";
const SAFE_ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export interface DbRoleProvisioningTopology {
  /** SQL-Admin, der die Zielrollen angelegt und die Fachkanten erteilt hat. */
  provisioningAdminRole: string;
  /** Grantor der von PostgreSQL 18 automatisch angelegten ADMIN-Kanten. */
  bootstrapGrantorRole: string;
  /**
   * Nur nach einem Legacy-Cutover: gehärtete Altrolle, deren unverfügbare
   * identity_reconciler-Bootstrapkante exakt erhalten bleibt.
   */
  retainedLegacyRole?: string;
}

function assertContractRoleName(label: string, value: string): void {
  if (!SAFE_ROLE_NAME.test(value)) {
    throw new Error(`${label} ist kein sicherer PostgreSQL-Rollenname.`);
  }
  if ((APP_ROLES as readonly string[]).includes(value)) {
    throw new Error(`${label} darf keine geschützte App-Zielrolle benennen.`);
  }
}

export function validateDbRoleProvisioningTopology(
  topology: DbRoleProvisioningTopology,
): void {
  assertContractRoleName("provisioningAdminRole", topology.provisioningAdminRole);
  assertContractRoleName("bootstrapGrantorRole", topology.bootstrapGrantorRole);
  if (topology.provisioningAdminRole === topology.bootstrapGrantorRole) {
    throw new Error(
      "Provisioning-Admin und Bootstrap-Grantor müssen im Providervertrag verschieden sein.",
    );
  }
  if (topology.retainedLegacyRole) {
    assertContractRoleName("retainedLegacyRole", topology.retainedLegacyRole);
    if (
      topology.retainedLegacyRole === topology.provisioningAdminRole ||
      topology.retainedLegacyRole === topology.bootstrapGrantorRole
    ) {
      throw new Error("Die retainedLegacyRole muss von Provisioning-Admin/Bootstrap verschieden sein.");
    }
  }
}

export function dbRoleProvisioningTopologyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DbRoleProvisioningTopology | undefined {
  const provisioningAdminRole = env.DB_ROLE_PROVISIONING_ADMIN;
  const bootstrapGrantorRole = env.DB_ROLE_BOOTSTRAP_GRANTOR;
  const retainedLegacyRole = env.DB_ROLE_RETAINED_LEGACY_ROLE;
  if (!provisioningAdminRole && !bootstrapGrantorRole && !retainedLegacyRole) return undefined;
  if (!provisioningAdminRole || !bootstrapGrantorRole) {
    throw new Error(
      "DB_ROLE_PROVISIONING_ADMIN und DB_ROLE_BOOTSTRAP_GRANTOR müssen gemeinsam gesetzt sein; " +
        "DB_ROLE_RETAINED_LEGACY_ROLE ist nur zusammen mit beiden zulässig.",
    );
  }
  const topology: DbRoleProvisioningTopology = {
    provisioningAdminRole,
    bootstrapGrantorRole,
    ...(retainedLegacyRole ? { retainedLegacyRole } : {}),
  };
  validateDbRoleProvisioningTopology(topology);
  return topology;
}

/** Grantor-genauer Zielvertrag für alle Membership-Kanten der App-Rollen. */
export function expectedDbRoleMembershipSignatures(
  topology?: DbRoleProvisioningTopology,
): string[] {
  if (topology) validateDbRoleProvisioningTopology(topology);
  const provisioningAdmin = topology?.provisioningAdminRole ?? LOCAL_SUPERUSER_PROVISIONING_ROLE;
  const identityOwnerGrantor = topology?.retainedLegacyRole
    ? topology.bootstrapGrantorRole
    : provisioningAdmin;
  const signatures = [
    `app_membership_writer>app_owner@${provisioningAdmin}:false/false/false`,
    `app_membership_writer>app_system@${provisioningAdmin}:false/false/false`,
    `app_owner>app_migrator@${provisioningAdmin}:false/false/true`,
    `identity_reconciler>app_owner@${identityOwnerGrantor}:true/false/false`,
  ];
  if (!topology) return signatures.sort();

  for (const roleName of APP_ROLES) {
    // Im Legacy-Cutover existiert identity_reconciler bereits. PostgreSQL hat
    // deshalb keine CREATE-ROLE-Bootstrapkante zum neuen Provisioning-Admin
    // angelegt; ausschließlich die historische Kante zur retained Legacy-
    // Rolle bleibt erhalten. Alle im Cutover frisch angelegten App-Rollen
    // besitzen dagegen weiterhin ihre providerseitige Bootstrapkante.
    if (topology.retainedLegacyRole && roleName === "identity_reconciler") continue;
    signatures.push(
      `${roleName}>${topology.provisioningAdminRole}@${topology.bootstrapGrantorRole}:` +
        "true/false/false",
    );
  }
  for (const ownerRole of ["app_owner", "app_worker"] as const) {
    signatures.push(
      `${ownerRole}>${topology.provisioningAdminRole}@${topology.provisioningAdminRole}:` +
        "false/false/true",
    );
  }
  if (topology.retainedLegacyRole) {
    signatures.push(
      `identity_reconciler>${topology.retainedLegacyRole}@${topology.bootstrapGrantorRole}:` +
        "true/false/false",
    );
  }
  return signatures.sort();
}

const APPLY_DEFAULT_PRIVILEGE_CONTRACT_SQL = `
  alter default privileges for role app_owner
    revoke all on tables from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on tables from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on sequences from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on sequences from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on functions from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on functions from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on types from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on types from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_membership_writer, identity_reconciler;

  grant identity_reconciler to app_owner
    with inherit false, set true granted by current_user;
  set role identity_reconciler;
  alter default privileges
    revoke all on functions from public, app_owner, app_migrator, app_runtime,
      app_system, app_auth, app_worker, app_membership_writer;
  alter default privileges in schema public
    revoke all on functions from public, app_owner, app_migrator, app_runtime,
      app_system, app_auth, app_worker, app_membership_writer;
  set role app_owner;
  grant identity_reconciler to app_owner
    with inherit false, set false granted by current_user;
  revoke identity_reconciler from app_owner granted by app_owner;
`;

// Allowlist statt Default-Grants: Eine neue Tabelle beginnt ohne Runtime-Recht
// und macht den Rollenvertrag rot, bis sie bewusst einem Dienst zugeordnet ist.
// Das Manifest läuft nach JEDER strikten Migration innerhalb einer Transaktion.
const APPLY_ROLE_CONTRACT_SQL = `
  revoke all privileges on all tables in schema public
    from public, app_runtime, app_system, app_auth, app_worker, identity_reconciler;
  revoke all privileges on all sequences in schema public
    from public, app_runtime, app_system, app_auth, app_worker, identity_reconciler;

  -- Nach einem ALTER OWNER erbt der neue Owner nicht zwingend die zuvor vom
  -- Legacy-Owner widerrufenen Tabellen-ACLs. DDL ist zwar owner-inhaerent,
  -- ein spaeterer FK braucht aber explizit REFERENCES. Der Migrations-Owner
  -- erhaelt deshalb seine vollstaendigen Eigenrechte deterministisch zurueck.
  grant all privileges on all tables in schema public to app_owner;
  grant all privileges on all sequences in schema public to app_owner;

  revoke all on schema public from public, app_runtime, app_system, app_auth, app_worker;
  grant usage on schema public to app_runtime, app_system, app_auth, identity_reconciler;

  grant select on
    public.workspace,
    public.membership,
    public.user_identity,
    public.site,
    public.domain_events,
    public.audit_log
  to app_runtime;
  grant insert, update, delete on public.site to app_runtime;
  grant insert on public.domain_events, public.audit_log to app_runtime;

  grant select, insert, update on public.workspace to app_system;
  grant select, insert, update, delete on public.membership to app_system;
  grant select, insert on public.user_identity to app_system;
  grant select, insert on public.domain_events, public.audit_log to app_system;

  grant select on public.membership to identity_reconciler;
  grant select, insert, update on public.user_identity to identity_reconciler;

  grant select, insert, update, delete on
    public.auth_user,
    public.auth_session,
    public.auth_account,
    public.auth_verification,
    public.auth_rate_limit
  to app_auth;

  revoke execute on function public.forbid_mutation()
    from public, app_runtime, app_system, app_auth, app_worker;
  revoke execute on function public.user_identity_link_auth_only()
    from public, app_runtime, app_system, app_auth, app_worker;
  revoke execute on function public.app_actor_id()
    from public, app_runtime, app_system, app_auth, app_worker;
  revoke execute on function public.guard_membership_statement()
    from public, app_runtime, app_system, app_auth, app_worker;
  revoke execute on function public.guard_membership_dml()
    from public, app_runtime, app_system, app_auth, app_worker;
  grant execute on function public.app_actor_id() to app_runtime, app_system;

  grant identity_reconciler to app_owner
    with inherit false, set true granted by current_user;
  set role identity_reconciler;
  revoke execute on function public.reconcile_user_identity(text, text)
    from public, app_owner, app_runtime, app_system, app_worker;
  grant execute on function public.reconcile_user_identity(text, text) to app_auth;
  alter default privileges in schema public revoke execute on functions from public;
  set role app_owner;
  grant identity_reconciler to app_owner
    with inherit false, set false granted by current_user;
  -- PostgreSQL 18 speichert dieselbe Mitgliedschaft pro Grantor. Der
  -- kurzzeitige Self-Grant von app_owner wäre sonst eine zweite ACL-Zeile
  -- neben dem bootstrap-seitigen ADMIN-Grant. Nach dem Rückwechsel wird nur dieser
  -- temporäre Grantor-Pfad entfernt; ADMIN TRUE/SET FALSE des Bootstrap-
  -- Principals bleibt bestehen und trägt den nächsten Migrationslauf. SET ROLE
  -- app_owner statt RESET ROLE ist dabei tragend: RESET würde auf session_user
  -- (beim lokalen Cutover postgres) springen und einen falschen Grantor erzeugen.
  revoke identity_reconciler from app_owner granted by app_owner;
`;

interface RoleRow extends QueryResultRow {
  rolname: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
  rolvaliduntil: Date | string | null;
  rolconfig: string[] | null;
}

interface EffectiveRoleSettingRow extends QueryResultRow {
  principal: string;
  setting_scope: "global" | "database" | "role" | "role+database";
  settings: string | null;
}

interface StandaloneTypeRow extends QueryResultRow {
  schema_name: string;
  type_kind: string;
  type_name: string;
  owner: string;
  effective_acl: string;
}

interface MembershipRow extends QueryResultRow {
  granted_role: string;
  member_role: string;
  grantor_role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

interface EffectiveMembershipRow extends QueryResultRow {
  principal: string;
  membership_writer: boolean;
  neon_superuser: boolean;
}

interface AclRow extends QueryResultRow {
  grantee: string;
  grantor: string;
  object_name: string;
  privilege_type: string;
  is_grantable: boolean;
}

function equalRows(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(
      `${label} weicht vom Rollenvertrag ab.\nErwartet: ${e.join(", ")}\nIst: ${a.join(", ")}`,
    );
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Exakter Katalogvertrag aller App-Rollen. Neben den offensichtlichen
 * Privileg-Attributen sind CONNECTION LIMIT, Passwortablauf und beide
 * PostgreSQL-Setting-Speicher Teil der Trust Boundary: ein search_path- oder
 * row_security-Default darf nicht unbemerkt vor dem App-Code wirksam werden.
 */
export async function verifyAppRoleCatalogContract(
  client: PoolClient,
  label = "App-Rollen-Katalogvertrag",
): Promise<void> {
  const roles = await client.query<RoleRow>(`
    select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls,
           rolcreatedb, rolcreaterole, rolreplication, rolconnlimit,
           rolvaliduntil, rolconfig
    from pg_catalog.pg_roles
    where rolname = any($1::text[])
    order by rolname
  `, [APP_ROLES]);
  equalRows(
    roles.rows.map((role) => [
      role.rolname,
      String(role.rolcanlogin),
      String(role.rolinherit),
      String(role.rolsuper),
      String(role.rolbypassrls),
      String(role.rolcreatedb),
      String(role.rolcreaterole),
      String(role.rolreplication),
      String(role.rolconnlimit),
      role.rolvaliduntil === null ? "-" : String(role.rolvaliduntil),
      role.rolconfig === null ? "-" : `{${role.rolconfig.join(",")}}`,
    ].join(":")),
    APP_ROLES.map((roleName) => [
      roleName,
      String(LOGIN_APP_ROLES.has(roleName)),
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "-1",
      "-",
      "-",
    ].join(":")),
    `${label}: Rollenattribute`,
  );

  // Vier wirksame pg_db_role_setting-Sichten pro App-Rolle: clusterweit,
  // datenbankweit, rollenweit sowie Rolle+aktuelle Datenbank. setrole=0 ist
  // absichtlich enthalten; ein ALTER DATABASE würde sonst jede Dienstrolle
  // beeinflussen, ohne an deren eigener Katalogzeile sichtbar zu sein.
  const effectiveSettings = await client.query<EffectiveRoleSettingRow>(`
    select role_row.rolname as principal,
           case
             when setting.setrole = 0 and setting.setdatabase = 0 then 'global'
             when setting.setrole = 0 then 'database'
             when setting.setdatabase = 0 then 'role'
             else 'role+database'
           end as setting_scope,
           setting.setconfig::text as settings
    from pg_catalog.pg_roles role_row
    cross join pg_catalog.pg_database database_row
    cross join pg_catalog.pg_db_role_setting setting
    where role_row.rolname = any($1::text[])
      and database_row.datname = pg_catalog.current_database()
      and setting.setrole in (0, role_row.oid)
      and setting.setdatabase in (0, database_row.oid)
    order by role_row.rolname, setting_scope, settings
  `, [APP_ROLES]);
  equalRows(
    effectiveSettings.rows.map(
      (row) => `${row.principal}:${row.setting_scope}:${row.settings ?? "NULL"}`,
    ),
    [],
    `${label}: effektive pg_db_role_setting-Einträge`,
  );
}

/**
 * Nur echte standalone Typen gehören ins Inventar: Tabellen-/View-Rowtypes
 * und automatisch erzeugte Arraytypen sind abgeleitet und werden bereits über
 * ihre Relation geprüft. CREATE TYPE ... AS, Enum, Domain, Range/Multirange,
 * Base- und selbst unvollständige Shell-Typen werden dagegen vollständig samt
 * Owner und effektiver (bei NULL: PostgreSQL-Default-)ACL signiert.
 */
export async function verifyStandaloneTypeContract(
  client: PoolClient,
  label = "Standalone-Typeinventar",
): Promise<void> {
  const types = await client.query<StandaloneTypeRow>(`
    with standalone_types as (
      select type_row.oid,
             schema_row.nspname as schema_name,
             type_row.typtype::text as type_kind,
             type_row.typname as type_name,
             type_row.typowner,
             type_row.typacl,
             owner.rolname as owner
      from pg_catalog.pg_type type_row
      join pg_catalog.pg_namespace schema_row on schema_row.oid = type_row.typnamespace
      join pg_catalog.pg_roles owner on owner.oid = type_row.typowner
      left join pg_catalog.pg_class row_relation on row_relation.oid = type_row.typrelid
      where schema_row.nspname in ('public', 'drizzle')
        and type_row.typelem = 0
        and (type_row.typrelid = 0 or row_relation.relkind = 'c')
    )
    select type_row.schema_name,
           type_row.type_kind,
           type_row.type_name,
           type_row.owner,
           coalesce(
             (
               select pg_catalog.string_agg(
                 coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                   grantor.rolname || ':' || acl.privilege_type || ':' ||
                   acl.is_grantable::text,
                 ',' order by coalesce(grantee.rolname, 'PUBLIC'),
                              acl.privilege_type, grantor.rolname, acl.is_grantable
               )
               from pg_catalog.aclexplode(
                 coalesce(
                   type_row.typacl,
                   pg_catalog.acldefault('T', type_row.typowner)
                 )
               ) acl
               join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
               left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
               where acl.grantee <> type_row.typowner
             ),
             '-'
           ) as effective_acl
    from standalone_types type_row
    order by type_row.schema_name, type_row.type_kind, type_row.type_name
  `);
  equalRows(
    types.rows.map(
      (row) =>
        `${row.schema_name}:${row.type_kind}:${row.type_name}:${row.owner}:${row.effective_acl}`,
    ),
    [],
    label,
  );
}

export async function applyDatabaseAclContract(client: PoolClient): Promise<void> {
  const database = await client.query<{ database_name: string }>(`
    select pg_catalog.current_database() as database_name
  `);
  const databaseName = database.rows[0]?.database_name;
  if (!databaseName) throw new Error("Aktuelle Datenbank konnte nicht aufgelöst werden.");
  const quotedDatabase = quoteIdentifier(databaseName);
  const nonOwnerAppRoles = APP_ROLES
    .filter((roleName) => roleName !== "app_owner")
    .map(quoteIdentifier)
    .join(", ");

  // PUBLIC erhält ausschließlich CONNECT. Direkte App-Rollen-ACLs werden
  // vollständig entfernt; die Loginrollen verbinden effektiv über PUBLIC.
  await client.query(
    `revoke all privileges on database ${quotedDatabase} from public, ${nonOwnerAppRoles}`,
  );
  await client.query(`grant connect on database ${quotedDatabase} to public`);
}

export async function verifyDatabaseAclContract(
  client: PoolClient,
  label = "Datenbank-ACLs",
): Promise<void> {
  const databaseOwner = await client.query<{ owner: string }>(`
    select owner.rolname as owner
    from pg_catalog.pg_database database_row
    join pg_catalog.pg_roles owner on owner.oid = database_row.datdba
    where database_row.datname = pg_catalog.current_database()
  `);
  if (databaseOwner.rows[0]?.owner !== "app_owner") {
    throw new Error(
      `Datenbank-Owner ist nicht app_owner: ${databaseOwner.rows[0]?.owner ?? "?"}`,
    );
  }

  const databaseAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           pg_catalog.current_database() as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_database database_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        database_row.datacl,
        pg_catalog.acldefault('d', database_row.datdba)
      )
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where database_row.datname = pg_catalog.current_database()
      and acl.grantee <> database_row.datdba
    order by grantee, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    databaseAcl.rows.map(
      (row) => `${row.grantee}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    ["PUBLIC:CONNECT:app_owner:false"],
    label,
  );
}

async function verifyRetainedLegacyRole(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  if (!topology?.retainedLegacyRole) return;
  const retained = await client.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolconnlimit: number;
    role_setting_count: number;
    database_setting_count: number;
  }>(`
    select role_row.rolcanlogin,
           role_row.rolinherit,
           role_row.rolsuper,
           role_row.rolbypassrls,
           role_row.rolcreatedb,
           role_row.rolcreaterole,
           role_row.rolreplication,
           role_row.rolconnlimit,
           coalesce(pg_catalog.cardinality(role_row.rolconfig), 0)::int
             as role_setting_count,
           (
             select count(*)::int
             from pg_catalog.pg_db_role_setting setting
             where setting.setrole = role_row.oid
           ) as database_setting_count
    from pg_catalog.pg_roles role_row
    where role_row.rolname = $1
  `, [topology.retainedLegacyRole]);
  const role = retained.rows[0];
  if (
    !role ||
    role.rolcanlogin ||
    role.rolinherit ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolconnlimit !== 0 ||
    role.role_setting_count !== 0 ||
    role.database_setting_count !== 0
  ) {
    throw new Error(
      `${topology.retainedLegacyRole}: quarantänierter Legacy-Rollenvertrag weicht ab.`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function executeContractStatements(
  client: PoolClient,
  sql: string,
  label: string,
): Promise<void> {
  const statements = sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new Error(`${label} scheiterte in Schritt ${index + 1}.`, { cause: error });
    }
  }
}

export async function applyRoleContract(client: PoolClient): Promise<void> {
  await applyDatabaseAclContract(client);
  await executeContractStatements(client, APPLY_ROLE_CONTRACT_SQL, "Rollen-ACL-Manifest");

  // Der beaufsichtigte Legacy-Cutover uebernimmt bewusst einen echten
  // 0018-Zustand und wendet die spaeteren Migrationen erst NACH dem
  // Ownership-Wechsel an. Das Basismanifest muss dort ohne Zukunftstabellen
  // funktionieren; sobald eine der atomar gemeinsam eingefuehrten M1-04-
  // Relationen existiert, muessen dagegen alle existieren und erhalten exakt
  // die eng begrenzten Runtime-Rechte.
  const rechnerRelations = [
    "calculator_snapshot",
    "contact",
    "inbound_receipt",
    "project",
    "project_requirement",
  ] as const;
  const existing = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [rechnerRelations]);
  if (existing.rows.length > 0) {
    if (
      existing.rows.length !== rechnerRelations.length
      || existing.rows.some((row, index) => row.relname !== rechnerRelations[index])
    ) {
      throw new Error("Rollen-ACL-Manifest: M1-04-Relationen sind nur teilweise vorhanden.");
    }
    await client.query(`
      grant select on
        public.contact,
        public.project,
        public.inbound_receipt,
        public.calculator_snapshot,
        public.project_requirement
      to app_runtime;
      grant insert, update on public.contact, public.project to app_runtime;
      grant insert on
        public.inbound_receipt,
        public.calculator_snapshot,
        public.project_requirement
      to app_runtime
    `);
  }

  // M1-05 bleibt genauso prefix-tauglich wie M1-04: der beaufsichtigte
  // Legacy-Cutover wendet das Rollenmanifest auch gegen historische Schemas
  // an. Erst wenn beide Kanban-Relationen atomar vorhanden sind, erhalten sie
  // ihre reine Read-ACL. Die Provisioning-Funktion bleibt für alle
  // Runtime-Dienste ohne EXECUTE; der Workspace-Trigger ruft sie intern auf.
  const triageRelations = ["kanban_board", "kanban_column"] as const;
  const triageExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [triageRelations]);
  if (triageExisting.rows.length === 0) return;
  if (
    triageExisting.rows.length !== triageRelations.length
    || triageExisting.rows.some((row, index) => row.relname !== triageRelations[index])
  ) {
    throw new Error("Rollen-ACL-Manifest: M1-05-Relationen sind nur teilweise vorhanden.");
  }
  await client.query(`
    grant select on public.kanban_board, public.kanban_column to app_runtime;
    revoke execute on function public.provision_default_request_board()
      from public, app_runtime, app_system, app_auth, app_worker
  `);
}

export async function applyDefaultPrivilegeContract(client: PoolClient): Promise<void> {
  await executeContractStatements(
    client,
    APPLY_DEFAULT_PRIVILEGE_CONTRACT_SQL,
    "Default-ACL-Manifest",
  );
}

export async function verifyDefaultPrivilegeContract(client: PoolClient): Promise<void> {
  const unexpectedDefaults = await client.query<{
    owner: string;
    schema_name: string;
    object_type: string;
    grantee: string;
    grantor: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`
    with global_contract(owner_name, object_type) as (
      values
        ('app_owner'::text, 'r'::text),
        ('app_owner'::text, 'S'::text),
        ('app_owner'::text, 'f'::text),
        ('app_owner'::text, 'T'::text),
        ('identity_reconciler'::text, 'f'::text)
    ),
    schema_contract(owner_name, schema_name, object_type) as (
      select owner_name, 'public'::text, object_type
      from global_contract
    ),
    effective_defaults as (
      select owner.oid as owner_oid,
             owner.rolname as owner,
             '*'::text as schema_name,
             contract.object_type,
             acl.*
      from global_contract contract
      join pg_catalog.pg_roles owner on owner.rolname = contract.owner_name
      left join pg_catalog.pg_default_acl d
        on d.defaclrole = owner.oid
       and d.defaclnamespace = 0
       and d.defaclobjtype = contract.object_type::"char"
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          d.defaclacl,
          pg_catalog.acldefault(contract.object_type::"char", owner.oid)
        )
      ) acl

      union all

      select owner.oid as owner_oid,
             owner.rolname as owner,
             contract.schema_name,
             contract.object_type,
             acl.*
      from schema_contract contract
      join pg_catalog.pg_roles owner on owner.rolname = contract.owner_name
      join pg_catalog.pg_namespace n on n.nspname = contract.schema_name
      join pg_catalog.pg_default_acl d
        on d.defaclrole = owner.oid
       and d.defaclnamespace = n.oid
       and d.defaclobjtype = contract.object_type::"char"
      cross join lateral pg_catalog.aclexplode(d.defaclacl) acl
    )
    select defaults.owner,
           defaults.schema_name,
           defaults.object_type,
           coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           defaults.privilege_type,
           defaults.is_grantable
    from effective_defaults defaults
    join pg_catalog.pg_roles grantor on grantor.oid = defaults.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = defaults.grantee
    where defaults.grantee <> defaults.owner_oid
    order by defaults.owner, defaults.schema_name, defaults.object_type,
             grantee, defaults.privilege_type, grantor.rolname
  `);
  equalRows(
    unexpectedDefaults.rows.map((row) =>
      `${row.owner}:${row.schema_name}:${row.object_type}:${row.grantee}:` +
        `${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [],
    "Default-ACLs",
  );
}

/**
 * Läuft vor Advisory Lock und vor Drizzle. Der spätere Vollvertrag käme zu
 * spät: ein privilegierter Session-Principal könnte bereits während einer
 * Migration RESET ROLE verwenden oder außerhalb von RLS schreiben.
 */
export async function verifyMigrationPrincipalBoundary(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  const identity = await client.query<{
    session_user: string;
    current_user: string;
    session_login: boolean;
    session_inherit: boolean;
    session_super: boolean;
    session_bypassrls: boolean;
    session_createdb: boolean;
    session_createrole: boolean;
    session_replication: boolean;
    current_login: boolean;
    current_inherit: boolean;
    current_super: boolean;
    current_bypassrls: boolean;
    current_createdb: boolean;
    current_createrole: boolean;
    current_replication: boolean;
  }>(`
    select session_user,
           current_user,
           s.rolcanlogin as session_login,
           s.rolinherit as session_inherit,
           s.rolsuper as session_super,
           s.rolbypassrls as session_bypassrls,
           s.rolcreatedb as session_createdb,
           s.rolcreaterole as session_createrole,
           s.rolreplication as session_replication,
           c.rolcanlogin as current_login,
           c.rolinherit as current_inherit,
           c.rolsuper as current_super,
           c.rolbypassrls as current_bypassrls,
           c.rolcreatedb as current_createdb,
           c.rolcreaterole as current_createrole,
           c.rolreplication as current_replication
    from pg_catalog.pg_roles s
    cross join pg_catalog.pg_roles c
    where s.rolname = session_user
      and c.rolname = current_user
  `);
  const role = identity.rows[0];
  if (!role || role.session_user !== "app_migrator" || role.current_user !== "app_owner") {
    throw new Error(
      `Falsche Migrationsrollen: session_user=${role?.session_user ?? "?"}, ` +
        `current_user=${role?.current_user ?? "?"}`,
    );
  }
  if (
    !role.session_login ||
    role.session_inherit ||
    role.session_super ||
    role.session_bypassrls ||
    role.session_createdb ||
    role.session_createrole ||
    role.session_replication
  ) {
    throw new Error("app_migrator besitzt ein verbotenes Rollenattribut vor der Migration.");
  }
  if (
    role.current_login ||
    role.current_inherit ||
    role.current_super ||
    role.current_bypassrls ||
    role.current_createdb ||
    role.current_createrole ||
    role.current_replication
  ) {
    throw new Error("app_owner besitzt ein verbotenes Rollenattribut vor der Migration.");
  }

  await verifyAppRoleCatalogContract(client, "App-Rollenvertrag vor Schemaänderung");

  const reconciler = await client.query<RoleRow>(`
    select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls,
           rolcreatedb, rolcreaterole, rolreplication
    from pg_catalog.pg_roles
    where rolname = 'identity_reconciler'
  `);
  const reconcilerRole = reconciler.rows[0];
  if (
    !reconcilerRole ||
    reconcilerRole.rolcanlogin ||
    reconcilerRole.rolinherit ||
    reconcilerRole.rolsuper ||
    reconcilerRole.rolbypassrls ||
    reconcilerRole.rolcreatedb ||
    reconcilerRole.rolcreaterole ||
    reconcilerRole.rolreplication
  ) {
    throw new Error(
      "identity_reconciler fehlt oder besitzt vor dem temporären SET ROLE ein verbotenes Attribut.",
    );
  }

  const memberships = await client.query<MembershipRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role,
           m.admin_option,
           m.inherit_option,
           m.set_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles granted on granted.oid = m.roleid
    join pg_catalog.pg_roles member on member.oid = m.member
    join pg_catalog.pg_roles grantor on grantor.oid = m.grantor
    where granted.rolname = any($1::text[])
       or member.rolname = any($1::text[])
    order by granted.rolname, member.rolname, grantor.rolname
  `, [APP_ROLES]);
  equalRows(
    memberships.rows.map((row) =>
      `${row.granted_role}>${row.member_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    ),
    expectedDbRoleMembershipSignatures(topology),
    "Migrationsrollen-Mitgliedschaften vor Schemaänderung",
  );
  await verifyRetainedLegacyRole(client, topology);

  const providerMembership = await client.query<{
    migrator_neon_superuser: boolean;
    owner_neon_superuser: boolean;
  }>(`
    select case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role('app_migrator', 'neon_superuser', 'MEMBER')
           end as migrator_neon_superuser,
           case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role('app_owner', 'neon_superuser', 'MEMBER')
           end as owner_neon_superuser
  `);
  if (
    providerMembership.rows[0]?.migrator_neon_superuser ||
    providerMembership.rows[0]?.owner_neon_superuser
  ) {
    throw new Error("Migrationsrollen dürfen nicht Mitglied von neon_superuser sein.");
  }

  // Ownership ist ebenfalls eine PRE-Drizzle-Bedingung. Andernfalls könnte
  // eine falsch provisionierte Fresh-/Legacy-DB alle Migrationen committen und
  // erst im nachgelagerten ACL-Manifest rot werden.
  await verifyDatabaseAclContract(client, "Datenbank-ACLs vor Schemaänderung");

  const schemaOwners = await client.query<{ nspname: string; owner: string }>(`
    select n.nspname, owner.rolname as owner
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
    where n.nspname in ('public', 'drizzle', 'pgboss')
    order by n.nspname
  `);
  const actualSchemas = new Map(schemaOwners.rows.map((row) => [row.nspname, row.owner]));
  if (
    actualSchemas.get("public") !== "app_owner" ||
    actualSchemas.get("pgboss") !== "app_worker" ||
    (actualSchemas.has("drizzle") && actualSchemas.get("drizzle") !== "app_owner")
  ) {
    throw new Error(
      `Schema-Owner weichen vor der Migration ab: ${JSON.stringify(schemaOwners.rows)}`,
    );
  }
  await verifyStandaloneTypeContract(client, "Standalone-Typeinventar vor Schemaänderung");
}

export async function verifyRoleContract(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  await verifyDefaultPrivilegeContract(client);
  await verifyRetainedLegacyRole(client, topology);
  await verifyAppRoleCatalogContract(client);
  await verifyDatabaseAclContract(client);

  const memberships = await client.query<MembershipRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role,
           m.admin_option,
           m.inherit_option,
           m.set_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles granted on granted.oid = m.roleid
    join pg_catalog.pg_roles member on member.oid = m.member
    join pg_catalog.pg_roles grantor on grantor.oid = m.grantor
    -- Eine unbekannte Provider-/Bridge-Rolle an einem der App-Principals ist
    -- ebenfalls Drift. Sonst könnte z. B. marker -> bridge -> runtime die
    -- Principal-Policy transitiv öffnen, obwohl alle bekannten Kanten stimmen.
    where granted.rolname = any($1::text[])
       or member.rolname = any($1::text[])
    order by granted.rolname, member.rolname, grantor.rolname
  `, [APP_ROLES]);
  equalRows(
    memberships.rows.map((row) =>
      `${row.granted_role}>${row.member_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    ),
    expectedDbRoleMembershipSignatures(topology),
    "Rollenmitgliedschaften",
  );

  const effectiveMemberships = await client.query<EffectiveMembershipRow>(`
    select principal,
           pg_catalog.pg_has_role(
             principal,
             'app_membership_writer',
             'MEMBER'
           ) as membership_writer,
           case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role(principal, 'neon_superuser', 'MEMBER')
           end as neon_superuser
    from pg_catalog.unnest($1::text[]) as principal
    order by principal
  `, [[
    "app_owner",
    "app_migrator",
    "app_runtime",
    "app_system",
    "app_auth",
    "app_worker",
    "identity_reconciler",
  ]]);
  equalRows(
    effectiveMemberships.rows
      .filter((row) => row.membership_writer)
      .map((row) => row.principal),
    ["app_migrator", "app_owner", "app_system"],
    "Effektive Membership-Writer-Principals",
  );
  const neonMembers = effectiveMemberships.rows
    .filter((row) => row.neon_superuser)
    .map((row) => row.principal);
  if (neonMembers.length > 0) {
    throw new Error(`Verbotene neon_superuser-Mitgliedschaft: ${neonMembers.join(", ")}`);
  }

  const schemaOwners = await client.query<{ nspname: string; owner: string }>(`
    select n.nspname, r.rolname as owner
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles r on r.oid = n.nspowner
    where n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema'
    order by n.nspname
  `);
  equalRows(
    schemaOwners.rows.map((row) => `${row.nspname}:${row.owner}`),
    ["drizzle:app_owner", "pgboss:app_worker", "public:app_owner"],
    "Nicht-System-Schemainventar und Ownership",
  );
  await verifyStandaloneTypeContract(client);

  const relationInventory = await client.query<{ relkind: string; relname: string }>(`
    select c.relkind, c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
    order by c.relkind, c.relname
  `);
  equalRows(
    relationInventory.rows.map((row) => `${row.relkind}:${row.relname}`),
    [
      "r:audit_log",
      "r:auth_account",
      "r:auth_rate_limit",
      "r:auth_session",
      "r:auth_user",
      "r:auth_verification",
      "r:calculator_snapshot",
      "r:contact",
      "r:domain_events",
      "r:inbound_receipt",
      "r:kanban_board",
      "r:kanban_column",
      "r:membership",
      "r:project",
      "r:project_requirement",
      "r:site",
      "r:user_identity",
      "r:workspace",
    ],
    "Relationsinventar",
  );

  const wrongTableOwners = await client.query<{ schema_name: string; table_name: string; owner: string }>(`
    select n.nspname as schema_name, c.relname as table_name, r.rolname as owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
    where n.nspname in ('public', 'drizzle')
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and r.rolname <> 'app_owner'
    order by n.nspname, c.relname
  `);
  if (wrongTableOwners.rows.length > 0) {
    throw new Error(`Falsche Tabellen-/Sequenz-Owner: ${JSON.stringify(wrongTableOwners.rows)}`);
  }

  const wrongPgbossOwners = await client.query<{
    object_kind: string;
    object_name: string;
    owner: string;
  }>(`
    select 'relation:' || c.relkind::text as object_kind,
           c.relname as object_name,
           owner.rolname as owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    where n.nspname = 'pgboss'
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'i', 'I')
      and owner.rolname <> 'app_worker'

    union all

    select 'function:' || p.prokind::text,
           p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')',
           owner.rolname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where n.nspname = 'pgboss'
      and owner.rolname <> 'app_worker'

    union all

    select 'type:' || t.typtype::text,
           t.typname,
           owner.rolname
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = t.typowner
    where n.nspname = 'pgboss'
      and owner.rolname <> 'app_worker'

    order by object_kind, object_name
  `);
  if (wrongPgbossOwners.rows.length > 0) {
    throw new Error(`Falsche pg-boss-Objektowner: ${JSON.stringify(wrongPgbossOwners.rows)}`);
  }

  const functionOwners = await client.query<{ proname: string; owner: string }>(`
    select p.proname, r.rolname as owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
    order by p.proname
  `);
  equalRows(
    functionOwners.rows.map((row) => `${row.proname}:${row.owner}`),
    [
      "app_actor_id:app_owner",
      "forbid_mutation:app_owner",
      "guard_membership_dml:app_owner",
      "guard_membership_statement:app_owner",
      "provision_default_request_board:app_owner",
      "reconcile_user_identity:identity_reconciler",
      "user_identity_link_auth_only:app_owner",
    ],
    "Funktions-Ownership",
  );

  const functionSecurity = await client.query<{
    proname: string;
    args: string;
    result_type: string;
    owner: string;
    language: string;
    prokind: string;
    provolatile: string;
    prosecdef: boolean;
    proleakproof: boolean;
    proisstrict: boolean;
    proparallel: string;
    proconfig: string[] | null;
    prosrc: string;
  }>(`
    select p.proname,
           pg_catalog.oidvectortypes(p.proargtypes) as args,
           pg_catalog.pg_get_function_result(p.oid) as result_type,
           owner.rolname as owner,
           language.lanname as language,
           p.prokind,
           p.provolatile,
           p.prosecdef,
           p.proleakproof,
           p.proisstrict,
           p.proparallel,
           p.proconfig,
           p.prosrc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    join pg_catalog.pg_language language on language.oid = p.prolang
    where n.nspname = 'public'
    order by p.proname, p.oid
  `);
  equalRows(
    functionSecurity.rows.map((row) => [
      `${row.proname}(${row.args})`,
      row.result_type,
      row.owner,
      row.language,
      row.prokind,
      row.provolatile,
      String(row.prosecdef),
      String(row.proleakproof),
      String(row.proisstrict),
      row.proparallel,
      row.proconfig?.join("|") ?? "-",
      sha256(row.prosrc),
    ].join(":")),
    [
      "app_actor_id():uuid:app_owner:sql:f:s:false:false:false:s:search_path=pg_catalog:" +
        "acca23aaae3a91eda3aa424256de1527e1bb61d02fdd4b0d2c0803ecd6a37542",
      "forbid_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:-:" +
        "df89b0c65f44ffae87695685fca411fb8ad998cff6768bb8a176024d331910f3",
      "guard_membership_dml():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:89cb000d7bca739fe2bd23b737ffc5153b494f9f7eb80790dbeef4e6ab95a057",
      "guard_membership_statement():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:b5d5db39513acce303c62d10a27f8b3bdc0b7ec12b183ae127e59b181dac89b7",
      "provision_default_request_board():trigger:app_owner:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:8e375b2395604e242f864516e8b068fa01cbd46cceff11b3729eca10c2c010f2",
      "reconcile_user_identity(text, text):uuid:identity_reconciler:plpgsql:f:v:true:false:false:u:" +
        "search_path=public, pg_temp:ae576295ddea09162013c29d5828512764cecbe3c39bbcaa0cdd5d45307f2ac3",
      "user_identity_link_auth_only():trigger:app_owner:plpgsql:f:v:false:false:false:u:-:" +
        "642035f502409bec26defa74b308e8825d613a5592ae23d228aaabd76115ccfb",
    ],
    "Live-Funktions-Sicherheitsvertrag",
  );

  const rlsContract = await client.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by c.relname
  `);
  equalRows(
    rlsContract.rows.map((row) =>
      `${row.relname}:${row.relrowsecurity}:${row.relforcerowsecurity}`,
    ),
    [
      "audit_log:true:true",
      "auth_account:false:false",
      "auth_rate_limit:false:false",
      "auth_session:false:false",
      "auth_user:false:false",
      "auth_verification:false:false",
      "calculator_snapshot:true:true",
      "contact:true:true",
      "domain_events:true:true",
      "inbound_receipt:true:true",
      "kanban_board:true:true",
      "kanban_column:true:true",
      "membership:true:true",
      "project:true:true",
      "project_requirement:true:true",
      "site:true:true",
      "user_identity:true:true",
      "workspace:true:true",
    ],
    "Live-RLS/FORCE-Vertrag",
  );

  const policies = await client.query<{
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string;
    cmd: string;
    qual: string;
    with_check: string;
  }>(`
    select tablename,
           policyname,
           permissive,
           roles::text,
           cmd,
           coalesce(qual, '-') as qual,
           coalesce(with_check, '-') as with_check
    from pg_catalog.pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `);
  equalRows(
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
      return `${row.tablename}:${row.policyname}:${sha256(value)}`;
    }),
    [
      "audit_log:tenant_isolation:23ff85358d0c0e94974353f538c267f99f5a3e7219bf9e1cd8769f69744ae417",
      "calculator_snapshot:tenant_isolation:8c816e39dfc3d5d774d0de6f02961882e9ae6679904da2b9007d5ff86becbb72",
      "contact:tenant_isolation:e339a6411d39679d749a45535df17ea42132453c4725e42f0d5b310379489e46",
      "domain_events:tenant_isolation:f1715696222caf43a2adc220b67b8aebdce61f5ef9659884af1c7263ccab8284",
      "inbound_receipt:tenant_isolation:866b6644bba9899118c16bc502e420f0409e632a3cd6b709b3321f6c10c28c1c",
      "kanban_board:tenant_isolation:3fcf596a70932422900934bc4bb607edff72abb165949dcca9afcf372c67768b",
      "kanban_column:tenant_isolation:d11d4b31d67527780056ac587d49089fbd9e39568a0d2c15e55317d1d26ba507",
      "membership:membership_actor_delete:2b0f67a6a2931b84b4610114759e61a867d45e093a85ef8094cbdc2d81b14027",
      "membership:membership_actor_insert:f4f58cb0a649e8bf11dec66a6047da1ad5774ac03fe5acb808297937b3d5dbf6",
      "membership:membership_actor_update:9b7d643976dff08ea22d7a8db439ac1a36450de1a57c256c73035a5c37119902",
      "membership:membership_principal_delete:9e6e5d92622b8d255518733c4b1b8135a9bd99994dec0d73f723de6d963b84fe",
      "membership:membership_principal_insert:cdccab00a484775580d8b083aed280eb2cf90753f6697acae098e9cba54318fc",
      "membership:membership_principal_update:b2374f555501c25048e318fdaa54b7ef1d9b29a66694ef064e6e9ded271c75ca",
      "membership:tenant_isolation:1a5443560d407a656bdeaff6593819d601078d1ebdc58d4d1f8e02e829a587f3",
      "project:tenant_isolation:c5f62af4cbba473885ce886d0eef10a80ab1f5dca746c0cb4b6204dd1050717b",
      "project_requirement:tenant_isolation:4c2d81a0ad4ae0aa71972c72dc7f7cd57028a0ba50e01420106b350f724de0cb",
      "site:tenant_isolation:26181215437698e628cbd47ab08562d51de16bb0172d907c36c75a679a555d3c",
      "user_identity:user_identity_insert:ed42cd7d7ab49b586488c84e375edbd0c5679444866111bc9547a6a309424131",
      "user_identity:user_identity_reconcile_select:fa1b9f29b8bb9a694dc41a78d8ad73dc829d2715ff8e8c91c6357f9475b240bd",
      "user_identity:user_identity_reconcile_update:3763319bbd0208f0554077338d247e797d6122f9c56182072e2f3735b65eecd0",
      "user_identity:user_identity_select:824f30ce2ed4729f0ec66928efba45844aef4f048580c636bfd0c260d76bc9f6",
      "workspace:tenant_isolation:efde4221654b51f3f1df5df99ffe938484bd185d6d9057c808d0b2682d7be38f",
    ],
    "Live-Policyvertrag",
  );

  const triggers = await client.query<{
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
           coalesce(pg_catalog.pg_get_expr(trigger.tgqual, trigger.tgrelid, false), '-')
             as when_expression,
           trigger.tgconstraint::text
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace relation_schema on relation_schema.oid = relation.relnamespace
    join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
    join pg_catalog.pg_namespace function_schema on function_schema.oid = function.pronamespace
    where relation_schema.nspname = 'public'
      and not trigger.tgisinternal
    order by relation.relname, trigger.tgname
  `);
  equalRows(
    triggers.rows.map((row) => [
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
      "audit_log:audit_log_append_only:27:O:public:forbid_mutation::-:0",
      "audit_log:audit_log_no_truncate:34:O:public:forbid_mutation::-:0",
      "domain_events:domain_events_append_only:27:O:public:forbid_mutation::-:0",
      "domain_events:domain_events_no_truncate:34:O:public:forbid_mutation::-:0",
      "membership:membership_dml_guard:31:O:public:guard_membership_dml::-:0",
      "membership:membership_dml_serialize:30:O:public:guard_membership_statement::-:0",
      "user_identity:user_identity_link_auth_only:19:O:public:user_identity_link_auth_only::-:0",
      "workspace:workspace_default_request_board:5:O:public:provision_default_request_board::-:0",
    ],
    "Live-Triggervertrag",
  );

  // information_schema.role_table_grants blendet ACLs fremder Grantors für
  // den aktuellen Benutzer aus. aclexplode liest dagegen den tatsächlichen
  // Katalog und macht auch Legacy-/Bridge-Grantor-Pfade sichtbar. PUBLIC ist
  // bewusst Teil der Prüfung, weil sein Recht für jeden Dienst effektiv gilt.
  const grants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and acl.grantee <> c.relowner
    order by grantee, c.relname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    grants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_runtime:audit_log:INSERT:app_owner:false",
      "app_runtime:audit_log:SELECT:app_owner:false",
      "app_runtime:calculator_snapshot:INSERT:app_owner:false",
      "app_runtime:calculator_snapshot:SELECT:app_owner:false",
      "app_runtime:contact:INSERT:app_owner:false",
      "app_runtime:contact:SELECT:app_owner:false",
      "app_runtime:contact:UPDATE:app_owner:false",
      "app_runtime:domain_events:INSERT:app_owner:false",
      "app_runtime:domain_events:SELECT:app_owner:false",
      "app_runtime:inbound_receipt:INSERT:app_owner:false",
      "app_runtime:inbound_receipt:SELECT:app_owner:false",
      "app_runtime:kanban_board:SELECT:app_owner:false",
      "app_runtime:kanban_column:SELECT:app_owner:false",
      "app_runtime:membership:SELECT:app_owner:false",
      "app_runtime:project:INSERT:app_owner:false",
      "app_runtime:project:SELECT:app_owner:false",
      "app_runtime:project:UPDATE:app_owner:false",
      "app_runtime:project_requirement:INSERT:app_owner:false",
      "app_runtime:project_requirement:SELECT:app_owner:false",
      "app_runtime:site:DELETE:app_owner:false",
      "app_runtime:site:INSERT:app_owner:false",
      "app_runtime:site:SELECT:app_owner:false",
      "app_runtime:site:UPDATE:app_owner:false",
      "app_runtime:user_identity:SELECT:app_owner:false",
      "app_runtime:workspace:SELECT:app_owner:false",
      "app_system:audit_log:INSERT:app_owner:false",
      "app_system:audit_log:SELECT:app_owner:false",
      "app_system:domain_events:INSERT:app_owner:false",
      "app_system:domain_events:SELECT:app_owner:false",
      "app_system:membership:DELETE:app_owner:false",
      "app_system:membership:INSERT:app_owner:false",
      "app_system:membership:SELECT:app_owner:false",
      "app_system:membership:UPDATE:app_owner:false",
      "app_system:user_identity:INSERT:app_owner:false",
      "app_system:user_identity:SELECT:app_owner:false",
      "app_system:workspace:INSERT:app_owner:false",
      "app_system:workspace:SELECT:app_owner:false",
      "app_system:workspace:UPDATE:app_owner:false",
      ...["auth_account", "auth_rate_limit", "auth_session", "auth_user", "auth_verification"].flatMap(
        (table) => ["DELETE", "INSERT", "SELECT", "UPDATE"].map(
          (privilege) => `app_auth:${table}:${privilege}:app_owner:false`,
        ),
      ),
      "identity_reconciler:membership:SELECT:app_owner:false",
      "identity_reconciler:user_identity:INSERT:app_owner:false",
      "identity_reconciler:user_identity:SELECT:app_owner:false",
      "identity_reconciler:user_identity:UPDATE:app_owner:false",
    ],
    "Tabellen-Grants",
  );

  const columnGrants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname || '.' || a.attname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(a.attacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and a.attnum > 0
      and not a.attisdropped
      and acl.grantee <> c.relowner
    order by grantee, c.relname, a.attname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    columnGrants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [],
    "Spalten-Grants",
  );

  const sequenceGrants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and c.relkind = 'S'
      and acl.grantee <> c.relowner
    order by grantee, c.relname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    sequenceGrants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [],
    "Sequenz-Grants",
  );

  const rawFunctionAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and acl.grantee <> p.proowner
    order by grantee, object_name, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    rawFunctionAcl.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_auth:reconcile_user_identity(text, text):EXECUTE:identity_reconciler:false",
      "app_runtime:app_actor_id():EXECUTE:app_owner:false",
      "app_system:app_actor_id():EXECUTE:app_owner:false",
    ],
    "Funktions-Grants",
  );

  const rawSchemaAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           n.nspname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(
      coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname in ('public', 'drizzle', 'pgboss')
      and acl.grantee <> n.nspowner
    order by grantee, n.nspname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    rawSchemaAcl.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_auth:public:USAGE:app_owner:false",
      "app_runtime:public:USAGE:app_owner:false",
      "app_system:public:USAGE:app_owner:false",
      "identity_reconciler:public:USAGE:app_owner:false",
    ],
    "Schema-Grants",
  );

  const functionAcl = await client.query<{
    runtime_actor: boolean;
    system_actor: boolean;
    auth_reconcile: boolean;
    runtime_reconcile: boolean;
    system_reconcile: boolean;
    worker_reconcile: boolean;
    runtime_provision: boolean;
    system_provision: boolean;
    auth_provision: boolean;
    worker_provision: boolean;
  }>(`
    select
      pg_catalog.has_function_privilege('app_runtime', 'public.app_actor_id()', 'EXECUTE') as runtime_actor,
      pg_catalog.has_function_privilege('app_system', 'public.app_actor_id()', 'EXECUTE') as system_actor,
      pg_catalog.has_function_privilege('app_auth', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as auth_reconcile,
      pg_catalog.has_function_privilege('app_runtime', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as runtime_reconcile,
      pg_catalog.has_function_privilege('app_system', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as system_reconcile,
      pg_catalog.has_function_privilege('app_worker', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as worker_reconcile,
      pg_catalog.has_function_privilege('app_runtime', 'public.provision_default_request_board()', 'EXECUTE') as runtime_provision,
      pg_catalog.has_function_privilege('app_system', 'public.provision_default_request_board()', 'EXECUTE') as system_provision,
      pg_catalog.has_function_privilege('app_auth', 'public.provision_default_request_board()', 'EXECUTE') as auth_provision,
      pg_catalog.has_function_privilege('app_worker', 'public.provision_default_request_board()', 'EXECUTE') as worker_provision
  `);
  const acl = functionAcl.rows[0];
  if (
    !acl?.runtime_actor || !acl.system_actor || !acl.auth_reconcile ||
    acl.runtime_reconcile || acl.system_reconcile || acl.worker_reconcile
    || acl.runtime_provision || acl.system_provision
    || acl.auth_provision || acl.worker_provision
  ) {
    throw new Error(`Funktions-ACL weicht vom Rollenvertrag ab: ${JSON.stringify(acl)}`);
  }

  const schemaAcl = await client.query<{
    runtime_create: boolean;
    system_create: boolean;
    auth_create: boolean;
    worker_public_usage: boolean;
    worker_pgboss_create: boolean;
  }>(`
    select
      pg_catalog.has_schema_privilege('app_runtime', 'public', 'CREATE') as runtime_create,
      pg_catalog.has_schema_privilege('app_system', 'public', 'CREATE') as system_create,
      pg_catalog.has_schema_privilege('app_auth', 'public', 'CREATE') as auth_create,
      pg_catalog.has_schema_privilege('app_worker', 'public', 'USAGE') as worker_public_usage,
      pg_catalog.has_schema_privilege('app_worker', 'pgboss', 'CREATE') as worker_pgboss_create
  `);
  const schemas = schemaAcl.rows[0];
  if (
    schemas?.runtime_create || schemas?.system_create || schemas?.auth_create ||
    schemas?.worker_public_usage || !schemas?.worker_pgboss_create
  ) {
    throw new Error(`Schema-ACL weicht vom Rollenvertrag ab: ${JSON.stringify(schemas)}`);
  }
}
