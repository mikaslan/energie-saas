import { describe, it, expect } from "vitest";
import { testPool } from "../setup/test-db";

// Boot-Test braucht POSTGRES_URL (lib/auth.ts baut den Drizzle-Adapter beim
// Modul-Import über getDb()/getPool() auf, lib/db/client.ts ist sonst lazy)
// und BETTER_AUTH_SECRET — beides wird hier gesetzt statt Entwickler-Setup zu
// verlangen (siehe Task-Brief). POSTGRES_URL_TEST steht bereits aus dem
// globalSetup (embedded-postgres) zur Verfügung.
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.POSTGRES_URL ??= process.env.POSTGRES_URL_TEST;

describe("auth-Schema", () => {
  it("better-auth-Tabellen existieren nach Migration", async () => {
    const { rows } = await testPool.query(
      `select table_name from information_schema.tables where table_schema='public' and table_name like 'auth_%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3); // auth_user, auth_session, auth_verification
  });

  it("auth-Instanz bootet", async () => {
    const { auth } = await import("@/lib/auth");
    expect(auth.handler).toBeDefined();
  });
});
