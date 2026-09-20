// F3-BATCH-1+2 — Range-Test 0270-0279 (TDD-RED-WELLE).
//
// Vertrag: docs/spec/F3-BATCH-1-vertrag.md, Specs F3-02 (0270,
// planning_source) + F3-03 (0271, planning_roof_min) + F3-03b
// (0272, planning_roof_restriction) + F3-04a (0273,
// planning_panel_group) + F3-05a (0274, planning_inverter/
// planning_string).
//
// Konventionen, die diese Suite festschreibt:
// - Up-Pfad: genau eine Datei je Prefix (drizzle-kit-Muster,
//   statement-breakpoint).
// - Down-Pfad: Sibling-Datei `drizzle/<tag>.down.sql` je Migration,
//   in umgekehrter Reihenfolge (0274 vor 0273 vor 0272 vor 0271 vor 0270)
//   ausführbar.
// - Range 0270-0279: nur 0270 + 0271 + 0272 + 0273 + 0274 belegt, 0275-0279 frei.
// - Journal: idx lückenlos, jede Entry-Tag-Datei existiert, 0270/0271/
//   0272/0273/0274 unmittelbar hintereinander (Batch-Atomizität).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

const RANGE_HEAD = "0270";
const RANGE_NEXT = "0271";
const RANGE_THIRD = "0272";
const RANGE_FOURTH = "0273";
const RANGE_FIFTH = "0274";
const RANGE_FREE = ["0275", "0276", "0277", "0278", "0279"];
const SOURCE_TABLE = "planning_source";
const ROOF_TABLE = "planning_roof_min";
const RESTRICTION_TABLE = "planning_roof_restriction";
const PANEL_TABLE = "planning_panel_group";
const INVERTER_TABLE = "planning_inverter";
const STRING_TABLE = "planning_string";

function drizzleDir(): string {
  return resolve("drizzle");
}

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function upFiles(prefix: string): string[] {
  return readdirSync(drizzleDir()).filter(
    (name) => name.startsWith(`${prefix}_`) && name.endsWith(".sql") && !name.endsWith(".down.sql"),
  );
}

function downFileFor(tag: string): string {
  return resolve("drizzle", `${tag}.down.sql`);
}

function requireSingleUp(prefix: string): string {
  const files = upFiles(prefix);
  expect(
    files,
    `F3-Batch-1 Up-Pfad fehlt: drizzle/${prefix}_*.sql existiert nicht (RED: Datei fehlt).`,
  ).toHaveLength(1);
  return files[0] as string;
}

function requireJournalEntry(prefix: string): { idx: number; tag: string } {
  const entry = migrationJournal().entries.find((candidate) => candidate.tag.startsWith(`${prefix}_`));
  expect(
    entry,
    `F3-Batch-1 Journal fehlt: kein Entry mit Tag ${prefix}_* in drizzle/meta/_journal.json (RED).`,
  ).toBeDefined();
  return entry as { idx: number; tag: string };
}

describe("F3-Batch-1+2 Range 0270-0279: nur 0270 + 0271 + 0272 + 0273 + 0274 belegt", () => {
  it("belegt 0270 (F3-02 planning_source) mit genau einer Up-Datei", () => {
    expect(requireSingleUp(RANGE_HEAD)).toMatch(/^0270_.+\.sql$/);
  });

  it("belegt 0271 (F3-03 planning_roof_min) mit genau einer Up-Datei", () => {
    expect(requireSingleUp(RANGE_NEXT)).toMatch(/^0271_.+\.sql$/);
  });

  it("belegt 0272 (F3-03b planning_roof_restriction) mit genau einer Up-Datei", () => {
    expect(requireSingleUp(RANGE_THIRD)).toMatch(/^0272_.+\.sql$/);
  });

  it("belegt 0273 (F3-04a planning_panel_group) mit genau einer Up-Datei", () => {
    expect(requireSingleUp(RANGE_FOURTH)).toMatch(/^0273_.+\.sql$/);
  });

  it("belegt 0274 (F3-05a planning_inverter/planning_string) mit genau einer Up-Datei", () => {
    expect(requireSingleUp(RANGE_FIFTH)).toMatch(/^0274_.+\.sql$/);
  });

  it("laesst 0275-0279 frei (keine Up- oder Down-Dateien)", () => {
    const names = readdirSync(drizzleDir());
    for (const prefix of RANGE_FREE) {
      const belegt = names.filter(
        (name) => name.startsWith(`${prefix}_`) && (name.endsWith(".sql")),
      );
      expect(belegt, `Range-Kollision: ${prefix} muss frei bleiben, gefunden: ${belegt.join(", ")}`).toEqual([]);
    }
    const journalTags = migrationJournal().entries.map((entry) => entry.tag);
    for (const prefix of RANGE_FREE) {
      expect(
        journalTags.filter((tag) => tag.startsWith(`${prefix}_`)),
        `Range-Kollision im Journal: ${prefix}_* muss frei bleiben.`,
      ).toEqual([]);
    }
  });
});

describe("F3-Batch-1 Journal-Kontinuitaet", () => {
  it("haelt Journal-idx lueckenlos und jede Tag-Datei vorhanden", () => {
    const journal = migrationJournal();
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    for (const entry of journal.entries) {
      expect(
        existsSync(resolve("drizzle", `${entry.tag}.sql`)),
        `Journal-Tag ohne Datei: drizzle/${entry.tag}.sql fehlt.`,
      ).toBe(true);
    }
  });

  it("reiht 0270/0271/0272/0273/0274 unmittelbar hintereinander", () => {
    const head = requireJournalEntry(RANGE_HEAD);
    const next = requireJournalEntry(RANGE_NEXT);
    const third = requireJournalEntry(RANGE_THIRD);
    const fourth = requireJournalEntry(RANGE_FOURTH);
    const fifth = requireJournalEntry(RANGE_FIFTH);
    expect(next.idx, "0271 muss direkt auf 0270 folgen (Batch-Atomizitaet).").toBe(head.idx + 1);
    expect(third.idx, "0272 muss direkt auf 0271 folgen (Batch-Atomizitaet).").toBe(next.idx + 1);
    expect(fourth.idx, "0273 muss direkt auf 0272 folgen (Batch-Atomizitaet).").toBe(third.idx + 1);
    expect(fifth.idx, "0274 muss direkt auf 0273 folgen (Batch-Atomizitaet).").toBe(fourth.idx + 1);
    const journal = migrationJournal();
    const headPosition = journal.entries.findIndex((entry) => entry.idx === head.idx);
    expect(headPosition).toBeGreaterThanOrEqual(0);
    expect(journal.entries[headPosition]?.tag).toBe(head.tag);
    expect(journal.entries[headPosition + 1]?.tag).toBe(next.tag);
    expect(journal.entries[headPosition + 2]?.tag).toBe(third.tag);
    expect(journal.entries[headPosition + 3]?.tag).toBe(fourth.tag);
    expect(journal.entries[headPosition + 4]?.tag).toBe(fifth.tag);
  });
});

describe("F3-Batch-1 Up-Pfade je Migration", () => {
  it("0270-Up erzeugt planning_source (F3-02)", () => {
    const file = requireSingleUp(RANGE_HEAD);
    const sql = readFileSync(resolve("drizzle", file), "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/create\s+table\s+"?planning_source"?/iu);
  });

  it("0271-Up erzeugt planning_roof_min mit FK auf planning_source (F3-03)", () => {
    const file = requireSingleUp(RANGE_NEXT);
    const sql = readFileSync(resolve("drizzle", file), "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/create\s+table\s+"?planning_roof_min"?/iu);
    expect(sql).toMatch(/references\s+"?(?:public"\.")?planning_source"?/iu);
  });

  it("0272-Up erzeugt planning_roof_restriction mit FK auf planning_roof_min (F3-03b)", () => {
    const file = requireSingleUp(RANGE_THIRD);
    const sql = readFileSync(resolve("drizzle", file), "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/create\s+table\s+"?planning_roof_restriction"?/iu);
    expect(sql).toMatch(/references\s+"?(?:public"\.")?planning_roof_min"?/iu);
  });

  it("0273-Up erzeugt planning_panel_group mit FK auf planning_roof_min (F3-04a)", () => {
    const file = requireSingleUp(RANGE_FOURTH);
    const sql = readFileSync(resolve("drizzle", file), "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/create\s+table\s+"?planning_panel_group"?/iu);
    expect(sql).toMatch(/references\s+"?(?:public"\.")?planning_roof_min"?/iu);
  });

  it("0274-Up erzeugt planning_inverter + planning_string mit FK-Kette (F3-05a)", () => {
    const file = requireSingleUp(RANGE_FIFTH);
    const sql = readFileSync(resolve("drizzle", file), "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/create\s+table\s+"?planning_inverter"?/iu);
    expect(sql).toMatch(/create\s+table\s+"?planning_string"?/iu);
    expect(sql).toMatch(/references\s+"?(?:public"\.")?project"?/iu);
    expect(sql).toMatch(/references\s+"?(?:public"\.")?planning_inverter"?/iu);
  });
});

describe("F3-Batch-1 Down-Pfade je Migration", () => {
  it("0270-Down existiert als drizzle/<tag>.down.sql und baut planning_source ab", () => {
    const { tag } = requireJournalEntry(RANGE_HEAD);
    const downPath = downFileFor(tag);
    expect(existsSync(downPath), `F3-Batch-1 Down-Pfad fehlt: ${downPath} existiert nicht (RED: Datei fehlt).`).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/drop\s+table[^;]*planning_source/iu);
  });

  it("0271-Down existiert als drizzle/<tag>.down.sql und baut planning_roof_min ab", () => {
    const { tag } = requireJournalEntry(RANGE_NEXT);
    const downPath = downFileFor(tag);
    expect(existsSync(downPath), `F3-Batch-1 Down-Pfad fehlt: ${downPath} existiert nicht (RED: Datei fehlt).`).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/drop\s+table[^;]*planning_roof_min/iu);
  });

  it("0272-Down existiert als drizzle/<tag>.down.sql und baut planning_roof_restriction ab", () => {
    const { tag } = requireJournalEntry(RANGE_THIRD);
    const downPath = downFileFor(tag);
    expect(existsSync(downPath), `F3-Batch-2 Down-Pfad fehlt: ${downPath} existiert nicht (RED: Datei fehlt).`).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/drop\s+table[^;]*planning_roof_restriction/iu);
  });

  it("0273-Down existiert als drizzle/<tag>.down.sql und baut planning_panel_group ab", () => {
    const { tag } = requireJournalEntry(RANGE_FOURTH);
    const downPath = downFileFor(tag);
    expect(existsSync(downPath), `F3-Batch-2 Down-Pfad fehlt: ${downPath} existiert nicht (RED: Datei fehlt).`).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/drop\s+table[^;]*planning_panel_group/iu);
  });

  it("0274-Down existiert als drizzle/<tag>.down.sql und baut String vor WR ab", () => {
    const { tag } = requireJournalEntry(RANGE_FIFTH);
    const downPath = downFileFor(tag);
    expect(existsSync(downPath), `F3-Batch-2 Down-Pfad fehlt: ${downPath} existiert nicht (RED: Datei fehlt).`).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql.trim().length).toBeGreaterThan(0);
    expect(sql).toMatch(/drop\s+table[^;]*planning_string/iu);
    expect(sql).toMatch(/drop\s+table[^;]*planning_inverter/iu);
    expect(sql.indexOf("planning_string")).toBeLessThan(sql.indexOf("planning_inverter"));
  });
});

describe("F3-Batch-1 Up/Down auf frischer DB", () => {
  it("migriert 0270/0271/0272/0273/0274 auf frischer DB mit RLS + FORCE (Up)", async () => {
    // Fail-fast ohne DB-Boot, solange die Dateien fehlen (RED-Signatur).
    requireJournalEntry(RANGE_HEAD);
    requireJournalEntry(RANGE_NEXT);
    requireJournalEntry(RANGE_THIRD);
    requireJournalEntry(RANGE_FOURTH);
    requireJournalEntry(RANGE_FIFTH);
    requireSingleUp(RANGE_HEAD);
    requireSingleUp(RANGE_NEXT);
    requireSingleUp(RANGE_THIRD);
    requireSingleUp(RANGE_FOURTH);
    requireSingleUp(RANGE_FIFTH);

    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: drizzleDir() });
      const relations = await pool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_catalog.pg_class
          where relnamespace = 'public'::regnamespace
            and relname = any($1::text[])
          order by relname`,
        [[SOURCE_TABLE, ROOF_TABLE, RESTRICTION_TABLE, PANEL_TABLE, INVERTER_TABLE, STRING_TABLE]],
      );
      expect(
        [...relations.rows].sort((a, b) => a.relname.localeCompare(b.relname)),
      ).toEqual([
        { relname: INVERTER_TABLE, relrowsecurity: true, relforcerowsecurity: true },
        { relname: PANEL_TABLE, relrowsecurity: true, relforcerowsecurity: true },
        { relname: ROOF_TABLE, relrowsecurity: true, relforcerowsecurity: true },
        { relname: RESTRICTION_TABLE, relrowsecurity: true, relforcerowsecurity: true },
        { relname: SOURCE_TABLE, relrowsecurity: true, relforcerowsecurity: true },
        { relname: STRING_TABLE, relrowsecurity: true, relforcerowsecurity: true },
      ]);
      // Journal-v7 trackt per id/hash (keine tag-Spalte): voller
      // Migrate-Lauf = Journal-Länge applied; Tabellen-Existenz oben
      // beweist 0270+0271+0272+0273+0274-Anwendung.
      const applied = await pool.query<{ n: number }>(
        "select count(*)::int as n from drizzle.__drizzle_migrations",
      );
      expect(applied.rows[0]?.n).toBe(migrationJournal().entries.length);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F3-Batch-1+2-Up-Teardown fehlgeschlagen",
      );
    }
  }, 120_000);

  it("baut 0274 vor 0273 vor 0272 vor 0271 vor 0270 per Down-SQL wieder ab (Down, umgekehrte Reihenfolge)", async () => {
    // Fail-fast ohne DB-Boot, solange die Dateien fehlen (RED-Signatur).
    const tag0270 = requireJournalEntry(RANGE_HEAD).tag;
    const tag0271 = requireJournalEntry(RANGE_NEXT).tag;
    const tag0272 = requireJournalEntry(RANGE_THIRD).tag;
    const tag0273 = requireJournalEntry(RANGE_FOURTH).tag;
    const tag0274 = requireJournalEntry(RANGE_FIFTH).tag;
    requireSingleUp(RANGE_HEAD);
    requireSingleUp(RANGE_NEXT);
    requireSingleUp(RANGE_THIRD);
    requireSingleUp(RANGE_FOURTH);
    requireSingleUp(RANGE_FIFTH);
    const down0270 = downFileFor(tag0270);
    const down0271 = downFileFor(tag0271);
    const down0272 = downFileFor(tag0272);
    const down0273 = downFileFor(tag0273);
    const down0274 = downFileFor(tag0274);
    expect(existsSync(down0274), `F3-Batch-2 Down-Pfad fehlt: ${down0274} (RED: Datei fehlt).`).toBe(true);
    expect(existsSync(down0273), `F3-Batch-2 Down-Pfad fehlt: ${down0273} (RED: Datei fehlt).`).toBe(true);
    expect(existsSync(down0272), `F3-Batch-2 Down-Pfad fehlt: ${down0272} (RED: Datei fehlt).`).toBe(true);
    expect(existsSync(down0271), `F3-Batch-1 Down-Pfad fehlt: ${down0271} (RED: Datei fehlt).`).toBe(true);
    expect(existsSync(down0270), `F3-Batch-1 Down-Pfad fehlt: ${down0270} (RED: Datei fehlt).`).toBe(true);

    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: drizzleDir() });
      // Down in umgekehrter Reihenfolge: erst Strings/WR (0274),
      // dann Panel-Gruppe, Restriktion, Dach, Quelle.
      await pool.query(readFileSync(down0274, "utf8"));
      await pool.query(readFileSync(down0273, "utf8"));
      await pool.query(readFileSync(down0272, "utf8"));
      await pool.query(readFileSync(down0271, "utf8"));
      await pool.query(readFileSync(down0270, "utf8"));
      const remaining = await pool.query<{ relname: string }>(
        `select relname from pg_catalog.pg_class
          where relnamespace = 'public'::regnamespace
            and relname = any($1::text[])`,
        [[SOURCE_TABLE, ROOF_TABLE, RESTRICTION_TABLE, PANEL_TABLE, INVERTER_TABLE, STRING_TABLE]],
      );
      expect(remaining.rows).toEqual([]);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F3-Batch-1+2-Down-Teardown fehlgeschlagen",
      );
    }
  }, 120_000);
});
