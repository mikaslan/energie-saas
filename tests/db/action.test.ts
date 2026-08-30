import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";
import {
  authorizedAction,
  authorizedOfferMutationAction,
  authorizedQuery,
  NotAuthenticatedError,
} from "@/lib/action";
import { closeDb } from "@/lib/db/client";
import { withSessionTenantOn, withTenantOn } from "@/lib/db/tenant";
import { getSessionUser } from "@/lib/session";
import { PermissionDeniedError, WORKSPACE_ACCESS } from "@/lib/permissions";
import { createSite } from "@/modules/sites";
import {
  createOfferFromRequest,
  OfferConflictError,
  OfferRateLimitError,
} from "@/modules/offers";
import * as Sentry from "@sentry/nextjs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const originalPostgresUrl = process.env.POSTGRES_URL;
const originalSentryDsn = process.env.SENTRY_DSN;

const ws = randomUUID();
const wsOhneMitgliedschaft = randomUUID();
const authViewer = `auth-viewer-${randomUUID()}`;
const authOfferEditor = `auth-offer-editor-${randomUUID()}`;
const authOutsider = `auth-outsider-${randomUUID()}`;

let viewerIdentityId: string;
let offerEditorIdentityId: string;

async function seedWorkspace(workspaceId: string, name: string): Promise<void> {
  await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${name})`),
  );
}

async function seedMember(workspaceId: string, authUserId: string, role: string): Promise<string> {
  const userIdentityId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into user_identity (id, email, auth_user_id)
      values (${userIdentityId}::uuid, ${`${userIdentityId}@action.test`}, ${authUserId})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${userIdentityId}::uuid, ${role})
    `);
  });
  return userIdentityId;
}

type OfferBoundaryFixture = {
  workspaceId: string;
  actorAuthUserId: string;
  actorIdentityId: string;
  adminAuthUserId: string;
};

type OfferCounterRow = {
  scope: "actor" | "workspace";
  actor_id: string | null;
  attempts: number;
  [key: string]: unknown;
};

async function createOfferBoundaryFixture(input: {
  role?: "viewer" | "editor" | "admin";
  capabilities?: Record<string, boolean>;
} = {}): Promise<OfferBoundaryFixture> {
  const workspaceId = randomUUID();
  const actorAuthUserId = `auth-offer-boundary-${randomUUID()}`;
  const adminAuthUserId = `auth-offer-boundary-admin-${randomUUID()}`;
  await seedWorkspace(workspaceId, "offer-action-boundary");
  await seedMember(workspaceId, adminAuthUserId, "admin");
  const actorIdentityId = await seedMember(
    workspaceId,
    actorAuthUserId,
    input.role ?? "editor",
  );
  if (input.capabilities) {
    await withSessionTenantOn(testPool, adminAuthUserId, workspaceId, (tx) =>
      tx.execute(sql`
        update membership
           set capabilities = ${JSON.stringify(input.capabilities)}::jsonb
         where workspace_id = ${workspaceId}::uuid
           and user_id = ${actorIdentityId}::uuid
      `));
  }
  return { workspaceId, actorAuthUserId, actorIdentityId, adminAuthUserId };
}

async function offerCounters(workspaceId: string): Promise<OfferCounterRow[]> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<OfferCounterRow>(sql`
      select scope, actor_id, attempts
        from offer_mutation_rate_window
       where workspace_id = ${workspaceId}::uuid
       order by scope, actor_id nulls first
    `);
    return result.rows;
  });
}

async function seedOfferCounter(input: {
  workspaceId: string;
  scope: "actor" | "workspace";
  actorId?: string;
  attempts: number;
}): Promise<void> {
  await withTenantOn(testPool, input.workspaceId, (tx) => tx.execute(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts
    ) values (
      ${input.workspaceId}::uuid, ${input.scope}, ${input.actorId ?? null}::uuid,
      date_bin(
        interval '15 minutes', clock_timestamp(),
        timestamptz '1970-01-01 00:00:00+00'
      ),
      ${input.attempts}
    )
  `));
}

async function replaceCapabilities(
  fixture: OfferBoundaryFixture,
  capabilitiesJson: string,
): Promise<void> {
  await withSessionTenantOn(
    testPool,
    fixture.adminAuthUserId,
    fixture.workspaceId,
    (tx) => tx.execute(sql`
      update membership
         set capabilities = ${capabilitiesJson}::jsonb
       where workspace_id = ${fixture.workspaceId}::uuid
         and user_id = ${fixture.actorIdentityId}::uuid
    `),
  );
}

beforeAll(async () => {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL_TEST;

  await seedWorkspace(ws, "action");
  await seedWorkspace(wsOhneMitgliedschaft, "action-ohne-mitgliedschaft");
  viewerIdentityId = await seedMember(ws, authViewer, "viewer");
  offerEditorIdentityId = await seedMember(ws, authOfferEditor, "editor");
});

afterEach(() => {
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(Sentry.captureMessage).mockReset();
  if (originalSentryDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalSentryDsn;
});

afterAll(async () => {
  await closeDb();
  if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
  else process.env.POSTGRES_URL = originalPostgresUrl;
});

describe("authorizedAction", () => {
  it("schreibt Denial-Audit nach can()-Ablehnung mit user_identity.id als Actor", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ authUserId: authViewer });

    let caught: unknown;
    try {
      await authorizedAction(ws, "project.write", "site", (tx, ctx) =>
        createSite(tx, ctx, { city: "Nicht erlaubt" }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).action).toBe("project.write");
    expect((caught as PermissionDeniedError).actor).toBe(viewerIdentityId);

    const audit = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ actor: string; allowed: boolean; [k: string]: unknown }>(sql`
        select actor, allowed
        from audit_log
        where workspace_id = ${ws}::uuid
          and action = 'project.write'
          and resource = 'site'
          and allowed = false
          and actor = ${viewerIdentityId}
      `),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toEqual({ actor: viewerIdentityId, allowed: false });
  });

  it("schreibt bei fehlender Membership keinen Tenant-Audit und meldet das Systemereignis", async () => {
    process.env.SENTRY_DSN = "https://example.invalid/1";
    vi.mocked(getSessionUser).mockResolvedValue({ authUserId: authOutsider });

    let lief = false;
    let caught: unknown;
    try {
      await authorizedAction(wsOhneMitgliedschaft, "project.write", "site", async () => {
        lief = true;
        return { id: randomUUID() };
      });
    } catch (error) {
      caught = error;
    }

    expect(lief).toBe(false);
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).action).toBe(WORKSPACE_ACCESS);

    // Frueher stand hier die authuser:<id>-Konvention. Ohne Membership ist
    // der Workspace-Bezug aber unverifiziert; in einer append-only-Tabelle
    // waere der Eintrag ein vom Angreifer beschreibbares Feld, kein Audit.
    const audit = await withTenantOn(testPool, wsOhneMitgliedschaft, (tx) =>
      tx.execute(sql`
        select 1
        from audit_log
        where workspace_id = ${wsOhneMitgliedschaft}::uuid
      `),
    );
    expect(audit.rows).toEqual([]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "workspace access denied without membership",
      {
        level: "warning",
        extra: {
          authUserId: authOutsider,
          workspaceId: wsOhneMitgliedschaft,
          action: "project.write",
          resource: "site",
        },
      },
    );
  });

  it("wirft ohne Session NotAuthenticatedError und schreibt keinen Audit-Eintrag", async () => {
    const vorher = await superuserPool().query<{ n: number }>(
      "select count(*)::int as n from audit_log",
    );
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await expect(
      authorizedAction(ws, "project.write", "site", async () => {
        throw new Error("darf ohne Session nicht laufen");
      }),
    ).rejects.toBeInstanceOf(NotAuthenticatedError);

    const nachher = await superuserPool().query<{ n: number }>(
      "select count(*)::int as n from audit_log",
    );
    expect(nachher.rows[0].n).toBe(vorher.rows[0].n);
  });
});

describe("authorizedOfferMutationAction", () => {
  it("committet Admission vor Validation, Replay, Conflict, Fine-Denied und Domain-Rollback", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ authUserId: authOfferEditor });

    await expect(authorizedOfferMutationAction(
      ws,
      ["project.write"],
      "offer_variant",
      async (tx) => {
        await tx.execute(sql`
          insert into audit_log (
            workspace_id, actor, action, resource, allowed, details
          ) values (
            ${ws}::uuid, ${offerEditorIdentityId}, 'project.write',
            'synthetic-domain-write', true, '{}'::jsonb
          )
        `);
        throw new Error("synthetic domain rollback");
      },
    )).rejects.toThrow("synthetic domain rollback");

    await expect(authorizedOfferMutationAction(
      ws,
      ["project.write"],
      "offer_variant",
      async () => {
        const validation = new Error("synthetic validation");
        validation.name = "OfferValidationError";
        throw validation;
      },
    )).rejects.toMatchObject({ name: "OfferValidationError" });

    await expect(authorizedOfferMutationAction(
      ws,
      ["project.write"],
      "offer_variant",
      async () => ({ replay: true }),
    )).resolves.toEqual({ replay: true });

    await expect(authorizedOfferMutationAction(
      ws,
      ["project.write"],
      "offer_variant",
      async (_tx, ctx) => {
        throw new PermissionDeniedError(
          "price.edit",
          "offer_pricing",
          "fine_grained",
          ctx.actor,
        );
      },
    )).rejects.toMatchObject({
      action: "price.edit",
      actor: offerEditorIdentityId,
    });

    const state = await withTenantOn(testPool, ws, async (tx) => {
      const rate = await tx.execute<{
        scope: string;
        actor_id: string | null;
        attempts: number;
        [key: string]: unknown;
      }>(sql`
        select scope, actor_id, attempts
          from offer_mutation_rate_window
         where workspace_id = ${ws}::uuid
           and (scope = 'workspace' or actor_id = ${offerEditorIdentityId}::uuid)
         order by scope
      `);
      const rolledBack = await tx.execute(sql`
        select 1 from audit_log
         where workspace_id = ${ws}::uuid
           and resource = 'synthetic-domain-write'
      `);
      const denied = await tx.execute(sql`
        select 1 from audit_log
         where workspace_id = ${ws}::uuid
           and actor = ${offerEditorIdentityId}
           and action = 'price.edit'
           and resource = 'offer_pricing'
           and allowed = false
      `);
      return { rate: rate.rows, rolledBack: rolledBack.rows, denied: denied.rows };
    });

    expect(state.rate).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "actor",
        actor_id: offerEditorIdentityId,
        attempts: 4,
      }),
      expect.objectContaining({ scope: "workspace", attempts: 4 }),
    ]));
    expect(state.rolledBack).toEqual([]);
    expect(state.denied).toHaveLength(1);
    expect(getSessionUser).toHaveBeenCalledTimes(8);
  });

  it("behält Actor- und Workspacezählung bei einem echten OfferConflictError", async () => {
    const fixture = await createOfferBoundaryFixture();
    vi.mocked(getSessionUser).mockResolvedValue({
      authUserId: fixture.actorAuthUserId,
    });

    let caught: unknown;
    try {
      await authorizedOfferMutationAction(
        fixture.workspaceId,
        "project.write",
        "offer_variant",
        async () => {
          throw new OfferConflictError(7);
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OfferConflictError);
    expect((caught as OfferConflictError).currentRevision).toBe(7);
    expect(await offerCounters(fixture.workspaceId)).toEqual([
      {
        scope: "actor",
        actor_id: fixture.actorIdentityId,
        attempts: 1,
      },
      { scope: "workspace", actor_id: null, attempts: 1 },
    ]);
    expect(getSessionUser).toHaveBeenCalledTimes(2);
  });

  it("stoppt am echten Wrapper-Rate-Limit vor Domaincallback, Event und Fachaudit", async () => {
    const fixture = await createOfferBoundaryFixture();
    const marker = `rate-limit-${randomUUID()}`;
    await seedOfferCounter({
      workspaceId: fixture.workspaceId,
      scope: "actor",
      actorId: fixture.actorIdentityId,
      attempts: 120,
    });
    vi.mocked(getSessionUser).mockResolvedValue({
      authUserId: fixture.actorAuthUserId,
    });
    let domainCalled = false;

    await expect(authorizedOfferMutationAction(
      fixture.workspaceId,
      "project.write",
      "site",
      async (tx, ctx) => {
        domainCalled = true;
        return createSite(tx, ctx, { city: marker });
      },
    )).rejects.toBeInstanceOf(OfferRateLimitError);

    const residue = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{
        sites: number;
        events: number;
        audits: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from site
            where workspace_id = ${fixture.workspaceId}::uuid
              and city = ${marker}) as sites,
          (select count(*)::int from domain_events
            where workspace_id = ${fixture.workspaceId}::uuid
              and event_type = 'site.created') as events,
          (select count(*)::int from audit_log
            where workspace_id = ${fixture.workspaceId}::uuid
              and action = 'project.write'
              and resource = 'site') as audits
      `);
      return result.rows[0];
    });
    expect(domainCalled).toBe(false);
    expect(residue).toEqual({ sites: 0, events: 0, audits: 0 });
    expect(await offerCounters(fixture.workspaceId)).toEqual([
      {
        scope: "actor",
        actor_id: fixture.actorIdentityId,
        attempts: 120,
      },
    ]);
    expect(getSessionUser).toHaveBeenCalledTimes(1);
  });

  it("zählt ein grobes Permission-Denial nur beim Actor", async () => {
    const fixture = await createOfferBoundaryFixture({ role: "viewer" });
    vi.mocked(getSessionUser).mockResolvedValue({
      authUserId: fixture.actorAuthUserId,
    });
    let domainCalled = false;

    await expect(authorizedOfferMutationAction(
      fixture.workspaceId,
      "project.write",
      "offer_variant",
      async () => {
        domainCalled = true;
        return null;
      },
    )).rejects.toMatchObject({
      action: "project.write",
      actor: fixture.actorIdentityId,
      reason: "capability",
    });

    expect(domainCalled).toBe(false);
    expect(await offerCounters(fixture.workspaceId)).toEqual([
      {
        scope: "actor",
        actor_id: fixture.actorIdentityId,
        attempts: 1,
      },
    ]);
    const denied = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute(sql`
        select 1
          from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and actor = ${fixture.actorIdentityId}
           and action = 'project.write'
           and resource = 'offer_variant'
           and allowed = false
      `));
    expect(denied.rows).toHaveLength(1);
    expect(getSessionUser).toHaveBeenCalledTimes(1);
  });

  it("legt ohne Session oder Ziel-Workspace-Membership keinen Zähler an", async () => {
    const member = await createOfferBoundaryFixture();
    const targetWorkspaceId = randomUUID();
    await seedWorkspace(targetWorkspaceId, "offer-action-nonmember-target");
    let domainCalled = false;
    vi.mocked(getSessionUser)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ authUserId: member.actorAuthUserId });

    await expect(authorizedOfferMutationAction(
      targetWorkspaceId,
      "project.write",
      "offer_variant",
      async () => {
        domainCalled = true;
        return null;
      },
    )).rejects.toBeInstanceOf(NotAuthenticatedError);
    await expect(authorizedOfferMutationAction(
      targetWorkspaceId,
      "project.write",
      "offer_variant",
      async () => {
        domainCalled = true;
        return null;
      },
    )).rejects.toMatchObject({ action: WORKSPACE_ACCESS });

    expect(domainCalled).toBe(false);
    expect(await offerCounters(targetWorkspaceId)).toEqual([]);
    expect(getSessionUser).toHaveBeenCalledTimes(2);
  });

  it("löst die Membership nach Admission neu auf und bleibt bei Widerruf fail-closed", async () => {
    const fixture = await createOfferBoundaryFixture();
    let domainCalled = false;
    vi.mocked(getSessionUser)
      .mockResolvedValueOnce({ authUserId: fixture.actorAuthUserId })
      .mockImplementationOnce(async () => {
        await withSessionTenantOn(
          testPool,
          fixture.adminAuthUserId,
          fixture.workspaceId,
          (tx) => tx.execute(sql`
            delete from membership
             where workspace_id = ${fixture.workspaceId}::uuid
               and user_id = ${fixture.actorIdentityId}::uuid
          `),
        );
        return { authUserId: fixture.actorAuthUserId };
      });

    await expect(authorizedOfferMutationAction(
      fixture.workspaceId,
      "project.write",
      "offer_variant",
      async () => {
        domainCalled = true;
        return null;
      },
    )).rejects.toMatchObject({
      action: WORKSPACE_ACCESS,
      reason: "not a member",
    });

    expect(domainCalled).toBe(false);
    // Der Actor-Zähler folgt der widerrufenen Membership per FK-CASCADE;
    // die bereits committete Workspace-Admission bleibt erhalten.
    expect(await offerCounters(fixture.workspaceId)).toEqual([
      { scope: "workspace", actor_id: null, attempts: 1 },
    ]);
    expect(getSessionUser).toHaveBeenCalledTimes(2);
  });

  it("verwendet nach Admission neue Capabilities und verweigert die Fachmutation", async () => {
    const fixture = await createOfferBoundaryFixture({
      capabilities: { convert_phase: true, edit_prices: true },
    });
    let domainCalled = false;
    vi.mocked(getSessionUser)
      .mockResolvedValueOnce({ authUserId: fixture.actorAuthUserId })
      .mockImplementationOnce(async () => {
        await replaceCapabilities(
          fixture,
          JSON.stringify({ convert_phase: true, edit_prices: false }),
        );
        return { authUserId: fixture.actorAuthUserId };
      });

    await expect(authorizedOfferMutationAction(
      fixture.workspaceId,
      ["project.write", "phase.convert", "price.edit"],
      "offer",
      async (tx, ctx) => {
        domainCalled = true;
        return createOfferFromRequest(tx, ctx, {});
      },
    )).rejects.toMatchObject({
      action: "price.edit",
      resource: "offer_pricing",
      actor: fixture.actorIdentityId,
    });

    expect(domainCalled).toBe(true);
    expect(await offerCounters(fixture.workspaceId)).toEqual([
      {
        scope: "actor",
        actor_id: fixture.actorIdentityId,
        attempts: 1,
      },
      { scope: "workspace", actor_id: null, attempts: 1 },
    ]);
    const state = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{
        offers: number;
        events: number;
        denied_audits: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from offer
            where workspace_id = ${fixture.workspaceId}::uuid) as offers,
          (select count(*)::int from domain_events
            where workspace_id = ${fixture.workspaceId}::uuid
              and event_type like 'offer.%') as events,
          (select count(*)::int from audit_log
            where workspace_id = ${fixture.workspaceId}::uuid
              and actor = ${fixture.actorIdentityId}
              and action = 'price.edit'
              and resource = 'offer_pricing'
              and allowed = false) as denied_audits
      `);
      return result.rows[0];
    });
    expect(state).toEqual({ offers: 0, events: 0, denied_audits: 1 });
    expect(getSessionUser).toHaveBeenCalledTimes(2);
  });

  it("weist malformed Membership-JSONB am echten withSessionTenant-Pfad vor Admission ab", async () => {
    const fixture = await createOfferBoundaryFixture();
    await replaceCapabilities(
      fixture,
      JSON.stringify({ external_only: "false", edit_prices: true }),
    );
    vi.mocked(getSessionUser).mockResolvedValue({
      authUserId: fixture.actorAuthUserId,
    });
    let domainCalled = false;

    await expect(authorizedOfferMutationAction(
      fixture.workspaceId,
      "project.write",
      "offer_variant",
      async () => {
        domainCalled = true;
        return null;
      },
    )).rejects.toMatchObject({
      action: WORKSPACE_ACCESS,
      actor: fixture.actorIdentityId,
      reason: "malformed capabilities",
    });

    expect(domainCalled).toBe(false);
    expect(await offerCounters(fixture.workspaceId)).toEqual([]);
    const audit = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute(sql`
        select 1 from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and actor = ${fixture.actorIdentityId}
      `));
    expect(audit.rows).toEqual([]);
    expect(getSessionUser).toHaveBeenCalledTimes(1);
  });
});

describe("authorizedQuery", () => {
  it("bindet auch Reads an Session, Membership und den verifizierten Actor", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ authUserId: authViewer });

    const result = await authorizedQuery(ws, "project.read", "project", async (tx, ctx) => {
      const rows = await tx.execute<{ workspace_name: string; [key: string]: unknown }>(sql`
        select name as workspace_name from workspace
      `);
      return {
        actor: ctx.actor,
        role: ctx.role,
        workspaceName: rows.rows[0].workspace_name,
      };
    });

    expect(result).toEqual({
      actor: viewerIdentityId,
      role: "viewer",
      workspaceName: "action",
    });
  });

  it("öffnet ohne Session keine Tenant-Transaktion", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    let called = false;

    await expect(authorizedQuery(ws, "project.read", "project", async () => {
      called = true;
      return null;
    })).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(called).toBe(false);
  });
});
