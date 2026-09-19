import { describe, expect, it } from "vitest";
import {
  OFFER_PDF_CHAPTER_IDS,
  defaultOfferPdfChapterConfig,
  isDefaultOfferPdfChapterConfig,
  resolveOfferPdfBadges,
  resolveOfferPdfChapterLayout,
  validateOfferPdfChapterConfig,
  type OfferPdfChapterConfig,
  type OfferPdfChapterId,
} from "@/lib/integrations/offers/pdf-chapters";
import {
  OFFER_PDF_DRAFT_TEMPLATE_VERSION,
  type OfferPdfDraftInputV1,
} from "@/lib/integrations/offers/pdf-contract";
import { renderOfferPdfDraftHtml } from "@/lib/integrations/offers/pdf-template";

function inputFixture(): OfferPdfDraftInputV1 {
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    recipient: { displayName: "Mia Muster" },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: { name: "Basis", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalDiscountCapCents: null, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Leistungsumfang",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Position 1",
        description: null,
        quantityMilli: 1_000,
        unit: "piece",
        positionType: "required",
        isHidden: false,
        salesUnitNetCents: 100,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100,
        taxCents: 19,
        grossCents: 119,
      }],
    }],
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  };
}

function withToggles(
  overrides: Partial<Record<OfferPdfChapterId, boolean>>,
  coverVariant = 1,
): OfferPdfChapterConfig {
  const base = defaultOfferPdfChapterConfig();
  return {
    ...base,
    coverVariant,
    chapters: base.chapters.map((chapter) => ({
      ...chapter,
      enabled: overrides[chapter.id] ?? chapter.enabled,
    })),
  };
}

describe("offer PDF chapter toggles (F2.7 R1)", () => {
  it("liefert alle zehn Kapitel aktiviert in Registerreihenfolge mit Cover-Variante 1", () => {
    const config = defaultOfferPdfChapterConfig();

    expect(config.schemaVersion).toBe("offer-pdf-chapter-config.v1");
    expect(config.coverVariant).toBe(1);
    expect(config.chapters).toHaveLength(10);
    expect(config.chapters.map((chapter) => chapter.id)).toEqual([...OFFER_PDF_CHAPTER_IDS]);
    expect(config.chapters.every((chapter) => chapter.enabled)).toBe(true);
    expect(config.chapters.map((chapter) => chapter.position))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(validateOfferPdfChapterConfig(config)).toMatchObject({ ok: true });
  });

  it("sortiert das Layout nach Position und markiert die Draft-Darstellbarkeit", () => {
    const base = defaultOfferPdfChapterConfig();
    const config: OfferPdfChapterConfig = {
      ...base,
      chapters: base.chapters.map((chapter) => ({
        ...chapter,
        enabled: chapter.id !== "company" && chapter.id !== "bom",
        position: OFFER_PDF_CHAPTER_IDS.length - chapter.position + 1,
      })),
    };

    expect(validateOfferPdfChapterConfig(config).ok).toBe(true);
    const layout = resolveOfferPdfChapterLayout(config);

    expect(layout.coverVariant).toBe(1);
    expect(layout.chapters.map((chapter) => chapter.id))
      .toEqual([...OFFER_PDF_CHAPTER_IDS].reverse());
    expect(layout.chapters.find((chapter) => chapter.id === "bom"))
      .toMatchObject({ enabled: false, renderedByDraft: false });
    expect(layout.chapters.find((chapter) => chapter.id === "company"))
      .toMatchObject({ enabled: false, renderedByDraft: false });
    expect(layout.chapters.find((chapter) => chapter.id === "legal"))
      .toMatchObject({ enabled: true, renderedByDraft: true });
    expect(layout.chapters.find((chapter) => chapter.id === "economics"))
      .toMatchObject({ enabled: true, renderedByDraft: false });
  });

  it("erkennt Default-, Toggle-, Sortier- und Cover-Abweichungen", () => {
    const base = defaultOfferPdfChapterConfig();
    expect(isDefaultOfferPdfChapterConfig(base)).toBe(true);
    expect(isDefaultOfferPdfChapterConfig(withToggles({ bom: false }))).toBe(false);
    expect(isDefaultOfferPdfChapterConfig(withToggles({}, 3))).toBe(false);

    const reordered: OfferPdfChapterConfig = {
      ...base,
      chapters: base.chapters.map((chapter) => ({
        ...chapter,
        position: chapter.id === "cover" ? 2 : chapter.id === "cover_letter" ? 1 : chapter.position,
      })),
    };
    expect(validateOfferPdfChapterConfig(reordered).ok).toBe(true);
    expect(isDefaultOfferPdfChapterConfig(reordered)).toBe(false);
  });

  it("blendet per Toggle Stückliste, Prüfhinweis und Cover-Bereich aus", () => {
    const input = inputFixture();

    const withoutBom = renderOfferPdfDraftHtml(input, { chapters: withToggles({ bom: false }) });
    expect(withoutBom).not.toContain("Basissumme");
    expect(withoutBom).not.toContain("Optionale Positionen");
    expect(withoutBom).not.toContain("<table");
    expect(withoutBom).toContain("WMEE");
    expect(withoutBom).toContain("Interner Prüfhinweis");

    const withoutLegal = renderOfferPdfDraftHtml(input, { chapters: withToggles({ legal: false }) });
    expect(withoutLegal).not.toContain("Prüfhinweis");
    expect(withoutLegal).toContain("Basissumme");

    const withoutCover = renderOfferPdfDraftHtml(input, { chapters: withToggles({ cover: false }) });
    expect(withoutCover).not.toContain("WMEE");
    expect(withoutCover).not.toContain("Angebotsnummer");
    expect(withoutCover).not.toContain("Mia Muster");
    expect(withoutCover).toContain("Basissumme");
    expect(withoutCover).toContain("Angebotsentwurf");
  });

  it("meldet ehrlich, wenn alle darstellbaren Kapitel deaktiviert sind", () => {
    const html = renderOfferPdfDraftHtml(inputFixture(), {
      chapters: withToggles({ cover: false, bom: false, legal: false }),
    });

    expect(html).toContain("Alle darstellbaren Kapitel sind deaktiviert.");
    expect(html).toContain("Angebotsentwurf");
  });

  it("ignoriert dormante Folge-Kapitel im Draft-Render byte-identisch", () => {
    const input = inputFixture();
    const expected = renderOfferPdfDraftHtml(input);
    const actual = renderOfferPdfDraftHtml(structuredClone(input), {
      chapters: withToggles({ company: false, testimonial: false, economics: false }),
    });

    expect(actual).toBe(expected);
    expect(renderOfferPdfDraftHtml(input, { chapters: defaultOfferPdfChapterConfig() })).toBe(expected);
    expect(expected).not.toContain("data-cover-variant");
  });

  it("zeichnet eine abweichende Cover-Variante deterministisch aus", () => {
    const input = inputFixture();
    const first = renderOfferPdfDraftHtml(input, { chapters: withToggles({}, 3) });
    const second = renderOfferPdfDraftHtml(structuredClone(input), { chapters: withToggles({}, 3) });

    expect(first).toBe(second);
    expect(first).toContain('data-cover-variant="3"');
  });

  it("verweigert ungültige Kapitel-Konfigurationen fail-closed", () => {
    const input = inputFixture();

    expect(() => renderOfferPdfDraftHtml(input, {
      chapters: { schemaVersion: "offer-pdf-chapter-config.v1", coverVariant: 1, chapters: [] },
    })).toThrow(/Kapitel/u);
    expect(() => renderOfferPdfDraftHtml(input, { chapters: { ungueltig: true } }))
      .toThrow(/Kapitel/u);
    expect(validateOfferPdfChapterConfig({})).toMatchObject({ ok: false });
  });
});

describe("offer PDF snapshot badges (F2.7 R1)", () => {
  it("meldet einen sauberen Standard-Stand ohne Badge", () => {
    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    })).toEqual([]);
    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      chapters: defaultOfferPdfChapterConfig(),
      foreignPdfCount: 0,
    })).toEqual([]);
  });

  it("stuft Fehler, unbekannte und neuere Template-Versionen rot ein", () => {
    expect(resolveOfferPdfBadges({
      hasError: true,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    })).toEqual([{ level: "red", code: "snapshot_error", label: "Fehler: Stand prüfen" }]);

    for (const renderedTemplateVersion of [null, "kein-template", "offer-pdf-draft-template.v0"]) {
      expect(resolveOfferPdfBadges({ hasError: false, renderedTemplateVersion }))
        .toEqual([{ level: "red", code: "template_unknown", label: "Template-Version unbekannt" }]);
    }

    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: "offer-pdf-draft-template.v2",
    })).toEqual([{ level: "red", code: "template_mismatch", label: "Template-Version passt nicht" }]);
  });

  it("stuft ein neueres Template amber ein (Upgrade-Dry-Run)", () => {
    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: "offer-pdf-draft-template.v1",
      currentTemplateVersion: "offer-pdf-draft-template.v2",
    })).toEqual([{ level: "amber", code: "template_outdated", label: "Template neuer — neu rendern" }]);
  });

  it("stuft Custom-Layout und Fremd-PDFs blau ein, ungültige Kapitel rot", () => {
    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      chapters: withToggles({ bom: false }),
    })).toEqual([{ level: "blue", code: "custom_layout", label: "Angepasste Kapitel" }]);

    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      foreignPdfCount: 2,
    })).toEqual([{ level: "blue", code: "foreign_pdf", label: "Fremd-PDF eingebettet" }]);

    expect(resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      chapters: { ungueltig: true },
    })).toEqual([{ level: "red", code: "chapters_invalid", label: "Kapitel-Konfiguration ungültig" }]);
  });

  it("ordnet Badges rot vor amber vor blau", () => {
    const badges = resolveOfferPdfBadges({
      hasError: true,
      renderedTemplateVersion: "offer-pdf-draft-template.v1",
      currentTemplateVersion: "offer-pdf-draft-template.v2",
      chapters: withToggles({ bom: false }),
      foreignPdfCount: 1,
    });

    expect(badges.map((badge) => badge.code))
      .toEqual(["snapshot_error", "template_outdated", "custom_layout", "foreign_pdf"]);
    expect(badges.map((badge) => badge.level)).toEqual(["red", "amber", "blue", "blue"]);
  });

  it("verweigert malformed Badge-Input fail-closed", () => {
    expect(() => resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      foreignPdfCount: -1,
    })).toThrow(TypeError);
    expect(() => resolveOfferPdfBadges({
      hasError: false,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      foreignPdfCount: 1.5,
    })).toThrow(TypeError);
    expect(() => resolveOfferPdfBadges({
      hasError: "ja" as unknown as boolean,
      renderedTemplateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    })).toThrow(TypeError);
  });
});
