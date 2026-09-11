import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  importManualLeadBulk,
  MANUAL_LEAD_BULK_MAX_ROWS,
  ManualLeadBulkFileError,
} from "@/modules/projects/lead-bulk-import";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  sourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const sourceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-02 Bulk')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f102.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f102.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F102 Messe', 'f102 messe')
    `);
  });
  return { workspaceId, editorId, viewerId, sourceId };
}

async function countProjects(workspaceId: string): Promise<number> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const found = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from project where workspace_id = ${workspaceId}::uuid
    `);
    return Number(found.rows[0]?.n ?? 0);
  });
}

describe("F1-02 Lead-Bulk-CSV-Import (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const MIXED_CSV = [
    "Name;E-Mail;Telefon;PLZ;Ort;Bereich;Quelle;Notiz",
    "Bulk Anna;anna@f102.test;0151 11111111;10115;Berlin;;F102 Messe;Rückruf bitte",
    "Ohne Weg;;;10115;Berlin;;;",
    "Falsche Mail;keine-mail;;10115;Berlin;;;",
    "Unbekannte Quelle;u@f102.test;;;;;Gibt es nicht;",
    "Bereich Gewerbe;g@f102.test;0151 22222222;80331;München;Gewerbe;;",
  ].join("\n");

  it("F102-DB-01: gemischter Import legt gültige Zeilen an, meldet Rest", async () => {
    const noted: Array<{ projectId: string; text: string }> = [];
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: MIXED_CSV,
      defaultScope: "residential",
      dryRun: false,
      writeNote: async (projectId, textMarkdown) => {
        noted.push({ projectId, text: textMarkdown });
      },
    }));

    expect(report.dryRun).toBe(false);
    expect(report.totalRows).toBe(5);
    expect(report.createdCount).toBe(2);
    expect(report.reusedCount).toBe(0);
    expect(report.noteFailedProjectIds).toEqual([]);
    expect(report.rows.map((row) => row.status)).toEqual([
      "created", "invalid", "invalid", "invalid", "created",
    ]);
    expect(report.rows[1]).toMatchObject({ line: 3, errors: ["missing-contact"] });
    expect(report.rows[2]).toMatchObject({ line: 4, errors: ["invalid-row"] });
    expect(report.rows[3]).toMatchObject({ line: 5, errors: ["unknown-source"] });
    // Notiz-Callback nur für die angelegte Zeile mit Notiz.
    expect(noted).toHaveLength(1);
    expect(noted[0]!.text).toBe("Rückruf bitte");
    expect(noted[0]!.projectId).toBe(report.rows[0]!.projectId);

    const detail = await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{
        source_key: string; lead_source_id: string | null; board_scope: string;
        postal: string | null; city: string | null; contact_name: string;
      }>(sql`
        select p.source_key, p.lead_source_id, b.scope as board_scope,
               s.postal_code as postal, s.city as city, contact.display_name as contact_name
          from project p
          join kanban_board b on b.workspace_id = p.workspace_id and b.id = p.kanban_board_id
          join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
          join contact on contact.workspace_id = p.workspace_id and contact.id = p.contact_id
         where p.workspace_id = ${fixture.workspaceId}::uuid
           and p.id = ${report.rows[0]!.projectId!}::uuid
      `);
      const gewerbe = await tx.execute<{ board_scope: string }>(sql`
        select b.scope as board_scope
          from project p
          join kanban_board b on b.workspace_id = p.workspace_id and b.id = p.kanban_board_id
         where p.workspace_id = ${fixture.workspaceId}::uuid
           and p.id = ${report.rows[4]!.projectId!}::uuid
      `);
      return { anna: found.rows[0], gewerbeScope: gewerbe.rows[0]?.board_scope };
    });
    expect(detail.anna).toMatchObject({
      source_key: "manual",
      lead_source_id: fixture.sourceId.toLowerCase(),
      board_scope: "residential",
      postal: "10115",
      city: "Berlin",
      contact_name: "Bulk Anna",
    });
    expect(detail.gewerbeScope).toBe("commercial");
  });

  it("F102-DB-02: Dry-Run validiert ohne Writes; Komma + Quotes", async () => {
    const before = await countProjects(fixture.workspaceId);
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: MIXED_CSV,
      defaultScope: "residential",
      dryRun: true,
    }));
    expect(report.dryRun).toBe(true);
    expect(report.createdCount).toBe(0);
    expect(report.rows.map((row) => row.status)).toEqual([
      "valid", "invalid", "invalid", "invalid", "valid",
    ]);
    expect(report.rows.every((row) => row.projectId === null)).toBe(true);
    expect(await countProjects(fixture.workspaceId)).toBe(before);

    const comma = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: 'Name,Telefon\n"Nachname, Vorname",0151 33333333',
      defaultScope: "residential",
      dryRun: false,
    }));
    expect(comma.createdCount).toBe(1);
    expect(comma.rows[0]).toMatchObject({ status: "created", displayName: "Nachname, Vorname" });
    expect(await countProjects(fixture.workspaceId)).toBe(before + 1);
  });

  it("F102-DB-03: Dateifehler fail-closed; Viewer denied", async () => {
    const before = await countProjects(fixture.workspaceId);
    await expect(asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: "Name;Unbekannt\nA;a@f102.test",
      defaultScope: "residential",
      dryRun: false,
    }))).rejects.toMatchObject({ name: "ManualLeadBulkFileError", code: "unknown-column" });
    await expect(asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: "E-Mail\na@f102.test",
      defaultScope: "residential",
      dryRun: false,
    }))).rejects.toMatchObject({ name: "ManualLeadBulkFileError", code: "missing-name-column" });
    await expect(asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: "Name\n",
      defaultScope: "residential",
      dryRun: false,
    }))).rejects.toBeInstanceOf(ManualLeadBulkFileError);
    const tooMany = [
      "Name;E-Mail",
      ...Array.from({ length: MANUAL_LEAD_BULK_MAX_ROWS + 1 }, (_, i) => `R${i};r${i}@f102.test`),
    ].join("\n");
    await expect(asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: tooMany,
      defaultScope: "residential",
      dryRun: true,
    }))).rejects.toMatchObject({ name: "ManualLeadBulkFileError", code: "too-many-rows" });
    expect(await countProjects(fixture.workspaceId)).toBe(before);

    await expect(asViewer(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: "Name;E-Mail\nV;v@f102.test",
      defaultScope: "residential",
      dryRun: true,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F102-DB-04: Dedupe über Zeilen hinweg; ungültiger Bereich", async () => {
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: [
        "Name;E-Mail;Bereich",
        "Dedupe Eins;dup@f102.test;",
        "Dedupe Zwei;DUP@f102.test;",
        "Falscher Bereich;x@f102.test;Mars",
      ].join("\n"),
      defaultScope: "residential",
      dryRun: false,
    }));
    expect(report.createdCount).toBe(2);
    expect(report.reusedCount).toBe(1);
    expect(report.rows[1]).toMatchObject({ status: "created", contactReused: true });
    expect(report.rows[2]).toMatchObject({ status: "invalid", errors: ["invalid-scope"] });
    const contacts = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from contact
         where workspace_id = ${fixture.workspaceId}::uuid
           and email_normalized = 'dup@f102.test'
      `);
      return Number(found.rows[0]?.n ?? 0);
    });
    expect(contacts).toBe(1);
  });
});
