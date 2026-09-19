import { describe, expect, it } from "vitest";
import {
  OFFER_PDF_CHAPTER_CONFIG_VERSION,
  OFFER_PDF_CHAPTER_IDS,
  OFFER_PDF_COVER_VARIANTS,
  OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS,
  compareOfferPdfTemplateVersion,
  defaultOfferPdfChapterConfig,
  offerPdfChapterConfigSchema,
  validateOfferPdfChapterConfig,
  type OfferPdfChapterConfig,
} from "@/lib/integrations/offers/pdf-chapters";
import {
  FOREIGN_PDF_MAX_BYTES,
  FOREIGN_PDF_MAX_COUNT,
  FOREIGN_PDF_MAX_PAGES,
  FOREIGN_PDF_MIN_BYTES,
  foreignPdfDescriptorListSchema,
  foreignPdfDescriptorSchema,
} from "@/lib/integrations/offers/foreign-pdf";

function validDescriptor() {
  return {
    filename: "datenblatt.pdf",
    mimeType: "application/pdf" as const,
    sizeBytes: 2048,
    sha256Hex: "a".repeat(64),
    pageCount: 3,
  };
}

describe("offer-pdf-chapter-config.v1 contract", () => {
  it("pinnt Version, Kapitelregister, Cover-Varianten und Draft-Abdeckung", () => {
    expect(OFFER_PDF_CHAPTER_CONFIG_VERSION).toBe("offer-pdf-chapter-config.v1");
    expect(OFFER_PDF_CHAPTER_IDS).toEqual([
      "cover",
      "cover_letter",
      "company",
      "testimonial",
      "sankey_kpi",
      "economics",
      "bom",
      "datasheets",
      "legal",
      "signature",
    ]);
    expect(OFFER_PDF_COVER_VARIANTS).toEqual([1, 2, 3, 4, 5, 6]);
    expect(OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.size).toBe(3);
    expect(OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.has("cover")).toBe(true);
    expect(OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.has("bom")).toBe(true);
    expect(OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.has("legal")).toBe(true);
    expect(OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.has("company")).toBe(false);
    expect(offerPdfChapterConfigSchema.safeParse(defaultOfferPdfChapterConfig()).success).toBe(true);
  });

  it("ist strikt und verlangt alle zehn Kapitel mit lückenlosen Positionen", () => {
    const base = defaultOfferPdfChapterConfig();
    expect(offerPdfChapterConfigSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(offerPdfChapterConfigSchema.safeParse({
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, extra: 1 })),
    }).success).toBe(false);
    expect(offerPdfChapterConfigSchema.safeParse({
      ...base,
      chapters: base.chapters.slice(0, 9),
    }).success).toBe(false);
    expect(offerPdfChapterConfigSchema.safeParse({
      ...base,
      chapters: [...base.chapters, { ...base.chapters[0]!, position: 10 }],
    }).success).toBe(false);

    const duplicateId: OfferPdfChapterConfig = {
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, id: "bom" as const })),
    };
    expect(offerPdfChapterConfigSchema.safeParse(duplicateId).success).toBe(false);

    const duplicatePosition: OfferPdfChapterConfig = {
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, position: 1 })),
    };
    expect(offerPdfChapterConfigSchema.safeParse(duplicatePosition).success).toBe(false);

    for (const chapters of [
      base.chapters.map((chapter, index) => ({ ...chapter, position: index })),
      base.chapters.map((chapter, index) => ({ ...chapter, position: index + 2 })),
    ]) {
      expect(offerPdfChapterConfigSchema.safeParse({ ...base, chapters }).success).toBe(false);
    }
    for (const coverVariant of [0, 7, 1.5]) {
      expect(offerPdfChapterConfigSchema.safeParse({ ...base, coverVariant }).success, String(coverVariant))
        .toBe(false);
    }
    expect(offerPdfChapterConfigSchema.safeParse({
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, id: "intro" })),
    }).success).toBe(false);
    expect(offerPdfChapterConfigSchema.safeParse({ ...base, schemaVersion: "v2" }).success).toBe(false);
  });

  it("liefert bei Inputfehlern stabile JSON-Pfade", () => {
    const result = validateOfferPdfChapterConfig({ ungueltig: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid erwartet");
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.paths.length).toBeLessThanOrEqual(20);
    expect(result.paths.every((path) => path.startsWith("/"))).toBe(true);
  });

  it("vergleicht Template-Versionen fail-closed", () => {
    expect(compareOfferPdfTemplateVersion(
      "offer-pdf-draft-template.v1",
      "offer-pdf-draft-template.v1",
    )).toBe("equal");
    expect(compareOfferPdfTemplateVersion(
      "offer-pdf-draft-template.v1",
      "offer-pdf-draft-template.v2",
    )).toBe("older");
    expect(compareOfferPdfTemplateVersion(
      "offer-pdf-draft-template.v2",
      "offer-pdf-draft-template.v1",
    )).toBe("newer");
    for (const rendered of ["", "müll", "offer-pdf-draft-template.v0", "offer-pdf-draft-template.v01"]) {
      expect(compareOfferPdfTemplateVersion(rendered, "offer-pdf-draft-template.v1"), rendered).toBe("unknown");
    }
    expect(compareOfferPdfTemplateVersion(
      "offer-pdf-draft-template.v1",
      "kein-template",
    )).toBe("unknown");
  });
});

describe("foreign-pdf descriptor contract", () => {
  it("pinnt Grenzen und akzeptiert genau einen wohlgeformten Deskriptor", () => {
    expect(FOREIGN_PDF_MIN_BYTES).toBe(100);
    expect(FOREIGN_PDF_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(FOREIGN_PDF_MAX_PAGES).toBe(50);
    expect(FOREIGN_PDF_MAX_COUNT).toBe(5);
    expect(foreignPdfDescriptorSchema.safeParse(validDescriptor()).success).toBe(true);
    expect(foreignPdfDescriptorListSchema.safeParse([validDescriptor()]).success).toBe(true);
  });

  it("verweigert fremde Keys, schwache Hashes und unplausible Maße", () => {
    const base = validDescriptor();
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, bytes: "privat" }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, sha256Hex: "A".repeat(64) }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, sha256Hex: "abc" }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, pageCount: 0 }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, pageCount: 51 }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, sizeBytes: 99 }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, filename: "../x.pdf" }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, filename: "x.txt" }).success).toBe(false);
    expect(foreignPdfDescriptorSchema.safeParse({ ...base, mimeType: "application/octet-stream" }).success)
      .toBe(false);
  });

  it("begrenzt Listen auf fünf eindeutige Anhänge", () => {
    const base = validDescriptor();
    const sha = (digit: string) => digit.repeat(64);
    expect(foreignPdfDescriptorListSchema.safeParse([]).success).toBe(false);
    expect(foreignPdfDescriptorListSchema.safeParse([base, base]).success).toBe(false);
    expect(foreignPdfDescriptorListSchema.safeParse(
      ["a", "b", "c", "d", "e", "f"].map((digit) => ({ ...base, sha256Hex: sha(digit) })),
    ).success).toBe(false);
    expect(foreignPdfDescriptorListSchema.safeParse(
      ["a", "b", "c", "d", "e"].map((digit) => ({ ...base, sha256Hex: sha(digit) })),
    ).success).toBe(true);
  });
});
