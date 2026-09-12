import { z } from "zod";

// F2-06 Upsell-Auswahl (Slice A): reine Projektion über versiegelten
// Snapshot-Zeilen. Kein DB-Zugriff, kein I/O, keine Simulationseingriffe.

export const UPSELL_SELECTION_MAX = 50;

const lineDomainIdSchema = z
  .string()
  .min(1)
  .max(120);

export const upsellSelectionSchema = z
  .array(lineDomainIdSchema)
  .max(UPSELL_SELECTION_MAX);

export const upsellOptionalLineSchema = z.strictObject({
  lineDomainId: lineDomainIdSchema,
  name: z.string().min(1).max(200),
  salesGrossCents: z.int().safe().min(0),
  positionType: z.string(),
  isHidden: z.boolean(),
});

export type UpsellOptionalLine = z.infer<typeof upsellOptionalLineSchema>;

export const upsellTotalInputSchema = z.strictObject({
  basisGrossCents: z.int().safe().min(0),
  lines: z.array(upsellOptionalLineSchema).max(500),
  selectedIds: z.array(z.string()).max(UPSELL_SELECTION_MAX),
});

export interface UpsellTotal {
  basisGrossCents: number;
  selectableCount: number;
  selectedIds: string[];
  unknownIds: string[];
  selectedGrossCents: number;
  totalGrossCents: number;
}

// Wählbar: exakt optionale, sichtbare Zeilen. Alles andere (unbekannte IDs,
// versteckte oder nicht-optionale Zeilen) fällt still heraus und wird in
// unknownIds belegt — keine erfundene Auswahl, keine Simulation.
export function resolveUpsellTotal(input: z.infer<typeof upsellTotalInputSchema>): UpsellTotal {
  const parsed = upsellTotalInputSchema.parse(input);
  const byId = new Map<string, UpsellOptionalLine>();
  for (const line of parsed.lines) {
    if (line.positionType !== "optional" || line.isHidden) continue;
    if (!byId.has(line.lineDomainId)) byId.set(line.lineDomainId, line);
  }
  const selectedIds: string[] = [];
  const unknownIds: string[] = [];
  const seen = new Set<string>();
  for (const id of parsed.selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId.has(id)) selectedIds.push(id);
    else unknownIds.push(id);
  }
  selectedIds.sort();
  let selectedGrossCents = 0;
  for (const id of selectedIds) selectedGrossCents += byId.get(id)!.salesGrossCents;
  return {
    basisGrossCents: parsed.basisGrossCents,
    selectableCount: byId.size,
    selectedIds,
    unknownIds,
    selectedGrossCents,
    totalGrossCents: parsed.basisGrossCents + selectedGrossCents,
  };
}
