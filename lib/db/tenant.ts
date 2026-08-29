import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getDb } from "./client";
import * as schema from "./schema";
import type { TenantTx } from "./types";
import { PermissionDeniedError, WORKSPACE_ACCESS, isRole, type ServiceCtx } from "../permissions";

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type { ServiceCtx };

async function run<T>(d: Db, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return d.transaction(async (tx) => {
    // Membership-DML wird in Migration 0018 bewusst nur unter READ COMMITTED
    // zugelassen: Ein REPEATABLE-READ-Snapshot könnte nach einer wartenden
    // Workspace-Sperre eine inzwischen gelöschte Actor-Membership weiter sehen.
    // Diese Anweisung MUSS deshalb vor der ersten Abfrage stehen und macht den
    // Vertrag unabhängig von einem sessionweit veränderten Pool-Default.
    await tx.execute(sql`set local transaction isolation level read committed`);

    // Beide Kontextwerte werden bei JEDEM verwalteten Transaktionsstart
    // explizit gesetzt. app.actor_id = '' neutralisiert auch einen sessionweit
    // vergifteten Wert auf einer wiederverwendeten Pool-Verbindung;
    // app_actor_id() bildet den Leerwert auf NULL ab (Migration 0018).
    await tx.execute(sql`
      select
        set_config('app.actor_id', '', true),
        set_config('app.workspace_id', ${workspaceId}, true)
    `);
    return fn(tx);
  });
}

// Der einzige legale Weg zu Mandantendaten: setzt app.workspace_id innerhalb
// einer Transaktion, gegen die die RLS-Policies (siehe drizzle/*_rls_core.sql)
// greifen. Alle Service-Funktionen ab M1 nehmen TenantTx als erstes Argument.
//
// ACHTUNG (Codex-Review #2): withTenant ALLEIN autorisiert nichts — es
// behandelt jede übergebene UUID als gültigen Mandanten. Für alles, was im
// Namen eines EINGELOGGTEN NUTZERS läuft, ist withSessionTenant die richtige
// Tür; withTenant bleibt für System-/Worker-Pfade ohne Nutzerbezug
// (Jobs, Migrations-Fixups) und für Tests.
export function withTenant<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(getDb(), workspaceId, fn);
}

// Für Tests: gleiche Semantik gegen einen beliebigen Pool (Test-DB). Nutzt
// NICHT den App-Client (lib/db/client.ts), damit Tests ohne POSTGRES_URL laufen.
export function withTenantOn<T>(p: Pool, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(drizzle(p, { schema }), workspaceId, fn);
}

interface MembershipCtxRow {
  user_identity_id: unknown;
  role: unknown;
  capabilities: unknown;
  feature_flags: unknown;
  [key: string]: unknown;
}

function asFlagRecord(value: unknown): Record<string, boolean> {
  // jsonb liefert zur Laufzeit beliebige Strukturen. Es wird hier NICHT
  // normalisiert oder gefiltert — can() vergleicht mit === true und ist damit
  // fail-closed (siehe lib/permissions.ts). Ein Filter hier würde nur eine
  // zweite, abweichende Wahrheit erzeugen.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, boolean>)
    : {};
}

function buildServiceCtx(workspaceId: string, row: MembershipCtxRow): ServiceCtx {
  if (typeof row.user_identity_id !== "string") {
    throw new PermissionDeniedError(WORKSPACE_ACCESS, "workspace", "unbekannte Identität in membership");
  }
  // Rolle wird auch hier validiert, nicht nur per DB-CHECK
  // (drizzle/0009_membership_role_check.sql): der CHECK schützt neue Zeilen,
  // dieser Test schützt gegen Altbestand/Direktimporte.
  if (!isRole(row.role)) {
    throw new PermissionDeniedError(WORKSPACE_ACCESS, "workspace", "unbekannte Rolle in membership");
  }
  return {
    workspaceId,
    actor: row.user_identity_id,
    role: row.role,
    capabilities: asFlagRecord(row.capabilities),
    featureFlags: asFlagRecord(row.feature_flags),
  };
}

async function runWithVerifiedActor<T>(
  tx: TenantTx,
  ctx: ServiceCtx,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  // Erst NACH Membership-Lookup + Laufzeitvalidierung setzen. Die Session-Tür
  // löst die Identität aus auth_user_id auf; die Adapter-Tür vertraut ihrer
  // userIdentityId bewusst (ADR 0004). SET LOCAL endet mit Commit/Rollback.
  await tx.execute(sql`select set_config('app.actor_id', ${ctx.actor}, true)`);
  return fn(tx, ctx);
}

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #2 (Important): Tenant-Kontext war nicht an eine Membership
// gebunden. withTenant(uuid, …) akzeptiert JEDE UUID, und ServiceCtx (Rolle,
// Capabilities, Feature-Flags, Actor) war ein frei konstruierbares Objekt.
// Ein Aufrufer konnte damit die Opfer-Workspace-UUID mit der Adminrolle eines
// ANDEREN Workspace kombinieren — RLS ließ den Zugriff regulär durch, weil
// RLS nur den Workspace filtert, nicht die Berechtigung darin.
//
// withAuthorizedTenant schließt das: Rolle, Capabilities, Feature-Flags und
// Actor werden IN DERSELBEN TRANSAKTION aus der DB gelesen, nachdem
// app.workspace_id gesetzt wurde. Der Membership-Lookup unterliegt damit
// selbst der RLS (membership-Policy: workspace_id = app.workspace_id), und
// der Workspace-Join unterliegt der workspace-Policy (id = app.workspace_id).
// Ohne Membership im ANGEFRAGTEN Workspace gibt es keinen ctx, sondern einen
// PermissionDeniedError — fail-closed.
//
// Ab M1 ist das die Tür für jede Server-Action/Route: die Session liefert die
// auth_user.id, der Request den Workspace, und withSessionTenant löst daraus
// user_identity.id, Rolle, Capabilities und Feature-Flags IN der TenantTx auf.
// ═══════════════════════════════════════════════════════════════════════
async function runAuthorized<T>(
  d: Db,
  userIdentityId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return run(d, workspaceId, async (tx) => {
    const res = await tx.execute<MembershipCtxRow>(sql`
      select m.user_id as user_identity_id, m.role, m.capabilities, w.feature_flags
      from membership m
      join workspace w on w.id = m.workspace_id
      where m.user_id = ${userIdentityId}::uuid
        and m.workspace_id = ${workspaceId}::uuid
    `);
    const row = res.rows[0];
    if (!row) {
      throw new PermissionDeniedError(WORKSPACE_ACCESS, "workspace", "not a member");
    }
    const ctx = buildServiceCtx(workspaceId, row);
    return runWithVerifiedActor(tx, ctx, fn);
  });
}

async function runSessionTenant<T>(
  d: Db,
  authUserId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return run(d, workspaceId, async (tx) => {
    const res = await tx.execute<MembershipCtxRow>(sql`
      select ui.id as user_identity_id, m.role, m.capabilities, w.feature_flags
      from membership m
      join user_identity ui on ui.id = m.user_id
      join workspace w on w.id = m.workspace_id
      where ui.auth_user_id = ${authUserId}
        and m.workspace_id = ${workspaceId}::uuid
    `);
    const row = res.rows[0];
    if (!row) {
      throw new PermissionDeniedError(WORKSPACE_ACCESS, "workspace", "not a member");
    }
    const ctx = buildServiceCtx(workspaceId, row);
    return runWithVerifiedActor(tx, ctx, fn);
  });
}

export function withAuthorizedTenant<T>(
  userIdentityId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  // Privilegierter Adapterpfad: Die userIdentityId ist bereits vom Aufrufer
  // gewählt. Browser-/Sessionpfade MÜSSEN withSessionTenant verwenden, das
  // die Identität aus auth_user_id auflöst (ADR 0004).
  return runAuthorized(getDb(), userIdentityId, workspaceId, fn);
}

// Testvariante analog withTenantOn (eigener Pool statt App-Client).
export function withAuthorizedTenantOn<T>(
  p: Pool,
  userIdentityId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return runAuthorized(drizzle(p, { schema }), userIdentityId, workspaceId, fn);
}

export function withSessionTenant<T>(
  authUserId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return runSessionTenant(getDb(), authUserId, workspaceId, fn);
}

// Testvariante analog withTenantOn (eigener Pool statt App-Client).
export function withSessionTenantOn<T>(
  p: Pool,
  authUserId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return runSessionTenant(drizzle(p, { schema }), authUserId, workspaceId, fn);
}
