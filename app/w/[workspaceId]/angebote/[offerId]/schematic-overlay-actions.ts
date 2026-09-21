"use server";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { assignOverlayIds } from "@/lib/integrations/schematic/editor-overlay-v1";
import { PermissionDeniedError } from "@/lib/permissions";
// Signatur-Muster (signature-actions.ts): Der Service traegt `server-only`
// und darf statisch nicht in die Client-Importkette (Formular);
// Typen statisch, Implementierung per dynamischem Import zur Laufzeit.
import type * as SchematicModule from "@/modules/schematic";

/**
 * F6-02a · Overlay-Server-Actions (Speichern und Laden des Anordnungs-Overlays).
 *
 * Persistenz: Tabelle `schematic_overlays` (W-DB, Unique-Key
 * (workspace_id, offer_id, variant_revision)). Der Schreibpfad läuft über
 * `saveSchematicOverlay` (idempotent: identischer Inhalt meldet `unchanged`,
 * abweichender Inhalt bei gleichem `parentRevision` inkrementiert `revision`).
 * Der Lesepfad läuft über `readSchematicOverlay` und liefert zusätzlich die
 * Diagramm-Revision aus `schematic_diagrams` (null, wenn noch kein Diagramm
 * gespeichert wurde).
 *
 * Scope-Gate (fail-closed): commercial/b2b meldet `gated` ohne Overlay.
 * Fehlt eine Tabelle (Lane noch nicht gemergt), meldet die Action
 * `unavailable` (kein Throw, kein Crash).
 *
 * Keine neue Permission (nutzt `project.write`).
 */

export type SaveSchematicOverlayStatus =
  | "saved"
  | "unchanged"
  | "conflict"
  | "gated"
  | "denied"
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type SaveSchematicOverlayActionResult = {
  status: SaveSchematicOverlayStatus;
  revision?: number;
  parentRevision?: number;
};

export type SaveSchematicOverlayInput = {
  workspaceId: string;
  offerId: string;
  variantRevision: number;
  parentRevision: number;
  expectedRevision?: number;
  elements: unknown[];
};

export type LoadSchematicOverlayStatus =
  | "loaded"
  | "gated"
  | "denied"
  | "unauthenticated"
  | "invalid"
  | "unavailable";

export type LoadSchematicOverlayResult = {
  status: LoadSchematicOverlayStatus;
  overlay: SchematicModule.ReadSchematicOverlayResult | null;
  diagramRevision: number | null;
  /**
   * F6-02c-A/CONTRACT: paralleles Array zu `overlay.elements` (gleiche
   * Laenge und Reihenfolge); vergebene `ovl-*`-ID je Zeile oder `null`
   * (Konnektor, ungespeichert, fail-closed). `[]`, wenn kein Overlay
   * geladen wurde.
   */
  elementIds: (string | null)[];
};

export type LoadSchematicOverlayInput = {
  workspaceId: string;
  offerId: string;
  variantRevision: number;
};

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

const saveOverlaySchema = z.strictObject({
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  variantRevision: z.int().min(1),
  parentRevision: z.int().min(1),
  expectedRevision: z.int().min(0).optional(),
  elements: z.array(z.unknown()).max(32),
});

const loadOverlaySchema = z.strictObject({
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  variantRevision: z.int().min(1),
});

function pgErrorCode(error: unknown): string | null {
  // Drizzle haengt den pg-Fehler teils unter .cause an (Muster
  // isUniqueViolation im Service) — beide Ebenen lesen.
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string") return nested;
  }
  return null;
}

/** F6-02c-A: Backbone-IDs aus dem gespeicherten Netz — fail-closed null. */
function backboneIdsFromNetlist(netlist: unknown): string[] | null {
  if (typeof netlist !== "object" || netlist === null) return null;
  const nodes = (netlist as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  const ids: string[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) return null;
    const id = (node as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * F6-02c-A (GREEN): paralleles ID-Array zu den Overlay-Zeilen
 * (Server-Mapping, deterministisch). Ohne Diagramm-Zeile, bei
 * fehlerhaftem Netz oder Validierungsfehler: alles `null`
 * (fail-closed: keine Anzeige statt falscher Anzeige).
 */
function toElementIds(
  netlist: unknown,
  overlay: SchematicModule.ReadSchematicOverlayResult,
): (string | null)[] {
  if (overlay === null) return [];
  const backboneIds = backboneIdsFromNetlist(netlist);
  if (backboneIds === null) return overlay.elements.map(() => null);
  try {
    const assigned = assignOverlayIds(backboneIds, overlay.elements);
    const idByIndex = new Map(assigned.map((entry) => [entry.index, entry.id]));
    return overlay.elements.map((_, index) => idByIndex.get(index) ?? null);
  } catch {
    return overlay.elements.map(() => null);
  }
}

function toSaveResult(
  result: SchematicModule.SaveSchematicOverlayResult,
): SaveSchematicOverlayActionResult {
  return {
    status: result.changed ? "saved" : "unchanged",
    revision: result.revision,
    parentRevision: result.parentRevision,
  };
}

export async function saveSchematicOverlayAction(
  input: SaveSchematicOverlayInput,
): Promise<SaveSchematicOverlayActionResult> {
  const parsed = saveOverlaySchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  const command = parsed.data;

  try {
    return await authorizedAction(
      command.workspaceId,
      "project.write",
      "schematic_overlays",
      async (tx, ctx) => {
        const services = await import("@/modules/schematic");
        try {
          const result = await services.saveSchematicOverlay(tx, ctx, {
            offerId: command.offerId,
            variantRevision: command.variantRevision,
            parentRevision: command.parentRevision,
            expectedRevision: command.expectedRevision,
            elements: command.elements,
          });
          return toSaveResult(result);
        } catch (error) {
          // Optimistischer Konflikt: fremde Revision dazwischen — Client lädt neu.
          if (error instanceof services.SchematicConflictError) {
            return { status: "conflict" } as const;
          }
          // Commercial/b2b: Overlays sind residential-only.
          if (error instanceof services.SchematicScopeError) return { status: "gated" } as const;
          // Fachlich ungültiges Overlay (Element-Limit, Form).
          if (error instanceof services.SchematicValidationError) {
            return { status: "invalid" } as const;
          }
          // Overlay-Tabelle fehlt (Lane noch nicht gemergt): ehrlicher Status.
          if (pgErrorCode(error) === "42P01") return { status: "unavailable" } as const;
          // Offer/Variante zwischenzeitlich entfallen: kein Save, kein Crash.
          if (pgErrorCode(error) === "23503") return { status: "not_found" } as const;
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    throw error;
  }
}

export async function loadSchematicOverlayAction(
  input: LoadSchematicOverlayInput,
): Promise<LoadSchematicOverlayResult> {
  const parsed = loadOverlaySchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", overlay: null, diagramRevision: null, elementIds: [] };
  }
  const command = parsed.data;

  try {
    return await authorizedAction(
      command.workspaceId,
      "project.write",
      "schematic_overlays",
      async (tx, ctx) => {
        const services = await import("@/modules/schematic");
        let overlay: SchematicModule.ReadSchematicOverlayResult;
        try {
          overlay = await services.readSchematicOverlay(tx, ctx, {
            offerId: command.offerId,
            variantRevision: command.variantRevision,
          });
        } catch (error) {
          // Commercial/b2b: kein Overlay, keine Diagramm-Revision.
          if (error instanceof services.SchematicScopeError) {
            return { status: "gated", overlay: null, diagramRevision: null, elementIds: [] };
          }
          // Overlay-Tabelle fehlt (Lane noch nicht gemergt): ehrlicher Status.
          if (pgErrorCode(error) === "42P01") {
            return { status: "unavailable", overlay: null, diagramRevision: null, elementIds: [] };
          }
          throw error;
        }

        // Zugehörige Diagramm-Zeile laden (Revision + Netz fuer das
        // F6-02c-A-ID-Mapping; null, wenn noch nie gespeichert).
        try {
          const diagram = await tx.execute<{ revision: unknown; netlist: unknown }>(sql`
            select revision, netlist
              from schematic_diagrams
             where workspace_id = ${command.workspaceId}::uuid
               and offer_id = ${command.offerId}::uuid
               and variant_revision = ${command.variantRevision}::integer
             limit 1
          `);
          const raw = diagram.rows[0]?.revision;
          const diagramRevision = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
          const elementIds = toElementIds(diagram.rows[0]?.netlist, overlay);
          return { status: "loaded", overlay, diagramRevision, elementIds };
        } catch (error) {
          // Diagramm-Tabelle fehlt (F6-01-Lane noch nicht gemergt): ehrlicher Status.
          if (pgErrorCode(error) === "42P01") {
            return { status: "unavailable", overlay: null, diagramRevision: null, elementIds: [] };
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { status: "unauthenticated", overlay: null, diagramRevision: null, elementIds: [] };
    }
    if (error instanceof PermissionDeniedError) {
      return { status: "denied", overlay: null, diagramRevision: null, elementIds: [] };
    }
    throw error;
  }
}
