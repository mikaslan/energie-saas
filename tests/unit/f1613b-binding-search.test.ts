import { describe, expect, it } from "vitest";
import {
  normalizeBindingSearchQuery,
  PACKAGE_BINDING_SEARCH_LIMIT,
  PACKAGE_BINDING_SEARCH_MAX,
  PACKAGE_BINDING_SEARCH_MIN,
} from "@/lib/integrations/offers/package-contract";

describe("F16-13b Picker-Suchtext", () => {
  it("nimmt Suchtexte ab 2 Zeichen NFKC-getrimmt an", () => {
    expect(PACKAGE_BINDING_SEARCH_MIN).toBe(2);
    expect(PACKAGE_BINDING_SEARCH_MAX).toBe(120);
    expect(PACKAGE_BINDING_SEARCH_LIMIT).toBe(50);
    expect(normalizeBindingSearchQuery("  BAT-F1613B  ")).toBe("BAT-F1613B");
    expect(normalizeBindingSearchQuery("AB")).toBe("AB");
  });

  it("lehnt zu kurze, zu lange, leere und Steuerzeichen-Texte fail-closed ab", () => {
    expect(normalizeBindingSearchQuery("")).toBeNull();
    expect(normalizeBindingSearchQuery("   ")).toBeNull();
    expect(normalizeBindingSearchQuery("A")).toBeNull();
    expect(normalizeBindingSearchQuery("x".repeat(121))).toBeNull();
    expect(normalizeBindingSearchQuery("x".repeat(120))).toBe("x".repeat(120));
    expect(normalizeBindingSearchQuery("AB\u00a0CD")).toBe("AB CD");
    expect(normalizeBindingSearchQuery("AB\u0007CD")).toBeNull();
    expect(normalizeBindingSearchQuery("AB\u200bCD")).toBeNull();
    expect(normalizeBindingSearchQuery(null)).toBeNull();
    expect(normalizeBindingSearchQuery(undefined)).toBeNull();
    expect(normalizeBindingSearchQuery(42)).toBeNull();
    expect(normalizeBindingSearchQuery(["AB"])).toBeNull();
  });
});
