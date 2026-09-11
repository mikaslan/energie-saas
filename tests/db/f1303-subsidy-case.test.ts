import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ensureSubsidyCase,
  getSubsidyCase,
  nextSubsidyCaseStatuses,
  setSubsidyCaseDetails,
  SubsidyCaseNotFoundError,
  SubsidyCaseValidationError,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-03 Foerderung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1303.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1303.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

describe("F13-03 Förderakte (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Foerder Lead", phone: "+49 171 2222222" }),
    );
    return lead.projectId;
  };

  it("F1303-DB-01: Anlage idempotent, BzA→BnD-Kette bis Abschluss", async () => {
    const projectId = await seedProject(fixture);

    const before = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(before).toBeNull();

    const first = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    expect(first.status).toBe("vorbereitung");
    expect(first.bzaSubmittedAt).toBeNull();
    const again = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    expect(again.id).toBe(first.id);

    const withDetails = await asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
      projectId, program: "kfw", bzaNumber: "BZA-2026-0004711",
    }));
    expect(withDetails.program).toBe("kfw");
    expect(withDetails.bzaNumber).toBe("BZA-2026-0004711");

    for (const status of ["bza_eingereicht", "bza_bewilligt", "bnd_eingereicht", "abgeschlossen"] as const) {
      const next = await asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId, status }),
      );
      expect(next.status).toBe(status);
    }
    const done = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(done?.bzaSubmittedAt).not.toBeNull();
    expect(done?.bzaApprovedAt).not.toBeNull();
    expect(done?.bndSubmittedAt).not.toBeNull();
    expect(done?.completedAt).not.toBeNull();
  });

  it("F1303-DB-02: Korrekturrunde mit Wiedereinstieg, Storno terminal", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    const correction = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "korrektur" }));
    expect(correction.status).toBe("korrektur");
    // Wiedereinstieg in die BnD-Phase ist aus der Korrektur ehrlich möglich.
    const reentry = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bnd_eingereicht" }));
    expect(reentry.status).toBe("bnd_eingereicht");
    // Sprung in die BnD-Phase ohne Bewilligung bleibt verboten.
    const projectId2 = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId2));
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "bnd_eingereicht" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);

    const cancelled = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "storniert" }));
    expect(cancelled.status).toBe("storniert");
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    expect(nextSubsidyCaseStatuses("abgeschlossen")).toEqual([]);
  });

  it("F1304-DB-01: Portal-Projektion zeigt Förderstand ohne BzA-Nummer", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
      projectId, program: "bafa", bzaNumber: "BZA-INTERN-9",
    }));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        createPortalInvite(tx, ctx, {
          schemaVersion: PORTAL_INVITE_CREATE_VERSION,
          workspaceId: fixture.workspaceId,
          projectId,
          ttlDays: 14,
        }),
    );
    const view = await resolvePortalByToken(testPool, { token: created.token });
    expect(view.subsidy).toMatchObject({ status: "bza_eingereicht", program: "bafa" });
    expect(view.subsidy?.bzaSubmittedAt).not.toBeNull();
    // Interne Referenz tritt nie ins Portal aus.
    expect(JSON.stringify(view)).not.toContain("BZA-INTERN-9");
    expect(JSON.stringify(view)).not.toContain("bza_number");
    expect(JSON.stringify(view)).not.toContain("bzaNumber");
  });

  it("F1303-DB-03: Validation, NotFound ohne Orakel, Viewer-denied, Tenant-Isolation", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));

    const seen = await asViewer(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(seen?.status).toBe("vorbereitung");
    await expect(
      asViewer(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        setSubsidyCaseDetails(tx, ctx, { projectId, program: "eeg" as never, bzaNumber: null })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId, status: "abgeschlossen" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, randomUUID())),
    ).resolves.toBeNull();
    await expect(
      asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, randomUUID())),
    ).rejects.toBeInstanceOf(SubsidyCaseNotFoundError);

    // Fremdtenant sieht nichts (eigener Mandant, eigene Akte).
    const foreign: Fixture = await seedFixture();
    const foreignProject = await asEditor(foreign, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Fremd", phone: "+49 171 3333333" }),
    ).then((lead) => lead.projectId);
    await asEditor(foreign, (tx, ctx) => ensureSubsidyCase(tx, ctx, foreignProject));
    const cross = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, foreignProject));
    expect(cross).toBeNull();
  });
});
