import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/tenant";

// Factory legt GENAU EINE Zeile im gegebenen Workspace an (workspace-Zeile existiert bereits).
// Jede neue Mandantentabelle MUSS hier eine Factory registrieren, sonst wird
// tests/db/tenant-invariants.test.ts rot — das ist der Mechanismus, der die
// Tenant-Isolations-Invariante über alle künftigen Module (M1–M8) trägt.
export const tenantFixtures: Record<string, (tx: TenantTx, wsId: string) => Promise<void>> = {
  workspace: async () => {}, // Zeile wird vom Suite-Setup selbst angelegt
  membership: async (tx, wsId) => {
    // KEIN select von user_identity: dessen SELECT-Policy (Migration 0002)
    // verlangt eine bereits existierende Membership im aktuellen Workspace —
    // für eine frische Identität ohne Membership ist das chicken-egg. Aus
    // demselben Grund auch kein "insert ... returning" (RETURNING unterliegt
    // ebenfalls der SELECT-Policy). Stattdessen: client-seitige UUID, die
    // direkt in beide Inserts eingesetzt wird.
    const userId = randomUUID();
    await tx.execute(
      sql`insert into user_identity (id, email) values (${userId}, ${`${randomUUID()}@test.local`})`,
    );
    await tx.execute(
      sql`insert into membership (workspace_id, user_id, role) values (${wsId}, ${userId}, 'viewer')`,
    );
  },
};

// Globale Tabellen ohne workspace_id — jede Ausnahme ist hier begründet:
export const TENANT_EXEMPT = new Set<string>([
  // globale Identität, EIGENE membership-basierte RLS (Migration 0002), kein
  // workspace_id — von der generischen workspace_id-Suite ausgenommen, durch
  // tests/db/rls.test.ts abgedeckt
  "user_identity",
  // Migrations-Buchhaltung. Lebt tatsächlich im Schema "drizzle", nicht
  // "public" (drizzle-orm-Default), taucht in der public-Tabellenliste der
  // Suite also nie auf — der Eintrag ist harmlose, dokumentierende
  // Absicherung falls sich das je ändert.
  "__drizzle_migrations",
]);
export const TENANT_EXEMPT_PREFIXES = ["auth_", "pgboss_"]; // better-auth (Task 8), pg-boss (Task 11)
