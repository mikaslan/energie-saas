import { describe, expect, it } from "vitest";

import {
  applyCatalogCsvPreviewCatalogConflicts,
  autoMapCatalogCsvHeaders,
  catalogCsvPreviewRowPersistenceEnvelope,
  catalogCsvTemplate,
  inspectCatalogCsvFile,
  parseCatalogCsvPreview,
  parseCatalogImportSourceCommand,
  type CatalogCsvColumnMappingV1,
  type CatalogCsvPreviewV1,
} from "@/lib/integrations/catalog/import-contract";

function twoRowPreview(): CatalogCsvPreviewV1 {
  const [header, firstRow] = catalogCsvTemplate().trimEnd().split("\r\n");
  if (header === undefined || firstRow === undefined) throw new Error("template drifted");
  const aliasedHeader = header.replace("internalSku;", "Artikelnummer;");
  const secondRow = firstRow.replace("BEISPIEL-PV-440", "BEISPIEL-PV-441");
  const bytes = new TextEncoder().encode(
    `${aliasedHeader}\r\n${firstRow}\r\n${secondRow}\r\n`,
  );
  const inspection = inspectCatalogCsvFile({ filename: "konflikte.csv", bytes });
  const canonicalHeaders = inspection.headers.map((sourceHeader) => (
    sourceHeader === "Artikelnummer" ? "internalSku" : sourceHeader
  ));
  const automatic = autoMapCatalogCsvHeaders(canonicalHeaders);
  const mapping: CatalogCsvColumnMappingV1 = {
    ...automatic,
    columns: automatic.columns.map((entry) => entry.field === "internalSku"
      ? { ...entry, sourceHeader: "Artikelnummer" }
      : entry),
  };
  return parseCatalogCsvPreview({ filename: "konflikte.csv", bytes, mapping });
}

describe("M108B-CONTRACT-04 catalog-state preview conflicts", () => {
  it("ersetzt valide Zeilen deterministisch durch minimierte versiegelte Fehler", () => {
    const preview = twoRowPreview();
    const original = structuredClone(preview);
    const conflicts = [
      { rowNumber: 3, code: "archived_requires_manual_reactivation" as const },
      { rowNumber: 2, code: "sku_type_conflict" as const },
    ];
    const enriched = applyCatalogCsvPreviewCatalogConflicts(preview, conflicts);
    const reordered = applyCatalogCsvPreviewCatalogConflicts(preview, [...conflicts].reverse());

    expect(enriched).toEqual(reordered);
    expect(preview).toEqual(original);
    expect(enriched.counts).toEqual({ total: 2, valid: 0, invalid: 2 });
    expect(enriched.rows).toMatchObject([
      {
        status: "invalid",
        rowNumber: 2,
        normalizedSku: "BEISPIEL-PV-440",
        errors: [{
          field: "internalSku",
          sourceHeader: "Artikelnummer",
          code: "sku_type_conflict",
          message: "Die SKU kollidiert mit einem anderen Produkttyp.",
        }],
      },
      {
        status: "invalid",
        rowNumber: 3,
        normalizedSku: "BEISPIEL-PV-441",
        errors: [{
          field: "internalSku",
          sourceHeader: "Artikelnummer",
          code: "archived_requires_manual_reactivation",
          message: "Archivierte Produkte brauchen eine manuelle Reaktivierung.",
        }],
      },
    ]);
    for (const row of enriched.rows) {
      expect(catalogCsvPreviewRowPersistenceEnvelope(row).rowSha256)
        .toBe(row.rowSha256);
    }
    const serialized = JSON.stringify(enriched.rows);
    expect(serialized).not.toContain("purchasePriceNetCents");
    expect(serialized).not.toContain("Eigene autorisierte Preisliste");
    expect(serialized).not.toContain("technicalProvenance");
  });

  it("weist doppelte, unbekannte, bereits invalide und offene Konfliktcodes ab", () => {
    const preview = twoRowPreview();
    expect(() => applyCatalogCsvPreviewCatalogConflicts(preview, [
      { rowNumber: 2, code: "sku_type_conflict" },
      { rowNumber: 2, code: "sku_type_conflict" },
    ])).toThrow(TypeError);
    expect(() => applyCatalogCsvPreviewCatalogConflicts(preview, [
      { rowNumber: 99, code: "sku_type_conflict" },
    ])).toThrow(TypeError);
    const alreadyInvalid = applyCatalogCsvPreviewCatalogConflicts(preview, [
      { rowNumber: 2, code: "sku_type_conflict" },
    ]);
    expect(() => applyCatalogCsvPreviewCatalogConflicts(alreadyInvalid, [
      { rowNumber: 2, code: "sku_type_conflict" },
    ])).toThrow(TypeError);
    expect(() => applyCatalogCsvPreviewCatalogConflicts(preview, [{
      rowNumber: 2,
      code: "catalog_write_conflict",
    } as never])).toThrow();
  });

  it("parst ausschließlich den geschlossenen persistierten Quellcommand", () => {
    const row = twoRowPreview().rows[0];
    if (row?.status !== "valid") throw new Error("fixture must be valid");
    expect(parseCatalogImportSourceCommand(row.command)).toEqual(row.command);

    const mutated = (change: (value: Record<string, unknown>) => void) => {
      const command = structuredClone(row.command) as unknown as Record<string, unknown>;
      change(command);
      return command;
    };
    const invalid = [
      null,
      mutated((value) => { value.extra = true; }),
      mutated((value) => { value.commercial = null; }),
      mutated((value) => { value.componentType = "battery"; }),
      mutated((value) => {
        (value.presentation as Record<string, unknown>).unit = "set";
      }),
      mutated((value) => {
        (value.technicalProvenance as Record<string, unknown>).observedOn = "2026-02-30";
      }),
      mutated((value) => {
        (value.presentation as Record<string, unknown>).image = {
          role: "image",
          objectKey: "private/catalog.png",
        };
      }),
    ];
    for (const value of invalid) {
      expect(() => parseCatalogImportSourceCommand(value))
        .toThrow("Ungueltiger persistierter Import-Quellcommand.");
    }
  });
});
