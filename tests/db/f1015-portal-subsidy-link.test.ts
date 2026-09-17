// F10-15 KfW-Upload-Kontext (PostgreSQL): subsidyLinked-Projektion.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Lokales Backend je Worker (Muster f1013 — kein S3 in Tests).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1015-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { createFileRequest, fulfillFileRequestByToken } from "@/modules/file-requests";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { ensureSubsidyCase, getSubsidyCase } from "@/modules/subsidy-cases";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1015 KfW')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1015.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F10-15 KfW-Upload-Kontext (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1015-DB-01: subsidyLinked je Anfrage, keine Akten-ID in der Sicht", async () => {
    const lead = await asEditor(fixture, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "KfW Lead", phone: "+49 171 7777777" }));
    const projectId = lead.projectId;
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    const kase = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    if (kase === null) throw new Error("Akte fehlt nach Anlage");

    const linked = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "KfW-Nachweis", description: null, subsidyCaseId: kase.id,
      }));
    const general = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, { projectId, title: "Allgemein", description: null }));

    const created = await asEditor(fixture, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }));
    const view = await resolvePortalByToken(testPool, { token: created.token });
    const linkedView = view.fileRequests.find((entry) => entry.id === linked.id);
    const generalView = view.fileRequests.find((entry) => entry.id === general.id);
    expect(linkedView).toMatchObject({ subsidyLinked: true });
    expect(generalView).toMatchObject({ subsidyLinked: false });
    // Minimiert: nur das Bit, nie die Akten-ID.
    expect(JSON.stringify(view.fileRequests)).not.toContain(kase.id);
    expect(view.subsidy).not.toBeNull();

    // Nach Upload weiter true (Erfuellung fasst die Verknuepfung nicht an).
    await fulfillFileRequestByToken(testPool, {
      token: created.token,
      requestId: linked.id,
      filename: "kfw.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-1.4 F1015\n", "utf8"),
    });
    const after = await resolvePortalByToken(testPool, { token: created.token });
    expect(after.fileRequests.find((entry) => entry.id === linked.id))
      .toMatchObject({ status: "hochgeladen", subsidyLinked: true });
  });
});
