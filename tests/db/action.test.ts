import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { closeDb } from "@/lib/db/client";
import { withTenantOn } from "@/lib/db/tenant";
import { getSessionUser } from "@/lib/session";
import { PermissionDeniedError, WORKSPACE_ACCESS } from "@/lib/permissions";
import { createSite } from "@/modules/sites";
import * as Sentry from "@sentry/nextjs";

vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const originalPostgresUrl = process.env.POSTGRES_URL;
const originalSentryDsn = process.env.SENTRY_DSN;

const ws = randomUUID();
const wsOhneMitgliedschaft = randomUUID();
const authViewer = `auth-viewer-${randomUUID()}`;
const authOutsider = `auth-outsider-${randomUUID()}`;

let viewerIdentityId: string;

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

beforeAll(async () => {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL_TEST;

  await seedWorkspace(ws, "action");
  await seedWorkspace(wsOhneMitgliedschaft, "action-ohne-mitgliedschaft");
  viewerIdentityId = await seedMember(ws, authViewer, "viewer");
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
