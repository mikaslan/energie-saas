import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { createFileRequest, FileRequestValidationError } from "@/modules/file-requests";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  ensureSubsidyCase,
  getSubsidyCase,
  setSubsidyCaseDetails,
  SubsidyCaseValidationError,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-00 Filing-Kern')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1300.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1300.test`})
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

describe("F13-00 Filing-Kern (PostgreSQL)", () => {
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
      createManualLead(tx, ctx, { scope: "residential", displayName: "Filing Lead", phone: "+49 171 7777777" }),
    );
    return lead.projectId;
  };

  it("F1300-DB-01: Draft-Kanten (draft → vorbereitung, draft → storniert, kein Zurück)", async () => {
    const projectId = await seedProject(fixture);
    const first = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    expect(first.status).toBe("draft");

    // Direktsprung aus dem Entwurf in die BzA-Phase bleibt verboten.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);

    const submitted = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "vorbereitung" }));
    expect(submitted.status).toBe("vorbereitung");

    // Kein Zurück in den Entwurf (Revisionskette bleibt ehrlich).
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId, status: "draft" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);

    // Storno aus dem Entwurf ist ehrlich möglich, danach terminal.
    const projectId2 = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId2));
    const cancelled = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "storniert" }));
    expect(cancelled.status).toBe("storniert");
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "vorbereitung" })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
  });

  it("F1300-DB-02: Submit-Freeze (Edits nur in draft/korrektur, danach Validation)", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));

    const inDraft = await asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
      projectId, program: "kfw", bzaNumber: null,
    }));
    expect(inDraft.program).toBe("kfw");

    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "vorbereitung" }));
    const frozen = asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
      projectId, program: "bafa", bzaNumber: null,
    }));
    await expect(frozen).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    await expect(frozen).rejects.toThrow("details frozen in status vorbereitung");

    // Korrektur öffnet das Edit-Fenster wieder (Korrektur-Pendant).
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "korrektur" }));
    const inCorrection = await asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
      projectId, program: "bafa", bzaNumber: "BZA-KORR-1",
    }));
    expect(inCorrection.program).toBe("bafa");
    expect(inCorrection.bzaNumber).toBe("BZA-KORR-1");

    // Nach Wiedereinreichung wieder gesperrt.
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    await expect(
      asEditor(fixture, (tx, ctx) => setSubsidyCaseDetails(tx, ctx, {
        projectId, program: "kfw", bzaNumber: null,
      })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
  });

  it("F1300-DB-03: Übergangs-Event folgt .transition-Naming (IDs + Status, kein Kontext)", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "vorbereitung" }));

    const records = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      kind: string;
      value: string;
    }>(sql`
      select event.event_type as kind, event.payload::text as value
      from domain_events event
      where event.aggregate_id = ${projectId}::uuid
        and event.event_type like 'subsidy_case.%'
      union all
      select audit.action as kind, audit.details::text as value
      from audit_log audit
      where audit.action = 'subsidy_case.transition'
        and audit.details->>'projectId' = ${projectId}
    `));
    const kinds = records.rows.map((row) => row.kind).sort();
    expect(kinds).toContain("subsidy_case.transition");
    expect(kinds).not.toContain("subsidy_case.status_changed");
    const payload = JSON.parse(
      records.rows.find((row) => row.kind === "subsidy_case.transition")?.value ?? "{}",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ from: "draft", to: "vorbereitung" });
    // Details-Politik: nur IDs + Status (+ Portal-Outcome) — nie Inhalte.
    expect(Object.keys(payload).sort()).toEqual(["from", "portalActivation", "to"]);
  });

  it("F1300-DB-04: Slot-Typ-Roundtrip (gültig gespeichert, ungültig fail-closed)", async () => {
    const projectId = await seedProject(fixture);
    const kase = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));

    const slotted = await asEditor(fixture, (tx, ctx) => createFileRequest(tx, ctx, {
      projectId,
      title: "BnD-Beleg: Rechnung",
      description: null,
      subsidyCaseId: kase.id,
      slotType: "bnd_rechnung",
    }));
    expect(slotted.slotType).toBe("bnd_rechnung");

    const plain = await asEditor(fixture, (tx, ctx) => createFileRequest(tx, ctx, {
      projectId,
      title: "Allgemeine Anfrage",
      description: null,
    }));
    expect(plain.slotType).toBeNull();

    await expect(
      asEditor(fixture, (tx, ctx) => createFileRequest(tx, ctx, {
        projectId,
        title: "Falscher Slot",
        description: null,
        slotType: "eeg_verguetung",
      })),
    ).rejects.toBeInstanceOf(FileRequestValidationError);

    // CHECK auf DB-Ebene (Service-Gate umgangen → harte Schranke).
    await expect(
      withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        insert into file_request (workspace_id, project_id, slot_type, title, created_by)
        values (${fixture.workspaceId}::uuid, ${projectId}::uuid, 'eeg_verguetung', 'CHECK-Probe', ${fixture.editorId}::uuid)
      `)),
    ).rejects.toThrow();
  });

  it("F1300-DB-05: Entwurf unsichtbar für Externe (Portal: null bis Einreichung)", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    const created = await asEditor(fixture, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }));

    const draftView = await resolvePortalByToken(testPool, { token: created.token });
    expect(draftView.subsidy).toBeNull();

    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "vorbereitung" }));
    const submittedView = await resolvePortalByToken(testPool, { token: created.token });
    expect(submittedView.subsidy?.status).toBe("vorbereitung");
  });

  it("F1300-DB-06: Entwurf intern lesbar (Editor + Viewer sehen draft)", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    const kase = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(kase?.status).toBe("draft");
    // Unsichtbar für Externe (§1) heißt Portal-null — nicht lesesperre:
    // Viewer mit installation.read sieht den Entwurf.
    const seen = await asViewer(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(seen?.status).toBe("draft");
  });
});
