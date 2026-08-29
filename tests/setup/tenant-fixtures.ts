import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";

async function fixtureProjectGraph(tx: TenantTx, wsId: string): Promise<{
  contactId: string;
  siteId: string;
  projectId: string;
}> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  await tx.execute(sql`
    insert into contact (
      id, workspace_id, display_name, email_primary, email_normalized
    ) values (
      ${contactId}::uuid, ${wsId}::uuid, 'Fixture Contact',
      ${`${contactId}@test.local`}, ${`${contactId}@test.local`}
    )
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${wsId}::uuid, ${contactId}::uuid, 'Fixture Site')
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, name, source_key
    ) values (
      ${projectId}::uuid, ${wsId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
      'Fixture Project', 'fixture'
    )
  `);
  return { contactId, siteId, projectId };
}

async function fixtureReceipt(tx: TenantTx, wsId: string): Promise<{
  receiptId: string;
  projectId: string;
}> {
  const { contactId, siteId, projectId } = await fixtureProjectGraph(tx, wsId);
  const receiptId = randomUUID();
  await tx.execute(sql`
    insert into inbound_receipt (
      id, workspace_id, source_key, submission_id, contract_version,
      body_sha256, auth_key_id, signed_at, submitted_at, received_at,
      producer_application, producer_git_revision, producer_environment,
      calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
      privacy_notice_version, privacy_notice_url, contact_resolution,
      contact_id, site_id, project_id
    ) values (
      ${receiptId}::uuid, ${wsId}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
      'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
      now(), now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
      'wmee-solar.v1', '{}'::jsonb, 'offer_request',
      'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
      'created', ${contactId}::uuid, ${siteId}::uuid, ${projectId}::uuid
    )
  `);
  return { receiptId, projectId };
}

async function fixtureSnapshot(tx: TenantTx, wsId: string): Promise<{
  snapshotId: string;
  projectId: string;
}> {
  const { receiptId, projectId } = await fixtureReceipt(tx, wsId);
  const snapshotId = randomUUID();
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-08-29T00:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  await tx.execute(sql`
    insert into calculator_snapshot (
      id, workspace_id, receipt_id, project_id, schema_version,
      calculator_engine, result_integrity, investment_source, calculated_at,
      snapshot
    ) values (
      ${snapshotId}::uuid, ${wsId}::uuid, ${receiptId}::uuid, ${projectId}::uuid,
      'wmee-solar-snapshot.v1', 'wmee-solar.v1', 'client_reported_unverified',
      'market_estimate', now(), ${JSON.stringify(snapshot)}::jsonb
    )
  `);
  return { snapshotId, projectId };
}

const fixtureRequirements = {
  schemaVersion: "project-requirements.rechner.v1",
  source: "wmee-rechner-v3",
  branch: "new_installation",
  requestedProducts: {
    targetStorageKwh: 8,
    wallbox: false,
    bidirectionalCharging: false,
    backupPower: false,
  },
};

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
  domain_events: async (tx, wsId) => {
    await tx.execute(sql`insert into domain_events (workspace_id, aggregate_type, aggregate_id, event_type, actor)
      values (${wsId}::uuid, 'workspace', ${wsId}::uuid, 'fixture', 'system')`);
  },
  audit_log: async (tx, wsId) => {
    await tx.execute(sql`insert into audit_log (workspace_id, actor, action, resource, allowed)
      values (${wsId}::uuid, 'system', 'fixture', 'none', true)`);
  },
  contact: async (tx, wsId) => {
    const id = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${id}::uuid, ${wsId}::uuid, 'Fixture Contact',
        ${`${id}@test.local`}, ${`${id}@test.local`})
    `);
  },
  site: async (tx, wsId) => {
    await tx.execute(sql`insert into site (workspace_id, city) values (${wsId}::uuid, 'fixture')`);
  },
  project: async (tx, wsId) => {
    await fixtureProjectGraph(tx, wsId);
  },
  inbound_receipt: async (tx, wsId) => {
    await fixtureReceipt(tx, wsId);
  },
  calculator_snapshot: async (tx, wsId) => {
    await fixtureSnapshot(tx, wsId);
  },
  project_requirement: async (tx, wsId) => {
    const { snapshotId, projectId } = await fixtureSnapshot(tx, wsId);
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${wsId}::uuid, ${projectId}::uuid, 1,
        'project-requirements.rechner.v1', ${snapshotId}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Cross-Write-Test (Codex-Review #3): dieselbe Factory wird mit einem FREMDEN
// Workspace-Parameter in einer Transaktion des EIGENEN Workspace aufgerufen —
// der Insert MUSS an der with-check-Klausel scheitern.
//
// Für die meisten Tabellen leistet die normale Factory das schon (sie schreibt
// workspace_id = <fremd>). `workspace` selbst hat keine eigene Factory (die
// Zeile legt das Suite-Setup an), deshalb hier ein expliziter Fall: eine
// FRISCHE UUID (weder A noch B). Eine bereits existierende fremde ID würde am
// Primary Key scheitern und den Test vacuum-grün machen — nur mit einer
// frischen UUID kann AUSSCHLIESSLICH die RLS-with-check-Klausel greifen.
// ═══════════════════════════════════════════════════════════════════════
export const crossWriteOverrides: Record<string, (tx: TenantTx) => Promise<void>> = {
  workspace: async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${randomUUID()}::uuid, 'cross-write')`);
  },
  project: async (tx) => {
    await tx.execute(sql`
      insert into project (workspace_id, contact_id, site_id, name, source_key)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'Cross Write', 'fixture')
    `);
  },
  inbound_receipt: async (tx) => {
    await tx.execute(sql`
      insert into inbound_receipt (
        workspace_id, source_key, submission_id, contract_version, body_sha256,
        auth_key_id, signed_at, submitted_at, producer_application,
        producer_git_revision, producer_environment, calculator_engine,
        acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${randomUUID()}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
        'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
        now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
        'wmee-solar.v1', '{}'::jsonb, 'offer_request',
        'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
        'created', ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid
      )
    `);
  },
  calculator_snapshot: async (tx) => {
    const snapshot = {
      schemaVersion: "wmee-solar-snapshot.v1",
      calculatedAt: "2026-08-29T00:00:00.000Z",
      branch: "new_installation",
      questionnaireVariant: "short",
      resultIntegrity: "client_reported_unverified",
      inputs: {},
      provenance: { investment: "market_estimate" },
      result: { mode: "new_installation" },
    };
    await tx.execute(sql`
      insert into calculator_snapshot (
        workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source, calculated_at,
        snapshot
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(snapshot)}::jsonb
      )
    `);
  },
  project_requirement: async (tx) => {
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1,
        'project-requirements.rechner.v1', ${randomUUID()}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
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

// ═══════════════════════════════════════════════════════════════════════
// EXAKTE Auth-Allowlist statt Präfix-Match (Codex-Review #4).
//
// Vorher stand hier TENANT_EXEMPT_PREFIXES = ["auth_", …]. Beim Doppeldefekt
// war das vakuum-grün: eine echte Mandantentabelle namens
// `auth_workspace_invitation`, bei der versehentlich auch workspace_id fehlt,
// wurde als Auth-Tabelle exemptiert UND erfüllte den Wächter anschließend
// gerade WEGEN der fehlenden Spalte. Mit exakten Namen ist jede unbekannte
// auth_*-Tabelle automatisch ein Suite-Fehler.
//
// Die Liste MUSS mit den modelName-Angaben in lib/auth.ts übereinstimmen.
// auth_rate_limit kommt aus rateLimit.modelName (Codex-Review #21).
//
// pg-boss steht bewusst NICHT hier: es legt seine Tabellen in einem EIGENEN
// Schema ("pgboss") an, nicht in "public" — die Suite scannt nur "public" und
// sieht sie deshalb ohnehin nie.
// ═══════════════════════════════════════════════════════════════════════
export const TENANT_EXEMPT_AUTH = new Set<string>([
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
  "auth_rate_limit",
]);

// Regel 1 (UNIQUE (workspace_id, id)): existiert, damit ein
// zusammengesetzter FK auf die Tabelle zeigen kann. Append-only-Protokolle
// sind Blätter im Referenzgraph — auf sie zeigt nie ein FK.
export const COMPOSITE_KEY_EXEMPT = new Set<string>(["domain_events", "audit_log"]);

// Regel 3 (FK workspace_id -> workspace.id): koppelt die Löschbarkeit des
// Workspace an die der Zeile. Bei append-only-Protokollen (drizzle/0004,
// drizzle/0005 sperren DELETE und TRUNCATE) entstünde ein Workspace, der
// nicht mehr löschbar ist, ohne legalen Ausweg.
export const WORKSPACE_FK_EXEMPT = new Set<string>(["domain_events", "audit_log"]);

// ═══════════════════════════════════════════════════════════════════════
// Materialisierte Views (Codex-Review #5).
//
// Eine Matview speichert Cross-Tenant-Ergebnisse PHYSISCH und erbt die RLS
// ihrer Basistabellen NICHT. Die Architektur sieht materialisierte
// Reporting-Views vor — solange keine ein explizit tenantgeschütztes
// Cache-Muster mitbringt (eigener Schutznachweis + Eintrag hier), ist jede
// Matview in "public" ein Suite-Fehler.
// ═══════════════════════════════════════════════════════════════════════
export const MATVIEW_ALLOWLIST = new Set<string>([]);

export function isExempt(name: string): boolean {
  return TENANT_EXEMPT.has(name) || TENANT_EXEMPT_AUTH.has(name);
}
