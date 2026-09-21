"use server";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  resolveSchematicScope,
  type SingleLineSchematic,
} from "@/lib/integrations/schematic/single-line-v1";
import { PermissionDeniedError } from "@/lib/permissions";

/**
 * F6-01 · Erstöffnen-Save des Schaltplans (idempotent, lesend ausgelöst).
 *
 * Persistenz: Tabelle `schematic_diagrams` aus
 * `drizzle/0300_f6_01_schematic_diagrams.sql` (W-DB, Unique-Key
 * (workspace_id, offer_id, variant_revision)). Genau eine Zeile je
 * Varianten-Revision via `on conflict do nothing`; Zweitaufrufe melden
 * `already_saved`. Gespeichert wird die Netzliste als `{nodes, edges}`
 * (0300-CHECK, keine Metadaten); Zählspalten und `created_by` (UUID-Akteur
 * oder null) werden mitgeschrieben. Solange 0300 fehlt, meldet die Action
 * `unavailable` (kein Throw, kein Crash).
 *
 * Scope-Gate (fail-closed, W-CORE-Modell): residential gilt nur bei
 * offer.scope=`residential` UND offer.price_audience=`b2c` UND
 * Board-Scope=`residential` UND decision.audience=`b2c`. Jede
 * commercial/b2b-Angabe — wie jede unbekannte/fehlende — meldet `gated`
 * ohne Schreibzugriff. Die View-Auflösung (Integration) nutzt dieselbe
 * Regel über `resolveSchematicScope`; live auslösbar ist heute der
 * Board-Scope (offer-seitige commercial/b2b-Werte blockt der
 * `offer_status_scope_audience_ck`-CHECK bis zu einer eigenen Migration).
 *
 * Keine neue Permission (nutzt `project.write`).
 */

export type SchematicScope = "residential" | "commercial";

export type SaveSchematicFirstOpenStatus =
  | "saved"
  | "already_saved"
  | "gated"
  | "denied"
  | "unauthenticated"
  | "invalid"
  | "not_found"
  | "unavailable";

export type SaveSchematicFirstOpenResult = {
  status: SaveSchematicFirstOpenStatus;
};

export type SaveSchematicFirstOpenInput = {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  schematic: SingleLineSchematic;
};

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

const schematicNodeSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(200),
  sub: z.string().trim().max(200).nullable(),
  x: z.number().finite(),
  y: z.number().finite(),
}).strip();

const schematicEdgeSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
}).strip();

const firstOpenSchema = z.strictObject({
  workspaceId: UUID_SCHEMA,
  offerId: UUID_SCHEMA,
  variantId: UUID_SCHEMA,
  revision: z.int().min(1).max(1_000_000),
  schematic: z.strictObject({
    nodes: z.array(schematicNodeSchema).max(64),
    edges: z.array(schematicEdgeSchema).max(128),
    unwired: z.array(z.string().trim().min(1).max(200)).max(64),
    empty: z.boolean(),
  }),
});

function pgErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export async function saveSchematicFirstOpen(
  input: SaveSchematicFirstOpenInput,
): Promise<SaveSchematicFirstOpenResult> {
  const parsed = firstOpenSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  const command = parsed.data;

  try {
    return await authorizedAction(
      command.workspaceId,
      "project.write",
      "schematic_diagrams",
      async (tx, ctx) => {
        const scopeResult = await tx.execute<{
          scope: unknown;
          price_audience: unknown;
          board_scope: unknown;
          audience: unknown;
          [key: string]: unknown;
        }>(sql`
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
            join offer_variant variant_record
              on variant_record.workspace_id = offer_record.workspace_id
             and variant_record.id = ${command.variantId}::uuid
             and variant_record.offer_id = offer_record.id
           where offer_record.workspace_id = ${command.workspaceId}::uuid
             and offer_record.id = ${command.offerId}::uuid
           limit 1
        `);
        const scopeRow = scopeResult.rows[0];
        if (!scopeRow) return { status: "not_found" } as const;
        const scope = resolveSchematicScope({
          scope: scopeRow.scope,
          priceAudience: scopeRow.price_audience,
          boardScope: scopeRow.board_scope,
          audience: scopeRow.audience,
        });
        if (scope === "commercial") return { status: "gated" } as const;

        const netlist = { nodes: command.schematic.nodes, edges: command.schematic.edges };
        const createdBy = z.uuid().safeParse(ctx.actor).success ? ctx.actor : null;
        try {
          const inserted = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
            insert into schematic_diagrams (
              workspace_id, offer_id, variant_revision, netlist,
              node_count, edge_count, created_by
            ) values (
              ${command.workspaceId}::uuid,
              ${command.offerId}::uuid,
              ${command.revision}::integer,
              ${JSON.stringify(netlist)}::jsonb,
              ${netlist.nodes.length}::integer,
              ${netlist.edges.length}::integer,
              ${createdBy}::uuid
            )
            on conflict (workspace_id, offer_id, variant_revision) do nothing
            returning id
          `);
          if (inserted.rows.length === 1) return { status: "saved" } as const;
          return { status: "already_saved" } as const;
        } catch (error) {
          // 0300-Tabelle fehlt (Lane noch nicht gemergt): ehrlicher
          // Degradations-Status statt Throw — der Client bleibt still.
          if (pgErrorCode(error) === "42P01") return { status: "unavailable" } as const;
          // Offer zwischenzeitlich entfallen: kein Save, kein Crash.
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
