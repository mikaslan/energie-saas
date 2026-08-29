import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  applyDatabaseAclContract,
  expectedDbRoleMembershipSignatures,
  verifyAppRoleCatalogContract,
  verifyDatabaseAclContract,
  verifyStandaloneTypeContract,
} from "../../scripts/db-role-contract.mjs";
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from "../setup/embedded-postgres";

const DATABASE_NAME = "energie_saas_test";

describe("Provider-Membership-Signaturen", () => {
  const provider = {
    provisioningAdminRole: "provider_admin",
    bootstrapGrantorRole: "provider_bootstrap",
  } as const;

  it("unterscheidet Fresh-Bootstrap und retained Legacy exakt", () => {
    const fresh = expectedDbRoleMembershipSignatures(provider);
    const retained = expectedDbRoleMembershipSignatures({
      ...provider,
      retainedLegacyRole: "app_legacy",
    });

    expect(fresh).toContain(
      "identity_reconciler>provider_admin@provider_bootstrap:true/false/false",
    );
    expect(fresh).not.toContain(
      "identity_reconciler>app_legacy@provider_bootstrap:true/false/false",
    );
    expect(fresh).toContain(
      "identity_reconciler>app_owner@provider_admin:true/false/false",
    );
    expect(retained).not.toContain(
      "identity_reconciler>provider_admin@provider_bootstrap:true/false/false",
    );
    expect(retained).not.toContain(
      "identity_reconciler>app_owner@provider_admin:true/false/false",
    );
    expect(retained).toContain(
      "identity_reconciler>app_owner@provider_bootstrap:true/false/false",
    );
    expect(retained).toContain(
      "identity_reconciler>app_legacy@provider_bootstrap:true/false/false",
    );
    expect(fresh).toHaveLength(14);
    expect(retained).toHaveLength(14);
  });
});

describe.sequential("App-Rollen-/Type-/Datenbank-ACL-Katalogvertrag auf PostgreSQL 18", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    client = await admin.connect();

    await client.query(`
      create role app_owner nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role app_migrator login noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role app_runtime login noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role app_system login noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role app_auth login noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role app_worker login noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;
      create role identity_reconciler nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication connection limit -1;

      alter database ${DATABASE_NAME} owner to app_owner;
      revoke all privileges on database ${DATABASE_NAME} from app_test;
      create schema drizzle authorization app_owner;
    `);
  });

  afterAll(async () => {
    await client?.query("reset role").catch(() => undefined);
    client?.release();
    await admin?.end().catch(() => undefined);
    await embedded?.stop();
  });

  it("verwirft Rollenattribute sowie alle wirksamen Setting-Sichten", async () => {
    await expect(verifyAppRoleCatalogContract(client)).resolves.toBeUndefined();

    await client.query("alter role app_runtime connection limit 2");
    await expect(verifyAppRoleCatalogContract(client)).rejects.toThrow(/Rollenattribute/);
    await client.query("alter role app_runtime connection limit -1");

    await client.query("alter role app_runtime set search_path = public");
    await expect(verifyAppRoleCatalogContract(client)).rejects.toThrow(/Rollenattribute/);
    await client.query("alter role app_runtime reset all");

    await client.query(`alter database ${DATABASE_NAME} set row_security = off`);
    await expect(verifyAppRoleCatalogContract(client)).rejects.toThrow(
      /effektive pg_db_role_setting-Einträge/,
    );
    await client.query(`alter database ${DATABASE_NAME} reset row_security`);

    await client.query(
      `alter role app_runtime in database ${DATABASE_NAME} set search_path = public`,
    );
    await expect(verifyAppRoleCatalogContract(client)).rejects.toThrow(
      /effektive pg_db_role_setting-Einträge/,
    );
    await client.query(
      `alter role app_runtime in database ${DATABASE_NAME} reset search_path`,
    );

    await expect(verifyAppRoleCatalogContract(client)).resolves.toBeUndefined();
  });

  it("macht jeden neuen standalone public/drizzle-Typ inklusive Default-ACL rot", async () => {
    await expect(verifyStandaloneTypeContract(client)).resolves.toBeUndefined();
    await client.query("create type public.unexpected_contract_enum as enum ('unexpected')");
    await expect(verifyStandaloneTypeContract(client)).rejects.toThrow(
      /public:e:unexpected_contract_enum:postgres:PUBLIC:postgres:USAGE:false/,
    );
    await client.query("drop type public.unexpected_contract_enum");
    await expect(verifyStandaloneTypeContract(client)).resolves.toBeUndefined();
  });

  it("normalisiert PUBLIC auf CONNECT-only und entzieht App-Rollen TEMPORARY", async () => {
    await client.query(`grant temporary on database ${DATABASE_NAME} to app_runtime`);
    await client.query("set role app_owner");
    try {
      await applyDatabaseAclContract(client);
    } finally {
      await client.query("reset role");
    }

    await expect(verifyDatabaseAclContract(client)).resolves.toBeUndefined();
    const privileges = await client.query<{
      runtime_connect: boolean;
      runtime_create: boolean;
      runtime_temporary: boolean;
    }>(`
      select pg_catalog.has_database_privilege(
               'app_runtime', pg_catalog.current_database(), 'CONNECT'
             ) as runtime_connect,
             pg_catalog.has_database_privilege(
               'app_runtime', pg_catalog.current_database(), 'CREATE'
             ) as runtime_create,
             pg_catalog.has_database_privilege(
               'app_runtime', pg_catalog.current_database(), 'TEMPORARY'
             ) as runtime_temporary
    `);
    expect(privileges.rows[0]).toEqual({
      runtime_connect: true,
      runtime_create: false,
      runtime_temporary: false,
    });
  });
});
