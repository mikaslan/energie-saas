import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { OfferNotFoundError } from "@/modules/offers";
import {
  completeInstallation,
  createInstallation,
  getInstallationWorkbook,
  InstallationConflictError,
  listInstallableVariants,
  setInstallationVariant,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";
import { seedSignedGraphDirect } from "../setup/f806-offer-import-seed";

type Fixture = { workspaceId: string; editorId: string; adminId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-08 Workbook')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f708.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f708.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f708.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, adminId, viewerId };
}

describe("F7-08 Workbook (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F708-DB-01: Bindung + Umbindung, Scope, Completed-Freeze", async () => {
    const { graph } = await seedSignedGraphDirect(testPool, {
      workspaceId: fixture.workspaceId,
      adminId: fixture.adminId,
    });
    await asEditor(fixture, (tx, ctx) => createInstallation(tx, ctx, { projectId: graph.projectId }));

    const bound = await asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }));
    expect(bound.offerId).toBe(graph.offerId);
    expect(bound.variantId).toBe(graph.variantId);

    // Umbindung auf dieselbe Variante ist idempotent-ehrlich möglich.
    const rebound = await asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }));
    expect(rebound.variantId).toBe(graph.variantId);

    // Fremde Variante (kein Treffer im Projekt-Scope) → NotFound.
    await expect(asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: randomUUID(),
    }))).rejects.toBeInstanceOf(OfferNotFoundError);

    // Abgeschlossene Installation ist eingefroren.
    await asEditor(fixture, (tx, ctx) => completeInstallation(tx, ctx, { projectId: graph.projectId }));
    await expect(asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }))).rejects.toBeInstanceOf(InstallationConflictError);

    // Viewer ohne Schreibrecht → denied.
    await expect(asViewer(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F708-DB-02: Workbook-Projektion aus versiegeltem Snapshot", async () => {
    const { graph } = await seedSignedGraphDirect(testPool, {
      workspaceId: fixture.workspaceId,
      adminId: fixture.adminId,
    });

    // Ohne Bindung: null (UI zeigt nur den Selektor).
    const empty = await asEditor(fixture, (tx, ctx) => getInstallationWorkbook(tx, ctx, {
      projectId: graph.projectId,
    }));
    expect(empty).toBeNull();

    // Auswahl zeigt die ECHT signierte Variante (Signaturstrecke).
    const options = await asEditor(fixture, (tx, ctx) => listInstallableVariants(tx, ctx, {
      projectId: graph.projectId,
    }));
    const signed = options.filter((option) => option.variantId === graph.variantId);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.signed).toBe(true);
    expect(signed[0]!.offerId).toBe(graph.offerId);

    await asEditor(fixture, (tx, ctx) => createInstallation(tx, ctx, { projectId: graph.projectId }));
    await asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }));

    const workbook = await asEditor(fixture, (tx, ctx) => getInstallationWorkbook(tx, ctx, {
      projectId: graph.projectId,
    }));
    expect(workbook).not.toBeNull();
    expect(workbook!.offerId).toBe(graph.offerId);
    expect(workbook!.variantId).toBe(graph.variantId);
    // Stückliste aus versiegelten Sektionen: Tenant-Fixture-Position sichtbar.
    const names = workbook!.sections.flatMap((section) => section.lines.map((line) => line.name));
    expect(names).toContain("Freie Tenant-Fixture-Position");
    const gross = workbook!.sections.reduce(
      (sum, section) => sum + section.lines.reduce((inner, line) => inner + line.grossCents, 0),
      0,
    );
    expect(workbook!.visibleGrossCents).toBe(gross);
    expect(workbook!.visibleGrossCents).toBeGreaterThan(0);
    // Kategorien sind belegt (sonst wäre die Gruppierung erfunden).
    for (const section of workbook!.sections) {
      expect(section.category.length).toBeGreaterThan(0);
      expect(section.position).toBeGreaterThan(0);
    }
  });
});
