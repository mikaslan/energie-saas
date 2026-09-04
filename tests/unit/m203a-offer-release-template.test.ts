import { describe, expect, it } from "vitest";

import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import { renderOfferReleaseCandidateHtml } from "@/lib/integrations/offers/release-template";

function inputFixture(lineCount = 3): OfferReleaseCandidateInputV1 {
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
    positionType: index === 2
      ? "optional" as const
      : index === 1
        ? "additional" as const
        : "required" as const,
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
    schemaVersion: "offer-release-candidate-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-release-candidate-template.v1",
    rendererRecipeVersion: "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: {
      name: "Synthetisches Angebotsprofil <Freigabe>",
      revision: 4,
    },
    sender: {
      legalName: "Beispiel Energie GmbH <Test>",
      tradingName: "Beispiel Energie",
      representedBy: "Mia Musterfrau & Max Mustermann",
      address: {
        street: "Sonnenstraße",
        houseNumber: "12 <A>",
        postalCode: "10115",
        city: "Berlin & Mitte",
        country: "DE",
      },
      contactEmail: "angebot@beispiel.invalid",
      contactPhone: "+49301234567",
      website: "https://angebot.beispiel.invalid",
      registerCourt: "Amtsgericht Berlin-Charlottenburg",
      registerNumber: "HRB 123456 B",
      vatId: "DE123456789",
    },
    recipient: {
      displayName: "Mia & Max <Muster>",
      company: "Musterhaus & Partner GbR",
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "7 & 8",
        postalCode: "10117",
        city: "Berlin <Zentrum>",
        country: "DE",
        formattedAddress: "Rechnungsweg 7 & 8, 10117 Berlin <Zentrum>",
      },
    },
    installationSite: {
      formattedAddress: "Solstraße 8, 10115 Berlin",
    },
    variant: {
      name: "Komfort & Autarkie <Plus>",
      revision: 7,
    },
    commercialTerms: {
      globalDiscountBps: 250,
      globalFixDiscountCents: null,
      customDealNetCents: null,
    },
    sections: [{
      position: 1,
      title: "PV-Anlage & Zubehör <Süd>",
      discountBps: 100,
      lines,
    }],
    totals: {
      basisNetCents: total(basisLines, "finalNetCents"),
      basisTaxCents: total(basisLines, "taxCents"),
      basisGrossCents: total(basisLines, "grossCents"),
      optionalNetCents: total(optionalLines, "finalNetCents"),
      optionalTaxCents: total(optionalLines, "taxCents"),
      optionalGrossCents: total(optionalLines, "grossCents"),
    },
    legalDocuments: {
      terms: {
        title: "Allgemeine Geschäftsbedingungen & Hinweise",
        plainText: "1. Nur Text <script>alert(1)</script>\n2. Bedingungen für die Ausführung.",
      },
      withdrawalInformation: {
        title: "Widerrufsinformation",
        plainText: "Information über ein mögliches Widerrufsrecht.\nMusterkontakt: recht@beispiel.invalid",
      },
      privacyNotice: {
        title: "Datenschutzhinweise",
        plainText: "Personenbezogene Daten werden nur zweckgebunden verarbeitet.",
      },
    },
  };
}

function fiveHundredLineFixture(): OfferReleaseCandidateInputV1 {
  const input = inputFixture(1);
  input.sections[0]!.lines = Array.from({ length: 500 }, (_, index) => ({
    position: index + 1,
    title: `Leistungsposition ${index + 1} ${"Belastungstest".repeat(8)}`,
    description: index % 2 === 0
      ? `Technische Beschreibung ${index + 1} ${"mit langem Inhalt ".repeat(10)}`
      : null,
    quantityMilli: 1_000,
    unit: "piece" as const,
    positionType: "required" as const,
    salesUnitNetCents: 100,
    lineDiscountBps: 0,
    taxRateBps: 1_900 as const,
    finalNetCents: 100,
    taxCents: 19,
    grossCents: 119,
  }));
  input.totals = {
    basisNetCents: 50_000,
    basisTaxCents: 9_500,
    basisGrossCents: 59_500,
    optionalNetCents: 0,
    optionalTaxCents: 0,
    optionalGrossCents: 0,
  };
  return input;
}

describe("offer release candidate HTML template", () => {
  it("rendert deterministisches semantisches A4-HTML mit festem Status auf jeder Seite", () => {
    const input = inputFixture();
    const first = renderOfferReleaseCandidateHtml(input);
    const second = renderOfferReleaseCandidateHtml(structuredClone(input));

    expect(first).toBe(second);
    expect(first).toMatch(/^<!doctype html>/u);
    expect(first).toContain('<html lang="de">');
    expect(first).toContain("@page { size: A4;");
    expect(first).toMatch(/\.page-status \{[^}]*position: fixed/gu);
    expect(first).toMatch(/\.page-footer \{[^}]*position: fixed/gu);
    expect(first).toContain("thead { display: table-header-group; }");
    expect(first).toMatch(/tr \{[^}]*break-inside: avoid/u);
    expect(first.match(/Freigabekandidat · nicht ausgestellt · nicht versendet/gu)?.length)
      .toBeGreaterThanOrEqual(3);
    expect(first).not.toMatch(/interner Angebotsentwurf/iu);
    expect(first).not.toMatch(/Reonic/iu);
  });

  it("trennt Aussteller, Empfänger, Rechnungsadresse und Anlagenstandort sichtbar", () => {
    const html = renderOfferReleaseCandidateHtml(inputFixture());
    const senderIndex = html.indexOf("Aussteller");
    const recipientIndex = html.indexOf("Empfänger und Rechnungsadresse");
    const siteIndex = html.indexOf("Anlagenstandort");

    expect(senderIndex).toBeGreaterThan(-1);
    expect(recipientIndex).toBeGreaterThan(senderIndex);
    expect(siteIndex).toBeGreaterThan(recipientIndex);
    expect(html).toContain("Beispiel Energie GmbH &lt;Test&gt;");
    expect(html).toContain("Mia &amp; Max &lt;Muster&gt;");
    expect(html).toContain("Rechnungsweg 7 &amp; 8, 10117 Berlin &lt;Zentrum&gt;");
    expect(html).toContain("Solstraße 8, 10115 Berlin");
    expect(html).toContain("ANG-2026-000042");
    expect(html).toContain("Komfort &amp; Autarkie &lt;Plus&gt;");
    expect(html).toContain("29.09.2026");
  });

  it("escaped sämtliche Vertragsdaten und bindet keine Ressourcen, URLs oder Skripte ein", () => {
    const html = renderOfferReleaseCandidateHtml(inputFixture());

    expect(html).toContain("Montage &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; Inbetriebnahme");
    expect(html).toContain("&lt;img src=https://evil.invalid/x onerror=alert(1)&gt;");
    expect(html).toContain("Nur Text &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script[\s>]/iu);
    expect(html).not.toMatch(/<(?:a|img|link|iframe|object|embed|video|audio|source)\b/iu);
    const markupOnly = html.match(/<[^>]*>/gu)?.join("\n") ?? "";
    expect(markupOnly).not.toMatch(/\s(?:src|href)\s*=/iu);
    const style = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
    expect(style).not.toMatch(/url\s*\(/iu);
    expect(html).toContain("default-src &#39;none&#39;");
  });

  it("trennt Basis- und Optionsleistungen und weist Preise, Steuer und Konditionen aus", () => {
    const html = renderOfferReleaseCandidateHtml(inputFixture());
    const baseStart = html.indexOf("Basisleistungen");
    const optionalStart = html.indexOf("Optionale Leistungen");
    const optionalLine = html.indexOf("Sehr lange Position 3");

    expect(baseStart).toBeGreaterThan(-1);
    expect(optionalStart).toBeGreaterThan(baseStart);
    expect(optionalLine).toBeGreaterThan(optionalStart);
    expect(html).toContain("Erforderlich");
    expect(html).toContain("Zusätzlich");
    expect(html).toContain("Optional");
    expect(html).toContain("19&nbsp;%");
    expect(html).toContain("0&nbsp;%");
    expect(html).toContain("Globaler Rabatt");
    expect(html).toContain("2,50&nbsp;%");
    expect(html).toContain("Basis brutto");
    expect(html).toContain("219,00&nbsp;€");
    expect(html).toContain("Optionen brutto");
    expect(html).toContain("238,00&nbsp;€");
    expect(html).toContain("nicht in der Basissumme enthalten");
  });

  it("rendert sämtliche versionierten Rechtstexte als reinen, umbruchfähigen Text", () => {
    const html = renderOfferReleaseCandidateHtml(inputFixture());

    expect(html).toContain("Rechtliche Dokumente");
    expect(html).toContain("Allgemeine Geschäftsbedingungen &amp; Hinweise");
    expect(html).toContain("Widerrufsinformation");
    expect(html).toContain("Datenschutzhinweise");
    expect(html).toContain("white-space: pre-line");
    expect(html).toMatch(/\.legal-document \{[^}]*overflow-wrap: anywhere/u);
  });

  it("rendert 500 lange Tabellenzeilen vollständig und mehrseitentauglich", () => {
    const html = renderOfferReleaseCandidateHtml(fiveHundredLineFixture());

    expect(html.match(/data-offer-line=/gu)).toHaveLength(500);
    expect(html).toContain("Leistungsposition 500");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("page-break-inside: avoid");
    expect(html).toContain("table-layout: fixed");
  });

  it("verweigert einen typumgangenen unbekannten oder inkonsistenten Renderinput", () => {
    const unknownField = {
      ...inputFixture(),
      workspaceId: "private",
    } as OfferReleaseCandidateInputV1;
    const inconsistent = structuredClone(inputFixture());
    inconsistent.totals.basisGrossCents += 1;

    expect(() => renderOfferReleaseCandidateHtml(unknownField))
      .toThrow(/Freigabekandidaten-Dokumentinput/u);
    expect(() => renderOfferReleaseCandidateHtml(inconsistent))
      .toThrow(/Freigabekandidaten-Dokumentinput/u);
  });
});
