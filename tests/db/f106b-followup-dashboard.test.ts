import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  FollowUpValidationError,
  changeProjectOutcome,
  listFollowUpDashboard,
  setProjectFollowUp,
} from "@/modules/projects";
import { PROJECT_OUTCOME_COMMAND_VERSION } from "@/modules/projects/outcome-contract";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string; externalId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-06b FollowUp Dashboard')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f106b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f106b.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f106b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'viewer', '{"external_only":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId, externalId };
}

const isoInDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

describe("F1-06b Wiedervorlagen-Widget (PostgreSQL)", () => {
  it("F106B-DB-01: nur handelbare Bänder, fälligste zuerst, Limit greift", async () => {
    const fx = await seedFixture();
    const run = <T>(actor: string, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, actor, fx.workspaceId, fn as never) as Promise<T>;

    const seedLead = async (name: string, days: number | null): Promise<string> => {
      const lead = await run(fx.editorId, (tx, ctx) =>
        createManualLead(tx, ctx, { scope: "residential", displayName: name, phone: "+49 171 1111111" }));
      if (days !== null) {
        await run(fx.editorId, (tx, ctx) =>
          setProjectFollowUp(tx, ctx, { projectId: lead.projectId, followUpAt: isoInDays(days) }));
      }
      return lead.projectId;
    };

    const escalatedId = await seedLead("Eskaliert Lead", -10);
    const overdueId = await seedLead("Ueberfaellig Lead", -2);
    const dueId = await seedLead("Faellig Lead", 0);
    await seedLead("Anstehend Lead", 10);
    await seedLead("Ohne Datum Lead", null);

    const entries = await run(fx.editorId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {}));
    expect(entries.map((entry) => entry.projectId)).toEqual([escalatedId, overdueId, dueId]);
    expect(entries.map((entry) => entry.band)).toEqual(["escalated", "overdue", "due"]);
    for (const entry of entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.followUpAt).toBe("string");
    }

    const limited = await run(fx.editorId, (tx, ctx) => listFollowUpDashboard(tx, ctx, { limit: 2 }));
    expect(limited.map((entry) => entry.projectId)).toEqual([escalatedId, overdueId]);

    await expect(run(fx.editorId, (tx, ctx) => listFollowUpDashboard(tx, ctx, { limit: 0 })))
      .rejects.toBeInstanceOf(FollowUpValidationError);
    await expect(run(fx.editorId, (tx, ctx) => listFollowUpDashboard(tx, ctx, { limit: 21 })))
      .rejects.toBeInstanceOf(FollowUpValidationError);
  });

  it("F106B-DB-02: geschlossen/Fremdmandant unsichtbar; Viewer ok; Extern leer", async () => {
    const fx = await seedFixture();
    const run = <T>(actor: string, ws: string, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, actor, ws, fn as never) as Promise<T>;

    const lead = await run(fx.editorId, fx.workspaceId, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Offen Lead", phone: "+49 171 1111111" }));
    await run(fx.editorId, fx.workspaceId, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: lead.projectId, followUpAt: isoInDays(-3) }));

    const won = await run(fx.editorId, fx.workspaceId, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Gewonnen Lead", phone: "+49 171 1111111" }));
    await run(fx.editorId, fx.workspaceId, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: won.projectId, followUpAt: isoInDays(-3) }));
    // Schließen über den Fachpfad (Outcome-Guard verbietet Direkt-Update).
    await run(fx.editorId, fx.workspaceId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_won",
        confirmation: "mark_won",
        projectId: won.projectId,
        expectedOutcomeRevision: 0,
      }));

    const editorEntries = await run(fx.editorId, fx.workspaceId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {}));
    expect(editorEntries.map((entry) => entry.projectId)).toEqual([lead.projectId]);

    const viewerEntries = await run(fx.viewerId, fx.workspaceId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {}));
    expect(viewerEntries.map((entry) => entry.projectId)).toEqual([lead.projectId]);

    const externalEntries = await run(fx.externalId, fx.workspaceId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {}));
    expect(externalEntries).toEqual([]);

    // Fremdmandant sieht fremde Projekte nie (leere Liste, kein Orakel).
    const other = await seedFixture();
    const foreignEntries = await run(other.editorId, other.workspaceId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {}));
    expect(foreignEntries).toEqual([]);

    // Ohne project.read (fremde Identität ohne Membership) bleibt es denied.
    await expect(
      withAuthorizedTenantOn(testPool, randomUUID(), fx.workspaceId, (tx, ctx) => listFollowUpDashboard(tx, ctx, {})),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
