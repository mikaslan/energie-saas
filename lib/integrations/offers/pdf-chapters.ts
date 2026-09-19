import { z } from "zod";
import { OFFER_PDF_DRAFT_TEMPLATE_VERSION } from "./pdf-contract";

// F2.7 PDF-Engine (R1, migrationsfrei): Kapitel-Toggles + Snapshot-Badges.
// Kapitelregister aus dem Modulkatalog (F2.7): Cover mit 6 Varianten,
// Firmenvorstellung, Testimonial, Sankey/KPI, Economics, Stückliste,
// Datenblätter als QR/Anhang, Signaturseite — plus Anschreiben
// (KI-generierbar) und Rechtstexte (AGB/Widerruf). Der Draft-Renderer
// (offer-pdf-draft-template.v1) stellt davon cover/bom/legal dar; alle
// weiteren Kapitel sind validiert, aber dormant bis zur Voll-Engine
// (eigener Folge-Slice; nicht Epic-R2/M2-03b2).
// Badges: rot = Fehler, amber = Template neuer, blau = custom.

export const OFFER_PDF_CHAPTER_IDS = [
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
] as const;
export type OfferPdfChapterId = (typeof OFFER_PDF_CHAPTER_IDS)[number];

export const OFFER_PDF_COVER_VARIANTS = [1, 2, 3, 4, 5, 6] as const;
export type OfferPdfCoverVariant = (typeof OFFER_PDF_COVER_VARIANTS)[number];

// Draft-Abbildung (v1): cover = Kopf + Kontext + Variantenkarte,
// bom = Konditionen + Basis- und Optionsblöcke, legal = Prüfhinweis.
export const OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS: ReadonlySet<OfferPdfChapterId> = new Set([
  "cover",
  "bom",
  "legal",
]);

export const OFFER_PDF_CHAPTER_CONFIG_VERSION = "offer-pdf-chapter-config.v1" as const;

const chapterIdSchema = z.enum(OFFER_PDF_CHAPTER_IDS);

const chapterToggleSchema = z.strictObject({
  id: chapterIdSchema,
  enabled: z.boolean(),
  position: z.int().safe().min(1).max(OFFER_PDF_CHAPTER_IDS.length),
});

// Volle Liste, keine Partials: Der Aufrufer (UI-State) sendet immer alle
// zehn Kapitel; Teillisten wären mehrdeutig (Default-Merge) und werden
// fail-closed verworfen. Eindeutige IDs + Positionen implizieren bei
// Länge 10 automatisch Vollständigkeit und lückenlose Sortierung 1..10.
export const offerPdfChapterConfigSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_PDF_CHAPTER_CONFIG_VERSION),
  coverVariant: z.int().safe().min(1).max(OFFER_PDF_COVER_VARIANTS.length),
  chapters: z.array(chapterToggleSchema).min(OFFER_PDF_CHAPTER_IDS.length).max(OFFER_PDF_CHAPTER_IDS.length),
}).superRefine((config, context) => {
  const ids = new Set<string>();
  const positions = new Set<number>();
  for (const [index, chapter] of config.chapters.entries()) {
    if (ids.has(chapter.id)) {
      context.addIssue({
        code: "custom",
        path: ["chapters", index, "id"],
        message: "Kapitel muessen eindeutig sein.",
      });
    }
    ids.add(chapter.id);
    if (positions.has(chapter.position)) {
      context.addIssue({
        code: "custom",
        path: ["chapters", index, "position"],
        message: "Positionen muessen eindeutig sein.",
      });
    }
    positions.add(chapter.position);
  }
});
export type OfferPdfChapterConfig = z.infer<typeof offerPdfChapterConfigSchema>;

export type OfferPdfChapterConfigResult =
  | { ok: true; value: OfferPdfChapterConfig }
  | { ok: false; paths: string[] };

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part)
      .replaceAll("~", "~0")
      .replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

export function defaultOfferPdfChapterConfig(): OfferPdfChapterConfig {
  return {
    schemaVersion: OFFER_PDF_CHAPTER_CONFIG_VERSION,
    coverVariant: 1,
    chapters: OFFER_PDF_CHAPTER_IDS.map((id, index) => ({
      id,
      enabled: true,
      position: index + 1,
    })),
  };
}

export function validateOfferPdfChapterConfig(value: unknown): OfferPdfChapterConfigResult {
  const parsed = offerPdfChapterConfigSchema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  return { ok: true, value: parsed.data };
}

export function parseOfferPdfChapterConfig(value: unknown): OfferPdfChapterConfig {
  const parsed = offerPdfChapterConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltige PDF-Kapitelkonfiguration: ${validationPaths(parsed.error).join(", ")}`);
  }
  return parsed.data;
}

export type OfferPdfChapterLayoutEntry = {
  id: OfferPdfChapterId;
  enabled: boolean;
  position: number;
  renderedByDraft: boolean;
};

export type OfferPdfChapterLayout = {
  schemaVersion: typeof OFFER_PDF_CHAPTER_CONFIG_VERSION;
  coverVariant: number;
  chapters: OfferPdfChapterLayoutEntry[];
};

export function resolveOfferPdfChapterLayout(config: OfferPdfChapterConfig): OfferPdfChapterLayout {
  const chapters = [...config.chapters]
    .sort((left, right) => left.position - right.position)
    .map((chapter) => ({
      ...chapter,
      renderedByDraft: chapter.enabled && OFFER_PDF_DRAFT_SUPPORTED_CHAPTERS.has(chapter.id),
    }));
  return {
    schemaVersion: OFFER_PDF_CHAPTER_CONFIG_VERSION,
    coverVariant: config.coverVariant,
    chapters,
  };
}

export function isDefaultOfferPdfChapterConfig(config: OfferPdfChapterConfig): boolean {
  if (config.coverVariant !== 1) return false;
  return OFFER_PDF_CHAPTER_IDS.every((id, index) =>
    config.chapters.some((chapter) =>
      chapter.id === id && chapter.enabled && chapter.position === index + 1));
}

export type OfferPdfTemplateComparison = "equal" | "older" | "newer" | "unknown";

const TEMPLATE_VERSION_PATTERN = /^offer-pdf-draft-template\.v([1-9][0-9]*)$/u;

function templateVersionNumber(value: string): number | null {
  const match = TEMPLATE_VERSION_PATTERN.exec(value);
  if (match?.[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function compareOfferPdfTemplateVersion(rendered: string, current: string): OfferPdfTemplateComparison {
  const renderedNumber = templateVersionNumber(rendered);
  const currentNumber = templateVersionNumber(current);
  if (renderedNumber === null || currentNumber === null) return "unknown";
  if (renderedNumber === currentNumber) return "equal";
  return renderedNumber < currentNumber ? "older" : "newer";
}

export type OfferPdfBadgeLevel = "red" | "amber" | "blue";
export type OfferPdfBadgeCode =
  | "snapshot_error"
  | "template_unknown"
  | "template_mismatch"
  | "template_outdated"
  | "chapters_invalid"
  | "custom_layout"
  | "foreign_pdf";
export type OfferPdfBadge = {
  level: OfferPdfBadgeLevel;
  code: OfferPdfBadgeCode;
  label: string;
};

export type ResolveOfferPdfBadgesInput = {
  hasError: boolean;
  renderedTemplateVersion: string | null;
  chapters?: unknown;
  foreignPdfCount?: number;
  currentTemplateVersion?: string;
};

// Reihenfolge: rot vor amber vor blau. currentTemplateVersion dient dem
// Upgrade-Dry-Run ("wäre dieser Stand unter Template v2 veraltet?") und
// fällt auf die gepinnte Draft-Version zurück.
export function resolveOfferPdfBadges(input: ResolveOfferPdfBadgesInput): OfferPdfBadge[] {
  if (typeof input.hasError !== "boolean") {
    throw new TypeError("Ungueltiger Badge-Input: hasError.");
  }
  if (input.renderedTemplateVersion !== null && typeof input.renderedTemplateVersion !== "string") {
    throw new TypeError("Ungueltiger Badge-Input: renderedTemplateVersion.");
  }
  const current = input.currentTemplateVersion ?? OFFER_PDF_DRAFT_TEMPLATE_VERSION;
  if (typeof current !== "string") {
    throw new TypeError("Ungueltiger Badge-Input: currentTemplateVersion.");
  }
  const foreignPdfCount = input.foreignPdfCount ?? 0;
  if (!Number.isInteger(foreignPdfCount) || foreignPdfCount < 0) {
    throw new TypeError("Ungueltiger Badge-Input: foreignPdfCount.");
  }
  const badges: OfferPdfBadge[] = [];
  if (input.hasError) {
    badges.push({ level: "red", code: "snapshot_error", label: "Fehler: Stand prüfen" });
  }
  const comparison = input.renderedTemplateVersion === null
    ? "unknown"
    : compareOfferPdfTemplateVersion(input.renderedTemplateVersion, current);
  if (comparison === "unknown") {
    badges.push({ level: "red", code: "template_unknown", label: "Template-Version unbekannt" });
  } else if (comparison === "older") {
    badges.push({ level: "amber", code: "template_outdated", label: "Template neuer — neu rendern" });
  } else if (comparison === "newer") {
    badges.push({ level: "red", code: "template_mismatch", label: "Template-Version passt nicht" });
  }
  if (input.chapters !== undefined) {
    const parsed = offerPdfChapterConfigSchema.safeParse(input.chapters);
    if (!parsed.success) {
      badges.push({ level: "red", code: "chapters_invalid", label: "Kapitel-Konfiguration ungültig" });
    } else if (!isDefaultOfferPdfChapterConfig(parsed.data)) {
      badges.push({ level: "blue", code: "custom_layout", label: "Angepasste Kapitel" });
    }
  }
  if (foreignPdfCount > 0) {
    badges.push({ level: "blue", code: "foreign_pdf", label: "Fremd-PDF eingebettet" });
  }
  return badges;
}
