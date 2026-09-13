import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATE_SCHEMA_VERSION } from "@/lib/email-template";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  archiveEmailTemplate,
  EmailTemplateNotFoundError,
  EmailTemplateValidationError,
  listEmailTemplates,
  restoreEmailTemplate,
  updateEmailTemplate,
} from "@/modules/messaging";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(name: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${name})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1610.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1610.test`})
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

describe("F16-10 E-Mail-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("F16-10 Vorlagen");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1610-DB-01: Listen sät genau die 8 fixen Schlüssel (idempotent)", async () => {
    const first = await asEditor(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    expect(first.map((t) => t.key)).toEqual([...EMAIL_TEMPLATE_KEYS]);
    expect(first.every((t) => t.active)).toBe(true);
    expect(first.every((t) => t.permissions.canWrite)).toBe(true);
    expect(first.find((t) => t.key === "portal_link")?.label).toBe("Portal-Link");

    const second = await asEditor(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
  });

  it("F1610-DB-02: Update je Schlüssel, unbekannter Schlüssel NotFound, Validation fail-closed", async () => {
    await asEditor(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    const updated = await asEditor(fixture, (tx, ctx) =>
      updateEmailTemplate(tx, ctx, {
        schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
        key: "portal_link",
        subject: "Angepasster Betreff {{customer_name}}",
        body: "Hallo {{customer_name}}, Link: {{portal_link}}",
      }));
    expect(updated.subject).toBe("Angepasster Betreff {{customer_name}}");
    expect(updated.body).toBe("Hallo {{customer_name}}, Link: {{portal_link}}");

    await expect(
      asEditor(fixture, (tx, ctx) =>
        updateEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "kein_schluessel" as never,
          subject: "x",
          body: "y",
        })),
    ).rejects.toBeInstanceOf(EmailTemplateValidationError);

    await expect(
      asEditor(fixture, (tx, ctx) =>
        updateEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "portal_link",
          subject: "   ",
          body: "y",
        })),
    ).rejects.toBeInstanceOf(EmailTemplateValidationError);
  });

  it("F1610-DB-03: Archiv/Reaktivieren, Viewer fail-closed, Isolation", async () => {
    await asEditor(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    const archived = await asEditor(fixture, (tx, ctx) =>
      archiveEmailTemplate(tx, ctx, {
        schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
        key: "cannot_fulfil",
        active: false,
      }));
    expect(archived.active).toBe(false);
    const restored = await asEditor(fixture, (tx, ctx) =>
      restoreEmailTemplate(tx, ctx, {
        schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
        key: "cannot_fulfil",
        active: true,
      }));
    expect(restored.active).toBe(true);

    await expect(
      asViewer(fixture, (tx, ctx) =>
        updateEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "portal_link",
          subject: "Viewer",
          body: "Viewer",
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const viewerList = await asViewer(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    expect(viewerList).toHaveLength(8);
    expect(viewerList.every((t) => !t.permissions.canWrite)).toBe(true);

    const other = await seedFixture("F16-10 Fremd");
    const foreign = await asEditor(other, (tx, ctx) => listEmailTemplates(tx, ctx));
    expect(foreign).toHaveLength(8);
    const own = await asEditor(fixture, (tx, ctx) =>
      updateEmailTemplate(tx, ctx, {
        schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
        key: "portal_link",
        subject: "Eigener Betreff",
        body: "Eigener Text",
      }));
    expect(own.subject).toBe("Eigener Betreff");
    const foreignAgain = await asEditor(other, (tx, ctx) => listEmailTemplates(tx, ctx));
    expect(foreignAgain.find((t) => t.key === "portal_link")?.subject).not.toBe("Eigener Betreff");
  });

  it("F1610-DB-04: Archiv mit active=true / Restore mit active=false fail-closed", async () => {
    await asEditor(fixture, (tx, ctx) => listEmailTemplates(tx, ctx));
    await expect(
      asEditor(fixture, (tx, ctx) =>
        archiveEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "new_lead",
          active: true,
        })),
    ).rejects.toBeInstanceOf(EmailTemplateValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        restoreEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "new_lead",
          active: false,
        })),
    ).rejects.toBeInstanceOf(EmailTemplateValidationError);
    // NotFound-Pfad: Schlüssel gültig, aber Zeile fehlt (kein Seed).
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`delete from email_template where workspace_id = ${fixture.workspaceId}::uuid`);
    });
    await expect(
      asEditor(fixture, (tx, ctx) =>
        updateEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key: "new_lead",
          subject: "x",
          body: "y",
        })),
    ).rejects.toBeInstanceOf(EmailTemplateNotFoundError);
  });
});
