/**
 * F6-02 Schaltplan-Export (Spec F6-02): deterministischer SVG-Dateiname
 * aus Angebotsnummer + Variantenname. Reiner Builder, keine I/O.
 *
 * Unzulässige Zeichen werden zu `-` normalisiert (laufende `-` kollabiert,
 * Ränder gestutzt); leeres Ergebnis fällt fail-closed auf `schaltplan`
 * zurück statt eine `.svg`-zonder-Namen zu erzeugen.
 */

export const SCHEMATIC_EXPORT_PREFIX = "schaltplan" as const;
export const SCHEMATIC_EXPORT_EXTENSION = ".svg" as const;

export function sanitizeSchematicExportSegment(value: string): string {
  const collapsed = value
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9-_äöüÄÖÜß]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed;
}

export function schematicExportFilename(input: {
  offerNumber: string;
  variantName: string;
}): string {
  const offer = sanitizeSchematicExportSegment(input.offerNumber);
  const variant = sanitizeSchematicExportSegment(input.variantName);
  const base = [offer, variant].filter((segment) => segment.length > 0).join("-");
  const stem = base.length > 0 ? `${SCHEMATIC_EXPORT_PREFIX}-${base}` : SCHEMATIC_EXPORT_PREFIX;
  return `${stem}${SCHEMATIC_EXPORT_EXTENSION}`;
}
