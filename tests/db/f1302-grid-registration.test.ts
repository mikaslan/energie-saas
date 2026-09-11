import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ensureGridRegistration,
  getGridRegistration,
  GridRegistrationNotFoundError,
  GridRegistrationValidationError,
  setGridRegistrationDetails,
  transitionGridRegistration,
} from "@/modules/grid-registration";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-01 Netz')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1302.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1302.test`})
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

describe("F13-02 Netzanmeldung (PostgreSQL)", () => {
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
      createManualLead(tx, ctx, { scope: "residential", displayName: "Netz Lead", phone: "+49 171 1111111" }),
    );
    return lead.projectId;
  };

  it("F1302-DB-01: Anlage idempotent, Kette bis Abschluss", async () => {
    const projectId = await seedProject(fixture);

    const before = await asEditor(fixture, (tx, ctx) => getGridRegistration(tx, ctx, projectId));
    expect(before).toBeNull();

    const first = await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    expect(first.status).toBe("vorbereitung");
    expect(first.submittedAt).toBeNull();
    const again = await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    expect(again.id).toBe(first.id);

    const withDetails = await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: "1EMH0012345678",
    }));
    expect(withDetails.operatorName).toBe("Netze BW");
    expect(withDetails.meterNumber).toBe("1EMH0012345678");

    for (const status of ["eingereicht", "genehmigt", "fertiggemeldet", "abgeschlossen"] as const) {
      const next = await asEditor(fixture, (tx, ctx) =>
        transitionGridRegistration(tx, ctx, { projectId, status }),
      );
      expect(next.status).toBe(status);
    }
    const done = await asEditor(fixture, (tx, ctx) => getGridRegistration(tx, ctx, projectId));
    expect(done?.submittedAt).not.toBeNull();
    expect(done?.decidedAt).not.toBeNull();
    expect(done?.completedAt).not.toBeNull();
  });

  it("F1302-DB-02: illegale Übergänge und terminaler Storno", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));

    // Sprung vorwärts und rückwärts fail-closed.
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "genehmigt" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);

    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }),
    );
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "vorbereitung" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Storno aus eingereicht ist terminal.
    const cancelled = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "storniert" }),
    );
    expect(cancelled.status).toBe("storniert");
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);
  });

  it("F1302-DB-03: Validation, NotFound, RBAC, Isolation", async () => {
    const projectId = await seedProject(fixture);

    // Details ohne Anlage → NotFound (kein Orakel: gleiche Klasse wie
    // fehlendes Projekt).
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: null,
    }))).rejects.toBeInstanceOf(GridRegistrationNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }),
    )).rejects.toBeInstanceOf(GridRegistrationNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      ensureGridRegistration(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(GridRegistrationNotFoundError);

    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    // Leerer Betreiber nach Trim → Validation.
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "   ", meterNumber: null,
    }))).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Viewer: lesen ja, schreiben nein.
    const viewerRead = await asViewer(fixture, (tx, ctx) => getGridRegistration(tx, ctx, projectId));
    expect(viewerRead?.status).toBe("vorbereitung");
    await expect(asViewer(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId))).rejects
      .toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremdmandant sieht nichts.
    const other = await seedFixture();
    expect(await asEditor(other, (tx, ctx) => getGridRegistration(tx, ctx, projectId))).toBeNull();
    await expect(asEditor(other, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId))).rejects
      .toBeInstanceOf(GridRegistrationNotFoundError);
  });
});
