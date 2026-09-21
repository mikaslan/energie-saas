// F6-02b Ensure-Verdrahtung: Wire-Vertrag (GREEN). Reine Funktionen ohne
// Server-Bindung: First-Open-Nutzlast, Page-Ensure-Entscheid,
// Sections-Projektion, Mengen-Format. Das Modul bleibt dauerhaft
// crypto-frei (client-sicher per Konstruktion, kein node:crypto-Import).
import type { SchematicSectionInput, SingleLineSchematic } from "./single-line-v1";

export const ENSURE_WIRE_VERSION = "ensure-wire.v1" as const;

const quantityFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * F6-02b Move aus `offer-detail-view.tsx` (byte-identisches Verhalten,
 * Move-Pins in f602b-ensure-wire.test.ts): Milli-Menge + Einheit → Label.
 */
export function formatQuantity(quantityMilli: number, unit: string): string {
  const unitLabel = unit === "piece" ? "Stk." : unit === "set" ? "Set" : "m";
  return `${quantityFormatter.format(quantityMilli / 1_000)} ${unitLabel}`;
}

/** Minimale Sections-Form fuer die Schaltplan-Projektion. */
export type SchematicSectionProjection = {
  category: SchematicSectionInput["category"];
  title: string;
  lines: ReadonlyArray<{
    isHidden: boolean;
    quantityMilli: number;
    product: { unit: string };
  }>;
};

/**
 * F6-02b Sections-Projektion (GREEN Teil 2): sichtbare Lines summieren,
 * Label nur bei einheitlicher Einheit — EINE Quelle fuer Ansicht und
 * Page-Loader (zuvor inline in `SchematicCard`).
 */
export function projectSchematicSections(
  sections: ReadonlyArray<SchematicSectionProjection>,
): SchematicSectionInput[] {
  return sections.flatMap((section) => {
    const visible = section.lines.filter((line) => !line.isHidden);
    if (visible.length === 0) return [];
    const units = new Set(visible.map((line) => line.product.unit));
    const quantityLabel = units.size === 1
      ? formatQuantity(
        visible.reduce((sum, line) => sum + line.quantityMilli, 0),
        visible[0]!.product.unit,
      )
      : null;
    return [{ category: section.category, title: section.title, quantityLabel }];
  });
}

/** First-Open-Nutzlast (SPEC F6-02b §Backbone-Persistenz: Backbone-only). */
export type FirstOpenPayloadV1 = {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  schematic: SingleLineSchematic;
};

export type PageEnsureMode = "ensure" | "skip:gate" | "skip:rights" | "skip:empty";

/**
 * F6-02b First-Open-Nutzlast (GREEN Teil 1): verpackt den BACKBONE
 * (nie das gemergte Netz) fuer den Erstöffnen-Save. Entscheidungs-
 * unabhaengig — gilt fuer beide Trigger-Optionen (SPEC §3).
 */
export function firstOpenPayload(input: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  backbone: SingleLineSchematic;
}): FirstOpenPayloadV1 {
  return {
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    variantId: input.variantId,
    revision: input.revision,
    schematic: input.backbone,
  };
}

/**
 * F6-02b Page-Ensure-Entscheid (GREEN Teil 2, Leitstand-Q1 PAGE-LOADER):
 * residential + Editor + Inhalt → "ensure", sonst Skip-Grund
 * (Gate zuerst, dann Recht, dann Inhalt).
 */
export function resolvePageEnsureMode(input: {
  scope: "residential" | "commercial";
  canWrite: boolean;
  nodeCount: number;
  unwiredCount: number;
}): PageEnsureMode {
  if (input.scope !== "residential") return "skip:gate";
  if (!input.canWrite) return "skip:rights";
  if (input.nodeCount === 0 && input.unwiredCount === 0) return "skip:empty";
  return "ensure";
}
