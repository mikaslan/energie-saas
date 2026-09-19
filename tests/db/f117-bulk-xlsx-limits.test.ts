import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  importManualLeadBulk,
  MANUAL_LEAD_BULK_MAX_ROWS,
  ManualLeadBulkFileError,
} from "@/modules/projects/lead-bulk-import";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-17 xlsx-limits')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f117.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

function bookBytes(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function xlsxBytes(rows: Array<Array<string | number>>): Uint8Array {
  return bookBytes([{ name: "Blatt1", rows }]);
}

describe("F1-17 Bulk-xlsx: Limits fail-closed (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  async function countProjects(): Promise<number> {
    return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from project where workspace_id = ${fixture.workspaceId}::uuid
      `);
      return Number(found.rows[0]?.n ?? 0);
    });
  }

  function expectFileError(promise: Promise<unknown>, code: string): Promise<void> {
    return expect(promise).rejects.toMatchObject({
      name: "ManualLeadBulkFileError",
      code,
    });
  }

  it("F117-DB-02: alle xlsx-Limits verweigern ohne Writes", async () => {
    // 5 MB: Längenprüfung greift vor jeder Parser-Arbeit.
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        defaultScope: "residential",
        dryRun: true,
      })),
      "too-large",
    );

    // 500 Zeilen (gleiche Grenze wie CSV).
    const tooMany: Array<Array<string | number>> = [["Name", "E-Mail"]];
    for (let i = 0; i < MANUAL_LEAD_BULK_MAX_ROWS + 1; i += 1) {
      tooMany.push([`R${i}`, `r${i}@f117.test`]);
    }
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: xlsxBytes(tooMany),
        defaultScope: "residential",
        dryRun: true,
      })),
      "too-many-rows",
    );

    // 10 Spalten (Breitenprüfung vor der Alias-Auflösung).
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: xlsxBytes([Array.from({ length: 11 }, () => "Name"), ["A", "a@f117.test"]]),
        defaultScope: "residential",
        dryRun: true,
      })),
      "too-many-columns",
    );

    // Header ≤100 Zeichen.
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: xlsxBytes([[`${"N".repeat(101)}`, "E-Mail"], ["A", "a@f117.test"]]),
        defaultScope: "residential",
        dryRun: true,
      })),
      "header-too-long",
    );

    // Zelle ≤2000 Zeichen.
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: xlsxBytes([["Name", "Notiz"], ["A", "x".repeat(2001)]]),
        defaultScope: "residential",
        dryRun: true,
      })),
      "cell-too-long",
    );

    // Kein ZIP-Container → kein xlsx.
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: new TextEncoder().encode("kein xlsx, nur text"),
        defaultScope: "residential",
        dryRun: true,
      })),
      "invalid-xlsx",
    );

    // Kopf ohne Datenzeilen.
    await expectFileError(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: xlsxBytes([["Name", "E-Mail"]]),
        defaultScope: "residential",
        dryRun: true,
      })),
      "empty-file",
    );

    // Völlig leeres erstes Blatt.
    await expect(
      asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
        fileKind: "xlsx",
        bytes: bookBytes([{ name: "Leer", rows: [] }]),
        defaultScope: "residential",
        dryRun: true,
      })),
    ).rejects.toBeInstanceOf(ManualLeadBulkFileError);

    expect(await countProjects()).toBe(0);
  });

  it("F117-DB-03: nur erstes Blatt, echte Excel-Zeilennummern", async () => {
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      fileKind: "xlsx",
      bytes: bookBytes([
        {
          name: "Import",
          rows: [
            ["Name", "E-Mail"],
            ["Erste", "erste@f117.test"],
            ["", ""],
            ["Ohne Weg", ""],
            ["Zweite", "zweite@f117.test"],
          ],
        },
        // Zweites Blatt mit unbekannter Spalte muss ignoriert werden.
        { name: "Ignoriert", rows: [["Unbekannt"], ["x"]] },
      ]),
      defaultScope: "residential",
      dryRun: true,
    }));

    expect(report.totalRows).toBe(3);
    expect(report.rows.map((row) => row.line)).toEqual([2, 4, 5]);
    expect(report.rows.map((row) => row.status)).toEqual(["valid", "invalid", "valid"]);
    expect(report.rows[1]).toMatchObject({ errors: ["missing-contact"] });
    expect(await countProjects()).toBe(0);
  });
});
