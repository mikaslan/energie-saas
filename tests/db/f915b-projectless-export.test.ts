import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  createTimeEventType,
  exportProjectlessTimeEntries,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  typeId: string;
};

// F9-14-Stil: frischer Workspace je Test, eigenes Projekt, kein W3-Recycling.
// Ereignistyp nach F9.4-Muster (Spalte ereignistyp belegbar).
async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f915b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f915b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-15b Projekt', 'F9', 'Fuenfzehn',
        ${`${contactId}@f915b.test`}, ${`${contactId}@f915b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-15b Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9-15b Projekt', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  const typeId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Anfahrt",
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, projectId, typeId };
}

function entryCommand(
  projectId: string | null,
  minutes: number,
  startHour: number,
  comment: string,
  typeId: string | null,
): CreateTimeEntryCommand {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId: projectId as string,
    fields: {
      typeId,
      startAt: `2026-09-04T${pad(startHour)}:00:00.000Z`,
      endAt: `2026-09-04T${pad(startHour + 2)}:00:00.000Z`,
      workingTimeMinutes: minutes,
      breakDurationMinutes: 0,
      comment,
    },
  };
}

function stripBom(content: string): string[] {
  return content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== "");
}

describe("F9-15b projektloser CSV-Export (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F9-15b Projektlos-Export");
    // Projektlose Zeilen (Export-Kandidaten).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(null, 90, 8, 'Montage; "Sonderfall"', fixture.typeId),
      ),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(null, 30, 14, "Nacharbeit", null),
      ),
    );
    // Projekt-Zeile desselben Workspaces — darf NIEMALS im Export stehen.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(fixture.projectId, 60, 10, "Projektarbeit", null),
      ),
    );
  });

  it("F915B-DB-01: nur projektlose Zeilen, Kopf exakt, BOM/Dateiname intakt", async () => {
    const result = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportProjectlessTimeEntries(tx, ctx, {}),
    );
    expect(result.contentType).toBe("text/csv; charset=utf-8");
    expect(result.fileName).toMatch(/^zeiterfassung-ohne-projekt-\d{8}\.csv$/u);
    expect(result.content.charCodeAt(0)).toBe(0xFEFF);
    const lines = stripBom(result.content);
    expect(lines[0]).toBe("datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id");
    expect(lines).toHaveLength(3);
    // Sortierung wie Liste: start_at absteigend (14:00 vor 10:00).
    // 2026-09-04T14:00Z = 16:00 Berlin (Sommerzeit).
    expect(lines[1]).toContain("2026-09-04;16:00;18:00;30;0;;Nacharbeit;");
    expect(lines[1]).toContain(fixture.editorId);
    // 2026-09-04T08:00Z = 10:00 Berlin (Sommerzeit).
    expect(lines[2]).toContain("2026-09-04;10:00;12:00;90;0;Anfahrt;");
    expect(lines[2]).toContain('"Montage; ""Sonderfall"""');
    expect(lines[2]).toContain(fixture.editorId);
    // Strikte Trennung: Projekt-Zeile desselben Workspaces fehlt.
    expect(result.content).not.toContain("Projektarbeit");
  });

  it("F915B-DB-02: Formel-Injection neutralisiert (Excel-Textmarker)", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(null, 15, 10, "=HYPERLINK(\"https://evil.test\")", fixture.typeId),
      ),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(null, 20, 11, "@SUMME(A1:A9)", null),
      ),
    );
    const result = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportProjectlessTimeEntries(tx, ctx, {}),
    );
    const lines = stripBom(result.content);
    const formula = lines.find((line) => line.includes("HYPERLINK"));
    expect(formula).toBeDefined();
    expect(formula).toContain("'=HYPERLINK");
    const atFormula = lines.find((line) => line.includes("SUMME"));
    expect(atFormula).toBeDefined();
    expect(atFormula).toContain("'@SUMME");
    // Trennung gilt auch hier: Projekt-Zeile fehlt weiterhin.
    expect(result.content).not.toContain("Projektarbeit");
  });
});
