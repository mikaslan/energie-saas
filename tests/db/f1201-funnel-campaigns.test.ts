import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  FUNNEL_CAMPAIGN_SCHEMA_VERSION,
  type CreateFunnelCampaignCommand,
} from "@/lib/integrations/funnel-campaigns/contract";
import {
  archiveFunnelCampaign,
  createFunnelCampaign,
  FunnelCampaignConflictError,
  FunnelCampaignNotFoundError,
  FunnelCampaignValidationError,
  listFunnelCampaigns,
} from "@/modules/funnel-campaigns";
import { LeadSourceNotFoundError } from "@/modules/lead-sources";
import {
  createManualLead,
  ManualLeadValidationError,
} from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  sourceId: string;
  archivedSourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const sourceId = randomUUID();
  const archivedSourceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F12-01 Kampagnen')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1201.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1201.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F1201 Messe', 'f1201 messe'),
             (${archivedSourceId}::uuid, ${workspaceId}::uuid, 'F1201 Archiv', 'f1201 archiv')
    `);
    await tx.execute(sql`
      update lead_source set archived_at = statement_timestamp()
       where workspace_id = ${workspaceId}::uuid and id = ${archivedSourceId}::uuid
    `);
  });
  return { workspaceId, editorId, viewerId, sourceId, archivedSourceId };
}

describe("F12-01 Funnel-Kampagnen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  function command(overrides: Partial<CreateFunnelCampaignCommand> = {}): CreateFunnelCampaignCommand {
    return {
      schemaVersion: FUNNEL_CAMPAIGN_SCHEMA_VERSION,
      name: "Sommer-Kampagne",
      slug: "sommer-2026",
      leadSourceId: fixture.sourceId,
      ...overrides,
    };
  }

  it("F1201-DB-01: anlegen + aktiv listen (DTO mit Quelle)", async () => {
    const created = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    expect(created.name).toBe("Sommer-Kampagne");
    expect(created.slug).toBe("sommer-2026");
    expect(created.leadSourceId).toBe(fixture.sourceId.toLowerCase());
    expect(created.leadSourceName).toBe("F1201 Messe");
    expect(created.archivedAt).toBeNull();

    const list = await asEditor(fixture, (tx, ctx) => listFunnelCampaigns(tx, ctx));
    expect(list.map((c) => c.id)).toContain(created.id);
  });

  it("F1201-DB-02: Validierung fail-closed (Name/Slug/Quelle)", async () => {
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ slug: "GROSS ungültig!" })),
    )).rejects.toBeInstanceOf(FunnelCampaignValidationError);
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ name: "   " })),
    )).rejects.toBeInstanceOf(FunnelCampaignValidationError);
    // Fremde Quelle.
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ leadSourceId: randomUUID() })),
    )).rejects.toBeInstanceOf(LeadSourceNotFoundError);
    // Archivierte Quelle.
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ leadSourceId: fixture.archivedSourceId })),
    )).rejects.toBeInstanceOf(LeadSourceNotFoundError);
  });

  it("F1201-DB-03: Doppelanlage aktiv → Konflikt; nach Archiv frei", async () => {
    const first = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ slug: "anderer-slug" })),
    )).rejects.toBeInstanceOf(FunnelCampaignConflictError);
    await expect(asEditor(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command({ name: "Anderer Name" })),
    )).rejects.toBeInstanceOf(FunnelCampaignConflictError);

    const archived = await asEditor(fixture, (tx, ctx) => archiveFunnelCampaign(tx, ctx, first.id));
    expect(archived.archivedAt).not.toBeNull();
    // Archiv gibt Name + Slug wieder frei (F1.8-Muster).
    const second = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    expect(second.id).not.toBe(first.id);
    // Archiv ist idempotent.
    const again = await asEditor(fixture, (tx, ctx) => archiveFunnelCampaign(tx, ctx, first.id));
    expect(again.id).toBe(first.id.toLowerCase());

    await expect(asEditor(fixture, (tx, ctx) =>
      archiveFunnelCampaign(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(FunnelCampaignNotFoundError);
  });

  it("F1201-DB-04: manuelle Erfassung mit Kampagne setzt Quelle + Kampagne", async () => {
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Kampagnen Lead",
      email: "kampagne@f1201.test",
      funnelCampaignId: campaign.id,
    }));
    const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{
        lead_source_id: string | null; funnel_campaign_id: string | null;
      }>(sql`
        select lead_source_id, funnel_campaign_id from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${result.projectId}::uuid
      `);
      return found.rows[0];
    });
    expect(rows?.lead_source_id).toBe(fixture.sourceId.toLowerCase());
    expect(rows?.funnel_campaign_id).toBe(campaign.id.toLowerCase());
  });

  it("F1201-DB-05: Attribution fail-closed (doppelt/fremd/archiviert)", async () => {
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    // Quelle + Kampagne gleichzeitig ist mehrdeutig.
    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Doppelt",
      email: "doppelt@f1201.test",
      leadSourceId: fixture.sourceId,
      funnelCampaignId: campaign.id,
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);
    // Fremde Kampagne.
    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Fremd",
      email: "fremd@f1201.test",
      funnelCampaignId: randomUUID(),
    }))).rejects.toBeInstanceOf(FunnelCampaignNotFoundError);
    // Archivierte Kampagne.
    await asEditor(fixture, (tx, ctx) => archiveFunnelCampaign(tx, ctx, campaign.id));
    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Archiviert",
      email: "archiv@f1201.test",
      funnelCampaignId: campaign.id,
    }))).rejects.toBeInstanceOf(FunnelCampaignNotFoundError);
  });

  it("F1201-DB-06: Viewer darf lesen, aber nichts anlegen/archivieren", async () => {
    const list = await asViewer(fixture, (tx, ctx) => listFunnelCampaigns(tx, ctx));
    expect(list).toHaveLength(0);
    await expect(asViewer(fixture, (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command()),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) =>
      archiveFunnelCampaign(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
