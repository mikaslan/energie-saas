import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SERVICE_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../modules/energy/service.ts"),
  "utf8",
);

function exportedFunctionSource(name: string, nextExport: string): string {
  const start = SERVICE_SOURCE.indexOf(`export async function ${name}(`);
  const end = SERVICE_SOURCE.indexOf(`export async function ${nextExport}(`, start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`Servicegrenze ${name} konnte nicht isoliert werden.`);
  }
  return SERVICE_SOURCE.slice(start, end);
}

describe("M1-07 Project-Energy-Read Source-Vertrag", () => {
  it("startet auf einem TenantTx keine konkurrierenden Queries", () => {
    const readSource = exportedFunctionSource(
      "getProjectEnergyContext",
      "confirmProjectEnergyProfile",
    );

    expect(readSource).not.toMatch(/\bPromise\.all\s*\(/);
  });
});
