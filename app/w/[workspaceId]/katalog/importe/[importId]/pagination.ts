export const CATALOG_IMPORT_PAGE_SIZE = 100;

const CANONICAL_AFTER_ROWS = new Set([
  "1", "101", "201", "301", "401", "501", "601", "701", "801", "901",
]);

export function parseCatalogImportAfterRow(
  value: string | string[] | undefined,
): number | null {
  const candidate = value ?? "1";
  return typeof candidate === "string" && CANONICAL_AFTER_ROWS.has(candidate)
    ? Number(candidate)
    : null;
}

export function expectedCatalogImportPageSize(
  totalCount: number,
  afterRow: number,
): number {
  return Math.min(CATALOG_IMPORT_PAGE_SIZE, Math.max(0, totalCount - (afterRow - 1)));
}

export function previousCatalogImportAfterRow(afterRow: number): number | null {
  return afterRow === 1 ? null : Math.max(1, afterRow - CATALOG_IMPORT_PAGE_SIZE);
}

export function nextCatalogImportAfterRow(
  totalCount: number,
  lastVisibleRow: number | null,
): number | null {
  return lastVisibleRow !== null && lastVisibleRow <= totalCount
    ? lastVisibleRow
    : null;
}
