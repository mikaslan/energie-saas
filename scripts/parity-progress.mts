// ═══════════════════════════════════════════════════════════════════════
// parity-progress: mechanische Stand-Auswertung.
//
// Liest die kanonische STATUS-Datei (docs/parity/STATUS.md) und das
// Migrationsjournal und druckt einen kompakten Standbericht. Die
// Prozentwerte werden NICHT neu erfunden: die Schätzung kommt wörtlich
// aus STATUS.md, die F1–F16-Fraktion wird mechanisch aus der Matrix
// gezählt (Bereiche mit mindestens PARTIAL VERIFIED / Gesamtbereiche)
// und bleibt als ESTIMATE gekennzeichnet — sie ist keine Behauptung
// einer Reonic-1:1-Parität (siehe STATUS.md, Abschnitt „Bedeutung").
//
// Aufruf: npx tsx scripts/parity-progress.mts [pfad-zu-STATUS.md]
// Kanonische Quelle ist der tooling-Branch; auf Lanes wird die lokale
// Kopie gelesen (kann gegenüber tooling veraltet sein — Hinweis unten).
// ═══════════════════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const STATUS_PATH = process.argv[2] ?? resolve(process.cwd(), "docs/parity/STATUS.md");
const JOURNAL_PATH = resolve(process.cwd(), "drizzle/meta/_journal.json");

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

function readStatus(): string {
  if (!existsSync(STATUS_PATH)) {
    throw new Error(`STATUS-Datei nicht gefunden: ${STATUS_PATH}`);
  }
  return readFileSync(STATUS_PATH, "utf8");
}

function headShort(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unbekannt";
  }
}

function branchName(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() || "detached";
  } catch {
    return "unbekannt";
  }
}

function migrationInfo(): { count: number; lastTag: string } {
  if (!existsSync(JOURNAL_PATH)) return { count: 0, lastTag: "—" };
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Journal;
  return {
    count: journal.entries.length,
    lastTag: journal.entries.at(-1)?.tag ?? "—",
  };
}

const KATEGORIEN = [
  { label: "VERIFIED", test: (s: string) => /^VERIFIED\b/.test(s) },
  { label: "PARTIAL VERIFIED", test: (s: string) => /^PARTIAL VERIFIED\b/.test(s) },
  { label: "SPECIFIED", test: (s: string) => /^SPECIFIED\b/.test(s) },
  { label: "CONTRACTED", test: (s: string) => /^CONTRACTED\b/.test(s) },
  { label: "DISCOVERED", test: (s: string) => /^DISCOVERED\b/.test(s) },
] as const;

function main(): void {
  const text = readStatus();

  const standLine = text.match(/^Stand:\s*(.+)$/m)?.[1]?.trim() ?? "—";

  const schaetzung: Array<{ name: string; value: string }> = [];
  for (const match of text.matchAll(/^\|\s*(Gesamtmission[^|]*|Technisches Fundament[^|]*|Nutzerseitige[^|]*)\|\s*([^|]+)\|/gm)) {
    schaetzung.push({ name: match[1].trim(), value: match[2].trim() });
  }

  const matrix: Array<{ bereich: string; stand: string }> = [];
  for (const match of text.matchAll(/^\|\s*(F\d{1,2}\s+[^|]+?)\s*\|\s*(VERIFIED|PARTIAL VERIFIED|SPECIFIED|CONTRACTED|DISCOVERED)([^|]*)\|/gm)) {
    matrix.push({
      bereich: match[1].trim(),
      stand: match[2].startsWith("PARTIAL") ? "PARTIAL VERIFIED" : match[2],
    });
  }

  const histogram = new Map<string, number>();
  let teilabgenommen = 0;
  for (const row of matrix) {
    const kategorie = KATEGORIEN.find((k) => k.test(row.stand))?.label ?? "SONSTIGES";
    histogram.set(kategorie, (histogram.get(kategorie) ?? 0) + 1);
    if (kategorie === "VERIFIED" || kategorie === "PARTIAL VERIFIED") teilabgenommen += 1;
  }

  // Abschnitte sind NICHT durchgehend chronologisch sortiert (neue Blöcke
  // werden oben eingefügt). Deshalb: Datum/Uhrzeit parsen und das Maximum
  // wählen; Überschriften ohne Uhrzeit gelten als 00:00 desselben Tages.
  const abschnitte = [...text.matchAll(/^## (2026-\d{2}-\d{2})(?: \((\d{2}:\d{2})\))?[^\n]*$/gm)]
    .map((match) => ({
      titel: match[0].replace(/^## /, "").trim(),
      schluessel: `${match[1]}T${match[2] ?? "00:00"}`,
    }));
  const letzterAbschnitt = abschnitte
    .reduce((max, eintrag) => (eintrag.schluessel > max.schluessel ? eintrag : max),
      { titel: "—", schluessel: "" }).titel;

  console.log("PARITY-STAND (mechanisch; Prozentwerte = ESTIMATE, keine 1:1-Paritätsaussage)");
  console.log("─".repeat(72));
  console.log(`Repo:        ${headShort()} (${branchName()})`);
  const migration = migrationInfo();
  console.log(`Migrationen: ${migration.count} Einträge im Journal, letzte: ${migration.lastTag}`);
  console.log(`STATUS.md:   Stand ${standLine}`);
  console.log(`Letzter Abschnitt: ${letzterAbschnitt}`);
  console.log();
  console.log("Schätzung (wörtlich aus STATUS.md):");
  for (const row of schaetzung) {
    console.log(`  ${row.name}: ${row.value}`);
  }
  console.log();
  console.log("F1–F16-Matrix (mechanisch gezählt):");
  const kategorien = KATEGORIEN.map((k) => k.label).filter((label) => histogram.has(label));
  for (const label of kategorien) {
    console.log(`  ${label.padEnd(18)} ${histogram.get(label)}/${matrix.length}`);
  }
  const fraktion = matrix.length > 0 ? Math.round((teilabgenommen / matrix.length) * 100) : 0;
  console.log(
    `  Teilabgenommen (VERIFIED/PARTIAL): ${teilabgenommen}/${matrix.length} = ${fraktion} % der Bereiche (ESTIMATE, bereichsbezogen)`,
  );
  if (matrix.length === 0) {
    console.log("  WARNUNG: keine F1–F16-Matrixzeilen gefunden — Datei prüfen.");
  }
  console.log();
  console.log(
    "Hinweis: Kanonisch ist docs/parity/STATUS.md auf dem tooling-Branch;",
  );
  console.log(
    "auf Lanes kann diese Kopie veraltet sein. Quote steigt nur mit VERIFIED-Slices.",
  );
}

main();
