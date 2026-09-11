import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { FILE_REQUEST_TEMPLATE_SCHEMA_VERSION } from "@/lib/file-request-template";
import {
  applyFileRequestTemplate,
  archiveFileRequestTemplate,
  createFileRequestTemplate,
  FileRequestTemplateConflictError,
  FileRequestTemplateNotFoundError,
  listFileRequestTemplates,
  restoreFileRequestTemplate,
  updateFileRequestTemplate,
} from "@/modules/file-requests";
import { createManualLead } from "@/modules/projects/manual-lead-service";
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
      values (${editorId}::uuid, ${`editor-${editorId}@f1607.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1607.test`})
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

describe("F16-07 Datei-Anfragen-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("F16-07 Vorlagen");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Vorlagen Lead", phone: "+49 171 6666666" }),
    );
    return lead.projectId;
  };

  it("F1607-DB-01: CRUD, normalisiertes Duplikat → Konflikt", async () => {
    const created = await asEditor(fixture, (tx, ctx) =>
      createFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        name: "Stromrechnung",
        title: "Stromrechnung hochladen",
        description: "Jahresabrechnung als PDF",
        allowMany: false,
        position: 0,
      }));
    expect(created.title).toBe("Stromrechnung hochladen");
    expect(created.description).toBe("Jahresabrechnung als PDF");
    expect(created.active).toBe(true);
    expect(created.allowMany).toBe(false);

    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          name: "  STROMRECHNUNG ",
          title: "Duplikat",
          allowMany: true,
          position: 1,
        })),
    ).rejects.toBeInstanceOf(FileRequestTemplateConflictError);

    const updated = await asEditor(fixture, (tx, ctx) =>
      updateFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Stromrechnung",
        title: "Stromrechnung (aktuell) hochladen",
        description: null,
        allowMany: true,
        position: 2,
      }));
    expect(updated.title).toBe("Stromrechnung (aktuell) hochladen");
    expect(updated.description).toBeNull();
    expect(updated.position).toBe(2);
    // F10-10: Allow-many per Update setzbar.
    expect(updated.allowMany).toBe(true);

    const listed = await asViewer(fixture, (tx, ctx) => listFileRequestTemplates(tx, ctx));
    expect(listed.map((t) => t.id)).toContain(created.id);
  });

  it("F1607-DB-02: Archiv sperrt Anwenden; Restore hebt auf", async () => {
    const projectId = await seedProject(fixture);
    const created = await asEditor(fixture, (tx, ctx) =>
      createFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        name: "Zaehlerfoto",
        title: "Zählerfoto hochladen",
        allowMany: true,
        position: 0,
      }));

    await asEditor(fixture, (tx, ctx) =>
      archiveFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: false,
      }));
    await expect(
      asEditor(fixture, (tx, ctx) =>
        applyFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          templateId: created.id,
          projectId,
        })),
    ).rejects.toBeInstanceOf(FileRequestTemplateNotFoundError);

    const visible = await asEditor(fixture, (tx, ctx) => listFileRequestTemplates(tx, ctx));
    expect(visible.map((t) => t.id)).not.toContain(created.id);
    const withArchived = await asEditor(fixture, (tx, ctx) =>
      listFileRequestTemplates(tx, ctx, { includeArchived: true }));
    expect(withArchived.find((t) => t.id === created.id)?.active).toBe(false);

    await asEditor(fixture, (tx, ctx) =>
      restoreFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: true,
      }));
    const applied = await asEditor(fixture, (tx, ctx) =>
      applyFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId,
      }));
    expect(applied.templateId).toBe(created.id);
    expect(applied.request.title).toBe("Zählerfoto hochladen");
    expect(applied.request.status).toBe("offen");
    expect(applied.request.subsidyCaseId).toBeNull();
    // F10-10: Allow-many wandert aus der Vorlage in die Anfrage.
    expect(applied.request.allowMany).toBe(true);
  });

  it("F1607-DB-03: Viewer fail-closed; fremder Mandant isoliert", async () => {
    await expect(
      asViewer(fixture, (tx, ctx) =>
        createFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          name: "Viewer-Versuch",
          title: "Titel",
          allowMany: false,
          position: 0,
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const created = await asEditor(fixture, (tx, ctx) =>
      createFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        name: "Privat",
        title: "Privater Titel",
        allowMany: false,
        position: 0,
      }));
    const foreign = await seedFixture("F16-07 fremd");
    const foreignList = await asEditor(foreign, (tx, ctx) => listFileRequestTemplates(tx, ctx));
    expect(foreignList.map((t) => t.id)).not.toContain(created.id);
    await expect(
      asEditor(foreign, (tx, ctx) =>
        updateFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          id: created.id,
          name: "Privat",
          title: "Fremder Titel",
          description: null,
          allowMany: false,
          position: 0,
        })),
    ).rejects.toBeInstanceOf(FileRequestTemplateNotFoundError);
  });
});
