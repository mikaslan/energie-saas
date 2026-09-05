import { describe, expect, it } from "vitest";
import type { OfferPdfDraftInputV1 } from "@/lib/integrations/offers/pdf-contract";
import { renderOfferPdfDraftHtml } from "@/lib/integrations/offers/pdf-template";

function inputFixture(lineCount = 3): OfferPdfDraftInputV1 {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    position: index + 1,
    title: index === 0
      ? "Montage <script>alert('x')</script> & Inbetriebnahme"
      : `Sehr lange Position ${index + 1} ${"Wort".repeat(index === lineCount - 1 ? 25 : 1)}`,
    description: index === 0
      ? "Nur Text: <img src=https://evil.invalid/x onerror=alert(1)> & url(https://evil.invalid)"
      : null,
    quantityMilli: index === 1 ? 2_500 : 1_000,
    unit: index === 1 ? "meter" as const : "piece" as const,
    positionType: index === 2 ? "optional" as const
      : index === 1 ? "additional" as const : "required" as const,
    isHidden: index === lineCount - 1 && lineCount > 3,
    salesUnitNetCents: index === 2 ? 20_000 : 10_000,
    lineDiscountBps: index === 0 ? 500 : 0,
    taxRateBps: index === 1 ? 0 as const : 1_900 as const,
    finalNetCents: index === 2 ? 20_000 : 10_000,
    taxCents: index === 1 ? 0 : index === 2 ? 3_800 : 1_900,
    grossCents: index === 1 ? 10_000 : index === 2 ? 23_800 : 11_900,
  }));
  const basisLines = lines.filter((line) => line.positionType !== "optional");
  const optionalLines = lines.filter((line) => line.positionType === "optional");
  const total = (values: typeof lines, field: "finalNetCents" | "taxCents" | "grossCents") =>
    values.reduce((sum, line) => sum + line[field], 0);
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    recipient: { displayName: "Mia & Max <Muster>" },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: {
      name: "Komfort & Autarkie",
      revision: 7,
    },
    commercialTerms: { globalDiscountBps: 250, globalDiscountCapCents: null, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{ position: 1, title: "PV-Anlage & Zubehör", discountBps: 100, lines }],
    totals: {
      basisNetCents: total(basisLines, "finalNetCents"),
      basisTaxCents: total(basisLines, "taxCents"),
      basisGrossCents: total(basisLines, "grossCents"),
      optionalNetCents: total(optionalLines, "finalNetCents"),
      optionalTaxCents: total(optionalLines, "taxCents"),
      optionalGrossCents: total(optionalLines, "grossCents"),
    },
  };
}

describe("offer PDF draft HTML template", () => {
  it("rendert deterministisches semantisches A4-HTML mit dauerhaftem Draft-Marker", () => {
    const input = inputFixture();
    const first = renderOfferPdfDraftHtml(input);
    const second = renderOfferPdfDraftHtml(structuredClone(input));

    expect(first).toBe(second);
    expect(first).toMatch(/^<!doctype html>/u);
    expect(first).toContain('<html lang="de">');
    expect(first).toContain("<header");
    expect(first).toContain("<main");
    expect(first).toContain("<table");
    expect(first).toContain("<thead>");
    expect(first).toContain('scope="col"');
    expect(first).toContain("<footer");
    expect(first).toContain("@page { size: A4;");
    expect(first).toContain('@top-center { content: "Interner Angebotsentwurf');
    expect(first).toContain('@bottom-left { content: "ANG-2026-000042 · Revision 7');
    expect(first).toContain('@bottom-right { content: "Seite " counter(page) " von " counter(pages);');
    expect(first).toContain("thead { display: table-header-group; }");
    expect(first).toMatch(/tr \{[^}]*break-inside: avoid/u);
    expect(first).not.toContain("position: fixed");
    expect(first.match(/Interner Angebotsentwurf · nicht versendet · nicht verbindlich/gu)?.length)
      .toBeGreaterThanOrEqual(2);
  });

  it("kollabiert layoutfeindliche Zeilenumbrüche statt eine Position über Seiten zu ziehen", () => {
    const input = inputFixture(1);
    input.sections[0]!.lines[0]!.description = `Anfang${"\n".repeat(450)}Ende`;
    const html = renderOfferPdfDraftHtml(input);

    expect(html).toContain("Anfang Ende");
    expect(html).not.toContain("white-space: pre-wrap");
  });

  it("escaped alle Nutztexte und erzeugt weder Remote-Assets noch aktiven Inhalt", () => {
    const html = renderOfferPdfDraftHtml(inputFixture());

    expect(html).toContain("Mia &amp; Max &lt;Muster&gt;");
    expect(html).toContain("Montage &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; Inbetriebnahme");
    expect(html).toContain("&lt;img src=https://evil.invalid/x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<script[\s>]/iu);
    expect(html).not.toMatch(/<(?:img|link|iframe|object|embed|video|audio|source)\b/iu);
    const markupOnly = html.match(/<[^>]*>/gu)?.join("\n") ?? "";
    expect(markupOnly).not.toMatch(/\s(?:src|href)\s*=/iu);
    expect(html).toContain("default-src &#39;none&#39;");
  });

  it("trennt optionale Positionen und weist Positionstyp, 19/0 Prozent und Summen aus", () => {
    const html = renderOfferPdfDraftHtml(inputFixture());
    const baseStart = html.indexOf("Im Entwurf enthaltener Basisumfang");
    const optionalStart = html.indexOf("Optionale Positionen");
    const optionalLine = html.indexOf("Sehr lange Position 3");

    expect(baseStart).toBeGreaterThan(-1);
    expect(optionalStart).toBeGreaterThan(baseStart);
    expect(optionalLine).toBeGreaterThan(optionalStart);
    expect(html).toContain("Erforderlich");
    expect(html).toContain("Zusätzlich");
    expect(html).toContain("Optional");
    expect(html).toContain("19&nbsp;%");
    expect(html).toContain("0&nbsp;%");
    expect(html).toContain("Steueranteil 19&nbsp;%");
    expect(html).toContain("Steueranteil 0&nbsp;%");
    expect(html).toContain("Globaler Rabatt");
    expect(html).toContain("2,50&nbsp;%");
    expect(html).toContain("Basis brutto");
    expect(html).toContain("219,00&nbsp;€");
    expect(html).toContain("Optionen brutto");
    expect(html).toContain("238,00&nbsp;€");
    expect(html).toContain("nicht in der Basissumme enthalten");
  });

  it("rendert 500 lange Tabellenzeilen vollständig mit Seitenbruchschutz", () => {
    const html = renderOfferPdfDraftHtml(inputFixture(500));

    expect(html.match(/data-offer-line=/gu)).toHaveLength(500);
    expect(html).toContain("Sehr lange Position 500");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("page-break-inside: avoid");
    expect(html).toContain("table-layout: fixed");
    expect(html).toContain("Intern ausgeblendet");
    expect(html).toContain("nicht für späteres Kundendokument freigegeben");
  });

  it("verweigert zur Laufzeit einen typumgangenen unbekannten Renderinput", () => {
    const invalid = { ...inputFixture(), workspaceId: "private" } as OfferPdfDraftInputV1;
    expect(() => renderOfferPdfDraftHtml(invalid)).toThrow(/PDF-Dokumentinput/u);
  });
});
