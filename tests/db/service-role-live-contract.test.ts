import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { servicePoolConfig } from "@/lib/db/role-env";
import { createHealthProbe } from "@/worker/health";
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from "../setup/embedded-postgres";

const ROLE = "app_runtime";
const PASSWORD = "runtime_live_contract";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function expectNewPoolRejected(url: string, pattern: RegExp): Promise<void> {
  const pool = new Pool(servicePoolConfig(url, ROLE));
  try {
    await expect(pool.query("select 1")).rejects.toThrow(pattern);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

describe.sequential("Live-Dienstrollenvertrag auf echtem PostgreSQL 18", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let runtimeUrl: string;
  let workerUrl: string;
  let previousMode: string | undefined;
  let previousTenantId: string | undefined;
  let previousTimelineId: string | undefined;

  beforeAll(async () => {
    previousMode = process.env.DB_ROLE_MODE;
    previousTenantId = process.env.POSTGRES_EXPECTED_NEON_TENANT_ID;
    previousTimelineId = process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID;
    process.env.DB_ROLE_MODE = "strict";
    delete process.env.POSTGRES_EXPECTED_NEON_TENANT_ID;
    delete process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID;

    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    await admin.query(
      `create role ${quoteIdentifier(ROLE)} login password '${PASSWORD}' ` +
        "noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication",
    );
    await admin.query(
      "create role app_worker login password 'worker_live_contract' " +
        "noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication",
    );
    await admin.query(`
      create schema pgboss authorization app_worker;
      set role app_worker;
      create table pgboss.version(version integer not null);
      create table pgboss.queue(name text primary key);
      create table pgboss.job(id uuid primary key);
      reset role;
    `);
    const url = new URL(embedded.url);
    url.username = ROLE;
    url.password = PASSWORD;
    runtimeUrl = url.toString();
    url.username = "app_worker";
    url.password = "worker_live_contract";
    workerUrl = url.toString();
  });

  afterAll(async () => {
    await admin?.query(`alter database energie_saas_test reset search_path`).catch(() => undefined);
    await admin?.query(`alter database energie_saas_test owner to app_test`).catch(() => undefined);
    await admin?.query(`alter role ${quoteIdentifier(ROLE)} reset all`).catch(() => undefined);
    await admin?.query(`revoke runtime_live_bridge from ${quoteIdentifier(ROLE)}`).catch(() => undefined);
    await admin?.query("drop role if exists runtime_live_bridge").catch(() => undefined);
    await admin?.query("drop schema if exists pgboss cascade").catch(() => undefined);
    await admin?.query("drop role if exists app_worker").catch(() => undefined);
    await admin?.query(`drop role if exists ${quoteIdentifier(ROLE)}`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop();

    if (previousMode === undefined) delete process.env.DB_ROLE_MODE;
    else process.env.DB_ROLE_MODE = previousMode;
    if (previousTenantId === undefined) delete process.env.POSTGRES_EXPECTED_NEON_TENANT_ID;
    else process.env.POSTGRES_EXPECTED_NEON_TENANT_ID = previousTenantId;
    if (previousTimelineId === undefined) delete process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID;
    else process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID = previousTimelineId;
  });

  it("gibt einen exakt unprivilegierten Principal erst nach Live-Verify aus", async () => {
    const config = servicePoolConfig(runtimeUrl, ROLE);
    expect(config.verify).toBeTypeOf("function");
    expect(config.maxLifetimeSeconds).toBe(300);
    const pool = new Pool(config);
    try {
      const result = await pool.query<{
        session_role: string;
        current_role: string;
        search_path: string;
        statement_timeout: string;
      }>(`
        select session_user::text as session_role,
               current_user::text as current_role,
               pg_catalog.current_setting('search_path') as search_path,
               pg_catalog.current_setting('statement_timeout') as statement_timeout
      `);
      expect(result.rows[0]).toEqual({
        session_role: ROLE,
        current_role: ROLE,
        search_path: "pg_catalog,public",
        statement_timeout: "15s",
      });
    } finally {
      await pool.end();
    }
  });

  it("lehnt direkte Memberships vor dem ersten Checkout ab", async () => {
    await admin.query("create role runtime_live_bridge nologin");
    await admin.query(`grant runtime_live_bridge to ${quoteIdentifier(ROLE)}`);
    await expectNewPoolRejected(runtimeUrl, /unerwartete Memberships/);
    await admin.query(`revoke runtime_live_bridge from ${quoteIdentifier(ROLE)}`);
    await admin.query("drop role runtime_live_bridge");
  });

  it("lehnt role- und datenbankweite Settings einschließlich setrole=0 ab", async () => {
    await admin.query(
      `alter role ${quoteIdentifier(ROLE)} in database energie_saas_test set search_path = evil`,
    );
    await expectNewPoolRejected(runtimeUrl, /Datenbank-Settings/);
    await admin.query(
      `alter role ${quoteIdentifier(ROLE)} in database energie_saas_test reset search_path`,
    );

    await admin.query("alter database energie_saas_test set search_path = evil");
    await expectNewPoolRejected(runtimeUrl, /Datenbank-Settings/);
    await admin.query("alter database energie_saas_test reset search_path");
  });

  it("lehnt die implizite pg_database_owner-Mitgliedschaft ab", async () => {
    await admin.query(`alter database energie_saas_test owner to ${quoteIdentifier(ROLE)}`);
    await expectNewPoolRejected(runtimeUrl, /pg_database_owner/);
    await admin.query("alter database energie_saas_test owner to app_test");
  });

  it("macht Worker-Readiness bei pg-boss-Ownerdrift und Prozessfehlern rot", async () => {
    const healthy = createHealthProbe(workerUrl, 1_000);
    try {
      await expect(healthy.probe()).resolves.toBeUndefined();
      await admin.query("alter table pgboss.job owner to postgres");
      await expect(healthy.probe()).rejects.toThrow(/Ownership-\/Zugriffsvertrag/);
      await admin.query("alter table pgboss.job owner to app_worker");
    } finally {
      await healthy.close();
    }

    const failedProcess = createHealthProbe(workerUrl, 1_000, () => {
      throw new Error("pg-boss poller dauerhaft fehlgeschlagen");
    });
    try {
      await expect(failedProcess.probe()).rejects.toThrow(/poller dauerhaft/);
    } finally {
      await failedProcess.close();
    }
  });
});
