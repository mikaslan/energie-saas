// F6-02a/W-SVC Overlay-Service: saveSchematicOverlay/readSchematicOverlay
// sichern das Editor-Overlay je (Angebot, Varianten-Revision) in
// `schematic_overlays` (0301, W-DB-Lane) — idempotent (nur Element-Drift
// schreibt mit revision+1/CAS), fail-closed residential (commercial ->
// SchematicScopeError, Scope live aus offer+Board, W-CORE-4-Felder-Modell)
// und tenant-isoliert. Genau eine Zeile je Key; kein History-Append.
//
// Parent-Pin (SPEC docs/spec/F6-02a-editor-overlay.md): Das Overlay haengt
// an der Diagramm-Revision von `schematic_diagrams`; Schreiben gegen eine
// veraltete Revision antwortet mit SchematicConflictError statt still zu
// ueberschreiben. Der 0301-Key enthaelt keine variant_id — ein
// Varianten-Stempel wie in ensureSchematicDiagram entfaellt daher.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import {
  EDITOR_OVERLAY_MAX_ELEMENTS,
  overlayElementSchema,
  type OverlayElementInput,
} from "@/lib/integrations/schematic/editor-overlay-v1";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  SchematicConflictError,
  SchematicScopeError,
  SchematicValidationError,
} from "./errors";

export type SaveSchematicOverlayResult = {
  offerId: string;
  variantRevision: number;
  revision: number;
  previousRevision: number | null;
  parentRevision: number;
  changed: boolean;
};

export type ReadSchematicOverlayResult = {
  revision: number;
  parentRevision: number;
  elements: OverlayElementInput[];
} | null;

/** Speicherumschlag in schematic_overlays.elements (0301-CHECK-kompatibel). */
export type SchematicStoredOverlay = {
  elements: OverlayElementInput[];
};

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.int().min(1).max(2_147_483_647);

const saveCommandSchema = z.strictObject({
  offerId: uuidSchema,
  variantRevision: revisionSchema,
  parentRevision: revisionSchema,
  expectedRevision: z.int().min(0).max(2_147_483_647).optional(),
  elements: z.array(overlayElementSchema).max(EDITOR_OVERLAY_MAX_ELEMENTS),
});

const readCommandSchema = z.strictObject({
  offerId: uuidSchema,
  variantRevision: revisionSchema,
});

type ScopeRow = {
  scope: unknown;
  price_audience: unknown;
  board_scope: unknown;
  audience: unknown;
  [key: string]: unknown;
};

type OverlayRow = {
  id: string;
  revision: number;
  parent_revision: number;
  elements: unknown;
  [key: string]: unknown;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

function constraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  if (typeof candidate.constraint === "string") return candidate.constraint;
  if (typeof candidate.cause === "object" && candidate.cause !== null) {
    const cause = candidate.cause as { constraint?: unknown };
    if (typeof cause.constraint === "string") return cause.constraint;
  }
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const direct = (error as { code?: unknown }).code;
  if (direct === "23505") return true;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null
    && (cause as { code?: unknown }).code === "23505";
}

function requireAccess(ctx: ServiceCtx): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "schematic_overlays", undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.write",
      "schematic_overlays",
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function isResidentialScope(row: ScopeRow): boolean {
  return row.scope === "residential"
    && row.price_audience === "b2c"
    && row.board_scope === "residential"
    && row.audience === "b2c";
}

/** jsonb sortiert Objektschluessel um — Gleichheit daher kanonisch pruefen. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Umschlag lesen und fail-closed validieren (Korruption -> undefined). */
function storedOverlayElements(envelope: unknown): OverlayElementInput[] | undefined {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return undefined;
  }
  const elements = (envelope as Record<string, unknown>)["elements"];
  if (!Array.isArray(elements)) return undefined;
  const validated: OverlayElementInput[] = [];
  for (const entry of elements) {
    const parsed = overlayElementSchema.safeParse(entry);
    if (!parsed.success) return undefined;
    validated.push(parsed.data);
  }
  return validated;
}

export async function saveSchematicOverlay(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SaveSchematicOverlayResult> {
  requireAccess(ctx);
  const parsed = saveCommandSchema.safeParse(value);
  if (!parsed.success) throw new SchematicValidationError(issuePaths(parsed.error));
  const command = parsed.data;

  // Scope live aus offer+Board (W-CORE-4-Felder-Modell, Muster
  // ensureSchematicDiagram): behauptete Scopes aus dem Aufruf zaehlen nicht.
  const scopeResult = await tx.execute<ScopeRow>(sql`
    select offer_record.scope as scope,
           offer_record.price_audience as price_audience,
           board.scope as board_scope,
           offer_record.price_audience_decision ->> 'audience' as audience
      from offer offer_record
      join project project_record
        on project_record.workspace_id = offer_record.workspace_id
       and project_record.id = offer_record.project_id
      join kanban_board board
        on board.workspace_id = offer_record.workspace_id
       and board.id = project_record.kanban_board_id
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and offer_record.id = ${command.offerId}::uuid
     limit 1
  `);
  const scopeRow = scopeResult.rows[0];
  if (!scopeRow) throw new SchematicValidationError(["/offerId"]);
  if (!isResidentialScope(scopeRow)) throw new SchematicScopeError();

  // Parent-Pin: Ohne Diagramm-Zeile gibt es nichts zu bepinseln.
  const diagramResult = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    select revision
      from schematic_diagrams
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and variant_revision = ${command.variantRevision}
     limit 1
  `);
  const diagramRow = diagramResult.rows[0];
  if (!diagramRow) throw new SchematicValidationError(["/parentRevision"]);

  const existing = await tx.execute<OverlayRow>(sql`
    select id, revision, parent_revision, elements
      from schematic_overlays
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and variant_revision = ${command.variantRevision}
     limit 1
     for update
  `);
  const row = existing.rows[0];

  // Kein Editieren gegen veraltetes Auto-Gen (Parent-Mismatch -> Konflikt).
  if (command.parentRevision !== diagramRow.revision) {
    throw new SchematicConflictError(row?.revision ?? undefined);
  }

  const stored: SchematicStoredOverlay = { elements: command.elements };
  const storedJson = JSON.stringify(stored);

  if (!row) {
    if (command.expectedRevision !== undefined && command.expectedRevision !== 0) {
      throw new SchematicConflictError();
    }
    const createdBy = z.uuid().safeParse(ctx.actor).success ? ctx.actor : null;
    try {
      await tx.execute(sql`
        insert into schematic_overlays (
          workspace_id, offer_id, variant_revision, parent_revision,
          elements, element_count, revision, created_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.offerId}::uuid, ${command.variantRevision},
          ${command.parentRevision}, ${storedJson}::jsonb,
          ${stored.elements.length}::integer, 1, ${createdBy}::uuid
        )
      `);
    } catch (error) {
      if (
        constraintName(error) === "schematic_overlays_ws_offer_revision_uq"
        || isUniqueViolation(error)
      ) {
        throw new SchematicConflictError(
          await readRevision(tx, ctx, command.offerId, command.variantRevision) ?? undefined,
        );
      }
      throw error;
    }
    return {
      offerId: command.offerId,
      variantRevision: command.variantRevision,
      revision: 1,
      previousRevision: null,
      parentRevision: command.parentRevision,
      changed: true,
    };
  }

  // SPEC (Sperren): Schreiben nur per CAS — ein fehlender
  // expectedRevision ist kein Freifahrtschein (stale Client darf einen
  // neueren Stand nie still ueberschreiben).
  if (command.expectedRevision === undefined || command.expectedRevision !== row.revision) {
    throw new SchematicConflictError(row.revision);
  }
  const previousElements = storedOverlayElements(row.elements);
  if (
    previousElements !== undefined
    && canonicalJson(previousElements) === canonicalJson(command.elements)
  ) {
    return {
      offerId: command.offerId,
      variantRevision: command.variantRevision,
      revision: row.revision,
      previousRevision: null,
      parentRevision: command.parentRevision,
      changed: false,
    };
  }
  const nextRevision = row.revision + 1;
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update schematic_overlays
       set revision = ${nextRevision},
           parent_revision = ${command.parentRevision},
           elements = ${storedJson}::jsonb,
           element_count = ${stored.elements.length}::integer,
           updated_at = clock_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and variant_revision = ${command.variantRevision}
       and revision = ${row.revision}
    returning id
  `);
  if (!updated.rows[0]) {
    throw new SchematicConflictError(
      await readRevision(tx, ctx, command.offerId, command.variantRevision) ?? undefined,
    );
  }
  return {
    offerId: command.offerId,
    variantRevision: command.variantRevision,
    revision: nextRevision,
    previousRevision: row.revision,
    parentRevision: command.parentRevision,
    changed: true,
  };
}

export async function readSchematicOverlay(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: { offerId: string; variantRevision: number },
): Promise<ReadSchematicOverlayResult> {
  requireAccess(ctx);
  const parsed = readCommandSchema.safeParse(value);
  if (!parsed.success) return null;
  const command = parsed.data;

  const scopeResult = await tx.execute<ScopeRow>(sql`
    select offer_record.scope as scope,
           offer_record.price_audience as price_audience,
           board.scope as board_scope,
           offer_record.price_audience_decision ->> 'audience' as audience
      from offer offer_record
      join project project_record
        on project_record.workspace_id = offer_record.workspace_id
       and project_record.id = offer_record.project_id
      join kanban_board board
        on board.workspace_id = offer_record.workspace_id
       and board.id = project_record.kanban_board_id
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and offer_record.id = ${command.offerId}::uuid
     limit 1
  `);
  const scopeRow = scopeResult.rows[0];
  if (!scopeRow) return null;
  if (!isResidentialScope(scopeRow)) throw new SchematicScopeError();

  const existing = await tx.execute<OverlayRow>(sql`
    select revision, parent_revision, elements
      from schematic_overlays
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and variant_revision = ${command.variantRevision}
     limit 1
  `);
  const row = existing.rows[0];
  if (!row) return null;
  const elements = storedOverlayElements(row.elements);
  if (elements === undefined) return null;
  return { revision: row.revision, parentRevision: row.parent_revision, elements };
}

async function readRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
  variantRevision: number,
): Promise<number | null> {
  const result = await tx.execute<OverlayRow>(sql`
    select revision
      from schematic_overlays
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and variant_revision = ${variantRevision}
     limit 1
  `);
  return result.rows[0]?.revision ?? null;
}
