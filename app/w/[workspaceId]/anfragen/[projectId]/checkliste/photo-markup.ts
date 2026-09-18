// F7-15b Fotodoku-Markup — pure Math (DOM-frei, unit-testbar).
// Der Dialog (ItemPhotoMarkupDialog im Manager-File daneben) nutzt diese
// Bausteine fuer Display- und Export-Composit; alles Canvas/DOM bleibt dort.

export type MarkupPoint = { x: number; y: number };
export type MarkupArrow = { from: MarkupPoint; to: MarkupPoint };
export type MarkupTextAnnotation = { at: MarkupPoint; text: string };
export type MarkupAnnotations = { arrows: MarkupArrow[]; texts: MarkupTextAnnotation[] };
export type MarkupSize = { width: number; height: number };

// Export-Kante (ESTIMATE, reversibel): Das Original bleibt in voller
// Aufloesung erhalten — die annotierte Kopie ist Arbeitskopie; der Downscale
// haelt PNGs typischer Kamerafotos unter dem Byte-Cap.
export const PHOTO_MARKUP_EXPORT_MAX_EDGE = 2048;
// Display-Kante im Dialog (ESTIMATE, reversibel): Kamerafotos waeren nativ
// unbedienbar; 64x64-Fixtures (E2E) bleiben unveraendert.
export const PHOTO_MARKUP_DISPLAY_MAX_EDGE = 640;
// Text-Cap (ESTIMATE, reversibel): Kurztext am Pfeil, kein Aufsatz.
export const PHOTO_MARKUP_TEXT_MAX = 140;
// Client-Spiegel von CHECKLIST_PHOTO_MAX_BYTES
// (modules/checklists/service.ts): Der Client pre-checkt fail-fast, der
// Server prueft massgeblich (Route + Service). Kein Import aus modules/* —
// die service-Kette (node:crypto/drizzle) ist Bundle-Gift im Client.
export const PHOTO_MARKUP_MAX_BYTES = 10_485_760;
// Fixe Darstellung (SPEC-DECIDED): Rot, keine Picker.
export const PHOTO_MARKUP_ARROW_COLOR = "#ff0000";
export const PHOTO_MARKUP_LINE_WIDTH = 3;
export const PHOTO_MARKUP_FONT_SIZE = 16;
export const PHOTO_MARKUP_FONT_FAMILY = "sans-serif";
export const PHOTO_MARKUP_ARROW_HEAD_LENGTH = 12;
export const PHOTO_MARKUP_ARROW_HEAD_ANGLE = Math.PI / 6;

export function photoMarkupFont(sizePx: number): string {
  return `${sizePx}px ${PHOTO_MARKUP_FONT_FAMILY}`;
}

// Passt eine Nativ-Groesse unter die Kante (Aspekt erhalten, lange Kante
// exakt maxEdge; kleine Fotos unveraendert).
export function fitSize(naturalWidth: number, naturalHeight: number, maxEdge: number): MarkupSize {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth < 0 || naturalHeight < 0) {
    return { width: 0, height: 0 };
  }
  const longEdge = Math.max(naturalWidth, naturalHeight);
  if (longEdge <= 0 || longEdge <= maxEdge) {
    return { width: naturalWidth, height: naturalHeight };
  }
  const factor = maxEdge / longEdge;
  if (naturalWidth >= naturalHeight) {
    return { width: maxEdge, height: Math.max(1, Math.round(naturalHeight * factor)) };
  }
  return { width: Math.max(1, Math.round(naturalWidth * factor)), height: maxEdge };
}

// Display→Export-Skalierung (ganzzahlig gerundet: Canvas-Pixel).
export function scalePoint(point: MarkupPoint, factor: number): MarkupPoint {
  return { x: Math.round(point.x * factor), y: Math.round(point.y * factor) };
}

// Linien-/Schrift-/Fluegel-Groessen skalieren mit (mindestens 1px).
export function scaleLength(value: number, factor: number): number {
  return Math.max(1, Math.round(value * factor));
}

// Pfeilspitze als 2 Fluegel-Endpunkte (Spitze = `to`; Winkel gegen die
// Pfeilachse, Laenge exakt headLength — deterministisch).
// Reihenfolge: [+Streuung, -Streuung] (stabile Ordnung, kein Sortieren).
export function arrowHeadPoints(
  from: MarkupPoint,
  to: MarkupPoint,
  headLength: number = PHOTO_MARKUP_ARROW_HEAD_LENGTH,
  headAngle: number = PHOTO_MARKUP_ARROW_HEAD_ANGLE,
): [MarkupPoint, MarkupPoint] {
  const base = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI - headAngle;
  const wing = (angle: number): MarkupPoint => ({
    x: to.x + headLength * Math.cos(angle),
    y: to.y + headLength * Math.sin(angle),
  });
  return [wing(base + spread), wing(base - spread)];
}

// Anker-Clamping in die Zeichenflaeche (nie negativ, nie Overflow).
export function clampPoint(point: MarkupPoint, width: number, height: number): MarkupPoint {
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(0, width - 1)),
    y: Math.min(Math.max(point.y, 0), Math.max(0, height - 1)),
  };
}

// Text-Cap (zusaetzlich zum input-maxLength: Paste/Script-Pfad).
export function capMarkupText(text: string): string {
  return text.slice(0, PHOTO_MARKUP_TEXT_MAX);
}
