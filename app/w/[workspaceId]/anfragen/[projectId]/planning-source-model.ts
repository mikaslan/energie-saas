// F3-02 Dachquellen-Registry (Batch-1, providerfrei): geteiltes DTO plus
// reine Helfer. Absichtlich ohne "use client"/"use server", damit
// Server-Actions, Server-Panel und Client-Sektion dieselbe Abbildung
// nutzen. Storage-Bytes liegen WORM (immutableKey + putImmutable); die DB
// speichert nur Key/Pruefsumme/Groesse — der Anzeigename wird aus dem
// deterministischen Key-Suffix rekonstruiert.
export type PlanningSourceKind = "upload" | "self_drawn";

export type PlanningSourceScaleRef = {
  meters: number;
  pixelLength: number;
};

export type PlanningSourceDto = {
  id: string;
  kind: PlanningSourceKind;
  filename: string | null;
  scaleRef: PlanningSourceScaleRef | null;
  createdAt: string;
};

export const PLANNING_SOURCE_KIND_LABEL: Record<PlanningSourceKind, string> = {
  upload: "Upload",
  self_drawn: "Selbstzeichnung",
};

export type PlanningSourceRow = {
  id: string;
  kind: string;
  storage_key: string | null;
  scale_ref_json: unknown;
  created_at: string | Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Key-Format (Actions): `<stem>_<sha8>.<ext>` unter
// `immutable/<workspace>/planning-sources/`. Rueckweg fuer die Anzeige:
// letztes `_<8hex>`-Suffix abtrennen, Rest + Extension ist der Dateiname.
export function planningSourceDisplayFilename(storageKey: string | null): string | null {
  if (typeof storageKey !== "string" || storageKey.length === 0) return null;
  const basename = storageKey.split("/").at(-1) ?? "";
  if (basename.length === 0) return null;
  const match = /^(.*)_([0-9a-f]{8})\.(png|jpg|jpeg)$/u.exec(basename);
  if (!match?.[1]) return basename;
  const extension = match[3] === "jpg" ? "jpg" : match[3];
  return `${match[1]}.${extension}`;
}

export function planningSourceScaleRef(value: unknown): PlanningSourceScaleRef | null {
  const candidate: unknown = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;
  if (!isRecord(candidate)) return null;
  const meters = candidate.meters;
  const pixelLength = candidate.pixelLength;
  if (typeof meters !== "number" || typeof pixelLength !== "number") return null;
  if (!Number.isFinite(meters) || !Number.isFinite(pixelLength)) return null;
  if (meters <= 0 || pixelLength <= 0) return null;
  return { meters, pixelLength };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: unbekannte kind-Werte (DB-CHECK laesst nur upload +
// self_drawn zu) werden nicht geraten, sondern uebersprungen.
export function toPlanningSourceDto(row: PlanningSourceRow): PlanningSourceDto | null {
  if (row.kind !== "upload" && row.kind !== "self_drawn") return null;
  return {
    id: row.id,
    kind: row.kind,
    filename: row.kind === "upload" ? planningSourceDisplayFilename(row.storage_key) : null,
    scaleRef: row.kind === "upload" ? planningSourceScaleRef(row.scale_ref_json) : null,
    createdAt: toIso(row.created_at),
  };
}
