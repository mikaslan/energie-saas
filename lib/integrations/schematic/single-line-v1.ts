// F6-01 · Einliniger Schaltplan-Builder (ESTIMATE, reversibel).
// Reine Funktion: Angebotskategorien -> Knoten/Kanten auf festem Raster.
// Exaktes Reonic-Layout UNKNOWN — Positionen sind deterministisch und
// dokumentiert, keine erfundene Verdrahtung (s. unwired-Hinweisliste).

export type SchematicCategory =
  | "module"
  | "inverter"
  | "battery"
  | "wallbox"
  | "heat_pump"
  | "mounting"
  | "other";

export type SchematicSectionInput = {
  category: SchematicCategory;
  /** Anzeigetitel der Sektion (z. B. „PV-Module"). */
  title: string;
  /** Bereits formatierte Menge (z. B. „12 Stück"). */
  quantityLabel: string | null;
};

export type SchematicNode = {
  id: string;
  kind: Exclude<SchematicCategory, "other"> | "meter" | "grid";
  label: string;
  sub: string | null;
  x: number;
  y: number;
};

export type SchematicEdge = {
  from: string;
  to: string;
  label: string;
};

export type SingleLineSchematic = {
  nodes: SchematicNode[];
  edges: SchematicEdge[];
  /** Sektionen ohne Leitungsführung (Hinweisliste statt Knoten). */
  unwired: string[];
  /** true, wenn kein verdrahteter Knoten existiert. */
  empty: boolean;
};

const BACKBONE_ORDER = ["pv", "inverter", "meter", "grid"] as const;

const BACKBONE_LABELS: Record<string, string> = {
  pv: "PV-Generator",
  inverter: "Wechselrichter",
  meter: "Zähler",
  grid: "Netz",
};

const BACKBONE_X: Record<string, number> = {
  pv: 90,
  inverter: 250,
  meter: 410,
  grid: 560,
};

function nodeLabel(title: string, quantityLabel: string | null): { label: string; sub: string | null } {
  return {
    label: title,
    sub: quantityLabel,
  };
}

/**
 * Baut das Einlinienbild. Backbone-Kanten nur zwischen vorhandenen
 * Backbone-Knoten in Reihenfolge; Speicher braucht den Wechselrichter,
 * Wallbox/Wärmepumpe den Zähler — sonst Hinweisliste.
 */
export function buildSingleLineSchematic(
  sections: readonly SchematicSectionInput[],
): SingleLineSchematic {
  const byCategory = new Map<SchematicCategory, SchematicSectionInput>();
  for (const section of sections) {
    if (!byCategory.has(section.category)) byCategory.set(section.category, section);
  }

  const nodes: SchematicNode[] = [];
  const edges: SchematicEdge[] = [];
  const unwired: string[] = [];
  const present = new Set<string>();

  const pushBackbone = (id: string, title: string | null, quantityLabel: string | null) => {
    const label = nodeLabel(title ?? BACKBONE_LABELS[id]!, quantityLabel);
    nodes.push({ id, kind: id as SchematicNode["kind"], label: label.label, sub: label.sub, x: BACKBONE_X[id]!, y: 80 });
    present.add(id);
  };

  if (byCategory.has("module")) {
    const section = byCategory.get("module")!;
    pushBackbone("pv", section.title, section.quantityLabel);
  }
  if (byCategory.has("inverter")) {
    const section = byCategory.get("inverter")!;
    pushBackbone("inverter", section.title, section.quantityLabel);
  }
  // Zähler und Netz sind Anschlusspunkte, keine Angebotspositionen.
  pushBackbone("meter", null, null);
  pushBackbone("grid", null, null);

  // Backbone nur zwischen tatsächlich vorhandenen Knoten verketten; ohne
  // PV/Wechselrichter bleibt die Kette ab Zähler bestehen (Anschlusslage).
  const chain = BACKBONE_ORDER.filter((id) => {
    if (id === "meter" || id === "grid") return true;
    return present.has(id);
  });
  // Ohne Erzeugung (kein PV-Knoten) kein Erzeugungsstrang: Kette beginnt am
  // Zähler nur, wenn mindestens PV oder Wechselrichter vorhanden sind.
  const hasGeneration = present.has("pv") || present.has("inverter");
  const wiredChain = hasGeneration ? chain : chain.filter((id) => id === "meter" || id === "grid");
  for (let index = 0; index < wiredChain.length - 1; index += 1) {
    const from = wiredChain[index]!;
    const to = wiredChain[index + 1]!;
    const label = from === "pv" ? "DC" : "AC";
    edges.push({ from, to, label });
  }
  for (const id of BACKBONE_ORDER) {
    if (!wiredChain.includes(id)) {
      const nodeIndex = nodes.findIndex((node) => node.id === id);
      if (nodeIndex >= 0) nodes.splice(nodeIndex, 1);
    }
  }

  if (byCategory.has("battery")) {
    const section = byCategory.get("battery")!;
    if (present.has("inverter") && wiredChain.includes("inverter")) {
      const label = nodeLabel(section.title, section.quantityLabel);
      nodes.push({ id: "battery", kind: "battery", label: label.label, sub: label.sub, x: 250, y: 220 });
      edges.push({ from: "inverter", to: "battery", label: "Ladung/Entladung" });
    } else {
      unwired.push(section.title);
    }
  }
  if (byCategory.has("wallbox")) {
    const section = byCategory.get("wallbox")!;
    const label = nodeLabel(section.title, section.quantityLabel);
    nodes.push({ id: "wallbox", kind: "wallbox", label: label.label, sub: label.sub, x: 410, y: 220 });
    edges.push({ from: "meter", to: "wallbox", label: "Hausabgang" });
  }
  if (byCategory.has("heat_pump")) {
    const section = byCategory.get("heat_pump")!;
    const label = nodeLabel(section.title, section.quantityLabel);
    nodes.push({ id: "heatPump", kind: "heat_pump", label: label.label, sub: label.sub, x: 560, y: 220 });
    edges.push({ from: "meter", to: "heatPump", label: "Hausabgang" });
  }
  if (byCategory.has("mounting")) {
    const section = byCategory.get("mounting")!;
    if (wiredChain.includes("pv")) {
      const label = nodeLabel(section.title, section.quantityLabel);
      nodes.push({ id: "mounting", kind: "mounting", label: label.label, sub: label.sub, x: 90, y: 220 });
      edges.push({ from: "pv", to: "mounting", label: "Montage" });
    } else {
      unwired.push(section.title);
    }
  }
  if (byCategory.has("other")) {
    unwired.push(byCategory.get("other")!.title);
  }

  // Nur Zähler+Netz ohne Angebotsinhalt ist kein Schaltbild.
  const offerNodes = nodes.filter((node) => node.id !== "meter" && node.id !== "grid");
  if (offerNodes.length === 0) {
    return { nodes: [], edges: [], unwired, empty: true };
  }
  return { nodes, edges, unwired, empty: false };
}
