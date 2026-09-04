import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  LEAD_SOURCE_SCHEMA_VERSION,
  type CreateLeadSourceCommand,
} from "@/lib/integrations/lead-sources/contract";
import {
  archiveLeadSource,
  createLeadSource,
  LeadSourceConflictError,
  LeadSourceNotFoundError,
  LeadSourceValidationError,
  listLeadSources,
  normalizeLeadSourceName,
  resolveLeadSourceForProducer,
  restoreLeadSource,
  updateLeadSource,
} from "@/modules/lead-sources";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string; adminId: string };

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f108.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f108.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f108.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId, adminId };
}

function createCommand(overrides: Partial<CreateLeadSourceCommand> = {}): CreateLeadSourceCommand {
  return {
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    name: "wmee-rechner-v5",
    projectDomain: "residential",
    color: "#3B82F6",
    ...overrides,
  };
}

describe("F1.8 Lead Sources (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F1.8 Lead Sources");
  });

  it("F108-DB-01: create/list/update happy path, Namens-Normalisierung, DTO-Permissions", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand()),
    );
    expect(created.name).toBe("wmee-rechner-v5");
    expect(created.projectDomain).toBe("residential");
    expect(created.color).toBe("#3B82F6");
    expect(created.archivedAt).toBeNull();
    expect(created.permissions.canWrite).toBe(true);

    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listLeadSources(tx, ctx),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
    // Viewer bekommt canWrite=false im DTO.
    expect(list[0]!.permissions.canWrite).toBe(false);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateLeadSource(tx, ctx, {
        schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
        id: created.id,
        name: "  WMEE-Rechner-V5  ",
        projectDomain: null,
        color: null,
      }),
    );
    expect(updated.name).toBe("WMEE-Rechner-V5");
    expect(updated.projectDomain).toBeNull();
    expect(updated.color).toBeNull();
    // Namens-Normalisierung fürs Matching.
    expect(normalizeLeadSourceName("  WMEE-Rechner-V5 ")).toBe("wmee-rechner-v5");
  });

  it("F108-DB-02: Namenskollision → Conflict, case-insensitive", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand()),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "WMEE-RECHNER-V5" })),
    )).rejects.toBeInstanceOf(LeadSourceConflictError);

    // Update auf einen fremden Namen → Conflict.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "broker-wattfox" })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateLeadSource(tx, ctx, {
        schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
        id: first.id,
        name: "BROKER-WATTFOX",
      }),
    )).rejects.toBeInstanceOf(LeadSourceConflictError);

    // Unbekannte Id → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateLeadSource(tx, ctx, {
        schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
        id: randomUUID(),
        name: "neu",
      }),
    )).rejects.toBeInstanceOf(LeadSourceNotFoundError);
  });

  it("F108-DB-03: archive/restore idempotent; archivierte Quelle matcht nicht mehr; Name wird frei", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand()),
    );

    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveLeadSource(tx, ctx, created.id),
    );
    expect(archived.archivedAt).not.toBeNull();

    // Idempotent: erneutes Archivieren wirft nicht.
    const again = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveLeadSource(tx, ctx, created.id),
    );
    expect(again.archivedAt).not.toBeNull();

    // Default-Liste zeigt die archivierte Quelle nicht.
    const active = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listLeadSources(tx, ctx),
    );
    expect(active).toHaveLength(0);
    const all = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listLeadSources(tx, ctx, { includeArchived: true }),
    );
    expect(all).toHaveLength(1);

    // Archivierte Quelle matcht nicht im Producer-Lookup.
    const resolved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => resolveLeadSourceForProducer(tx, ctx, "wmee-rechner-v5"),
    );
    expect(resolved).toBeNull();

    // Name ist nach Archivierung wieder frei (Reonic-Muster).
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "wmee-rechner-v5" })),
    );
    expect(recreated.id).not.toBe(created.id);

    // Restore stellt Matching wieder her.
    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreLeadSource(tx, ctx, recreated.id),
    );
    expect(restored.archivedAt).toBeNull();
    const resolvedAfter = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => resolveLeadSourceForProducer(tx, ctx, "wmee-rechner-v5"),
    );
    expect(resolvedAfter).toBe(recreated.id);
  });

  it("F108-DB-03b: Restore-Konflikt nach Namens-Neuvergabe (Kimi-P1-2)", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand()),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveLeadSource(tx, ctx, created.id),
    );
    // Name neu vergeben (explizit erlaubt).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "wmee-rechner-v5" })),
    );
    // Alte Quelle reaktivieren → Namenskollision → Conflict (kein 500er).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreLeadSource(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(LeadSourceConflictError);
  });

  it("F108-DB-06b: Grenzfälle — 121-Zeichen-Name, NFKC-Kollision, Viewer-Restore (Kimi-P3-5)", async () => {
    const longName = "x".repeat(121);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: longName })),
    )).rejects.toBeInstanceOf(LeadSourceValidationError);

    // NFKC-Fold-Kollision: Fullwidth-Buchstaben normalisieren auf denselben Namen.
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "wmee-rechner-v5" })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "ｗmee-rechner-v5" })),
    )).rejects.toBeInstanceOf(LeadSourceConflictError);

    // Viewer darf auch nicht reaktivieren.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => restoreLeadSource(tx, ctx, first.id),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F108-DB-04: Cross-Workspace-Isolation + Viewer darf nicht schreiben", async () => {
    const other = await seedWorkspace("F1.8 Fremd-Workspace");
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand()),
    );

    // Fremder Workspace sieht die Quelle nicht (RLS tenant_isolation).
    const foreignList = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => listLeadSources(tx, ctx, { includeArchived: true }),
    );
    expect(foreignList).toHaveLength(0);

    // Update über fremden Workspace-Kontext → NotFound (RLS filtert Zeile).
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => updateLeadSource(tx, ctx, {
        schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
        id: created.id,
        name: "gehackt",
      }),
    )).rejects.toBeInstanceOf(LeadSourceNotFoundError);

    // Viewer (eigener Workspace) darf weder anlegen noch archivieren.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "viewer-queue" })),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => archiveLeadSource(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F108-DB-06: Validierung — leere Namen, ungültige Farbe, unbekannte Domain", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ name: "   " })),
    )).rejects.toBeInstanceOf(LeadSourceValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({ color: "rot" })),
    )).rejects.toBeInstanceOf(LeadSourceValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, createCommand({
        name: "ok",
        projectDomain: "industrial" as unknown as "residential",
      })),
    )).rejects.toBeInstanceOf(LeadSourceValidationError);
  });
});
