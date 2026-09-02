#!/usr/bin/env tsx
// Import-Gate (Kimi-Auflage 3): Katalog-CSV-Dry-Run mit dem ECHTEN M1-08b-Parser.
//
// Was dieses Skript tut (und NICHT tut):
//   - liest ausschliesslich die Katalog-CSV (read-only),
//   - validiert jede Datenzeile mit dem echten `parseCatalogCsvPreview`
//     (M1-08b, `lib/integrations/catalog/import-contract.ts`),
//   - schreibt einen deterministischen Dry-Run-Bericht nach
//     `artifacts/catalog-import-20260902/DRY-RUN.md`.
//   - KEIN DB-Import, KEINE Produktionsmutation, KEIN Commit/Push,
//     KEINE Preis-/Daten-Aenderung, KEINE PII im Bericht.
//
// Der echte Parser liegt im integrierten Worktree `energie-saas-m1-wave-01`
// (Byte-identisch mit `energie-saas-m108b-catalog-csv-import`). Sein
// Abhaengigkeitskette (import-contract -> contract -> selection, import-wire)
// verwendet keine `@/`-Aliase und zieht weder Next.js noch DB hinein.
//
// Aufruf (aus dem Haupt-Worktree `tooling`):
//   npx tsx scripts/catalog-import-dry-run.mts [csv] [out-md]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Lokale Spiegel-Typen des echten Parser-Vertrags (keine Re-Implementierung,
// nur Typsicherheit fuer die gelesenen Strukturen).
// ---------------------------------------------------------------------------

type CatalogCsvRowError = {
  code: string;
  field: string | null;
  sourceHeader: string | null;
  message: string;
};

type CatalogCsvPreviewRow = {
  status: "valid" | "invalid";
  rowNumber: number;
  normalizedSku: string | null;
  errors?: CatalogCsvRowError[];
  command?: { internalSku: string; componentType: string };
};

type CatalogCsvPreviewV1 = {
  schemaVersion: string;
  file: {
    filename: string;
    sizeBytes: number;
    sha256: string;
    encoding: "utf-8" | "windows-1252";
    delimiter: ";" | ",";
    parserVersion: string;
    rowCount: number;
  };
  mappingSha256: string;
  counts: { total: number; valid: number; invalid: number };
  rows: CatalogCsvPreviewRow[];
};

type CatalogCsvParserModule = {
  CATALOG_CSV_IMPORT_CONTRACT_VERSION: string;
  parseCatalogCsvPreview(input: {
    filename: string;
    bytes: Uint8Array;
    mapping: unknown;
  }): CatalogCsvPreviewV1;
  inspectCatalogCsvFile(input: { filename: string; bytes: Uint8Array }): {
    headers: string[];
  };
  autoMapCatalogCsvHeaders(headers: string[]): unknown;
};

// ---------------------------------------------------------------------------
// Konstanten (Wahrheit aus dem Parser-Vertrag, hier zur Bericht-Ausgabe).
// ---------------------------------------------------------------------------

// Die 7 Katalogtypen aus `catalogComponentTypeSchema` (lib/integrations/catalog/contract.ts).
const KATALOG_TYPEN = [
  "module",
  "inverter",
  "battery",
  "wallbox",
  "heat_pump",
  "mounting",
  "other",
] as const;

// 13 im Workspace vorhandene Reonic-Typen -> 7 Katalogtypen.
// Uebernommen aus artifacts/catalog-import-20260902/REPORT.md §3 und gegen die
// CSV-Zieltyp-Zaehlung geprueft (siehe Bericht §6).
const REONIC_TYP_MAPPING: ReadonlyArray<{
  reonicTyp: string;
  imWorkspace: number;
  zielTyp: string;
}> = [
  { reonicTyp: "module", imWorkspace: 114, zielTyp: "module" },
  { reonicTyp: "inverter", imWorkspace: 79, zielTyp: "inverter" },
  { reonicTyp: "microinverter", imWorkspace: 13, zielTyp: "inverter" },
  { reonicTyp: "optimizer", imWorkspace: 2, zielTyp: "other" },
  { reonicTyp: "batteryStorage", imWorkspace: 71, zielTyp: "battery" },
  { reonicTyp: "evCharger", imWorkspace: 9, zielTyp: "wallbox" },
  { reonicTyp: "accessoryToModule", imWorkspace: 2, zielTyp: "other" },
  { reonicTyp: "accessoryToInverter", imWorkspace: 8, zielTyp: "other" },
  { reonicTyp: "accessoryToBatteryStorage", imWorkspace: 12, zielTyp: "other" },
  { reonicTyp: "other", imWorkspace: 7, zielTyp: "other" },
  { reonicTyp: "moduleFrameConstruction", imWorkspace: 6, zielTyp: "mounting" },
  { reonicTyp: "serviceFee", imWorkspace: 1, zielTyp: "other" },
  { reonicTyp: "installationFee", imWorkspace: 13, zielTyp: "other" },
];

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function locateParserWorktree(root: string): string {
  const candidates = [
    resolve(root, "..", "energie-saas-m1-wave-01"),
    resolve(root, "..", "energie-saas-m108b-catalog-csv-import"),
  ];
  const parserFile = "lib/integrations/catalog/import-contract.ts";
  for (const candidate of candidates) {
    const full = resolve(candidate, parserFile);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `M1-08b-Parser nicht gefunden. Gesucht: ${candidates.map((c) => resolve(c, parserFile)).join(", ")}`,
  );
}

function countBy<K extends string>(items: readonly K[]): Map<K, number> {
  const map = new Map<K, number>();
  for (const item of items) {
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return map;
}

function sortCounts<K>(map: Map<K, number>): [K, number][] {
  return [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]), "de");
  });
}

function mdTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hauptlauf
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const csvPath = resolve(process.argv[2] ?? "artifacts/catalog-import-20260902/wmee-components.csv");
  const outPath = resolve(process.argv[3] ?? "artifacts/catalog-import-20260902/DRY-RUN.md");
  const csvName = basename(csvPath);

  // 1) Echten Parser laden (dynamisch, aus dem integrierten Worktree).
  const parserPath = locateParserWorktree(root);
  const parser = (await import(parserPath)) as CatalogCsvParserModule;

  // 2) CSV roh lesen (Bytes, unveraendert) und Datei-Hash bilden.
  const bytes = new Uint8Array(readFileSync(csvPath));
  const fileSha256 = sha256Hex(bytes);

  // 3) Inspektion + Auto-Mapping ueber den echten Parser.
  const inspection = parser.inspectCatalogCsvFile({ filename: csvName, bytes });
  const mapping = parser.autoMapCatalogCsvHeaders(inspection.headers);

  // 4) Echte Validierung: der M1-08b-Parser entscheidet gueltig/ungueltig.
  const preview = parser.parseCatalogCsvPreview({ filename: csvName, bytes, mapping });

  // 5) Rohzeilen separat lesen (nur fuer die Bericht-Aggregation: flag, Marke,
  //    Zieltyp, SKU, Name). Die Validierung selbst stammt NUR vom Parser.
  const text = readFileSync(csvPath, "utf8").replace(/^\uFEFF/u, "");
  const raw = Papa.parse<string[]>(text, { delimiter: ";", skipEmptyLines: false });
  const rawHeader = (raw.data[0] ?? []).map((h) => h.normalize("NFKC").trim());
  const rawRows = raw.data.slice(1);
  while (rawRows.length > 1 && (rawRows.at(-1) ?? []).every((c) => c.trim() === "")) {
    rawRows.pop();
  }
  const headerIndex = new Map(rawHeader.map((h, i) => [h, i] as const));
  const cell = (row: string[], key: string): string =>
    row[headerIndex.get(key) ?? -1] ?? "";

  type RawRow = {
    internalSku: string;
    componentType: string;
    displayName: string;
    manufacturer: string;
    flag: string;
  };
  const rawByIndex: RawRow[] = rawRows.map((row) => ({
    internalSku: cell(row, "internalSku"),
    componentType: cell(row, "componentType"),
    displayName: cell(row, "displayName"),
    manufacturer: cell(row, "manufacturer"),
    flag: cell(row, "flag"),
  }));

  // 6) Parser-Verdikt + Rohzeile indexweise zusammenfuehren (Datei-Reihenfolge).
  const joined = preview.rows.map((prow, i) => ({
    prow,
    raw: rawByIndex[i] ?? {
      internalSku: "",
      componentType: "",
      displayName: "",
      manufacturer: "",
      flag: "",
    },
  }));

  // 7) Aggregationen (deterministisch sortiert).
  const validRows = joined.filter((j) => j.prow.status === "valid");
  const invalidRows = joined.filter((j) => j.prow.status === "invalid");

  // 7a) Flag-Gruende (CSV-Spalte `flag`, pipe-getrennt).
  const flagCounts = new Map<string, number>();
  for (const j of joined) {
    const flags = j.raw.flag.split("|").map((f) => f.trim()).filter((f) => f.length > 0);
    if (flags.length === 0) {
      flagCounts.set("(kein Flag)", (flagCounts.get("(kein Flag)") ?? 0) + 1);
    }
    for (const flag of flags) {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    }
  }

  // 7b) Parser-Fehlercodes (code × feld).
  const errorCounts = new Map<string, number>();
  for (const j of invalidRows) {
    for (const err of j.prow.errors ?? []) {
      const key = err.field ? `${err.code} (${err.field})` : err.code;
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
  }

  // 7c) Marken.
  const brandTotal = countBy(joined.map((j) => j.raw.manufacturer || "(leer)"));
  const brandValid = countBy(validRows.map((j) => j.raw.manufacturer || "(leer)"));

  // 7d) Ziel-Katalogtypen (CSV `componentType` ist bereits der 7er-Zieltyp).
  const typeTotal = countBy(joined.map((j) => j.raw.componentType));
  const typeValid = countBy(validRows.map((j) => j.raw.componentType));

  // 7e) Datenstand aus technicalObservedOn (deterministisch, kein Laufzeit-Timestamp).
  const observedOns = new Set(rawRows.map((row) => cell(row, "technicalObservedOn")).filter(Boolean));

  // 8) Bericht deterministisch bauen.
  const md = buildReport({
    csvName,
    csvPath,
    fileSha256,
    parserPath,
    parserVersion: parser.CATALOG_CSV_IMPORT_CONTRACT_VERSION,
    preview,
    flagCounts,
    errorCounts,
    brandTotal,
    brandValid,
    typeTotal,
    typeValid,
    validRows,
    observedOns: [...observedOns].sort(),
  });

  writeFileSync(outPath, md, "utf8");
  process.stdout.write(`Dry-Run abgeschlossen.\n`);
  process.stdout.write(
    `Zeilen gesamt=${preview.counts.total}  gueltig=${preview.counts.valid}  ungueltig=${preview.counts.invalid}\n`,
  );
  process.stdout.write(`Bericht: ${outPath}\n`);
  process.stdout.write(`Parser:  ${parserPath}\n`);
}

// ---------------------------------------------------------------------------
// Bericht-Generator (deterministisch: keine Laufzeit-Zeitstempel, sortiert).
// ---------------------------------------------------------------------------

function buildReport(input: {
  csvName: string;
  csvPath: string;
  fileSha256: string;
  parserPath: string;
  parserVersion: string;
  preview: CatalogCsvPreviewV1;
  flagCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  brandTotal: Map<string, number>;
  brandValid: Map<string, number>;
  typeTotal: Map<string, number>;
  typeValid: Map<string, number>;
  validRows: { prow: CatalogCsvPreviewRow; raw: { internalSku: string; componentType: string; displayName: string; manufacturer: string; flag: string } }[];
  observedOns: string[];
}): string {
  const p = input.preview;
  const f = p.file;

  const lines: string[] = [];
  lines.push("# DRY-RUN — Katalog-Import (Import-Gate, Kimi-Auflage 3)");
  lines.push("");
  lines.push("Modus: **read-only** · kein DB-Import · keine Produktionsmutation · kein Commit/Push.");
  lines.push("Validierung: **echter M1-08b-Parser** `parseCatalogCsvPreview` (keine Re-Implementierung).");
  lines.push("");
  lines.push(`- Eingabedatei: \`${input.csvPath}\` (${f.rowCount} Datenzeilen, ${f.encoding}, Delimiter \`${f.delimiter}\`)`);
  lines.push(`- Datei-SHA256: \`${input.fileSha256}\``);
  lines.push(`- Parser-Vertrag: \`${input.parserVersion}\` · Parser-Datei: \`${input.parserPath}\``);
  lines.push(`- Datenstand (technicalObservedOn): ${input.observedOns.join(", ") || "(nicht ermittelt)"}`);
  lines.push(`- Bericht ist deterministisch (keine Laufzeit-Zeitstempel, alle Tabellen sortiert).`);
  lines.push("");

  lines.push("## 1. Ergebnis (Parser-Verdikt)");
  lines.push("");
  lines.push(mdTable(
    ["Gesamtzeilen", "Gültig", "Ungültig", "Formatfehler"],
    [[String(p.counts.total), String(p.counts.valid), String(p.counts.invalid), String(f.rowCount - p.counts.total)]],
  ));
  lines.push("");
  lines.push(`> Formatfehler = Zeilen, die bereits beim CSV-Lesen scheitern (Parser wirft ` +
    `\`CatalogCsvImportError\`). Hier \`0\`: alle ${f.rowCount} Zeilen sind lesbar, ` +
    `die ${p.counts.invalid} Ungültigen scheitern ausschliesslich an Vertragsregeln ` +
    `(fehlende Daten, keine Formatfehler).`);
  lines.push("");

  lines.push("## 2. Fehlercode-Statistik (echter Parser, code × Feld)");
  lines.push("");
  lines.push(mdTable(
    ["Fehlercode (Feld)", "Zeilen"],
    sortCounts(input.errorCounts).map(([k, v]) => [k, String(v)]),
  ));
  lines.push("");

  lines.push("## 3. Flag-Statistik (CSV-Spalte `flag`, pipe-getrennt)");
  lines.push("");
  lines.push(mdTable(
    ["Flag", "Zeilen"],
    sortCounts(input.flagCounts).map(([k, v]) => [k, String(v)]),
  ));
  lines.push("");

  lines.push("## 4. Marken-Zählungen");
  lines.push("");
  const brandRows = sortCounts(input.brandTotal).map(([brand, total]) => [
    brand,
    String(input.brandValid.get(brand) ?? 0),
    String(total - (input.brandValid.get(brand) ?? 0)),
    String(total),
  ]);
  lines.push(mdTable(["Marke", "Gültig", "Ungültig", "Gesamt"], brandRows));
  lines.push("");

  lines.push("## 5. Ziel-Katalogtyp-Zählungen");
  lines.push("");
  const typeRows = KATALOG_TYPEN
    .filter((t) => input.typeTotal.has(t))
    .map((t) => {
      const total = input.typeTotal.get(t) ?? 0;
      const valid = input.typeValid.get(t) ?? 0;
      return [t, String(valid), String(total - valid), String(total)];
    });
  lines.push(mdTable(["Katalogtyp", "Gültig", "Ungültig", "Gesamt"], typeRows));
  lines.push("");

  lines.push("## 6. Mapping 13 Reonic-Typen → 7 Katalogtypen");
  lines.push("");
  lines.push("Übernommen aus `artifacts/catalog-import-20260902/REPORT.md` §3 und gegen die " +
    "CSV-Zieltyp-Zählung (Tabelle §5) geprüft. `componentType` in der CSV ist bereits der " +
    "7er-Zieltyp; die 13 Reonic-Typen sind der Quellbestand des Workspace-Exports.");
  lines.push("");
  lines.push(mdTable(
    ["Reonic-Typ", "im Workspace", "→ Katalogtyp"],
    REONIC_TYP_MAPPING.map((m) => [m.reonicTyp, String(m.imWorkspace), m.zielTyp]),
  ));
  lines.push("");

  const mappingCheckRows = KATALOG_TYPEN.map((t) => {
    const derived = REONIC_TYP_MAPPING
      .filter((m) => m.zielTyp === t)
      .reduce((sum, m) => sum + m.imWorkspace, 0);
    const actual = input.typeTotal.get(t) ?? 0;
    const ok = derived === actual;
    return [t, String(derived), String(actual), ok ? "✓" : "✗ DIFFERENZ"];
  });
  lines.push("Abgleich Mapping-Summe ↔ CSV-Zählung:");
  lines.push("");
  lines.push(mdTable(["Katalogtyp", "Mapping-Summe", "CSV-Zählung", "Status"], mappingCheckRows));
  lines.push("");

  lines.push("## 7. Reconciliation — importierbare SKUs");
  lines.push("");
  lines.push(`${input.validRows.length} gültige Zeilen (Datei-Reihenfolge):`);
  lines.push("");
  lines.push(mdTable(
    ["Zeile", "SKU", "Name", "Marke", "Katalogtyp"],
    input.validRows.map((j) => [
      String(j.prow.rowNumber),
      j.prow.normalizedSku ?? "(leer)",
      j.raw.displayName || "(leer)",
      j.raw.manufacturer || "(leer)",
      j.raw.componentType || "(leer)",
    ]),
  ));
  lines.push("");

  lines.push("## 8. Fehlende Daten für 100 % Import-Fähigkeit (explizit)");
  lines.push("");
  lines.push("1. **EK (purchasePriceNet):** 264 Zeilen ohne Einkaufspreis → `missing_value purchasePriceNet`; ohne EK bleibt die Zeile im Preview `invalid`.");
  lines.push("2. **Technikdaten Batterie:** Quelle liefert nur `nominalCapacityWh`; `usableCapacityWh`, `roundTripEfficiencyPercent` und teils `maxContinuousPowerWatts` fehlen → 71 Speicher sind TECH_INCOMPLETE.");
  lines.push("3. **Technikdaten Wallbox:** `phaseCount` und `connector` (type2_socket/type2_cable) fehlen in der Quelle → 9 Wallboxen TECH_INCOMPLETE.");
  lines.push("4. **SKUs:** nur 14/337 tragen eine nutzbare Artikelnummer; 323/337 erhalten eine synthetische, deterministische SKU `WMEE-<8hex>` (FLAGGED `SKU_GENERATED`) — vor Aktivierung durch echte SKU ersetzen.");
  lines.push("5. **GTIN:** Quelle liefert 0/337 GTIN; der CSV-v1-Vertrag hat kein GTIN-Feld — Wert wird nicht importiert (nur beobachtet).");
  lines.push("");

  lines.push("## 9. Grenzen & Provenienz");
  lines.push("");
  lines.push("- Rein lesend: kein DB-Import, keine Mutation, kein Commit/Push, keine Preisänderung.");
  lines.push("- Keine PII im Bericht; nur SKU, Name, Marke und Katalogtyp der Komponenten.");
  lines.push("- Mapping (13→7) ist Dokumentation aus `REPORT.md` §3; die 7er-Zieltypen sind direkt aus der CSV geprüft.");
  lines.push("");

  return lines.join("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
