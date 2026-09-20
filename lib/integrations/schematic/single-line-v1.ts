// F6-01 · Einliniger Schaltplan-Builder (ESTIMATE, reversibel).
// Reine Funktion: Angebotskategorien -> Knoten/Kanten auf festem Raster.
// Exaktes Reonic-Layout UNKNOWN — Positionen sind deterministisch und
// dokumentiert, keine erfundene Verdrahtung (s. unwired-Hinweisliste).
//
// W-CORE: fail-closed Residential-Gate (nur residential+b2c baut, alles
// andere wirft SchematicScopeError) plus Determinismus-Haertung (stabile
// Sortierung, JCS-kanonische Netzliste mit Hash). Der Legacy-Builder bleibt
// ohne Scope-Argument byte-identisch (Ansicht + Bestandstests).

import { createHash } from "node:crypto";

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
 *
 * Der optionale Scope schaltet das Residential-Gate zu (commercial/b2b
 * oder unbekannt -> SchematicScopeError); ohne Scope bleibt das Ergebnis
 * byte-identisch zum bisherigen Verhalten.
 */
export function buildSingleLineSchematic(
  sections: readonly SchematicSectionInput[],
  scope?: SchematicScopeInput,
): SingleLineSchematic {
  if (scope !== undefined) assertResidentialSchematicScope(scope);
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

// ─── W-CORE: Residential-Gate + Determinismus-Haertung ─────────────────

export const SCHEMATIC_NETLIST_VERSION = "schematic-netlist.v1" as const;
export const SCHEMATIC_CANONICALIZATION_VERSION = "schematic-jcs.v1" as const;

export class SchematicScopeError extends Error {
  constructor(detail = "schematic is limited to residential B2C scope") {
    super(detail);
    this.name = "SchematicScopeError";
  }
}

/**
 * Offer-Scope-Felder (vollstaendig, Fleet-Vertrag W-CORE-4-Felder-Modell):
 * offer.scope + offer.price_audience + kanban_board.scope (boardScope) +
 * price_audience_decision.audience (audience). Residential gilt nur bei
 * exakt residential+b2c+residential+b2c; jede commercial/b2b-Angabe — wie
 * jede unbekannte oder fehlende — verwirft fail-closed. Dieselbe
 * Entscheidungsgrenze nutzt die Erstöffnen-Action ueber
 * `resolveSchematicScope` (dort als Status statt Throw).
 */
export type SchematicScopeInput = {
  scope: unknown;
  priceAudience: unknown;
  boardScope: unknown;
  audience: unknown;
};

export function assertResidentialSchematicScope(input: unknown): void {
  const fail = (): never => {
    throw new SchematicScopeError();
  };
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  const record = input as Record<string, unknown>;
  if (record["scope"] !== "residential") fail();
  if (record["priceAudience"] !== "b2c") fail();
  if (record["boardScope"] !== "residential") fail();
  if (record["audience"] !== "b2c") fail();
}

/**
 * Status-Variante des Residential-Gates (identische Entscheidungsgrenze wie
 * `assertResidentialSchematicScope`, kein Throw): `commercial` ist fail-closed
 * Default. Einzige Regelstelle — Server-Action und Ansicht nutzen sie.
 */
export function resolveSchematicScope(input: {
  scope: unknown;
  priceAudience: unknown;
  boardScope: unknown;
  audience: unknown;
}): "residential" | "commercial" {
  try {
    assertResidentialSchematicScope(input);
    return "residential";
  } catch {
    return "commercial";
  }
}

/** Code-Unit-Vergleich: deterministisch ueber alle ICU-Versionen (kein localeCompare). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * NFC-Vergleich mit Raw-Tiebreak: Zwei Titel, die erst nach NFC gleich sind,
 * sortieren identisch, egal ob die Eingabe komponiert oder zerlegt war.
 */
function compareNfcText(a: string, b: string): number {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortSingleLineSchematic(schematic: SingleLineSchematic): SingleLineSchematic {
  const nodes = schematic.nodes.map((node) => ({ ...node }));
  nodes.sort((a, b) => compareCodeUnits(a.id, b.id));
  const edges = schematic.edges.map((edge) => ({ ...edge }));
  edges.sort(
    (a, b) =>
      compareCodeUnits(a.from, b.from) ||
      compareCodeUnits(a.to, b.to) ||
      compareCodeUnits(a.label, b.label),
  );
  const unwired = [...schematic.unwired].sort(compareNfcText);
  return { nodes, edges, unwired, empty: schematic.empty };
}

const SCHEMATIC_SECTION_RANK: Record<SchematicCategory, number> = {
  module: 0,
  inverter: 1,
  battery: 2,
  wallbox: 3,
  heat_pump: 4,
  mounting: 5,
  other: 6,
};

function compareSections(a: SchematicSectionInput, b: SchematicSectionInput): number {
  return (
    SCHEMATIC_SECTION_RANK[a.category] - SCHEMATIC_SECTION_RANK[b.category] ||
    compareNfcText(a.title, b.title) ||
    compareNfcText(a.quantityLabel ?? "", b.quantityLabel ?? "")
  );
}

/**
 * Strenger Builder: Gate ist Pflicht (fail-closed), Duplikat-Kategorien
 * gewinnen deterministisch (kleinster Titel), das Ergebnis ist stabil
 * sortiert. Einstieg fuer Persistierung und Hash-Vergleiche.
 */
export function buildResidentialSingleLineSchematic(
  sections: readonly SchematicSectionInput[],
  scope: SchematicScopeInput,
): SingleLineSchematic {
  assertResidentialSchematicScope(scope);
  const ordered = [...sections].sort(compareSections);
  return sortSingleLineSchematic(buildSingleLineSchematic(ordered));
}

type SchematicJsonValue =
  | null
  | boolean
  | number
  | string
  | SchematicJsonValue[]
  | { [key: string]: SchematicJsonValue };

function hasWellFormedUnicode(value: string): boolean {
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeSchematicJsonValue(value: unknown, seen: Set<object>): SchematicJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Schematic-JSON erlaubt nur sichere Ganzzahlen.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Schematic-JSON.");
    }
    return value.normalize("NFC");
  }
  if (typeof value !== "object") {
    throw new TypeError("Nicht persistierbarer Wert im Schematic-JSON.");
  }
  if (seen.has(value)) throw new TypeError("Zyklus im Schematic-JSON.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeSchematicJsonValue(entry, seen));
    }
    const result: Record<string, SchematicJsonValue> = {};
    for (const [rawKey, entry] of Object.entries(value)) {
      if (!hasWellFormedUnicode(rawKey)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Schematic-JSON-Schluessel.");
      }
      const key = rawKey.normalize("NFC");
      if (Object.hasOwn(result, key)) {
        throw new TypeError("Kollidierende normalisierte Schematic-JSON-Schluessel.");
      }
      result[key] = normalizeSchematicJsonValue(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function serializeSchematicJson(current: SchematicJsonValue): string {
  if (current === null || typeof current !== "object") {
    return JSON.stringify(current);
  }
  if (Array.isArray(current)) {
    return `[${current.map(serializeSchematicJson).join(",")}]`;
  }
  const keys = Object.keys(current).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeSchematicJson(current[key]!)}`).join(",")}}`;
}

/**
 * JCS-kanonische Netzliste (schematic-jcs.v1): sortiert Knoten/Kanten/
 * Hinweise vor dem Serialisieren, damit aequivalente Schaltbilder byte-
 * identisch kanonisieren. `empty` ist abgeleitet und kein Hash-Material.
 */
export function canonicalizeSchematicNetlist(schematic: SingleLineSchematic): string {
  if (typeof schematic !== "object" || schematic === null || Array.isArray(schematic)) {
    throw new TypeError("Schematic-Netzliste muss ein Objekt sein.");
  }
  if (
    !Array.isArray(schematic.nodes) ||
    !Array.isArray(schematic.edges) ||
    !Array.isArray(schematic.unwired)
  ) {
    throw new TypeError("Schematic-Netzliste ist unvollstaendig.");
  }
  const sorted = sortSingleLineSchematic(schematic);
  const payload = {
    schemaVersion: SCHEMATIC_NETLIST_VERSION,
    nodes: sorted.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      sub: node.sub,
      x: node.x,
      y: node.y,
    })),
    edges: sorted.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
    })),
    unwired: [...sorted.unwired],
  };
  return serializeSchematicJson(normalizeSchematicJsonValue(payload, new Set()));
}

export function hashSchematicNetlist(schematic: SingleLineSchematic): string {
  return createHash("sha256").update(canonicalizeSchematicNetlist(schematic), "utf8").digest("hex");
}
