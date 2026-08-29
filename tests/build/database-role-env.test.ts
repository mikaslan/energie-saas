import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = {
  DB_ROLE_MODE: process.env.DB_ROLE_MODE,
  NODE_ENV: process.env.NODE_ENV,
  POSTGRES_URL: process.env.POSTGRES_URL,
  POSTGRES_URL_AUTH: process.env.POSTGRES_URL_AUTH,
  POSTGRES_URL_MIGRATE: process.env.POSTGRES_URL_MIGRATE,
  POSTGRES_URL_SYSTEM: process.env.POSTGRES_URL_SYSTEM,
  POSTGRES_URL_WORKER: process.env.POSTGRES_URL_WORKER,
  POSTGRES_URL_TEST: process.env.POSTGRES_URL_TEST,
  POSTGRES_URL_TEST_SUPERUSER: process.env.POSTGRES_URL_TEST_SUPERUSER,
  POSTGRES_TEST_TARGET_CONFIRM: process.env.POSTGRES_TEST_TARGET_CONFIRM,
  POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET:
    process.env.POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET,
  POSTGRES_EXPECTED_NEON_TENANT_ID: process.env.POSTGRES_EXPECTED_NEON_TENANT_ID,
  POSTGRES_EXPECTED_NEON_TIMELINE_ID: process.env.POSTGRES_EXPECTED_NEON_TIMELINE_ID,
  PGOPTIONS: process.env.PGOPTIONS,
  NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE,
  SSL_CERT_DIR: process.env.SSL_CERT_DIR,
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL)) setEnv(name, value);
  vi.resetModules();
});

describe("DB-Rollen-Env", () => {
  it("fällt für Auth und Worker niemals still auf die Runtime-URL zurück", async () => {
    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_URL", "postgres://app_runtime:run@db.example:5432/app?sslmode=verify-full");
    setEnv("POSTGRES_URL_AUTH", undefined);
    setEnv("POSTGRES_URL_WORKER", undefined);
    const { requireServiceDatabaseUrl } = await import("@/lib/db/role-env");

    expect(() => requireServiceDatabaseUrl("POSTGRES_URL_AUTH", "app_auth")).toThrow(
      /POSTGRES_URL_AUTH ist nicht gesetzt/,
    );
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL_WORKER", "app_worker")).toThrow(
      /POSTGRES_URL_WORKER ist nicht gesetzt/,
    );
  });

  it("verlangt im Strict-Modus einen eindeutigen Login-Principal ohne URL-Overrides", async () => {
    setEnv("DB_ROLE_MODE", "strict");
    const { requireServiceDatabaseUrl } = await import("@/lib/db/role-env");

    setEnv("POSTGRES_URL", "postgres://wrong:pw@db.example:5432/app?sslmode=verify-full");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/app_runtime/);

    setEnv("POSTGRES_URL", "postgres://app_runtime:pw@db.example:5432/app?options=-c%20role%3Dapp_owner");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/Queryparameter/);

    for (const override of [
      "user=app_system",
      "password=system-secret",
      "host=other.example",
      "port=6432",
      "database=other",
      "db=other",
      "application_name=portal",
    ]) {
      setEnv("POSTGRES_URL", `postgres://app_runtime:pw@db.example:5432/app?${override}`);
      expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/Queryparameter/);
    }

    setEnv(
      "POSTGRES_URL",
      "postgres://app_runtime:pw@db.example:5432/app?sslmode=verify-full",
    );
    expect(requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toContain("app_runtime");

    setEnv("POSTGRES_URL", "postgres://app_runtime:pw@db.example:5432/app");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
      /sslmode=verify-full/,
    );

    for (const transport of ["sslmode=require", "channel_binding=require"]) {
      setEnv("POSTGRES_URL", `postgres://app_runtime:pw@db.example:5432/app?${transport}`);
      expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
        /Queryparameter/,
      );
    }
  });

  it("bindet Runtime und Auth im selben Web-Prozess an exakt dasselbe Datenbankziel", async () => {
    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_URL", "postgres://app_runtime:run@prod.example:5432/app?sslmode=verify-full");
    setEnv("POSTGRES_URL_AUTH", "postgres://app_auth:auth@stage.example:5432/app?sslmode=verify-full");
    const { requireServiceDatabaseUrl } = await import("@/lib/db/role-env");

    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
      /exakt dasselbe Postgres-Ziel/,
    );

    setEnv("POSTGRES_URL_AUTH", "postgres://app_auth:auth@prod.example:5432/app?sslmode=verify-full");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).not.toThrow();

    setEnv("POSTGRES_URL_AUTH", "postgres://app_runtime:auth@prod.example:5432/app?sslmode=verify-full");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/app_auth/);
  });

  it("verlangt und prüft für Neon die serverseitige Tenant-/Timeline-Identität", async () => {
    const tenantId = "a".repeat(32);
    const timelineId = "b".repeat(32);
    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_URL_AUTH", undefined);
    setEnv(
      "POSTGRES_URL",
      "postgres://app_runtime:pw@ep-prod.eu-central-1.aws.neon.tech:5432/app?sslmode=verify-full",
    );
    const { requireServiceDatabaseUrl, verifyServiceDatabaseSession } = await import(
      "@/lib/db/role-env"
    );

    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
      /POSTGRES_EXPECTED_NEON_TENANT_ID/,
    );
    setEnv("POSTGRES_EXPECTED_NEON_TENANT_ID", tenantId);
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/gemeinsam/);
    setEnv("POSTGRES_EXPECTED_NEON_TIMELINE_ID", timelineId);
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).not.toThrow();

    setEnv(
      "POSTGRES_URL",
      "postgres://app_runtime:pw@ep-prod-pooler.eu-central-1.aws.neon.tech:5432/app?sslmode=verify-full",
    );
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
      /direkten Neon-Endpunkt/,
    );
    setEnv(
      "POSTGRES_URL",
      "postgres://app_runtime:pw@ep-prod.eu-central-1.aws.neon.tech:5432/app?sslmode=verify-full",
    );

    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          database_name: "app",
          database_owner: "app_owner",
          session_role: "app_runtime",
          current_role: "app_runtime",
          rolcanlogin: true,
          rolinherit: false,
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolconnlimit: -1,
          password_never_expires: true,
          role_setting_count: 0,
          neon_tenant_id: tenantId,
          neon_timeline_id: "c".repeat(32),
        }],
      });
    await expect(
      verifyServiceDatabaseSession(
        { query } as never,
        "app_runtime",
        "app",
        { tenantId, timelineId },
      ),
    ).rejects.toThrow(/Neon-Serveridentität/);

    const verifiedNeonQuery = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          database_name: "app",
          database_owner: "app_owner",
          session_role: "app_runtime",
          current_role: "app_runtime",
          rolcanlogin: true,
          rolinherit: false,
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolconnlimit: -1,
          password_never_expires: true,
          role_setting_count: 0,
          neon_tenant_id: tenantId,
          neon_timeline_id: timelineId,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { name: "neon.tenant_id", setting: tenantId, context: "postmaster" },
          { name: "neon.timeline_id", setting: timelineId, context: "postmaster" },
        ],
      });
    await expect(
      verifyServiceDatabaseSession(
        { query: verifiedNeonQuery } as never,
        "app_runtime",
        "app",
        { tenantId, timelineId },
      ),
    ).resolves.toBeUndefined();
  });

  it("verifiziert Live-Rollenattribute, Memberships und Rollen-Settings vor Pool-Ausgabe", async () => {
    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_EXPECTED_NEON_TENANT_ID", undefined);
    setEnv("POSTGRES_EXPECTED_NEON_TIMELINE_ID", undefined);
    const { servicePoolConfig, verifyServiceDatabaseSession } = await import("@/lib/db/role-env");
    const role = {
      database_name: "app",
      database_owner: "app_owner",
      session_role: "app_auth",
      current_role: "app_auth",
      rolcanlogin: true,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolconnlimit: -1,
      password_never_expires: true,
      role_setting_count: 0,
      neon_tenant_id: null,
      neon_timeline_id: null,
    };
    const successfulQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [role] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(
      verifyServiceDatabaseSession({ query: successfulQuery } as never, "app_auth", "app"),
    ).resolves.toBeUndefined();

    const membershipQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [role] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          granted_role: "app_owner",
          grantor_role: "postgres",
          admin_option: false,
          inherit_option: false,
          set_option: true,
        }],
      });
    await expect(
      verifyServiceDatabaseSession({ query: membershipQuery } as never, "app_auth", "app"),
    ).rejects.toThrow(/unerwartete Memberships/);

    const ownerQuery = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...role, database_owner: "app_auth" }],
    });
    await expect(
      verifyServiceDatabaseSession({ query: ownerQuery } as never, "app_auth", "app"),
    ).rejects.toThrow(/pg_database_owner/);

    const wrongDatabaseQuery = vi.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...role, database_name: "staging_clone" }],
    });
    await expect(
      verifyServiceDatabaseSession({ query: wrongDatabaseQuery } as never, "app_auth", "app"),
    ).rejects.toThrow(/Falsches Live-DB-Ziel/);

    const databaseSettingQuery = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [role] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ setting_value: "search_path=evil" }] });
    await expect(
      verifyServiceDatabaseSession({ query: databaseSettingQuery } as never, "app_auth", "app"),
    ).rejects.toThrow(/Datenbank-Settings/);

    const config = servicePoolConfig(
      "postgres://app_auth:pw@127.0.0.1:5432/app",
      "app_auth",
    );
    expect(config.verify).toBeTypeOf("function");
  });

  it("erlaubt die Ein-Rollen-Ausnahme nur explizit in einer Testdatenbank", async () => {
    setEnv("DB_ROLE_MODE", "test-legacy-single");
    setEnv("NODE_ENV", "test");
    const { requireServiceDatabaseUrl } = await import("@/lib/db/role-env");

    setEnv("POSTGRES_URL_AUTH", "postgres://app_test:pw@127.0.0.1:5432/energie_saas_test");
    setEnv(
      "POSTGRES_TEST_TARGET_CONFIRM",
      "127.0.0.1:5432/energie_saas_test:ALLOW-DESTRUCTIVE-TESTS",
    );
    expect(requireServiceDatabaseUrl("POSTGRES_URL_AUTH", "app_auth")).toContain("energie_saas_test");

    setEnv("POSTGRES_URL_AUTH", "postgres://app_test:pw@127.0.0.1:5432/energie_saas");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL_AUTH", "app_auth")).toThrow(/test.*Namen/i);
  });

  it("lehnt unbekannte Rollenmodi und ungültige URLs fail-closed ab", async () => {
    const { requireServiceDatabaseUrl } = await import("@/lib/db/role-env");
    setEnv("DB_ROLE_MODE", "legacy");
    setEnv("POSTGRES_URL", "postgres://app_runtime:pw@db.example:5432/app?sslmode=verify-full");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/Unbekannter DB_ROLE_MODE/);

    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_URL", "kein-url");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/gültige Postgres-URL/);
  });

  it("bindet die Superuser-Testtür exakt an das geprüfte Testziel", async () => {
    for (const envName of [
      "POSTGRES_URL",
      "POSTGRES_URL_AUTH",
      "POSTGRES_URL_MIGRATE",
      "POSTGRES_URL_SYSTEM",
      "POSTGRES_URL_WORKER",
    ]) {
      setEnv(envName, undefined);
    }
    setEnv("POSTGRES_URL_TEST", "postgres://app_test:pw@127.0.0.1:55432/app_test");
    setEnv(
      "POSTGRES_TEST_TARGET_CONFIRM",
      "127.0.0.1:55432/app_test:ALLOW-DESTRUCTIVE-TESTS",
    );
    setEnv(
      "POSTGRES_URL_TEST_SUPERUSER",
      "postgres://postgres:pw@127.0.0.1:55432/anderes_test",
    );
    const { assertTestDatenbank } = await import("../setup/global-setup");

    expect(() => assertTestDatenbank(process.env.POSTGRES_URL_TEST!)).toThrow(
      /exakt Host, Port und Datenbank/,
    );

    setEnv(
      "POSTGRES_URL_TEST_SUPERUSER",
      "postgres://postgres:pw@127.0.0.1:55432/app_test",
    );
    expect(() => assertTestDatenbank(process.env.POSTGRES_URL_TEST!)).not.toThrow();
    expect(process.env.POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET).toContain("app_test");

    setEnv("POSTGRES_URL_AUTH", "postgres://app_auth:pw@127.0.0.1:55432/app_test");
    expect(() => assertTestDatenbank(process.env.POSTGRES_URL_TEST!)).toThrow(
      /POSTGRES_URL_AUTH zeigen auf dasselbe Ziel/,
    );
  });

  it("verlangt für externe Testziele eine exakte destruktive Bestätigung", async () => {
    for (const envName of [
      "POSTGRES_URL",
      "POSTGRES_URL_AUTH",
      "POSTGRES_URL_MIGRATE",
      "POSTGRES_URL_SYSTEM",
      "POSTGRES_URL_WORKER",
      "POSTGRES_URL_TEST_SUPERUSER",
    ]) {
      setEnv(envName, undefined);
    }
    const { assertTestDatenbank } = await import("../setup/global-setup");
    const deceptiveTarget = "postgres://app_test:pw@db.example:5432/latest?sslmode=verify-full";
    const validTarget = "postgres://app_test:pw@db.example:5432/app_test?sslmode=verify-full";

    setEnv("POSTGRES_TEST_TARGET_CONFIRM", undefined);
    expect(() => assertTestDatenbank(validTarget)).toThrow(/POSTGRES_TEST_TARGET_CONFIRM/);

    setEnv(
      "POSTGRES_TEST_TARGET_CONFIRM",
      "db.example:5432/anderes_test:ALLOW-DESTRUCTIVE-TESTS",
    );
    expect(() => assertTestDatenbank(validTarget)).toThrow(/POSTGRES_TEST_TARGET_CONFIRM/);

    setEnv(
      "POSTGRES_TEST_TARGET_CONFIRM",
      "db.example:5432/latest:ALLOW-DESTRUCTIVE-TESTS",
    );
    expect(() => assertTestDatenbank(deceptiveTarget)).toThrow(/klar abgegrenzten "test"-Segment/);

    setEnv(
      "POSTGRES_TEST_TARGET_CONFIRM",
      "db.example:5432/app_test:ALLOW-DESTRUCTIVE-TESTS",
    );
    expect(() => assertTestDatenbank(validTarget)).not.toThrow();
  });

  it("verwechselt case-sensitive und percent-encodierte Datenbankziele nicht", async () => {
    const { parsePostgresConnectionUrl, postgresConnectionTargetKey } = await import(
      "@/lib/db/postgres-url"
    );
    const key = (raw: string) =>
      postgresConnectionTargetKey(parsePostgresConnectionUrl("TEST", raw));

    expect(key("postgres://u:p@127.0.0.1:5432/app_test")).not.toBe(
      key("postgres://u:p@127.0.0.1:5432/APP_TEST"),
    );
    expect(key("postgres://u:p@127.0.0.1:5432/app%2Ftest")).not.toBe(
      key("postgres://u:p@127.0.0.1:5432/app/test"),
    );
    expect(key("postgres://u:p@localhost:5432/app_test")).toBe(
      key("postgres://u:p@127.42.7.9:5432/app_test"),
    );
    expect(key("postgres://u:p@[::1]:5432/app_test")).toBe(
      key("postgres://u:p@127.0.0.1:5432/app_test"),
    );
  });

  it("lehnt Parser-Trimming, implizite Ports und ambiente Startup-Overrides ab", async () => {
    const [
      { requireServiceDatabaseUrl, servicePoolConfig },
      { parsePostgresConnectionUrl },
    ] = await Promise.all([
      import("@/lib/db/role-env"),
      import("@/lib/db/postgres-url"),
    ]);

    for (const raw of [
      " postgres://app_runtime:pw@127.0.0.1:5432/app",
      "postgres://app_runtime:pw@127.0.0.1:5432/app ",
    ]) {
      expect(() => parsePostgresConnectionUrl("POSTGRES_URL", raw)).toThrow(/Leer-\/Steuerzeichen/);
    }
    expect(() =>
      parsePostgresConnectionUrl("POSTGRES_URL", "postgres://app_runtime:pw@127.0.0.1/app"),
    ).toThrow(/vollständige/);

    setEnv("DB_ROLE_MODE", "strict");
    setEnv("POSTGRES_URL", "postgres://app_runtime:pw@127.0.0.1:5432/app");
    setEnv("PGOPTIONS", "-c role=app_owner");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(/PGOPTIONS/);
    setEnv("PGOPTIONS", undefined);

    setEnv("POSTGRES_URL", "postgres://app_runtime:pw@db.example:5432/app?sslmode=verify-full");
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(() => requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime")).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED/,
    );
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", undefined);

    const config = servicePoolConfig(process.env.POSTGRES_URL!, "app_runtime");
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });
});
