import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderCatalogCsvImportJsonSchema } from
  "@/lib/integrations/catalog/import-contract";

const root = resolve(import.meta.dirname, "..");
const path = resolve(root, "contracts/catalog-csv-import.v1.schema.json");
const rendered = renderCatalogCsvImportJsonSchema();
const mode = process.argv[2] ?? "--check";

if (mode === "--write") {
  writeFileSync(path, rendered, "utf8");
} else if (mode === "--check") {
  if (readFileSync(path, "utf8") !== rendered) {
    throw new Error("catalog-csv-import.v1.schema.json ist nicht aus dem Runtime-Schema erzeugt.");
  }
} else {
  throw new Error("Erlaubt sind --check oder --write.");
}

process.stdout.write(
  `${createHash("sha256").update(rendered).digest("hex")}  contracts/catalog-csv-import.v1.schema.json\n`,
);
