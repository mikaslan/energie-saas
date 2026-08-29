// Produktionsnahe Fresh-Probe für ADR 0003 / M1-03. Sie läuft ausschließlich
// gegen eine flüchtige embedded-Postgres-Instanz, legt dort die vollständige
// Rollen-/Ownership-Topologie an, migriert als app_migrator → app_owner und
// greift anschließend mit echten Runtime-/System-/Auth-/Worker-Verbindungen an.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { Pool, type PoolClient } from "pg";
import { PgBoss } from "pg-boss";
import { startEmbeddedPostgres } from "../tests/setup/embedded-postgres";
import {
  dbRoleProvisioningTopologyFromEnvironment,
  type DbRoleProvisioningTopology,
  verifyDefaultPrivilegeContract,
  verifyRoleContract,
} from "./db-role-contract.mjs";
import {
  cutoverLegacyDatabaseRole,
  quarantineLegacyRoles,
  recoverLegacyCutoverConnections,
} from "./db-role-cutover.mjs";

const DB = "energie_saas_test";
const embedded = await startEmbeddedPostgres();
const superuser = new Pool({ connectionString: embedded.superuserUrl, max: 2 });
const host = new URL(embedded.url).host;

const urls = {
  migrator: `postgres://app_migrator:mig@${host}/${DB}`,
  runtime: `postgres://app_runtime:run@${host}/${DB}`,
  system: `postgres://app_system:sys@${host}/${DB}`,
  auth: `postgres://app_auth:aut@${host}/${DB}`,
  worker: `postgres://app_worker:wrk@${host}/${DB}`,
};

let checks = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`OK   ${label}`);
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-migrations-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(source, "meta", "_journal.json"), "utf8"),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspräfix 0..${maxIndex} ist nicht lückenlos.`);
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

function loseNextCommitAcknowledgement(
  client: PoolClient,
  faultLabel: string,
): PoolClient {
  let acknowledgementLost = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          if (acknowledgementLost) {
            throw new Error(`${faultLabel}: defekte Control-Session wurde wiederverwendet`);
          }
          const result = await (
            target.query.bind(target) as (...queryArgs: unknown[]) => Promise<unknown>
          )(...args);
          const statement =
            typeof args[0] === "string"
              ? args[0]
              : typeof args[0] === "object" && args[0] !== null && "text" in args[0]
                ? String((args[0] as { text: unknown }).text)
                : "";
          if (/^\s*commit\s*;?\s*$/i.test(statement)) {
            acknowledgementLost = true;
            throw new Error(`${faultLabel}: simulierte verlorene COMMIT-Antwort`);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
}

function failAfterNextCommittedControlTransaction(
  client: PoolClient,
  faultLabel: string,
): PoolClient {
  let failFollowingQuery = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          if (failFollowingQuery) {
            throw new Error(
              `${faultLabel}: Control-Session starb nach bestätigtem COMMIT`,
            );
          }
          const result = await (
            target.query.bind(target) as (...queryArgs: unknown[]) => Promise<unknown>
          )(...args);
          const statement =
            typeof args[0] === "string"
              ? args[0]
              : typeof args[0] === "object" && args[0] !== null && "text" in args[0]
                ? String((args[0] as { text: unknown }).text)
                : "";
          if (/^\s*commit\s*;?\s*$/i.test(statement)) failFollowingQuery = true;
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
}

function failFreezeAttestationAndRollback(
  client: PoolClient,
  faultLabel: string,
): { client: PoolClient; rollbackFailures: () => number } {
  let freezeMutationExecuted = false;
  let attestationFailed = false;
  let rollbackFailures = 0;
  const proxied = new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const statement =
            typeof args[0] === "string"
              ? args[0]
              : typeof args[0] === "object" && args[0] !== null && "text" in args[0]
                ? String((args[0] as { text: unknown }).text)
                : "";
          if (
            freezeMutationExecuted &&
            !attestationFailed &&
            /from\s+pg_catalog\.pg_database/i.test(statement)
          ) {
            attestationFailed = true;
            throw new Error(`${faultLabel}: Zustandsattestierung vor COMMIT fiel aus`);
          }
          if (
            attestationFailed &&
            rollbackFailures < 2 &&
            /^\s*rollback\s*;?\s*$/i.test(statement)
          ) {
            rollbackFailures += 1;
            // Absichtlich VOR target.query(): Die serverseitige Control-TX
            // bleibt offen, obwohl derselbe Client weitere Queries annähme.
            throw new Error(`${faultLabel}: ROLLBACK erreichte den Server nicht`);
          }
          const result = await (
            target.query.bind(target) as (...queryArgs: unknown[]) => Promise<unknown>
          )(...args);
          if (/alter\s+database[\s\S]+allow_connections\s+false/i.test(statement)) {
            freezeMutationExecuted = true;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
  return { client: proxied, rollbackFailures: () => rollbackFailures };
}

async function allowed(pool: Pool, label: string, text: string, values: unknown[] = []): Promise<void> {
  try {
    await pool.query(text, values);
    ok(label, true);
  } catch (error) {
    ok(label, false, String(error));
  }
}

async function denied(
  pool: Pool,
  label: string,
  text: string,
  values: unknown[] = [],
  expectedCode = "42501",
): Promise<void> {
  try {
    await pool.query(text, values);
    ok(label, false, "wurde erlaubt");
  } catch (error) {
    ok(label, postgresCode(error) === expectedCode, `SQLSTATE=${postgresCode(error)}; ${String(error)}`);
  }
}

async function inTenant(
  pool: Pool,
  workspaceId: string,
  statements: Array<{ text: string; values?: unknown[] }>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local transaction isolation level read committed");
    await client.query("select set_config('app.actor_id', '', true)");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    for (const statement of statements) {
      await client.query(statement.text, statement.values ?? []);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function proveLegacyUpgrade(): Promise<void> {
  const upgradeDb = "energie_saas_upgrade_test";
  const legacyUrl = `postgres://app_legacy:legacy@${host}/${upgradeDb}`;
  const upgradeMigratorUrl = `postgres://app_migrator:mig@${host}/${upgradeDb}`;
  const upgradeSystemUrl = `postgres://app_system:sys@${host}/${upgradeDb}`;
  const upgradeWorkerUrl = `postgres://app_worker:wrk@${host}/${upgradeDb}`;
  const providerCutoverUrl = `postgres://provider_admin_sim:provider@${host}/${upgradeDb}`;
  const providerControlUrl = `postgres://provider_admin_sim:provider@${host}/${DB}`;
  const upgradeSuperuserUrl = new URL(embedded.superuserUrl);
  upgradeSuperuserUrl.pathname = `/${upgradeDb}`;
  const legacyQueue = `legacy.roles.probe.${randomUUID()}`;
  let legacyJobId: string | null = null;

  const providerTopology: DbRoleProvisioningTopology = {
    provisioningAdminRole: "provider_admin_sim",
    bootstrapGrantorRole: "postgres",
    retainedLegacyRole: "app_legacy",
  };
  await superuser.query(`
    create role provider_admin_sim login password 'provider' noinherit nosuperuser nobypassrls
      createdb createrole noreplication;

    -- Standard-PG18-Abbild eines Nichtsuperuser-CREATEROLE-Bootstraps: der
    -- echte Bootstrap-Grantor trägt ADMIN, aber weder INHERIT noch SET.
    grant app_owner, app_migrator, app_runtime, app_system, app_auth, app_worker,
          app_membership_writer, identity_reconciler
      to provider_admin_sim with admin true, inherit false, set false;

    -- Die bisherigen lokalen Superuser-Fachkanten werden grantor-genau durch
    -- die Provisioning-Admin-Kanten ersetzt.
    revoke app_owner from app_migrator granted by current_user cascade;
    revoke app_membership_writer from app_system granted by current_user cascade;
    revoke app_membership_writer from app_owner granted by current_user cascade;
    revoke identity_reconciler from app_owner granted by current_user cascade;

    set role provider_admin_sim;
    grant app_owner to app_migrator
      with admin false, inherit false, set true granted by current_user;
    grant app_membership_writer to app_system
      with admin false, inherit false, set false granted by current_user;
    grant app_membership_writer to app_owner
      with admin false, inherit false, set false granted by current_user;
    grant identity_reconciler to app_owner
      with admin true, inherit false, set false granted by current_user;
    grant app_owner to provider_admin_sim
      with admin false, inherit false, set true granted by current_user;
    grant app_worker to provider_admin_sim
      with admin false, inherit false, set true granted by current_user;
    reset role;
  `);

  const freshProviderTopology = {
    provisioningAdminRole: providerTopology.provisioningAdminRole,
    bootstrapGrantorRole: providerTopology.bootstrapGrantorRole,
  } as const;
  const providerContractClient = await superuser.connect();
  try {
    await verifyRoleContract(providerContractClient, freshProviderTopology);
    ok("PG18-Providervertrag akzeptiert exakt Auto-/SET-Kanten", true);

    await providerContractClient.query(`
      set role provider_admin_sim;
      revoke app_worker from provider_admin_sim granted by current_user cascade;
      reset role;
    `);
    let missingProviderSetEdgeRejected = false;
    try {
      await verifyRoleContract(providerContractClient, freshProviderTopology);
    } catch (error) {
      missingProviderSetEdgeRejected = String(error).includes("Rollenmitgliedschaften");
    }
    ok(
      "PG18-Providervertrag lehnt eine fehlende app_worker-SET-Kante ab",
      missingProviderSetEdgeRejected,
    );
    await providerContractClient.query(`
      set role provider_admin_sim;
      grant app_worker to provider_admin_sim
        with admin false, inherit false, set true granted by current_user;
      reset role;
    `);
  } finally {
    providerContractClient.release();
  }

  // Legacy-Providervertrag: identity_reconciler existierte bereits vor dem
  // Provisioning-Admin. Seine historische Bootstrapkante zeigt deshalb nur
  // zur retained Legacy-Rolle; die Fachkante zu app_owner wird vom echten
  // Bootstrap-Superuser getragen. Die Fresh-Probe oben blieb davon unberührt.
  await superuser.query(`
    set role provider_admin_sim;
    revoke identity_reconciler from app_owner granted by current_user cascade;
    reset role;
    revoke identity_reconciler from provider_admin_sim granted by current_user cascade;
    grant identity_reconciler to app_owner
      with admin true, inherit false, set false granted by current_user;
  `);

  // Historische 0015-Installationen erzeugten die Clusterrolle ohne explizites
  // NOINHERIT; PostgreSQLs Default war daher INHERIT. Der Fresh-Pfad dieses
  // Probelaufs hat dieselbe clusterweite Rolle bereits gehärtet, also stellen
  // wir den echten Legacy-Drift vor Aufbau der zweiten DB bewusst wieder her.
  await superuser.query("alter role identity_reconciler inherit");
  await superuser.query(`
    create role app_legacy login password 'legacy' noinherit nosuperuser nobypassrls
      createdb createrole noreplication;
    grant identity_reconciler to app_legacy with admin true, inherit false, set false;
  `);
  await superuser.query(`create database ${upgradeDb} owner app_legacy`);

  const legacyMigrationFolder = migrationPrefixThrough(18);
  const upgradeSuperuser = new Pool({ connectionString: upgradeSuperuserUrl.toString(), max: 2 });
  try {
    await upgradeSuperuser.query(`
      alter schema public owner to app_legacy;
      grant all privileges on schema public to app_legacy;
      grant all privileges on database ${upgradeDb} to app_legacy;
    `);
    execFileSync("npx", ["tsx", "scripts/migrate.mts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_ROLE_MODE: "test-legacy-single",
        TEST_MIGRATIONS_FOLDER: legacyMigrationFolder,
        POSTGRES_URL_MIGRATE: legacyUrl,
        POSTGRES_TEST_TARGET_CONFIRM:
          `${host}/${upgradeDb}:ALLOW-DESTRUCTIVE-TESTS`,
      },
      stdio: "inherit",
    });

    const journalBefore = await upgradeSuperuser.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations where created_at=1787965786722",
    );
    ok("Legacy-Upgrade startet nachweislich auf Schema 0018", journalBefore.rows[0].n === 0);

    const historicalIdentity = await upgradeSuperuser.query<{
      rolinherit: boolean;
      legacy_execute: boolean;
    }>(`
      select r.rolinherit,
             pg_catalog.has_function_privilege(
               'app_legacy',
               'public.reconcile_user_identity(text,text)',
               'EXECUTE'
             ) as legacy_execute
      from pg_catalog.pg_roles r
      where r.rolname = 'identity_reconciler'
    `);
    ok(
      "Legacy-Probe bildet 0015-INHERIT und altes Reconcile-EXECUTE wirklich nach",
      historicalIdentity.rows[0]?.rolinherit === true &&
        historicalIdentity.rows[0]?.legacy_execute === true,
    );

    // Der alte Worker verwendete new PgBoss(POSTGRES_URL) und ließ Schema wie
    // Objekte automatisch unter dem damaligen Ein-Rollen-Principal anlegen.
    // Ein wartender Job beweist beim Cutover nicht nur Owner, sondern Datenhalt.
    const legacyBoss = new PgBoss(legacyUrl);
    legacyBoss.on("error", () => undefined);
    try {
      await legacyBoss.start();
      await legacyBoss.createQueue(legacyQueue, { partition: true });
      legacyJobId = await legacyBoss.send(legacyQueue, { source: "legacy-worker" });
    } finally {
      await legacyBoss.stop({ graceful: false }).catch(() => undefined);
    }
    ok("Legacy-Probe besitzt einen echten wartenden pg-boss-Bestandsjob", Boolean(legacyJobId));
    const legacyQueueCatalog = await upgradeSuperuser.query<{ table_name: string }>(`
      select table_name
      from pgboss.queue
      where name = $1
        and partition
    `, [legacyQueue]);
    const legacyQueueTable = legacyQueueCatalog.rows[0]?.table_name;
    ok(
      "Legacy-Probe löst die echte dynamische pg-boss-Queuepartition auf",
      typeof legacyQueueTable === "string" && /^j[0-9a-f]{56}$/.test(legacyQueueTable),
      legacyQueueTable ?? "keine Partition",
    );

    const workspaceId = randomUUID();
    const userId = randomUUID();
    await upgradeSuperuser.query(`
      create role cutover_rogue nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;
    `);
    const legacy = new Pool({ connectionString: legacyUrl, max: 1 });
    try {
      await inTenant(legacy, workspaceId, [
        { text: "insert into public.workspace(id, name) values ($1::uuid, 'legacy-bestand')", values: [workspaceId] },
        { text: "insert into public.user_identity(id, email) values ($1::uuid, $2)", values: [userId, `${userId}@legacy.test`] },
        {
          text: "insert into public.membership(workspace_id, user_id, role) values ($1::uuid, $2::uuid, 'admin')",
          values: [workspaceId, userId],
        },
      ]);
      await legacy.query("grant select on public.site to cutover_rogue");
    } finally {
      await legacy.end();
    }

    // Exakt derselbe zweiphasige Cutover: erst Control-Freeze, Drain, zweiter
    // Preflight und clusterweite Rollen-Härtung; danach laufen Owner-/ACL-
    // Wechsel und Daten-Gates atomar. Kein blanket REASSIGN.
    const cutover = await upgradeSuperuser.connect();
    const cutoverControlPool = new Pool({ connectionString: embedded.superuserUrl, max: 4 });
    const cutoverControl = await cutoverControlPool.connect();
    const lingeringLegacyPool = new Pool({ connectionString: legacyUrl, max: 1 });
    const lingeringLegacy = await lingeringLegacyPool.connect();
    // Bereits vor dem Control-Freeze öffnen: datallowconn=false beendet
    // bestehende Sessions absichtlich nicht; genau diese müssen sichtbar drainen.
    const activeSystemPool = new Pool({ connectionString: upgradeSystemUrl, max: 1 });
    const activeSystem = await activeSystemPool.connect();
    let lingeringLegacyReleased = false;
    let activeSystemReleased = false;
    try {
      const cutoverOptions = {
        expectedDatabase: upgradeDb,
        expectedControlDatabase: DB,
        expectedDatabaseConnectionLimit: -1,
        legacyRole: "app_legacy",
        expectedAdminRole: "postgres",
        expectedIdentityBootstrapGrantorRole: "postgres",
        provisioningTopology: providerTopology,
        confirmedClusterWideNoLoginRoles: ["app_legacy", "identity_reconciler"],
        sample: { workspaceId, userId, pgBossJobId: legacyJobId! },
      } as const;

      const readPhase1MutationState = async () => {
        const state = await cutover.query<{
          rolcanlogin: boolean;
          rolcreaterole: boolean;
          rolconnlimit: number;
          datallowconn: boolean;
          datconnlimit: number;
        }>(`
          select legacy.rolcanlogin,
                 legacy.rolcreaterole,
                 legacy.rolconnlimit,
                 database.datallowconn,
                 database.datconnlimit
          from pg_catalog.pg_roles legacy
          cross join pg_catalog.pg_database database
          where legacy.rolname = 'app_legacy'
            and database.datname = pg_catalog.current_database()
        `);
        return state.rows[0];
      };

      const expectPreMutationCutoverRejection = async (
        label: string,
        expectedError: string,
      ): Promise<void> => {
        let gateError = "";
        try {
          await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
        } catch (error) {
          gateError = String(error);
        }
        const state = await readPhase1MutationState();
        ok(
          label,
          gateError.includes(expectedError) &&
            state?.rolcanlogin === true &&
            state.rolcreaterole === true &&
            state.rolconnlimit === -1 &&
            state.datallowconn === true &&
            state.datconnlimit === -1,
          gateError,
        );
      };

      const readFaultBoundaryState = async () => {
        const state = await cutoverControl.query<{
          datallowconn: boolean;
          datconnlimit: number;
          rolcanlogin: boolean;
          rolcreaterole: boolean;
        }>(`
          select database.datallowconn,
                 database.datconnlimit,
                 legacy.rolcanlogin,
                 legacy.rolcreaterole
          from pg_catalog.pg_database database
          cross join pg_catalog.pg_roles legacy
          where database.datname = $1
            and legacy.rolname = 'app_legacy'
        `, [upgradeDb]);
        return state.rows[0];
      };

      const resetOpenAfterFreezeFault = async () => {
        const resetControl = await cutoverControlPool.connect();
        try {
          await resetControl.query(
            `alter database ${quoteIdentifier(upgradeDb)} allow_connections true`,
          );
        } finally {
          resetControl.release(true);
        }
      };

      const freezeAckControlRaw = await cutoverControlPool.connect();
      const freezeAckControl = loseNextCommitAcknowledgement(
        freezeAckControlRaw,
        "freeze-commit-ack",
      );
      let freezeReconnects = 0;
      let freezeAckControlDiscarded = false;
      let freezeAckError = "";
      try {
        await quarantineLegacyRoles(
          cutover,
          freezeAckControl,
          cutoverOptions,
          async (compromised) => {
            if (compromised !== freezeAckControl) {
              throw new Error("Freeze-Reconnect erhielt die falsche Control-Session");
            }
            freezeReconnects += 1;
            freezeAckControlDiscarded = true;
            compromised.release(true);
            return cutoverControlPool.connect();
          },
        );
      } catch (error) {
        freezeAckError = String(error);
      } finally {
        if (!freezeAckControlDiscarded) freezeAckControlRaw.release(true);
      }
      const frozenAfterLostFreezeAck = await readFaultBoundaryState();
      ok(
        "Verlorener Freeze-COMMIT-ACK nutzt eine frische Control-Session und bleibt bestätigt geschlossen",
        freezeReconnects === 1 &&
          freezeAckError.includes("Control-Freeze-COMMIT-Antwort ging verloren") &&
          freezeAckError.includes("bleibt fail-closed mit ALLOW_CONNECTIONS=false") &&
          !freezeAckError.includes("defekte Control-Session wurde wiederverwendet") &&
          frozenAfterLostFreezeAck?.datallowconn === false &&
          frozenAfterLostFreezeAck.datconnlimit === -1 &&
          frozenAfterLostFreezeAck.rolcanlogin === true &&
          frozenAfterLostFreezeAck.rolcreaterole === true,
        freezeAckError,
      );
      await resetOpenAfterFreezeFault();

      const reconnectFailureControlRaw = await cutoverControlPool.connect();
      const reconnectFailureControl = loseNextCommitAcknowledgement(
        reconnectFailureControlRaw,
        "freeze-reconnect-failure",
      );
      let reconnectFailureAttempts = 0;
      let reconnectFailureControlDiscarded = false;
      let reconnectFailureError = "";
      try {
        await quarantineLegacyRoles(
          cutover,
          reconnectFailureControl,
          cutoverOptions,
          async (compromised) => {
            if (compromised !== reconnectFailureControl) {
              throw new Error("Reconnect-Fehlerprobe erhielt die falsche Control-Session");
            }
            reconnectFailureAttempts += 1;
            reconnectFailureControlDiscarded = true;
            compromised.release(true);
            throw new Error("simulierter Control-Reconnect-Ausfall");
          },
        );
      } catch (error) {
        reconnectFailureError = String(error);
      } finally {
        if (!reconnectFailureControlDiscarded) reconnectFailureControlRaw.release(true);
      }
      const actualAfterUnconfirmedReconnect = await readFaultBoundaryState();
      ok(
        "Reconnect-Ausfall meldet den Control-Zustand ehrlich als unbestätigt ohne false-Claim",
        reconnectFailureAttempts === 1 &&
          reconnectFailureError.includes("Zustand unbestätigt") &&
          reconnectFailureError.includes("simulierter Control-Reconnect-Ausfall") &&
          !reconnectFailureError.includes("bleibt fail-closed mit ALLOW_CONNECTIONS=false") &&
          !reconnectFailureError.includes("defekte Control-Session wurde wiederverwendet") &&
          actualAfterUnconfirmedReconnect?.datallowconn === false &&
          actualAfterUnconfirmedReconnect.datconnlimit === -1 &&
          actualAfterUnconfirmedReconnect.rolcanlogin === true &&
          actualAfterUnconfirmedReconnect.rolcreaterole === true,
        reconnectFailureError,
      );
      await resetOpenAfterFreezeFault();

      const rollbackFaultControlRaw = await cutoverControlPool.connect();
      const rollbackFault = failFreezeAttestationAndRollback(
        rollbackFaultControlRaw,
        "freeze-rollback-failure",
      );
      let rollbackFaultReconnects = 0;
      let rollbackFaultControlDiscarded = false;
      let rollbackFaultError = "";
      try {
        await quarantineLegacyRoles(
          cutover,
          rollbackFault.client,
          cutoverOptions,
          async (compromised) => {
            if (compromised !== rollbackFault.client) {
              throw new Error("ROLLBACK-Fehlerprobe erhielt die falsche Control-Session");
            }
            rollbackFaultReconnects += 1;
            rollbackFaultControlDiscarded = true;
            compromised.release(true);
            return cutoverControlPool.connect();
          },
        );
      } catch (error) {
        rollbackFaultError = String(error);
      } finally {
        if (!rollbackFaultControlDiscarded) rollbackFaultControlRaw.release(true);
      }
      const frozenAfterRollbackFault = await readFaultBoundaryState();
      ok(
        "Fehlgeschlagenes Control-ROLLBACK erzwingt frischen committed Refreeze",
        rollbackFault.rollbackFailures() === 2 &&
          rollbackFaultReconnects === 1 &&
          rollbackFaultError.includes("ROLLBACK erreichte den Server nicht") &&
          rollbackFaultError.includes("bleibt fail-closed mit ALLOW_CONNECTIONS=false") &&
          !rollbackFaultError.includes("Zustand unbestätigt") &&
          frozenAfterRollbackFault?.datallowconn === false &&
          frozenAfterRollbackFault.datconnlimit === -1 &&
          frozenAfterRollbackFault.rolcanlogin === true &&
          frozenAfterRollbackFault.rolcreaterole === true,
        rollbackFaultError,
      );
      await resetOpenAfterFreezeFault();

      const restrictedAdminPool = new Pool({ connectionString: providerCutoverUrl, max: 1 });
      const restrictedControlPool = new Pool({ connectionString: providerControlUrl, max: 1 });
      try {
        const restrictedAdmin = await restrictedAdminPool.connect();
        const restrictedControl = await restrictedControlPool.connect();
        try {
          const restrictedIdentity = await restrictedAdmin.query<{
            server_version_num: number;
            rolsuper: boolean;
            rolcreaterole: boolean;
          }>(`
            select pg_catalog.current_setting('server_version_num')::int as server_version_num,
                   role.rolsuper,
                   role.rolcreaterole
            from pg_catalog.pg_roles role
            where role.rolname = session_user
          `);
          let restrictedAdminError = "";
          try {
            await quarantineLegacyRoles(
              restrictedAdmin,
              restrictedControl,
              {
                ...cutoverOptions,
                expectedAdminRole: "provider_admin_sim",
              },
            );
          } catch (error) {
            restrictedAdminError = String(error);
          }
          const state = await readPhase1MutationState();
          const identity = restrictedIdentity.rows[0];
          ok(
            "PG18-NOSUPERUSER+CREATEROLE scheitert vor Phase-1-Härtung und CONNECTION LIMIT",
            identity?.server_version_num >= 180_000 &&
              identity.server_version_num < 190_000 &&
              identity.rolsuper === false &&
              identity.rolcreaterole === true &&
              restrictedAdminError.includes("echten SUPERUSER") &&
              state?.rolcanlogin === true &&
              state.rolcreaterole === true &&
              state.rolconnlimit === -1 &&
              state.datallowconn === true &&
              state.datconnlimit === -1,
            restrictedAdminError,
          );
        } finally {
          restrictedAdmin.release();
          restrictedControl.release();
        }
      } finally {
        await Promise.allSettled([restrictedAdminPool.end(), restrictedControlPool.end()]);
      }

      await lingeringLegacy.query("alter table pgboss.bam drop constraint bam_pkey");
      try {
        await expectPreMutationCutoverRejection(
          "pg-boss-Constraintvertrag erkennt eine fehlende BAM-PK vor jeder Mutation",
          "Live-0018-pg-boss-Constraintvertrag",
        );
      } finally {
        await lingeringLegacy.query(
          "alter table pgboss.bam add constraint bam_pkey primary key (id)",
        );
      }

      const queuePartition = quoteIdentifier(legacyQueueTable!);
      await lingeringLegacy.query(
        `alter table pgboss.${queuePartition} drop constraint q_fkey`,
      );
      try {
        await expectPreMutationCutoverRejection(
          "pg-boss-Constraintvertrag erkennt eine fehlende Queue-FK vor jeder Mutation",
          "Live-0018-pg-boss-Constraintvertrag",
        );
      } finally {
        await lingeringLegacy.query(
          `alter table pgboss.${queuePartition} add constraint q_fkey ` +
            "foreign key (name) references pgboss.queue(name) on delete restrict " +
            "deferrable initially deferred",
        );
      }

      await lingeringLegacy.query(
        `alter table pgboss.${queuePartition} drop constraint cjc`,
      );
      try {
        await expectPreMutationCutoverRejection(
          "pg-boss-Constraintvertrag erkennt einen fehlenden Queue-CHECK vor jeder Mutation",
          "Live-0018-pg-boss-Constraintvertrag",
        );
      } finally {
        await lingeringLegacy.query(
          `alter table pgboss.${queuePartition} add constraint cjc ` +
            `check (name = ${quoteSqlLiteral(legacyQueue)})`,
        );
      }

      // Ein unverändertes Journal beweist allein noch keinen unveränderten
      // Live-Katalog. Selbst ein harmloser No-op-Trigger im Drizzle-Schema
      // muss die Quarantäne vor der ersten Rollenmutation fail-closed stoppen.
      await lingeringLegacy.query(`
        create function drizzle.cutover_probe_trigger()
        returns trigger
        language plpgsql
        volatile
        security invoker
        set search_path = pg_catalog
        as $fn$
        begin
          return new;
        end
        $fn$;
        create trigger cutover_probe_trigger
          before insert on drizzle.__drizzle_migrations
          for each row execute function drizzle.cutover_probe_trigger();
      `);
      let liveSurfaceGateClosed = false;
      let liveSurfaceGateError = "";
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        const position =
          typeof error === "object" && error !== null && "position" in error
            ? String((error as { position?: unknown }).position ?? "-")
            : "-";
        liveSurfaceGateError = `${String(error)} (SQL-Position ${position})`;
        liveSurfaceGateClosed =
          liveSurfaceGateError.includes("Live-0018-Routinenvertrag") ||
          liveSurfaceGateError.includes("Live-0018-Triggervertrag");
      }
      const roleBeforeRealQuarantine = await cutover.query<{
        rolcanlogin: boolean;
        rolcreaterole: boolean;
      }>(`
        select rolcanlogin, rolcreaterole
        from pg_catalog.pg_roles
        where rolname = 'app_legacy'
      `);
      ok(
        "Live-0018-Vertrag lehnt einen fremden Drizzle-Trigger vor jeder Quarantäne-Mutation ab",
        liveSurfaceGateClosed &&
          roleBeforeRealQuarantine.rows[0]?.rolcanlogin === true &&
          roleBeforeRealQuarantine.rows[0]?.rolcreaterole === true,
        liveSurfaceGateError,
      );
      await lingeringLegacy.query(`
        drop trigger cutover_probe_trigger on drizzle.__drizzle_migrations;
        drop function drizzle.cutover_probe_trigger();
      `);

      await lingeringLegacy.query("drop index public.membership_ws_user_uq");
      let structureGateClosed = false;
      let structureGateError = "";
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        structureGateError = String(error);
        structureGateClosed = structureGateError.includes("Live-0018-Kernstruktur");
      }
      const roleAfterStructureDrift = await cutover.query<{ rolcanlogin: boolean }>(`
        select rolcanlogin from pg_catalog.pg_roles where rolname = 'app_legacy'
      `);
      ok(
        "Live-0018-Kernstruktur erkennt einen entfernten Membership-Unique-Index vor jeder Mutation",
        structureGateClosed && roleAfterStructureDrift.rows[0]?.rolcanlogin === true,
        structureGateError,
      );
      await lingeringLegacy.query(`
        create unique index membership_ws_user_uq
          on public.membership using btree (workspace_id, user_id)
      `);

      const roguePgBossPartition = `j${"0".repeat(56)}`;
      await lingeringLegacy.query(
        `create table pgboss.${roguePgBossPartition} (id integer)`,
      );
      let pgBossTopologyGateClosed = false;
      let pgBossTopologyGateError = "";
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        pgBossTopologyGateError = String(error);
        pgBossTopologyGateClosed = pgBossTopologyGateError.includes(
          "Live-0018-pg-boss-Tabellenvertrag",
        );
      }
      ok(
        "pg-boss-Vertrag lehnt eine passend benannte, aber verwaiste Jobpartition ab",
        pgBossTopologyGateClosed,
        pgBossTopologyGateError,
      );
      await lingeringLegacy.query(`drop table pgboss.${roguePgBossPartition}`);

      await cutover.query(`
        create role cutover_bridge nologin noinherit nosuperuser nobypassrls
          nocreatedb nocreaterole noreplication;
        grant app_legacy to cutover_bridge
          with admin false, inherit false, set true;
      `);
      let bridgeGateClosed = false;
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        bridgeGateClosed = String(error).includes("SET-ROLE-Pfad");
      }
      ok(
        "Quarantäne lehnt einen über Bridge-Login erreichbaren Legacy-SET-Pfad ab",
        bridgeGateClosed,
      );
      await cutover.query(
        "revoke app_legacy from cutover_bridge granted by current_user cascade",
      );

      let drainGateClosed = false;
      let drainGateError = "";
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        drainGateError = String(error);
        drainGateClosed =
          drainGateError.includes("aktive Sessions") &&
          drainGateError.includes("ALLOW_CONNECTIONS=false");
      }
      const frozenAfterDrainFailure = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      ok(
        "Control-Freeze stoppt bei vorhandenen Target-Sessions dauerhaft fail-closed",
        drainGateClosed &&
          frozenAfterDrainFailure.rows[0]?.datallowconn === false &&
          frozenAfterDrainFailure.rows[0]?.datconnlimit === -1,
        drainGateError,
      );

      const rejectedByDatabaseFreeze = async (connectionString: string) => {
        const probePool = new Pool({
          connectionString,
          max: 1,
          connectionTimeoutMillis: 2_000,
        });
        try {
          await probePool.query("select 1");
          return false;
        } catch {
          return true;
        } finally {
          await probePool.end().catch(() => undefined);
        }
      };
      const [newWorkerDenied, newSuperuserDenied] = await Promise.all([
        rejectedByDatabaseFreeze(upgradeWorkerUrl),
        rejectedByDatabaseFreeze(upgradeSuperuserUrl.toString()),
      ]);
      ok(
        "ALLOW_CONNECTIONS=false blockiert neue normale Target-Verbindungen",
        newWorkerDenied,
      );
      ok(
        "ALLOW_CONNECTIONS=false blockiert auch neue SUPERUSER-Target-Verbindungen",
        newSuperuserDenied,
      );

      // PostgreSQL beendet beim Freeze keine bereits offenen Backends. Eine
      // solche Session kann noch DDL versuchen; der zweite vollständige
      // Preflight nach Drain muss diesen Drift erkennen, statt den alten
      // Snapshot als Freigabe zu behandeln.
      await lingeringLegacy.query("create schema cutover_parallel_drift authorization app_legacy");
      lingeringLegacy.release();
      lingeringLegacyReleased = true;
      await lingeringLegacyPool.end();
      activeSystem.release();
      activeSystemReleased = true;
      await activeSystemPool.end();

      let parallelDdlRejected = false;
      let parallelDdlError = "";
      try {
        await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      } catch (error) {
        parallelDdlError = String(error);
        parallelDdlRejected =
          parallelDdlError.includes("cutover_parallel_drift") &&
          parallelDdlError.includes("ALLOW_CONNECTIONS=false");
      }
      const stillFrozenAfterDrift = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      ok(
        "Paralleles CREATE SCHEMA umgeht den Freeze-Snapshot nicht und Fehler bleibt geschlossen",
        parallelDdlRejected &&
          stillFrozenAfterDrift.rows[0]?.datallowconn === false &&
          stillFrozenAfterDrift.rows[0]?.datconnlimit === -1,
        parallelDdlError,
      );
      await cutover.query("drop schema cutover_parallel_drift");

      await quarantineLegacyRoles(cutover, cutoverControl, cutoverOptions);
      const quarantineAttributes = await cutover.query<{
        rolname: string;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolconnlimit: number;
      }>(`
        select rolname, rolcanlogin, rolinherit, rolcreatedb, rolcreaterole, rolconnlimit
        from pg_catalog.pg_roles
        where rolname in ('app_legacy', 'identity_reconciler')
        order by rolname
      `);
      const phase1Frozen = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      ok(
        "Phase 1 committed Rollen-Härtung erst nach Drain und lässt Target eingefroren",
        quarantineAttributes.rows.length === 2 &&
          quarantineAttributes.rows.every((row) =>
            !row.rolcanlogin &&
            !row.rolinherit &&
            !row.rolcreatedb &&
            !row.rolcreaterole &&
            row.rolconnlimit === (row.rolname === "app_legacy" ? 0 : -1),
          ) &&
          phase1Frozen.rows[0]?.datallowconn === false &&
          phase1Frozen.rows[0]?.datconnlimit === 0,
      );

      const unfreezeAckControlRaw = await cutoverControlPool.connect();
      const unfreezeAckControl = loseNextCommitAcknowledgement(
        unfreezeAckControlRaw,
        "unfreeze-commit-ack",
      );
      let unfreezeReconnects = 0;
      let unfreezeAckControlDiscarded = false;
      let unfreezeAckError = "";
      try {
        await cutoverLegacyDatabaseRole(
          cutover,
          unfreezeAckControl,
          cutoverOptions,
          async (compromised) => {
            if (compromised !== unfreezeAckControl) {
              throw new Error("Unfreeze-Reconnect erhielt die falsche Control-Session");
            }
            unfreezeReconnects += 1;
            unfreezeAckControlDiscarded = true;
            compromised.release(true);
            return cutoverControlPool.connect();
          },
        );
      } catch (error) {
        unfreezeAckError = String(error);
      } finally {
        if (!unfreezeAckControlDiscarded) unfreezeAckControlRaw.release(true);
      }
      const frozenAfterLostUnfreezeAck = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      const ownershipAfterAmbiguousUnfreeze = await cutover.query<{
        relations: number;
        routines: number;
        types: number;
      }>(`
        select
          (select count(*)::int
             from pg_catalog.pg_class relation
             join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             join pg_catalog.pg_roles owner on owner.oid = relation.relowner
            where namespace.nspname in ('public', 'drizzle', 'pgboss')
              and owner.rolname in ('app_owner', 'app_worker')) as relations,
          (select count(*)::int
             from pg_catalog.pg_proc routine
             join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             join pg_catalog.pg_roles owner on owner.oid = routine.proowner
            where namespace.nspname in ('public', 'drizzle', 'pgboss')
              and owner.rolname in ('app_owner', 'app_worker')) as routines,
          (select count(*)::int
             from pg_catalog.pg_type type
             join pg_catalog.pg_namespace namespace on namespace.oid = type.typnamespace
             join pg_catalog.pg_roles owner on owner.oid = type.typowner
            where namespace.nspname in ('public', 'drizzle', 'pgboss')
              and owner.rolname in ('app_owner', 'app_worker')) as types
      `);
      ok(
        "Verlorener Unfreeze-COMMIT-ACK nach sicherem Target-Commit wird frisch reattestiert und refrozen",
        unfreezeReconnects === 1 &&
          unfreezeAckError.includes("Control-Unfreeze-COMMIT-Antwort ging verloren") &&
          unfreezeAckError.includes("Der atomare Target-Commit war erfolgreich") &&
          unfreezeAckError.includes("bleibt fail-closed mit ALLOW_CONNECTIONS=false") &&
          !unfreezeAckError.includes("defekte Control-Session wurde wiederverwendet") &&
          frozenAfterLostUnfreezeAck.rows[0]?.datallowconn === false &&
          frozenAfterLostUnfreezeAck.rows[0]?.datconnlimit === -1 &&
          ownershipAfterAmbiguousUnfreeze.rows[0]?.relations > 0 &&
          ownershipAfterAmbiguousUnfreeze.rows[0]?.routines > 0 &&
          ownershipAfterAmbiguousUnfreeze.rows[0]?.types > 0,
        unfreezeAckError,
      );

      const postCommitAttestationControlRaw = await cutoverControlPool.connect();
      const postCommitAttestationControl = failAfterNextCommittedControlTransaction(
        postCommitAttestationControlRaw,
        "unfreeze-post-commit-attestation",
      );
      let postCommitReconnects = 0;
      let postCommitControlDiscarded = false;
      let postCommitAttestationError = "";
      try {
        await recoverLegacyCutoverConnections(
          postCommitAttestationControl,
          cutoverOptions,
          `${DB}->${upgradeDb}:ALLOW-CONNECTIONS-RECOVERY:-1`,
          async (compromised) => {
            if (compromised !== postCommitAttestationControl) {
              throw new Error("Post-COMMIT-Probe erhielt die falsche Control-Session");
            }
            postCommitReconnects += 1;
            postCommitControlDiscarded = true;
            compromised.release(true);
            return cutoverControlPool.connect();
          },
        );
      } catch (error) {
        postCommitAttestationError = String(error);
      } finally {
        if (!postCommitControlDiscarded) postCommitAttestationControlRaw.release(true);
      }
      const frozenAfterPostCommitAttestationFailure = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      ok(
        "Tote Control-Session nach bestätigtem Unfreeze-COMMIT wird frisch refrozen statt offen behauptet",
        postCommitReconnects === 1 &&
          postCommitAttestationError.includes(
            "Control-Session starb nach bestätigtem COMMIT",
          ) &&
          postCommitAttestationError.includes(
            "bleibt fail-closed mit ALLOW_CONNECTIONS=false",
          ) &&
          frozenAfterPostCommitAttestationFailure.rows[0]?.datallowconn === false &&
          frozenAfterPostCommitAttestationFailure.rows[0]?.datconnlimit === -1,
        postCommitAttestationError,
      );

      await recoverLegacyCutoverConnections(
        cutoverControl,
        cutoverOptions,
        `${DB}->${upgradeDb}:ALLOW-CONNECTIONS-RECOVERY:-1`,
      );
      const restoredDatabaseState = await cutoverControl.query<{
        datallowconn: boolean;
        datconnlimit: number;
      }>(`
        select datallowconn, datconnlimit
        from pg_catalog.pg_database
        where datname = $1
      `, [upgradeDb]);
      const [workerStillDenied, superuserStillDenied] = await Promise.all([
        rejectedByDatabaseFreeze(upgradeWorkerUrl),
        rejectedByDatabaseFreeze(upgradeSuperuserUrl.toString()),
      ]);
      ok(
        "Phase 2 öffnet ausschließlich über Control exakt ALLOW_CONNECTIONS und CONNECTION LIMIT wieder",
        restoredDatabaseState.rows[0]?.datallowconn === true &&
          restoredDatabaseState.rows[0]?.datconnlimit === -1,
      );
      ok(
        "Control-Unfreeze erlaubt danach wieder normale und SUPERUSER-Target-Verbindungen",
        !workerStillDenied && !superuserStillDenied,
      );
      const databaseAcl = await cutover.query<{
        signature: string;
      }>(`
        select coalesce(grantee.rolname, 'PUBLIC') || ':' ||
               acl.privilege_type || ':' || grantor.rolname || ':' ||
               acl.is_grantable::text as signature
        from pg_catalog.pg_database database
        cross join lateral pg_catalog.aclexplode(
          coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
        ) acl
        join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
        where database.datname = pg_catalog.current_database()
          and acl.grantee <> database.datdba
        order by grantee.rolname, acl.privilege_type, grantor.rolname
      `);
      const serviceDatabasePrivileges = await cutover.query<{
        role_name: string;
        can_connect: boolean;
        can_create_temporary: boolean;
      }>(`
        select role_name,
               pg_catalog.has_database_privilege(
                 role_name,
                 pg_catalog.current_database(),
                 'CONNECT'
               ) as can_connect,
               pg_catalog.has_database_privilege(
                 role_name,
                 pg_catalog.current_database(),
                 'TEMPORARY'
               ) as can_create_temporary
        from pg_catalog.unnest($1::text[]) as roles(role_name)
        order by role_name
      `, [[
        "app_migrator",
        "app_runtime",
        "app_system",
        "app_auth",
        "app_worker",
        "app_membership_writer",
        "identity_reconciler",
      ]]);
      ok(
        "Cutover lässt PUBLIC exakt CONNECT und keinem Service TEMPORARY",
        JSON.stringify(databaseAcl.rows.map((row) => row.signature)) ===
          JSON.stringify(["PUBLIC:CONNECT:app_owner:false"]) &&
          serviceDatabasePrivileges.rows.every(
            (row) => row.can_connect && !row.can_create_temporary,
          ),
        JSON.stringify({ databaseAcl: databaseAcl.rows, services: serviceDatabasePrivileges.rows }),
      );
    } finally {
      if (!lingeringLegacyReleased) lingeringLegacy.release();
      await lingeringLegacyPool.end().catch(() => undefined);
      if (!activeSystemReleased) activeSystem.release();
      await activeSystemPool.end().catch(() => undefined);
      cutover.release();
      cutoverControl.release();
      await cutoverControlPool.end();
    }

    const rogueGrant = await upgradeSuperuser.query<{ allowed: boolean }>(`
      select pg_catalog.has_table_privilege(
        'cutover_rogue',
        'public.site',
        'SELECT'
      ) as allowed
    `);
    ok(
      "Legacy→Fremdgrant wird vor ALTER OWNER entfernt statt auf app_owner gewaschen",
      rogueGrant.rows[0]?.allowed === false,
    );

    const postCutoverMigrationAuthority = await upgradeSuperuser.query<{
      owner: string;
      owner_references: boolean;
      migrator_can_set_owner: boolean;
    }>(`
      select owner.rolname as owner,
             pg_catalog.has_table_privilege('app_owner', relation.oid, 'REFERENCES')
               as owner_references,
             pg_catalog.pg_has_role('app_migrator', 'app_owner', 'SET')
               as migrator_can_set_owner
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_catalog.pg_roles owner on owner.oid = relation.relowner
      where namespace.nspname = 'public' and relation.relname = 'site'
    `);
    ok(
      "Cutover hinterlaesst Site unter migrationsfaehiger app_owner-Autoritaet",
      postCutoverMigrationAuthority.rows[0]?.owner === "app_owner" &&
        postCutoverMigrationAuthority.rows[0]?.owner_references === true &&
        postCutoverMigrationAuthority.rows[0]?.migrator_can_set_owner === true,
      JSON.stringify(postCutoverMigrationAuthority.rows[0]),
    );

    execFileSync("npx", ["tsx", "scripts/migrate.mts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_ROLE_MODE: "strict",
        DB_ROLE_PROVISIONING_ADMIN: providerTopology.provisioningAdminRole,
        DB_ROLE_BOOTSTRAP_GRANTOR: providerTopology.bootstrapGrantorRole,
        DB_ROLE_RETAINED_LEGACY_ROLE: providerTopology.retainedLegacyRole,
        POSTGRES_URL_MIGRATE: upgradeMigratorUrl,
      },
      stdio: "inherit",
    });

    const upgradedBoss = new PgBoss({
      connectionString: upgradeWorkerUrl,
      schema: "pgboss",
      createSchema: false,
      max: 2,
    });
    upgradedBoss.on("error", () => undefined);
    let legacyQueuePreserved = false;
    try {
      await upgradedBoss.start();
      const [legacyJob] = await upgradedBoss.fetch<{ source: string }>(legacyQueue);
      legacyQueuePreserved =
        legacyJob?.id === legacyJobId && legacyJob.data.source === "legacy-worker";
      if (legacyJob) await upgradedBoss.complete(legacyQueue, [legacyJob.id]);
    } finally {
      await upgradedBoss.stop({ graceful: false }).catch(() => undefined);
    }
    ok("Legacy-pg-boss-Job und Worker-Zugriff überleben den atomaren Owner-Cutover", legacyQueuePreserved);

    const preserved = await upgradeSuperuser.query<{
      workspace_name: string;
      role: string;
      migration_count: number;
    }>(`
      select w.name as workspace_name,
             m.role,
             (select count(*)::int from drizzle.__drizzle_migrations
               where created_at=1787965786722) as migration_count
      from public.workspace w
      join public.membership m on m.workspace_id=w.id
      where w.id=$1::uuid and m.user_id=$2::uuid
    `, [workspaceId, userId]);
    ok(
      "Legacy 0018 → Ownership-Cutover → aktuelle Historie erhält Bestandsdaten und Journal",
      preserved.rows[0]?.workspace_name === "legacy-bestand" &&
        preserved.rows[0]?.role === "admin" &&
        preserved.rows[0]?.migration_count === 1,
    );
  } finally {
    await upgradeSuperuser.end();
    rmSync(legacyMigrationFolder, { recursive: true, force: true });
  }
}

const pools: Pool[] = [];
try {
  let partialProviderTopologyRejected = false;
  try {
    dbRoleProvisioningTopologyFromEnvironment({
      ...process.env,
      DB_ROLE_PROVISIONING_ADMIN: "provider_admin_sim",
      DB_ROLE_BOOTSTRAP_GRANTOR: undefined,
      DB_ROLE_RETAINED_LEGACY_ROLE: undefined,
    });
  } catch {
    partialProviderTopologyRejected = true;
  }
  ok(
    "Provider-Topologie-Env ist all-or-none und scheitert bei fehlendem Bootstrap-Grantor",
    partialProviderTopologyRejected,
  );

  // Der Bootstrap läuft absichtlich als lokale Superuser-Testverbindung. In
  // Neon ist das die direkte Admin-Verbindung; Runtime-Rollen werden dort per
  // SQL erzeugt, nie über Console/API/CLI (sonst neon_superuser/BYPASSRLS).
  await superuser.query(`
    -- startEmbeddedPostgres provisioniert für die historische Ein-Rollen-
    -- Testsuite app_test als Marker-Mitglied. Die strikte Probe entfernt
    -- diese Testausnahme, damit ihr Rollenvertrag produktionsgleich exakt ist.
    revoke app_membership_writer from app_test;

    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password 'mig' noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_runtime login password 'run' noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_system login password 'sys' noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login password 'aut' noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password 'wrk' noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    alter role app_membership_writer nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role identity_reconciler nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;

    grant app_owner to app_migrator with admin false, inherit false, set true;
    grant app_membership_writer to app_system with admin false, inherit false, set false;
    grant app_membership_writer to app_owner with admin false, inherit false, set false;
    grant identity_reconciler to app_owner with admin true, inherit false, set false;

    alter database ${DB} owner to app_owner;
    revoke all privileges on database ${DB} from app_test;
    revoke all privileges on database ${DB} from public;
    grant connect on database ${DB} to public;
    alter schema public owner to app_owner;
    revoke all on schema public from public;
    grant create on database ${DB} to app_owner;
    create schema pgboss authorization app_worker;
  `);
  ok("Rollen und Schema-Owner sind vor der Migration provisioniert", true);

  const wrongMigrator = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.runtime,
    },
    encoding: "utf8",
  });
  ok(
    "Strict-Migrator lehnt eine Runtime-URL vor jeder DB-Mutation ab",
    wrongMigrator.status !== 0 && `${wrongMigrator.stderr}${wrongMigrator.stdout}`.includes("app_migrator"),
  );

  const overriddenMigratorUrl = new URL(urls.migrator);
  overriddenMigratorUrl.searchParams.set("user", "app_system");
  const overriddenMigrator = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: overriddenMigratorUrl.toString(),
    },
    encoding: "utf8",
  });
  ok(
    "Strict-Migrator lehnt Authority-überschreibende Queryparameter ab",
    overriddenMigrator.status !== 0 &&
      `${overriddenMigrator.stderr}${overriddenMigrator.stdout}`.includes("Queryparameter"),
  );

  await superuser.query("alter role app_migrator superuser");
  const privilegedMigrator = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  const journalAfterPrivilegedAttempt = await superuser.query<{ journal: string | null }>(
    "select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as journal",
  );
  await superuser.query("alter role app_migrator nosuperuser");
  ok(
    "Privilegierter Migrator scheitert vor der ersten Journal-/Schemaänderung",
    privilegedMigrator.status !== 0 &&
      `${privilegedMigrator.stderr}${privilegedMigrator.stdout}`.includes("app_migrator") &&
      journalAfterPrivilegedAttempt.rows[0]?.journal === null,
  );

  await superuser.query(`
    create role migration_role_bridge nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    grant migration_role_bridge to app_migrator
      with admin false, inherit false, set false;
  `);
  const bridgedMigrator = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  const journalAfterBridgeAttempt = await superuser.query<{ journal: string | null }>(
    "select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as journal",
  );
  await superuser.query(`
    revoke migration_role_bridge from app_migrator;
    drop role migration_role_bridge;
  `);
  ok(
    "Unerwartete Migrator-Bridge scheitert vor der ersten Journal-/Schemaänderung",
    bridgedMigrator.status !== 0 &&
      `${bridgedMigrator.stderr}${bridgedMigrator.stdout}`.includes(
        "Migrationsrollen-Mitgliedschaften",
      ) &&
      journalAfterBridgeAttempt.rows[0]?.journal === null,
  );

  execFileSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    stdio: "inherit",
  });
  ok("Fresh 0→aktuelle Historie läuft als app_migrator → app_owner samt ACL-Manifest", true);

  const migrationToTamper = await superuser.query<{ id: number; hash: string }>(`
    select id, hash
    from drizzle.__drizzle_migrations
    order by created_at desc
    limit 1
  `);
  const originalMigration = migrationToTamper.rows[0];
  if (!originalMigration) throw new Error("Keine Migration für Hash-Negativprobe gefunden.");
  await superuser.query(
    "update drizzle.__drizzle_migrations set hash='tampered' where id=$1",
    [originalMigration.id],
  );
  const tamperedMigration = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  await superuser.query(
    "update drizzle.__drizzle_migrations set hash=$1 where id=$2",
    [originalMigration.hash, originalMigration.id],
  );
  ok(
    "Historisch angewandte SQL-Migrationen sind per Journalhash unveränderlich",
    tamperedMigration.status !== 0 &&
      `${tamperedMigration.stderr}${tamperedMigration.stdout}`.includes("unverändertes Präfix"),
  );

  const migrationToRemove = await superuser.query<{
    id: number;
    hash: string;
    created_at: string;
  }>(`
    delete from drizzle.__drizzle_migrations
    where id = (
      select id from drizzle.__drizzle_migrations order by created_at, id offset 5 limit 1
    )
    returning id, hash, created_at::text
  `);
  const removedMigration = migrationToRemove.rows[0];
  if (!removedMigration) throw new Error("Keine Migration für Journal-Lückenprobe gefunden.");
  const gappedJournal = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  await superuser.query(
    `insert into drizzle.__drizzle_migrations(id, hash, created_at)
     values ($1, $2, $3::numeric)`,
    [removedMigration.id, removedMigration.hash, removedMigration.created_at],
  );
  ok(
    "Migrationsjournal muss ein lückenloses Präfix der lokalen Historie sein",
    gappedJournal.status !== 0 &&
      `${gappedJournal.stderr}${gappedJournal.stdout}`.includes("lückenloses"),
  );

  await superuser.query(`
    create role app_role_bridge nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    grant app_membership_writer to app_role_bridge
      with admin false, inherit false, set false;
    grant app_role_bridge to app_runtime
      with admin false, inherit false, set false;
  `);
  const bridgeCheckClient = await superuser.connect();
  let bridgeRejected = false;
  try {
    await verifyRoleContract(bridgeCheckClient);
  } catch (error) {
    bridgeRejected = /Rollenmitgliedschaften|Membership-Writer/.test(String(error));
  } finally {
    bridgeCheckClient.release();
    await superuser.query(`
      revoke app_role_bridge from app_runtime;
      revoke app_membership_writer from app_role_bridge;
      drop role app_role_bridge;
    `);
  }
  ok("Rollen-Drift erkennt eine transitive Marker-Bridge", bridgeRejected);

  await superuser.query(`
    set role app_owner;
    create table public.unclassified_contract_drift(id integer primary key);
    reset role;
  `);
  const inventoryCheckClient = await superuser.connect();
  let inventoryRejected = false;
  try {
    await verifyRoleContract(inventoryCheckClient);
  } catch (error) {
    inventoryRejected = String(error).includes("Relationsinventar");
  } finally {
    inventoryCheckClient.release();
    await superuser.query("drop table public.unclassified_contract_drift");
  }
  ok("Relationsinventar lehnt eine unklassifizierte Zero-ACL-Tabelle ab", inventoryRejected);

  await superuser.query(`
    set role app_owner;
    create schema legacy_private;
    create table legacy_private.exposed_secret(id integer primary key, value text);
    create function legacy_private.public_definer()
      returns text
      language sql
      security definer
      set search_path = pg_catalog
      as 'select current_user::text';
    grant usage on schema legacy_private to public;
    grant select on legacy_private.exposed_secret to app_runtime;
    grant execute on function legacy_private.public_definer() to public;
    reset role;
  `);
  const foreignSchemaCheckClient = await superuser.connect();
  let foreignSchemaRejected = false;
  try {
    await verifyRoleContract(foreignSchemaCheckClient);
  } catch (error) {
    foreignSchemaRejected = String(error).includes("Nicht-System-Schemainventar");
  } finally {
    foreignSchemaCheckClient.release();
    await superuser.query("drop schema legacy_private cascade");
  }
  ok(
    "Schemainventar lehnt fremde Datenfläche samt PUBLIC-SECURITY-DEFINER ab",
    foreignSchemaRejected,
  );

  await superuser.query("alter function public.app_actor_id() security definer");
  const definerDriftClient = await superuser.connect();
  let definerDriftRejected = false;
  try {
    await verifyRoleContract(definerDriftClient);
  } catch (error) {
    definerDriftRejected = String(error).includes("Live-Funktions-Sicherheitsvertrag");
  } finally {
    definerDriftClient.release();
    await superuser.query("alter function public.app_actor_id() security invoker");
  }
  ok("Live-Vertrag lehnt unerlaubten SECURITY-DEFINER-Drift ab", definerDriftRejected);

  await superuser.query("alter table public.membership no force row level security");
  const rlsDriftClient = await superuser.connect();
  let rlsDriftRejected = false;
  try {
    await verifyRoleContract(rlsDriftClient);
  } catch (error) {
    rlsDriftRejected = String(error).includes("Live-RLS/FORCE-Vertrag");
  } finally {
    rlsDriftClient.release();
    await superuser.query("alter table public.membership force row level security");
  }
  ok("Live-Vertrag lehnt abgeschaltetes FORCE RLS ab", rlsDriftRejected);

  await superuser.query(`
    alter policy membership_principal_update on public.membership
      using (true)
      with check (true)
  `);
  const policyDriftClient = await superuser.connect();
  let policyDriftRejected = false;
  try {
    await verifyRoleContract(policyDriftClient);
  } catch (error) {
    policyDriftRejected = String(error).includes("Live-Policyvertrag");
  } finally {
    policyDriftClient.release();
    await superuser.query(`
      alter policy membership_principal_update on public.membership
        using (pg_catalog.pg_has_role(current_user, 'app_membership_writer', 'MEMBER'))
        with check (pg_catalog.pg_has_role(current_user, 'app_membership_writer', 'MEMBER'))
    `);
  }
  ok("Live-Vertrag lehnt semantischen Policy-Drift ab", policyDriftRejected);

  await superuser.query("alter table public.membership disable trigger membership_dml_guard");
  const triggerDriftClient = await superuser.connect();
  let triggerDriftRejected = false;
  try {
    await verifyRoleContract(triggerDriftClient);
  } catch (error) {
    triggerDriftRejected = String(error).includes("Live-Triggervertrag");
  } finally {
    triggerDriftClient.release();
    await superuser.query("alter table public.membership enable trigger membership_dml_guard");
  }
  ok("Live-Vertrag lehnt deaktivierten Schutztrigger ab", triggerDriftRejected);

  await superuser.query(`
    drop trigger membership_dml_guard on public.membership;
    create trigger membership_dml_guard
      before insert or update or delete on public.membership
      for each row when (false)
      execute function public.guard_membership_dml();
  `);
  const conditionalTriggerClient = await superuser.connect();
  let conditionalTriggerRejected = false;
  try {
    await verifyRoleContract(conditionalTriggerClient);
  } catch (error) {
    conditionalTriggerRejected = String(error).includes("Live-Triggervertrag");
  } finally {
    conditionalTriggerClient.release();
    await superuser.query(`
      drop trigger membership_dml_guard on public.membership;
      create trigger membership_dml_guard
        before insert or update or delete on public.membership
        for each row execute function public.guard_membership_dml();
    `);
  }
  ok(
    "Live-Vertrag lehnt einen Schutztrigger mit falscher WHEN-Bedingung ab",
    conditionalTriggerRejected,
  );

  await superuser.query(`
    create role app_acl_grantor nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    grant usage on schema public to app_acl_grantor;
    grant select on public.auth_user to app_acl_grantor with grant option;
    set role app_acl_grantor;
    grant select on public.auth_user to app_runtime;
    reset role;
  `);
  const foreignGrantorMigration = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  const foreignGrantorRejected =
    foreignGrantorMigration.status !== 0 &&
    `${foreignGrantorMigration.stderr}${foreignGrantorMigration.stdout}`.includes("Tabellen-Grants");
  await superuser.query(`
    set role app_acl_grantor;
    revoke select on public.auth_user from app_runtime;
    reset role;
    revoke select on public.auth_user from app_acl_grantor;
    revoke usage on schema public from app_acl_grantor;
    drop role app_acl_grantor;
  `);
  ok("ACL-Drift erkennt Tabellenrechte eines fremden Legacy-Grantors", foreignGrantorRejected);

  await superuser.query(`
    set role app_owner;
    alter default privileges in schema public
      grant select on tables to app_runtime;
    reset role;
  `);
  const defaultAclCheckClient = await superuser.connect();
  let defaultAclRejected = false;
  try {
    await verifyDefaultPrivilegeContract(defaultAclCheckClient);
  } catch (error) {
    defaultAclRejected = String(error).includes("Default-ACLs");
  } finally {
    defaultAclCheckClient.release();
  }
  const repairedDefaultAcl = spawnSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    encoding: "utf8",
  });
  await superuser.query(`
    set role app_owner;
    create table public.default_acl_probe(id integer primary key);
    reset role;
  `);
  const runtimeDefaultSelect = await superuser.query<{ allowed: boolean }>(`
    select pg_catalog.has_table_privilege(
      'app_runtime',
      'public.default_acl_probe',
      'SELECT'
    ) as allowed
  `);
  await superuser.query("drop table public.default_acl_probe");
  ok(
    "Pre-Migrationsgate repariert Default-ACL-Drift vor dem nächsten neuen Objekt",
    defaultAclRejected &&
      repairedDefaultAcl.status === 0 &&
      runtimeDefaultSelect.rows[0]?.allowed === false,
  );

  const runtime = new Pool({ connectionString: urls.runtime, max: 2 });
  const system = new Pool({ connectionString: urls.system, max: 2 });
  const auth = new Pool({ connectionString: urls.auth, max: 2 });
  const worker = new Pool({ connectionString: urls.worker, max: 2 });
  const migrator = new Pool({ connectionString: urls.migrator, max: 1 });
  pools.push(runtime, system, auth, worker, migrator);

  await allowed(runtime, "Runtime darf Site lesen (unter RLS leer)", "select count(*) from public.site");
  await denied(runtime, "Runtime sieht auth_user nicht", "select count(*) from public.auth_user");
  await denied(runtime, "Runtime darf kein DDL in public", "create table public.forbidden_runtime(x int)");
  await denied(runtime, "Runtime kann app_owner nicht annehmen", "set role app_owner");
  await denied(runtime, "Runtime kann Markerrolle nicht annehmen", "set role app_membership_writer");
  await denied(
    runtime,
    "Runtime darf reconcile_user_identity nicht ausführen",
    "select public.reconcile_user_identity('runtime@test.invalid', 'runtime-auth')",
  );

  const workspaceId = randomUUID();
  const userId = randomUUID();
  await inTenant(system, workspaceId, [
    { text: "insert into public.workspace(id, name) values ($1::uuid, 'strict-system')", values: [workspaceId] },
    { text: "insert into public.user_identity(id, email) values ($1::uuid, $2)", values: [userId, `${userId}@system.test`] },
    {
      text: "insert into public.membership(workspace_id, user_id, role) values ($1::uuid, $2::uuid, 'viewer')",
      values: [workspaceId, userId],
    },
  ]);
  ok("System-Principal kann actorlos Workspace + erste Membership bootstrappen", true);

  const runtimeClient = await runtime.connect();
  try {
    await runtimeClient.query("begin");
    await runtimeClient.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    await runtimeClient.query("select set_config('app.actor_id', '', true)");
    try {
      await runtimeClient.query(
        "update public.membership set role='admin' where workspace_id=$1::uuid and user_id=$2::uuid",
        [workspaceId, userId],
      );
      ok("Runtime-NULL-GUC umgeht Membership-ACL nicht", false, "UPDATE wurde erlaubt");
    } catch (error) {
      ok("Runtime-NULL-GUC umgeht Membership-ACL nicht", postgresCode(error) === "42501");
    }
  } finally {
    await runtimeClient.query("rollback").catch(() => undefined);
    runtimeClient.release();
  }
  await denied(runtime, "Runtime darf Membership nicht TRUNCATE", "truncate public.membership");

  // Negativkontrolle: Selbst wenn jemand UPDATE versehentlich wieder grantet,
  // lehnt der Principal-Trigger auch eine Nulltreffer-Mutation mit 42501 ab.
  await superuser.query("grant update on public.membership to app_runtime");
  const driftClient = await runtime.connect();
  try {
    await driftClient.query("begin");
    await driftClient.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    await driftClient.query("select set_config('app.actor_id', $1, true)", [randomUUID()]);
    try {
      await driftClient.query(
        "update public.membership set role='admin' where workspace_id=$1::uuid and user_id=$2::uuid",
        [workspaceId, randomUUID()],
      );
      ok("Principal-Gate hält auch bei versehentlichem Runtime-UPDATE-Grant", false, "UPDATE wurde erlaubt");
    } catch (error) {
      ok(
        "Principal-Gate hält auch bei versehentlichem Runtime-UPDATE-Grant",
        postgresCode(error) === "42501",
      );
    }
  } finally {
    await driftClient.query("rollback").catch(() => undefined);
    driftClient.release();
    await superuser.query("revoke update on public.membership from app_runtime");
  }

  await inTenant(system, workspaceId, [{
    text: "update public.membership set role='admin' where workspace_id=$1::uuid and user_id=$2::uuid",
    values: [workspaceId, userId],
  }]);
  ok("Nur der isolierte System-Principal darf Membership ändern", true);
  await denied(system, "System sieht auth_user nicht", "select count(*) from public.auth_user");
  await denied(system, "System darf Membership nicht TRUNCATE", "truncate public.membership");
  await denied(system, "System darf kein DDL in public", "create table public.forbidden_system(x int)");

  await allowed(auth, "Auth darf auth_user lesen", "select count(*) from public.auth_user");
  await denied(auth, "Auth sieht user_identity nicht direkt", "select count(*) from public.user_identity");
  const authId = `auth-${randomUUID()}`;
  const authEmail = `${randomUUID()}@auth.test`;
  await allowed(
    auth,
    "Auth darf ausschließlich über reconcile koppeln",
    "select public.reconcile_user_identity($1, $2)",
    [authEmail, authId],
  );
  const linked = await superuser.query<{ n: number }>(
    "select count(*)::int as n from public.user_identity where email=$1 and auth_user_id=$2",
    [authEmail, authId],
  );
  ok("Auth-Reconcile erzeugt genau eine Kopplung", linked.rows[0].n === 1);

  await denied(migrator, "Migrator ohne internen SET ROLE besitzt kein Fachrecht", "select count(*) from public.site");
  await denied(migrator, "Migrator ohne internen SET ROLE besitzt kein DDL", "create table public.forbidden_migrator(x int)");

  const queue = `roles.probe.${randomUUID()}`;
  const boss = new PgBoss({
    connectionString: urls.worker,
    schema: "pgboss",
    createSchema: false,
    max: 2,
  });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    await boss.createQueue(queue);
    const sentId = await boss.send(queue, { ok: true });
    const [job] = await boss.fetch<{ ok: boolean }>(queue);
    ok("Worker schafft echten pg-boss-Roundtrip in eigenem Schema", Boolean(sentId && job?.id === sentId));
    if (job) await boss.complete(queue, [job.id]);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  await denied(worker, "Worker sieht public.auth_user nicht", "select count(*) from public.auth_user");
  await denied(worker, "Worker darf kein DDL in public", "create table public.forbidden_worker(x int)");

  // Der strikte Migrator hat das Manifest bereits katalogbasiert vollständig
  // verifiziert. Dieser zweite Lauf beweist Idempotenz von Migration + Grants.
  execFileSync("npx", ["tsx", "scripts/migrate.mts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_ROLE_MODE: "strict",
      POSTGRES_URL_MIGRATE: urls.migrator,
    },
    stdio: "inherit",
  });
  ok("Migration und ACL-Manifest sind idempotent", true);

  await proveLegacyUpgrade();
} finally {
  await Promise.allSettled(pools.map((pool) => pool.end()));
  await superuser.end();
  await embedded.stop();
}

console.log(`\nM1-03 Rollenprobe: ${checks} Prüfungen grün.`);
