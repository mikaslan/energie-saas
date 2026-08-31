import { describe, expect, it } from "vitest";

import {
  expectedCatalogImportPageSize,
  nextCatalogImportAfterRow,
  parseCatalogImportAfterRow,
  previousCatalogImportAfterRow,
} from "@/app/w/[workspaceId]/katalog/importe/[importId]/pagination";

describe("M108B catalog import detail pagination", () => {
  it("akzeptiert ausschließlich kanonische 100er-Cursor", () => {
    expect(parseCatalogImportAfterRow(undefined)).toBe(1);
    for (const cursor of ["1", "101", "201", "301", "401", "501", "601", "701", "801", "901"]) {
      expect(parseCatalogImportAfterRow(cursor)).toBe(Number(cursor));
    }
    for (const cursor of ["0", "2", "001", "1001", ["1", "101"]]) {
      expect(parseCatalogImportAfterRow(cursor)).toBeNull();
    }
  });

  it("vermeidet eine leere Folgeseite bei exakt vollen Seiten", () => {
    expect(expectedCatalogImportPageSize(100, 1)).toBe(100);
    expect(nextCatalogImportAfterRow(100, 101)).toBeNull();
    expect(nextCatalogImportAfterRow(101, 101)).toBe(101);
    expect(expectedCatalogImportPageSize(101, 101)).toBe(1);
    expect(nextCatalogImportAfterRow(1_000, 1_001)).toBeNull();
  });

  it("navigiert höchstens eine Seite rückwärts", () => {
    expect(previousCatalogImportAfterRow(1)).toBeNull();
    expect(previousCatalogImportAfterRow(101)).toBe(1);
    expect(previousCatalogImportAfterRow(901)).toBe(801);
  });
});
