// F6-01/W-CORE Save-Service: ensureSchematicDiagram sichert den aktuellen
// Schaltplan-Abbild je (Angebot, Varianten-Revision) in `schematic_diagrams`
// (0300, W-DB-Lane) — idempotent (nur Hash-Drift schreibt mit revision+1/CAS),
// fail-closed residential (commercial/b2b -> SchematicScopeError, Scope live
// aus offer+Board gelesen, W-CORE-4-Felder-Modell) und tenant-isoliert.
//
// Zusammenspiel mit der Erstöffnen-Action (Nachbar-Lane): Die Action legt
// per on-conflict-do-nothing an (Status saved/already_saved), dieser Service
// erkennt zusaetzlich Drift (JCS-Netzlisten-Hash, schematic-jcs.v1) und
// schreibt neu aus. Genau eine Zeile je Key; kein History-Append.
//
// Varianten-Stempel: Der 0300-Key enthaelt keine variant_id (Fleet-Follow-up).
// Der Abbild traegt die Besitzer-Variante im Umschlag (netlist.variantId);
// fremd gestempelte Zeilen beantwortet ensure mit SchematicConflictError
// statt sie zu ueberschreiben. Ungestempelte Altzeilen (Action-Format
// {nodes,edges}) werden bei Hash-Gleichheit adoptiert und bei Drift nur im
// Ein-Varianten-Angebot uebernommen — sonst Konflikt.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import {
  buildResidentialSingleLineSchematic,
  hashSchematicNetlist,
  SchematicScopeError,
  type SchematicEdge,
  type SchematicNode,
  type SingleLineSchematic,
} from "@/lib/integrations/schematic/single-line-v1";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import { SchematicConflictError, SchematicValidationError } from "./errors";

export type EnsureSchematicDiagramResult = {
  offerId: string;
  variantId: string;
  revision: number;
  previousRevision: number | null;
  variantRevision: number;
  netlistSha256: string;
  changed: boolean;
};

/** Speicherumschlag in schematic_diagrams.netlist (0300-CHECK-kompatibel). */
export type SchematicStoredNetlist = {
  nodes: SchematicNode[];
  edges: SchematicEdge[];
  unwired: string[];
  variantId: string;
};

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.int().min(1).max(2_147_483_647);

const sectionSchema = z.strictObject({
  category: z.enum([
    "module",
    "inverter",
    "battery",
    "wallbox",
    "heat_pump",
    "mounting",
    "other",
  ]),
  // PostgreSQL jsonb kann U+0000 nicht abbilden — wie an der Offer-Grenze
  // als Feldfehler abweisen statt spaeter als Persistenzfehler.
  title: z.string().min(1).max(200).refine((value) => !value.includes("\u0000")),
  quantityLabel: z.string().min(1).max(120).refine((value) => !value.includes("\u0000")).nullable(),
});

const ensureCommandSchema = z.strictObject({
  offerId: uuidSchema,
  variantId: uuidSchema,
  variantRevision: revisionSchema,
  sections: z.array(sectionSchema).max(25),
  expectedRevision: z.int().min(0).max(2_147_483_647).optional(),
});

type ScopeRow = {
  scope: unknown;
  price_audience: unknown;
  board_scope: unknown;
  audience: unknown;
  [key: string]: unknown;
};

type DiagramRow = {
  id: string;
  revision: number;
  netlist: unknown;
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
    throw new PermissionDeniedError("project.write", "schematic_diagrams", undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.write",
      "schematic_diagrams",
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function storedHash(netlist: unknown): string | undefined {
  if (typeof netlist !== "object" || netlist === null || Array.isArray(netlist)) {
    return undefined;
  }
  const record = netlist as Record<string, unknown>;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) return undefined;
  const unwired = Array.isArray(record["unwired"]) ? record["unwired"] : [];
  try {
    return hashSchematicNetlist({
      nodes: record["nodes"] as SchematicNode[],
      edges: record["edges"] as SchematicEdge[],
      unwired: unwired as string[],
      empty: false,
    });
  } catch {
    // Nicht kanonisierbarer Altstand (z. B. nicht-ganzzahlige Koordinaten
    // aus handgebauten Netzen): als Drift behandeln, nie angleichen.
    return undefined;
  }
}

function storedVariantId(netlist: unknown): string | undefined {
  if (typeof netlist !== "object" || netlist === null || Array.isArray(netlist)) {
    return undefined;
  }
  const candidate = (netlist as Record<string, unknown>)["variantId"];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * F6-01 · Lesender Schaltplan-Scope fuer die Angebotsdetailansicht
 * (W-CORE-4-Felder-Modell, live aus offer+Board). Fehlendes Angebot
 * faellt fail-closed auf "commercial" (Gate-Hinweis statt Diagramm).
 */
export async function readSchematicScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: { offerId: string },
): Promise<"residential" | "commercial"> {
  const offerId = z.uuid().safeParse(value.offerId).success
    ? value.offerId.toLowerCase()
    : null;
  if (!offerId) return "commercial";
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
       and offer_record.id = ${offerId}::uuid
     limit 1
  `);
  const row = scopeResult.rows[0];
  if (!row) return "commercial";
  return row.scope === "residential"
    && row.price_audience === "b2c"
    && row.board_scope === "residential"
    && row.audience === "b2c"
    ? "residential"
    : "commercial";
}

export async function ensureSchematicDiagram(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<EnsureSchematicDiagramResult> {
  requireAccess(ctx);
  const parsed = ensureCommandSchema.safeParse(value);
  if (!parsed.success) throw new SchematicValidationError(issuePaths(parsed.error));
  const command = parsed.data;

  // Scope live aus offer+Board (W-CORE-4-Felder-Modell, Muster
  // Erstöffnen-Action): behauptete Scopes aus dem Aufruf zaehlen nicht.
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
  const variantResult = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.variantId}::uuid
       and offer_id = ${command.offerId}::uuid
     limit 1
  `);
  if (!variantResult.rows[0]) throw new SchematicValidationError(["/variantId"]);

  let schematic: SingleLineSchematic;
  let netlistSha256: string;
  try {
    schematic = buildResidentialSingleLineSchematic(command.sections, {
      scope: scopeRow.scope,
      priceAudience: scopeRow.price_audience,
      boardScope: scopeRow.board_scope,
      audience: scopeRow.audience,
    });
    netlistSha256 = hashSchematicNetlist(schematic);
  } catch (error) {
    if (error instanceof SchematicScopeError) throw error;
    throw new SchematicValidationError(["/sections"]);
  }

  const stored: SchematicStoredNetlist = {
    nodes: schematic.nodes,
    edges: schematic.edges,
    unwired: schematic.unwired,
    variantId: command.variantId,
  };
  const storedJson = JSON.stringify(stored);

  const existing = await tx.execute<DiagramRow>(sql`
    select id, revision, netlist
      from schematic_diagrams
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and variant_revision = ${command.variantRevision}
     limit 1
     for update
  `);
  const row = existing.rows[0];
  if (!row) {
    if (command.expectedRevision !== undefined && command.expectedRevision !== 0) {
      throw new SchematicConflictError();
    }
    const createdBy = z.uuid().safeParse(ctx.actor).success ? ctx.actor : null;
    try {
      await tx.execute(sql`
        insert into schematic_diagrams (
          workspace_id, offer_id, variant_revision, netlist,
          node_count, edge_count, revision, created_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.offerId}::uuid, ${command.variantRevision},
          ${storedJson}::jsonb,
          ${stored.nodes.length}::integer, ${stored.edges.length}::integer,
          1, ${createdBy}::uuid
        )
      `);
    } catch (error) {
      if (
        constraintName(error) === "schematic_diagrams_ws_offer_revision_uq"
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
      variantId: command.variantId,
      revision: 1,
      previousRevision: null,
      variantRevision: command.variantRevision,
      netlistSha256,
      changed: true,
    };
  }

  // Varianten-Stempel vor CAS: fremde Zeilen nie ueberschreiben.
  const owner = storedVariantId(row.netlist);
  const previousHash = storedHash(row.netlist);
  const drifted = previousHash === undefined || previousHash !== netlistSha256;
  if (owner !== undefined && owner !== command.variantId) {
    throw new SchematicConflictError(row.revision);
  }
  if (owner === undefined && drifted && !(await isSingleVariantOffer(tx, ctx, command.offerId))) {
    throw new SchematicConflictError(row.revision);
  }
  const expected = command.expectedRevision ?? row.revision;
  if (expected !== row.revision) {
    throw new SchematicConflictError(row.revision);
  }
  if (!drifted) {
    return {
      offerId: command.offerId,
      variantId: command.variantId,
      revision: row.revision,
      previousRevision: null,
      variantRevision: command.variantRevision,
      netlistSha256,
      changed: false,
    };
  }
  const nextRevision = row.revision + 1;
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update schematic_diagrams
       set revision = ${nextRevision},
           netlist = ${storedJson}::jsonb,
           node_count = ${stored.nodes.length}::integer,
           edge_count = ${stored.edges.length}::integer,
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
    variantId: command.variantId,
    revision: nextRevision,
    previousRevision: row.revision,
    variantRevision: command.variantRevision,
    netlistSha256,
    changed: true,
  };
}

async function readRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
  variantRevision: number,
): Promise<number | null> {
  const result = await tx.execute<DiagramRow>(sql`
    select revision
      from schematic_diagrams
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and variant_revision = ${variantRevision}
     limit 1
  `);
  return result.rows[0]?.revision ?? null;
}

async function isSingleVariantOffer(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
): Promise<boolean> {
  const result = await tx.execute<{ n: number; [key: string]: unknown }>(sql`
    select count(*)::int as n
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
  `);
  return (result.rows[0]?.n ?? 0) === 1;
}
