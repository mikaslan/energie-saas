import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn, withAuthorizedTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError, can } from "@/lib/permissions";

// Codex-Review #2: withTenant behandelt JEDE übergebene UUID als autorisierten
// Mandanten und ServiceCtx war frei konstruierbar. withAuthorizedTenant leitet
// Rolle, Capabilities, Feature-Flags und Actor stattdessen IN DERSELBEN
// Transaktion aus der DB ab.

const wsA = randomUUID();
const wsB = randomUUID();
const userA = randomUUID(); // admin in A, kein Mitglied in B
const userB = randomUUID(); // viewer in B
const outsider = randomUUID(); // Mitglied nirgends

async function seedWorkspace(wsId: string, flags: Record<string, boolean>) {
  await withTenantOn(testPool, wsId, (tx) =>
    tx.execute(
      sql`insert into workspace (id, name, feature_flags) values (${wsId}::uuid, 'auth-ctx', ${JSON.stringify(flags)}::jsonb)`,
    ),
  );
}

async function seedMember(
  wsId: string,
  userId: string,
  role: string,
  capabilities: Record<string, unknown>,
) {
  await withTenantOn(testPool, wsId, async (tx) => {
    await tx.execute(
      sql`insert into user_identity (id, email) values (${userId}::uuid, ${`${userId}@ctx.test`}) on conflict do nothing`,
    );
    await tx.execute(sql`insert into membership (workspace_id, user_id, role, capabilities)
      values (${wsId}::uuid, ${userId}::uuid, ${role}, ${JSON.stringify(capabilities)}::jsonb)`);
  });
}

beforeAll(async () => {
  await seedWorkspace(wsA, { invoicing: true });
  await seedWorkspace(wsB, { invoicing: false });
  await seedMember(wsA, userA, "admin", {});
  await seedMember(wsB, userB, "viewer", { edit_prices: true });
  // outsider bekommt eine Identität, aber KEINE Membership.
  await withTenantOn(testPool, wsA, (tx) =>
    tx.execute(sql`insert into user_identity (id, email) values (${outsider}::uuid, ${`${outsider}@ctx.test`})`),
  );
});

describe("withAuthorizedTenant bindet den Kontext an die Membership", () => {
  it("baut ctx aus DB-Werten (Rolle, Capabilities, Feature-Flags, Actor)", async () => {
    const ctx = await withAuthorizedTenantOn(testPool, userB, wsB, async (_tx, c) => c);
    expect(ctx.workspaceId).toBe(wsB);
    expect(ctx.actor).toBe(userB);
    expect(ctx.role).toBe("viewer"); // aus membership.role, NICHT vom Aufrufer
    expect(ctx.capabilities).toEqual({ edit_prices: true });
    expect(ctx.featureFlags).toEqual({ invoicing: false }); // aus workspace.feature_flags
  });

  it("die DB-Rolle schlägt jede Behauptung des Aufrufers — viewer bleibt viewer", async () => {
    const allowed = await withAuthorizedTenantOn(testPool, userB, wsB, async (_tx, c) =>
      can(c, "project.write"),
    );
    expect(allowed).toBe(false);
  });

  it("fremder Nutzer × fremder Workspace → PermissionDeniedError (not a member)", async () => {
    // Der Angriff aus der Review: Opfer-Workspace-UUID (wsB) mit der Adminrolle
    // aus einem ANDEREN Workspace (userA ist admin in wsA) kombinieren.
    let caught: unknown;
    try {
      await withAuthorizedTenantOn(testPool, userA, wsB, async () => "sollte nie laufen");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).message).toMatch(/not a member/);
  });

  it("Nutzer ohne jede Membership → PermissionDeniedError", async () => {
    await expect(withAuthorizedTenantOn(testPool, outsider, wsA, async () => 1)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("unbekannter Workspace → PermissionDeniedError (kein stiller leerer Kontext)", async () => {
    await expect(withAuthorizedTenantOn(testPool, userA, randomUUID(), async () => 1)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("echte Membership trägt die DB-Rolle bis in can() durch", async () => {
    const results = await withAuthorizedTenantOn(testPool, userA, wsA, async (_tx, c) => ({
      role: c.role,
      write: can(c, "project.write"),
      settings: can(c, "settings.manage"),
      invoice: can(c, "invoice.issue"), // admin + feature invoicing=true in wsA
    }));
    expect(results).toEqual({ role: "admin", write: true, settings: true, invoice: true });
  });

  it("die Transaktion des Callbacks sieht den Mandantenkontext (RLS greift)", async () => {
    const rows = await withAuthorizedTenantOn(testPool, userA, wsA, (tx) =>
      tx.execute<{ n: number; [k: string]: unknown }>(sql`select count(*)::int as n from workspace`),
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("membership.role CHECK-Constraint (drizzle/0009)", () => {
  it("DB lehnt eine unbekannte Rolle ab", async () => {
    const ws = randomUUID();
    const user = randomUUID();
    await seedWorkspace(ws, {});
    let caught: unknown;
    try {
      await withTenantOn(testPool, ws, async (tx) => {
        await tx.execute(
          sql`insert into user_identity (id, email) values (${user}::uuid, ${`${user}@ctx.test`})`,
        );
        await tx.execute(
          sql`insert into membership (workspace_id, user_id, role) values (${ws}::uuid, ${user}::uuid, 'owner')`,
        );
      });
    } catch (error) {
      caught = error;
    }
    // Drizzle wrapt Postgres-Fehler in DrizzleQueryError; die echte Meldung
    // steckt in .cause (siehe tests/db/rls.test.ts).
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as { cause?: unknown }).cause)).toMatch(/membership_role_check/);
  });
});
