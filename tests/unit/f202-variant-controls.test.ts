import { describe, expect, it } from "vitest";
import {
  formatCentsToEuroInput,
  parseBundlesJsonInput,
  parseEuroCentsInput,
} from "@/lib/integrations/offers/variant-controls";

describe("F2.2 Varianten-Steuerung (reine Ein-/Ausgabe-Helfer)", () => {
  it("parst Euro mit Komma und Punkt nach Cent", () => {
    expect(parseEuroCentsInput("12,50")).toBe(1250);
    expect(parseEuroCentsInput("12.50")).toBe(1250);
    expect(parseEuroCentsInput("12,5")).toBe(1250);
    expect(parseEuroCentsInput("0")).toBe(0);
    expect(parseEuroCentsInput(" 9800 ")).toBe(980000);
  });

  it("weist ungültige oder zu große Euro-Beträge ab", () => {
    expect(parseEuroCentsInput("12,555")).toBeNull();
    expect(parseEuroCentsInput("-1")).toBeNull();
    expect(parseEuroCentsInput("zwölf")).toBeNull();
    expect(parseEuroCentsInput("")).toBeNull();
    expect(parseEuroCentsInput("90000000000001")).toBeNull();
  });

  it("formatiert Cent deutsch ohne überflüssige Nachkommastellen", () => {
    expect(formatCentsToEuroInput(1250)).toBe("12,50");
    expect(formatCentsToEuroInput(1200)).toBe("12");
    expect(formatCentsToEuroInput(0)).toBe("0");
    expect(formatCentsToEuroInput(null)).toBe("");
  });

  it("parst Bundle-JSON strikt nach Vertrag", () => {
    expect(parseBundlesJsonInput("[]")).toEqual([]);
    expect(parseBundlesJsonInput(
      JSON.stringify([{ name: "Wallbox", position: 0 }]),
    )).toEqual([{ name: "Wallbox", position: 0 }]);
  });

  it("weist kaputte Bundle-Listen ab", () => {
    expect(parseBundlesJsonInput("kein-json")).toBeNull();
    expect(parseBundlesJsonInput(JSON.stringify({ name: "x" }))).toBeNull();
    expect(parseBundlesJsonInput(JSON.stringify([
      { name: "A", position: 0 },
      { name: "B", position: 0 },
    ]))).toBeNull();
    expect(parseBundlesJsonInput(JSON.stringify(
      Array.from({ length: 51 }, (_, index) => ({ name: `B${index}`, position: index })),
    ))).toBeNull();
  });
});
