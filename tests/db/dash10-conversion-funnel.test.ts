import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  changeProjectOutcome,
  getConversionFunnelStats,
  PROJECT_OUTCOME_COMMAND_VERSION,
} from "@/modules/projects";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(name: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${name})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@dash10.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("DASH-10 Conversion-Funnel (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("DASH-10 Funnel");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedLead = async (fx: Fixture, name: string): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: name, phone: "+49 171 7777777" }),
    );
    return lead.projectId;
  };

  // Phasenwechsel per SQL (Guard erlaubt phasenreine Updates, Muster
  // f1003); Abschluss nur über den legalen Outcome-Pfad.
  const setPhase = async (
    fx: Fixture,
    projectId: string,
    phase: "request" | "offer" | "installation",
  ): Promise<void> => {
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project set phase = ${phase}
         where workspace_id = ${fx.workspaceId}::uuid and id = ${projectId}::uuid
      `);
    });
  };

  const markWon = async (fx: Fixture, projectId: string): Promise<void> => {
    await asEditor(fx, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_won",
        projectId,
        expectedOutcomeRevision: 0,
        confirmation: "mark_won",
      }),
    );
  };

  it("DASH10-DB-01: Stufen zählen Bestand, Raten relativ zu Anfragen", async () => {
    await seedLead(fixture, "Funnel Anfrage");
    const offer = await seedLead(fixture, "Funnel Angebot");
    const installation = await seedLead(fixture, "Funnel Bau");
    const won = await seedLead(fixture, "Funnel Gewinn");
    await setPhase(fixture, offer, "offer");
    await setPhase(fixture, installation, "installation");
    await markWon(fixture, won);

    const stats = await asEditor(fixture, (tx, ctx) => getConversionFunnelStats(tx, ctx));
    expect(stats.requests).toBe(4);
    expect(stats.offers).toBe(2);
    expect(stats.installations).toBe(1);
    expect(stats.won).toBe(1);
    expect(stats.offerRate).toBe(50);
    expect(stats.installationRate).toBe(25);
    expect(stats.wonRate).toBe(25);
  });

  it("DASH10-DB-02: leerer Bestand ehrlich null-Raten; fremder Mandant isoliert", async () => {
    const empty = await asEditor(fixture, (tx, ctx) => getConversionFunnelStats(tx, ctx));
    expect(empty).toEqual({
      requests: 0,
      offers: 0,
      installations: 0,
      won: 0,
      offerRate: 0,
      installationRate: 0,
      wonRate: 0,
    });

    const projectId = await seedLead(fixture, "Funnel Isolation");
    await setPhase(fixture, projectId, "offer");
    const foreign = await seedFixture("DASH-10 fremd");
    const foreignStats = await asEditor(foreign, (tx, ctx) => getConversionFunnelStats(tx, ctx));
    expect(foreignStats.requests).toBe(0);
    const homeStats = await asEditor(fixture, (tx, ctx) => getConversionFunnelStats(tx, ctx));
    expect(homeStats.requests).toBe(1);
    expect(homeStats.offers).toBe(1);
  });
});
