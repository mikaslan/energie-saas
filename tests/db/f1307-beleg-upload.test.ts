import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Lokales Backend je Worker (kein S3 in Tests).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1307-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  createFileRequest,
  FileRequestNotFoundError,
  FileRequestValidationError,
  fulfillFileRequestByToken,
  listFileRequests,
  transitionFileRequest,
} from "@/modules/file-requests";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import {
  ensureSubsidyCase,
  getSubsidyCase,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { testPool } from "../setup/test-db";

const PDF_BYTES = Buffer.from("%PDF-1.4 Beleg\n", "utf8");

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-07 Beleg')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1307.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F13-07 BnD-Beleg-Upload (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Beleg Lead", phone: "+49 171 6666666" }),
    );
    return lead.projectId;
  };

  const seedCaseId = async (fx: Fixture, projectId: string): Promise<string> => {
    await asEditor(fx, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    await asEditor(fx, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    await asEditor(fx, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_bewilligt" }));
    const kase = await asEditor(fx, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    if (kase === null) throw new Error("Akte fehlt nach Anlage");
    return kase.id;
  };

  it("F1307-DB-01: Verknüpfung, Fremdakte-NotFound, List-Filter", async () => {
    const projectId = await seedProject(fixture);
    const caseId = await seedCaseId(fixture, projectId);
    const otherProjectId = await seedProject(fixture);
    const otherCaseId = await seedCaseId(fixture, otherProjectId);

    const linked = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "BnD-Beleg: Schlussrechnung", description: null, subsidyCaseId: caseId,
      }));
    expect(linked.subsidyCaseId).toBe(caseId);
    const general = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, { projectId, title: "Allgemein", description: null }));
    expect(general.subsidyCaseId).toBeNull();

    // Fremde Akte (anderes Projekt) und Unbekannt: uniform NotFound.
    await expect(asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "X", description: null, subsidyCaseId: otherCaseId,
      }),
    )).rejects.toBeInstanceOf(FileRequestNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "X", description: null, subsidyCaseId: randomUUID(),
      }),
    )).rejects.toBeInstanceOf(FileRequestNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "X", description: null, subsidyCaseId: "keine-uuid",
      }),
    )).rejects.toBeInstanceOf(FileRequestValidationError);

    const filtered = await asEditor(fixture, (tx, ctx) =>
      listFileRequests(tx, ctx, projectId, { subsidyCaseId: caseId }));
    expect(filtered.map((entry) => entry.id)).toEqual([linked.id]);
    const all = await asEditor(fixture, (tx, ctx) => listFileRequests(tx, ctx, projectId));
    expect(all).toHaveLength(2);
  });

  it("F1307-DB-02: Verknüpfter Beleg durchläuft Upload bis erledigt", async () => {
    const projectId = await seedProject(fixture);
    const caseId = await seedCaseId(fixture, projectId);
    const linked = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId, title: "BnD-Beleg: Rechnung", description: null, subsidyCaseId: caseId,
      }));

    const invite = await asEditor(fixture, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }));
    const view = await resolvePortalByToken(testPool, { token: invite.token });
    expect(view.fileRequests.map((entry) => entry.id)).toContain(linked.id);

    await fulfillFileRequestByToken(testPool, {
      token: invite.token,
      requestId: linked.id,
      filename: "schlussrechnung.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    await asEditor(fixture, (tx, ctx) =>
      transitionFileRequest(tx, ctx, { projectId, requestId: linked.id, status: "erledigt" }));

    const filtered = await asEditor(fixture, (tx, ctx) =>
      listFileRequests(tx, ctx, projectId, { subsidyCaseId: caseId }));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: linked.id, status: "erledigt", subsidyCaseId: caseId });
  });
});
