// F6-02a Editor-Overlay: Bibliothek + deterministischer Merge (GREEN).
// SPEC docs/spec/F6-02a-editor-overlay.md: Overlay-Knoten erhalten stabile
// IDs ovl-1…ovl-n (disjunkt zum Backbone), Konnektoren haengen an Backbone-
// oder Overlay-Knoten, jede Unschärfe verwirft fail-closed.
import { z } from "zod";

import {
  sortSingleLineSchematic,
  type SchematicNode,
  type SingleLineSchematic,
} from "./single-line-v1";

export const EDITOR_OVERLAY_VERSION = "editor-overlay.v1" as const;
export const EDITOR_OVERLAY_MAX_ELEMENTS = 32 as const;
export const EDITOR_OVERLAY_CANVAS = { width: 640, height: 300 } as const;

export class OverlayValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("editor overlay is invalid");
    this.name = "OverlayValidationError";
  }
}

const coordinateSchema = z.int().min(0).max(640);
const rowSchema = z.int().min(0).max(300);

export const overlayElementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("earthing_point"),
    x: coordinateSchema,
    y: rowSchema,
  }),
  z.strictObject({
    kind: z.literal("junction_box"),
    x: coordinateSchema,
    y: rowSchema,
  }),
  z.strictObject({
    kind: z.literal("generic"),
    x: coordinateSchema,
    y: rowSchema,
    label: z.string().trim().min(1).max(120),
  }),
  z.strictObject({
    kind: z.literal("textbox"),
    x: coordinateSchema,
    y: rowSchema,
    text: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("connector"),
    from: z.string().trim().min(1).max(80),
    to: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
  }),
]);

export type OverlayElementInput = z.infer<typeof overlayElementSchema>;

/** F6-02c-A/CONTRACT: vergebene Overlay-ID, an die Eingabezeile gebunden. */
export type AssignedOverlayId = {
  /** Index in der Eingabereihenfolge (nur ID-tragende Elemente). */
  index: number;
  /** Vergebene ID (`ovl-n`, disjunkt zu den Backbone-IDs). */
  id: string;
};

type OverlayNodeElement = Exclude<OverlayElementInput, { kind: "connector" }>;

type IndexedNodeElement = {
  element: OverlayNodeElement;
  index: number;
};

/** F6-02c-A: Merge-Sortierung (Rang, NFC/Raw, x, y, stabiler Index). */
function sortNodeElements(validated: OverlayElementInput[]): IndexedNodeElement[] {
  return validated
    .map((element, index) => ({ element, index }))
    .filter((entry): entry is IndexedNodeElement => entry.element.kind !== "connector")
    .sort(
      (a, b) =>
        OVERLAY_ELEMENT_RANK[a.element.kind] - OVERLAY_ELEMENT_RANK[b.element.kind] ||
        compareNfcText(overlaySortLabel(a.element), overlaySortLabel(b.element)) ||
        a.element.x - b.element.x ||
        a.element.y - b.element.y ||
        a.index - b.index,
    );
}

/**
 * F6-02c-A (GREEN): deterministische Overlay-ID-Vergabe (SPEC
 * docs/spec/F6-02c-freier-editor.md). Sortiert wie der Merge, vergibt
 * `ovl-1…` disjunkt zu `backboneIds`, gibt NUR ID-tragende Elemente
 * (keine Konnektoren) in Eingabereihenfolge zurueck. Validiert
 * fail-closed (`OverlayValidationError`); Konnektor-Endpunkte prueft
 * weiter der Merge (diese Funktion kennt keine Kanten).
 * `mergeEditorOverlay` nutzt diese Funktion intern (eine Quelle).
 */
export function assignOverlayIds(
  backboneIds: ReadonlySet<string> | readonly string[],
  elements: readonly OverlayElementInput[],
): AssignedOverlayId[] {
  const validated = validateElements(elements);
  const takenIds = new Set<string>(backboneIds);
  const assigned: AssignedOverlayId[] = [];
  let counter = 0;
  for (const { index } of sortNodeElements(validated)) {
    counter += 1;
    let id = `ovl-${counter}`;
    while (takenIds.has(id)) {
      counter += 1;
      id = `ovl-${counter}`;
    }
    takenIds.add(id);
    assigned.push({ index, id });
  }
  assigned.sort((a, b) => a.index - b.index);
  return assigned;
}

/** SPEC-Tabellenrang: Erdung, Dose, Generik, Textbox, Konnektor. */
const OVERLAY_ELEMENT_RANK: Record<OverlayElementInput["kind"], number> = {
  earthing_point: 0,
  junction_box: 1,
  generic: 2,
  textbox: 3,
  connector: 4,
};

const OVERLAY_DEFAULT_LABELS = {
  earthing_point: "Erdungspunkt",
  junction_box: "Abzweigdose",
} as const;

/** NFC-Vergleich mit Raw-Tiebreak (gleiche Semantik wie F6-01-Builder). */
function compareNfcText(a: string, b: string): number {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function overlaySortLabel(element: OverlayElementInput): string {
  if (element.kind === "generic" || element.kind === "connector") return element.label;
  if (element.kind === "textbox") return element.text;
  return "";
}

function isBackbone(value: unknown): value is SingleLineSchematic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record["nodes"]) &&
    Array.isArray(record["edges"]) &&
    Array.isArray(record["unwired"]) &&
    typeof record["empty"] === "boolean"
  );
}

function validateElements(elements: unknown): OverlayElementInput[] {
  if (!Array.isArray(elements)) throw new OverlayValidationError(["/elements"]);
  if (elements.length > EDITOR_OVERLAY_MAX_ELEMENTS) {
    throw new OverlayValidationError(["/elements"]);
  }
  return elements.map((entry, index) => {
    const parsed = overlayElementSchema.safeParse(entry);
    if (!parsed.success) {
      const paths = parsed.error.issues.map(
        (issue) =>
          `/elements/${index}${issue.path.map((segment) => `/${String(segment)}`).join("")}`,
      );
      throw new OverlayValidationError(paths.length > 0 ? paths : [`/elements/${index}`]);
    }
    return parsed.data;
  });
}

/**
 * F6-02a Merge: Backbone + Overlay → ein Netz (SPEC
 * docs/spec/F6-02a-editor-overlay.md). Deterministisch (Eingabereihenfolge
 * egal), Backbone-unantastbar (Kopien, nie Mutation), leeres Overlay
 * merged identisch.
 */
export function mergeEditorOverlay(
  backbone: SingleLineSchematic,
  elements: readonly OverlayElementInput[],
): SingleLineSchematic {
  if (!isBackbone(backbone)) throw new OverlayValidationError(["/backbone"]);
  const validated = validateElements(elements);
  if (validated.length === 0) {
    return {
      nodes: backbone.nodes.map((node) => ({ ...node })),
      edges: backbone.edges.map((edge) => ({ ...edge })),
      unwired: [...backbone.unwired],
      empty: backbone.empty,
    };
  }

  const backboneIds = new Set(backbone.nodes.map((node) => node.id));

  // F6-02c-A: ID-Vergabe aus einer Quelle (assignOverlayIds sortiert und
  // nummeriert; der Merge baut nur noch Knoten daraus).
  const assigned = assignOverlayIds(backboneIds, validated);
  const overlayNodes: SchematicNode[] = assigned.map(({ index, id }) => {
    const element = validated[index] as OverlayNodeElement;
    const label =
      element.kind === "generic"
        ? element.label
        : element.kind === "textbox"
          ? element.text
          : OVERLAY_DEFAULT_LABELS[element.kind];
    return { id, kind: element.kind, label, sub: null, x: element.x, y: element.y };
  });

  const knownIds = new Set([...backboneIds, ...overlayNodes.map((node) => node.id)]);
  const overlayEdges = validated.flatMap((element, index) => {
    if (element.kind !== "connector") return [];
    if (!knownIds.has(element.from)) {
      throw new OverlayValidationError([`/elements/${index}/from`]);
    }
    if (!knownIds.has(element.to)) {
      throw new OverlayValidationError([`/elements/${index}/to`]);
    }
    return [{ from: element.from, to: element.to, label: element.label }];
  });

  return sortSingleLineSchematic({
    nodes: [...backbone.nodes, ...overlayNodes],
    edges: [...backbone.edges, ...overlayEdges],
    unwired: [...backbone.unwired],
    empty: backbone.empty,
  });
}
