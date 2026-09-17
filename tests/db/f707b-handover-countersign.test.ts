import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f707b-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  completeInstallation,
  createInstallation,
  InstallationNotFoundError,
  InstallationValidationError,
  readHandoverCountersignature,
  recordHandover,
  recordHandoverCountersignature,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";

/**
 * F7-07B Handover-Gegenzeichnung (Katalog F7.7, on-screen, intern) —
 * Kunden-Name + Signatur-PNG + Zeit am Installations-Kopf (WORM),
 * korrigierbar wie die Abnahme. Migration 0176.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  viewerId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-07B Gegenzeichnung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f707b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f707b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F707B-CUSTOMER', 'Fixture', 'Contact', 'c@f707b.test', 'c@f707b.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F707B Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F707B Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });
  return { workspaceId, projectId, editorId, viewerId };
}

async function seedHandedOver(fixture: Fixture): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => recordHandover(tx, ctx, {
      projectId: fixture.projectId,
      byName: "Monteur Martin",
      note: null,
    }),
  );
}

function countersign(
  fixture: Fixture,
  userId: string,
  overrides: {
    projectId?: string;
    byName?: string;
    bytes?: Uint8Array;
    filename?: string;
    contentType?: string;
  } = {},
) {
  return withAuthorizedTenantOn(
    testPool, userId, fixture.workspaceId,
    (tx, ctx) => recordHandoverCountersignature(tx, ctx, {
      projectId: overrides.projectId ?? fixture.projectId,
      byName: overrides.byName ?? "Familie Berger",
      bytes: overrides.bytes ?? new Uint8Array(PNG_1X1),
      filename: overrides.filename ?? "gegenzeichnung.png",
      contentType: overrides.contentType ?? "image/png",
    }),
  );
}

describe("F7-07B Handover-Gegenzeichnung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F707B-DB-01: Gegenzeichnung belegt Name/Zeit; Lesen liefert Bytes; DTO ohne Key", async () => {
    await seedHandedOver(fixture);
    const signed = await countersign(fixture, fixture.editorId);
    expect(signed.handoverCustomerName).toBe("Familie Berger");
    expect(signed.handoverCustomerSignedAt).not.toBeNull();
    expect(JSON.stringify(signed)).not.toContain("installation-signatures");
    expect(JSON.stringify(signed)).not.toContain("immutable/");

    const readBack = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => readHandoverCountersignature(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(readBack.byName).toBe("Familie Berger");
    expect(readBack.contentType).toBe("image/png");
    expect(Buffer.from(readBack.body)).toEqual(PNG_1X1);
  });

  it("F707B-DB-02: Guards — aktiv, ohne Abnahme, fremd, Leer-Name, Fehltyp, Uebergroesse", async () => {
    // Aktive Installation (ohne Abschluss/Abnahme).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await expect(countersign(fixture, fixture.editorId))
      .rejects.toBeInstanceOf(InstallationValidationError);
    // Abgeschlossen, aber ohne Abnahme.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await expect(countersign(fixture, fixture.editorId))
      .rejects.toBeInstanceOf(InstallationValidationError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: fixture.projectId,
        byName: "Monteur Martin",
        note: null,
      }),
    );
    // Fremd-Projekt, Leer-Name, Fehltyp, Uebergroesse, Leere.
    await expect(countersign(fixture, fixture.editorId, { projectId: randomUUID() }))
      .rejects.toBeInstanceOf(InstallationNotFoundError);
    await expect(countersign(fixture, fixture.editorId, { byName: "   " }))
      .rejects.toBeInstanceOf(InstallationValidationError);
    await expect(countersign(fixture, fixture.editorId, {
      filename: "x.pdf",
      contentType: "application/pdf",
    })).rejects.toBeInstanceOf(InstallationValidationError);
    await expect(countersign(fixture, fixture.editorId, { bytes: new Uint8Array(10_485_761) }))
      .rejects.toBeInstanceOf(InstallationValidationError);
    await expect(countersign(fixture, fixture.editorId, { bytes: new Uint8Array(0) }))
      .rejects.toBeInstanceOf(InstallationValidationError);
  });

  it("F707B-DB-03: Erneute Gegenzeichnung ueberschreibt; Fremdtenant orakelfrei", async () => {
    await seedHandedOver(fixture);
    await countersign(fixture, fixture.editorId, { byName: "Familie Berger" });
    const corrected = await countersign(fixture, fixture.editorId, { byName: "Familie Berger-Kramer" });
    expect(corrected.handoverCustomerName).toBe("Familie Berger-Kramer");

    const foreign = await seedFixture();
    await expect(countersign(foreign, foreign.editorId, { projectId: fixture.projectId }))
      .rejects.toBeInstanceOf(InstallationNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => readHandoverCountersignature(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(InstallationNotFoundError);
  });
});
