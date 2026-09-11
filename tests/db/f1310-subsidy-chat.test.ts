// F13-10 Kundenchat zur Förderakte (PostgreSQL): interner Post +
// Token-Post über die DEFINER-Kapsel, Portal-Projektion ohne IDs.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createPortalInvite,
  resolvePortalByToken,
} from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import {
  ensureSubsidyCase,
  listSubsidyMessages,
  postSubsidyMessage,
  postSubsidyMessageByToken,
  SubsidyCaseNotFoundError,
  SubsidyCaseValidationError,
} from "@/modules/subsidy-cases";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(domain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-10 Chat')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@${domain}`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@${domain}`})
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

describe("F13-10 Kundenchat zur Förderakte (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1310.test");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedCase = async (fx: Fixture): Promise<{ projectId: string; caseId: string }> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Chat Lead", phone: "+49 171 3333333" }));
    const kase = await asEditor(fx, (tx, ctx) => ensureSubsidyCase(tx, ctx, lead.projectId));
    return { projectId: lead.projectId, caseId: kase.id };
  };

  it("F1310-DB-01: interner Post/Liste, Validierung, Viewer-Readonly, Mandantentrennung", async () => {
    const { projectId, caseId } = await seedCase(fixture);
    expect(await asEditor(fixture, (tx, ctx) => listSubsidyMessages(tx, ctx, projectId))).toEqual([]);
    const first = await asEditor(fixture, (tx, ctx) =>
      postSubsidyMessage(tx, ctx, { caseId, body: "Die BzA ist eingereicht." }));
    expect(first.side).toBe("internal");
    expect(first.body).toBe("Die BzA ist eingereicht.");
    const listed = await asEditor(fixture, (tx, ctx) => listSubsidyMessages(tx, ctx, projectId));
    expect(listed).toHaveLength(1);

    for (const body of ["   ", "A".repeat(2001), "Bau\tmorgen"]) {
      await expect(asEditor(fixture, (tx, ctx) =>
        postSubsidyMessage(tx, ctx, { caseId, body }))).rejects.toBeInstanceOf(
        SubsidyCaseValidationError,
      );
    }
    await expect(asEditor(fixture, (tx, ctx) =>
      postSubsidyMessage(tx, ctx, { caseId: randomUUID(), body: "X" }))).rejects.toBeInstanceOf(
      SubsidyCaseNotFoundError,
    );
    // Viewer liest, schreibt nicht.
    expect(await asViewer(fixture, (tx, ctx) => listSubsidyMessages(tx, ctx, projectId))).toHaveLength(1);
    await expect(asViewer(fixture, (tx, ctx) =>
      postSubsidyMessage(tx, ctx, { caseId, body: "X" }))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // Fremdmandant sieht nichts.
    const foreign = await seedFixture("f1310-foreign.test");
    const foreignLead = await asEditor(foreign, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Fremd", phone: "+49 171 4444444" }));
    expect(await asEditor(foreign, (tx, ctx) =>
      listSubsidyMessages(tx, ctx, foreignLead.projectId))).toEqual([]);
  });

  it("F1310-DB-02: Token-Post landet in der Portal-Projektion ohne IDs", async () => {
    const { projectId, caseId } = await seedCase(fixture);
    const invite = await asEditor(fixture, (tx, ctx) => createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fixture.workspaceId,
      projectId,
      ttlDays: 14,
    }));
    const posted = await postSubsidyMessageByToken(testPool, {
      token: invite.token,
      caseId: null,
      body: "Wann kommt der Bescheid?",
    });
    expect(posted.outcome).toBe("ok");

    const view = await resolvePortalByToken(testPool, { token: invite.token });
    expect(view.subsidy?.messages).toEqual([
      expect.objectContaining({ side: "customer", body: "Wann kommt der Bescheid?" }),
    ]);
    // Keine IDs/Akteure in der Projektion.
    expect(JSON.stringify(view.subsidy?.messages)).not.toContain(caseId);

    // Ungültiger Text → invalid (kein Wurf, kein Orakel).
    const invalid = await postSubsidyMessageByToken(testPool, {
      token: invite.token,
      caseId: null,
      body: "  ",
    });
    expect(invalid.outcome).toBe("invalid");

    // Fremdes Token und fremde Akte → identischer NotFound.
    await expect(postSubsidyMessageByToken(testPool, {
      token: "fremd",
      caseId: null,
      body: "X",
    })).rejects.toBeInstanceOf(SubsidyCaseNotFoundError);
    await expect(postSubsidyMessageByToken(testPool, {
      token: invite.token,
      caseId: randomUUID(),
      body: "X",
    })).rejects.toBeInstanceOf(SubsidyCaseNotFoundError);
  });
});
