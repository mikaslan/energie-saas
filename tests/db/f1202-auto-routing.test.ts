import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  FUNNEL_CAMPAIGN_SCHEMA_VERSION,
  type CreateFunnelCampaignCommand,
} from "@/lib/integrations/funnel-campaigns/contract";
import {
  archiveFunnelCampaign,
  createFunnelCampaign,
  FunnelCampaignAssigneeNotFoundError,
} from "@/modules/funnel-campaigns";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  sourceId: string;
  assigneeMembershipId: string;
  assigneeEmail: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const assigneeUserId = randomUUID();
  const sourceId = randomUUID();
  const assigneeMembershipId = randomUUID();
  const assigneeEmail = `beauftragt-${assigneeUserId}@f1202.test`;
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F12-02 Routing')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1202.test`}),
             (${assigneeUserId}::uuid, ${assigneeEmail})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${assigneeMembershipId}::uuid, ${workspaceId}::uuid, ${assigneeUserId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F1202 Messe', 'f1202 messe')
    `);
  });
  return {
    workspaceId, editorId, sourceId, assigneeMembershipId, assigneeEmail,
  };
}

describe("F12-02 Kampagnen-Auto-Routing (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  function command(overrides: Partial<CreateFunnelCampaignCommand> = {}): CreateFunnelCampaignCommand {
    return {
      schemaVersion: FUNNEL_CAMPAIGN_SCHEMA_VERSION,
      name: "Routing-Kampagne",
      slug: "routing-2026",
      leadSourceId: fixture.sourceId,
      ...overrides,
    };
  }

  async function projectState(projectId: string) {
    return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const project = await tx.execute<{
        assignment_revision: number; funnel_campaign_id: string | null;
      }>(sql`
        select assignment_revision, funnel_campaign_id from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${projectId}::uuid
      `);
      const assignments = await tx.execute<{ membership_id: string; assignment_role: string }>(sql`
        select membership_id, assignment_role from project_assignment
         where workspace_id = ${fixture.workspaceId}::uuid and project_id = ${projectId}::uuid
      `);
      const events = await tx.execute<{ event_type: string; payload: unknown }>(sql`
        select event_type, payload from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_id = ${projectId}::uuid
         order by id
      `);
      return { project: project.rows[0], assignments: assignments.rows, events: events.rows };
    });
  }

  it("F1202-DB-01: Kampagne mit Beauftragtem (DTO trägt Zuweisung)", async () => {
    const created = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command({
      assigneeMembershipId: fixture.assigneeMembershipId,
    })));
    expect(created.assignee).toMatchObject({
      membershipId: fixture.assigneeMembershipId.toLowerCase(),
      label: fixture.assigneeEmail,
    });
  });

  it("F1202-DB-02: fremder Beauftragter verweigert", async () => {
    await expect(asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command({
      assigneeMembershipId: randomUUID(),
    })))).rejects.toBeInstanceOf(FunnelCampaignAssigneeNotFoundError);
  });

  it("F1202-DB-03: Erfassung mit Beauftragtem weist Key Account zu", async () => {
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command({
      assigneeMembershipId: fixture.assigneeMembershipId,
    })));
    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Routing Lead",
      email: "routing@f1202.test",
      funnelCampaignId: campaign.id,
    }));
    const state = await projectState(result.projectId);
    expect(state.project?.assignment_revision).toBe(1);
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({
      membership_id: fixture.assigneeMembershipId.toLowerCase(),
      assignment_role: "key_account",
    });
    const routingEvents = state.events.filter(
      (event) => event.event_type === "project.assignment_key_account_changed",
    );
    expect(routingEvents).toHaveLength(1);
    expect(routingEvents[0]!.payload).toMatchObject({
      assignmentRevision: 1,
      commandKind: "set_key_account",
      membershipId: fixture.assigneeMembershipId.toLowerCase(),
      autoRouted: true,
      funnelCampaignId: campaign.id.toLowerCase(),
    });
  });

  it("F1202-DB-04: ohne Beauftragten keine Zuweisung (F12-01-Verhalten)", async () => {
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command()));
    expect(campaign.assignee).toBeNull();
    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Ohne Routing",
      email: "ohne@f1202.test",
      funnelCampaignId: campaign.id,
    }));
    const state = await projectState(result.projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "project.assignment_key_account_changed",
    );
  });

  it("F1202-DB-05: Offboarding des Beauftragten per RESTRICT blockiert", async () => {
    await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command({
      assigneeMembershipId: fixture.assigneeMembershipId,
    })));
    // Die Kampagne hält die Mitgliedschaft per RESTRICT-FK (wie
    // Routing-Regeln): stilles Verschwinden ist per Konstruktion
    // ausgeschlossen — der Service-Zweig bleibt letzte Verteidigung.
    // (Der Race-Zweig in createManualLead ist darum nur per direktem
    // DB-Eingriff erreichbar und fail-closed.)
    const blocked = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`
          delete from membership
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${fixture.assigneeMembershipId}::uuid
        `);
        return null;
      } catch (error) {
        const code = (error as { cause?: { code?: unknown } }).cause?.code;
        return typeof code === "string" ? code : "unknown";
      }
    });
    // 23001 = restrict_violation (ON DELETE RESTRICT greift) —
    // 23503 wäre foreign_key_violation beim Einfügen.
    expect(blocked).toBe("23001");
  });

  it("F1202-DB-06: Archiv gibt weiter frei, Beauftragter bleibt lesbar", async () => {
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, command({
      assigneeMembershipId: fixture.assigneeMembershipId,
    })));
    const archived = await asEditor(fixture, (tx, ctx) => archiveFunnelCampaign(tx, ctx, campaign.id));
    expect(archived.assignee?.membershipId).toBe(fixture.assigneeMembershipId.toLowerCase());
  });
});
