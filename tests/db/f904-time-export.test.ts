import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  createTimeEventType,
  exportTimeEntries,
  startTimeEntry,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  secondId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  typeId: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const secondId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9.4 Export')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f904.test`}),
             (${secondId}::uuid, ${`second-${secondId}@f904.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f904.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f904.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${secondId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.4 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f904.test`}, ${`${contactId}@f904.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.4 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.4 Projekt', 'fixture'
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
  return { workspaceId, editorId, secondId, viewerId, externalId, projectId, typeId };
}

function entryCommand(
  projectId: string,
  minutes: number,
  startHour: number,
  comment: string,
  typeId: string | null,
): CreateTimeEntryCommand {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
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

describe("F9.4 CSV-Export (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(fixture.projectId, 90, 8, 'Montage; "Sonderfall"', fixture.typeId),
      ),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.secondId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(fixture.projectId, 30, 14, "Nacharbeit", null),
      ),
    );
  });

  it("F904-DB-01: Kopf exakt, Zeilen vollständig, Filter treu", async () => {
    const all = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(all.contentType).toBe("text/csv; charset=utf-8");
    expect(all.fileName).toMatch(/^zeiterfassung-[0-9a-f]{8}-\d{8}\.csv$/u);
    const stripBom = (content: string): string[] =>
      content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== "");
    const lines = stripBom(all.content);
    expect(lines[0]).toBe("datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id");
    expect(lines).toHaveLength(3);
    // Sortierung wie Liste: start_at absteigend (14:00 vor 10:00).
    // 2026-09-04T14:00Z = 16:00 Berlin (Sommerzeit).
    expect(lines[1]).toContain("2026-09-04;16:00;18:00;30;0;;Nacharbeit;");
    expect(lines[1]).toContain(fixture.secondId);
    // 2026-09-04T08:00Z = 10:00 Berlin (Sommerzeit).
    expect(lines[2]).toContain("2026-09-04;10:00;12:00;90;0;Anfahrt;");
    expect(lines[2]).toContain('"Montage; ""Sonderfall"""');
    expect(lines[2]).toContain(fixture.editorId);

    const filtered = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.editorId] }),
    );
    const filteredLines = filtered.content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== "");
    expect(filteredLines).toHaveLength(2);
    expect(filteredLines[1]).toContain(fixture.editorId);

    const unknown = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [randomUUID()] }),
    );
    expect(unknown.content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== ""))
      .toHaveLength(1);
  });

  it("F904-DB-02: laufender Eintrag mit leeren Ende/Minuten, Viewer darf, Externer nicht", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: "Laufend",
      }),
    );
    const viewer = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    const lines = viewer.content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== "");
    expect(lines).toHaveLength(4);
    const running = lines.find((line) => line.includes("Laufend"));
    expect(running).toBeDefined();
    // Gatefix: beginn ist fuer laufende Eintraege NATUERLICH gesetzt
// (Startzeitpunkt existiert) — der SPEC-Vertrag fordert nur leeres
// Ende UND leere Minuten (Testtitel). Spalten: datum, beginn,
// ende, minuten, … -> slice(2, 4) = [ende, minuten].
    expect(running!.split(";").slice(2, 4)).toEqual(["", ""]);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F904-DB-03: Formel-Injection neutralisiert (Excel-Textmarker)", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(fixture.projectId, 15, 10, "=HYPERLINK(\"https://evil.test\")", fixture.typeId),
      ),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(
        tx, ctx, entryCommand(fixture.projectId, 20, 11, "@SUMME(A1:A9)", null),
      ),
    );
    const result = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    const lines = result.content.replace(/^\uFEFF/u, "").split("\r\n").filter((line) => line !== "");
    const formula = lines.find((line) => line.includes("HYPERLINK"));
    expect(formula).toBeDefined();
    expect(formula).toContain("'=HYPERLINK");
    const atFormula = lines.find((line) => line.includes("SUMME"));
    expect(atFormula).toBeDefined();
    expect(atFormula).toContain("'@SUMME");
  });
});
