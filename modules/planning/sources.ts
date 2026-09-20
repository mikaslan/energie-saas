// F3-02 Dachquellen-Registry (Katalog F3.2, Batch-1 providerfrei):
// Upload mit Referenzlinien-Skalierung + Selbstzeichnen je Projekt.
// Muster: modules/planning-requests/service.ts (TenantTx zuerst,
// ServiceCtx-Rechte, on-conflict-Idempotenz, DTO mit permissions).
// Rechte: project.read (lesen) / project.write (schreiben) — KEINE neuen
// Permission-Keys (F3-BATCH-1-vertrag). Validierung spiegelt den
// Batch-Contract (@/lib/integrations/planning/contracts, F302-CON-01..03):
// kind nur upload|self_drawn (RESERVED reject), scale_ref strikt positiv,
// upload verlangt Storage-Felder, self_drawn verbietet sie.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PlanningSourceNotFoundError,
  PlanningSourceValidationError,
} from "./source-errors";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const kinds = ["upload", "self_drawn"] as const;
export type PlanningSourceKind = (typeof kinds)[number];

const scaleRefSchema = z.strictObject({
  meters: z.number().finite().positive(),
  pixelLength: z.number().finite().positive(),
});
export type PlanningSourceScaleRef = z.infer<typeof scaleRefSchema>;

const createSourceCommandSchema = z.strictObject({
  projectId: uuidSchema,
  siteId: uuidSchema.nullish(),
  kind: z.enum(kinds),
  storageKey: z.string().min(1).nullish(),
  sha256: z.string().min(1).nullish(),
  byteSize: z.number().int().nonnegative().nullish(),
  scaleRef: scaleRefSchema.nullish(),
});

export type PlanningSourceDto = {
  id: string;
  projectId: string;
  siteId: string | null;
  kind: PlanningSourceKind;
  storageKey: string | null;
  sha256: string | null;
  byteSize: number | null;
  scaleRef: PlanningSourceScaleRef | null;
  createdAt: string;
  permissions: { canWrite: boolean };
};

type PlanningSourceRow = {
  id: string;
  project_id: string;
  site_id: string | null;
  kind: string;
  storage_key: string | null;
  sha256: string | null;
  byte_size: number | null;
  scale_ref_json: unknown;
  created_at: string | Date;
};

function toDto(row: PlanningSourceRow, canWrite: boolean): PlanningSourceDto {
  if (!kinds.includes(row.kind as PlanningSourceKind)) {
    throw new PlanningSourceValidationError();
  }
  let scaleRef: PlanningSourceScaleRef | null = null;
  if (row.scale_ref_json !== null && row.scale_ref_json !== undefined) {
    const parsedRef = scaleRefSchema.safeParse(row.scale_ref_json);
    if (!parsedRef.success) throw new PlanningSourceValidationError();
    scaleRef = parsedRef.data;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    siteId: row.site_id,
    kind: row.kind as PlanningSourceKind,
    storageKey: row.storage_key,
    sha256: row.sha256,
    byteSize: row.byte_size,
    scaleRef,
    createdAt: new Date(row.created_at).toISOString(),
    permissions: { canWrite },
  };
}

function requireRead(ctx: ServiceCtx): void {
  // F3-BATCH-1: External fail-closed (Dach-/Upload-Daten sind sensitiv).
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "planning_source", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "planning_source", undefined, ctx.actor);
  }
}

const BASE_SELECT = sql`
  select id, project_id, site_id, kind, storage_key, sha256, byte_size,
         scale_ref_json, created_at
    from planning_source
`;

export async function createSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    siteId?: string | null;
    kind: PlanningSourceKind;
    storageKey?: string | null;
    sha256?: string | null;
    byteSize?: number | null;
    scaleRef?: PlanningSourceScaleRef | null;
  },
): Promise<PlanningSourceDto> {
  requireWrite(ctx);
  const parsed = createSourceCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningSourceValidationError();
  const { projectId, siteId, kind, storageKey, sha256, byteSize, scaleRef } = parsed.data;
  if (kind === "upload") {
    if (storageKey == null || sha256 == null || byteSize == null) {
      throw new PlanningSourceValidationError("upload requires storageKey, sha256 and byteSize");
    }
  } else if (storageKey != null || sha256 != null || byteSize != null || scaleRef != null) {
    throw new PlanningSourceValidationError("self_drawn forbids storage fields and scaleRef");
  }

  // Projekt-Bindung: Projekt muss zu DIESEM Workspace gehören, sonst NotFound
  // (kein Leak über fremde Projekte; DB-FK wäre nur zweite Linie).
  const scope = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!scope.rows[0]) throw new PlanningSourceNotFoundError(projectId);
  if (siteId != null) {
    const siteScope = await tx.execute<{ id: string }>(sql`
      select id from site
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${siteId}::uuid
       limit 1
    `);
    if (!siteScope.rows[0]) throw new PlanningSourceNotFoundError(siteId);
  }

  const inserted = await tx.execute<PlanningSourceRow>(sql`
    insert into planning_source (
      workspace_id, project_id, site_id, kind, storage_key, sha256,
      byte_size, scale_ref_json, created_by
    ) values (
      ${ctx.workspaceId}::uuid,
      ${projectId}::uuid,
      ${siteId ?? null}::uuid,
      ${kind},
      ${storageKey ?? null},
      ${sha256 ?? null},
      ${byteSize ?? null},
      ${scaleRef ? JSON.stringify(scaleRef) : null}::jsonb,
      ${ctx.actor}::uuid
    )
    on conflict (project_id, sha256) do nothing
    returning id, project_id, site_id, kind, storage_key, sha256, byte_size,
              scale_ref_json, created_at
  `);
  const created = inserted.rows[0];
  if (created) return toDto(created, true);
  // Duplikat per (project_id, sha256): existierende ID zurückgeben.
  if (sha256 == null) throw new PlanningSourceValidationError("planning source insert failed");
  const existing = await tx.execute<PlanningSourceRow>(sql`
    ${BASE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and sha256 = ${sha256}
     limit 1
  `);
  const row = existing.rows[0];
  if (!row) throw new PlanningSourceNotFoundError(projectId);
  return toDto(row, true);
}

export async function listSources(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<PlanningSourceDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new PlanningSourceValidationError();
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<PlanningSourceRow>(sql`
    ${BASE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     order by created_at, id
  `);
  return rows.rows.map((row) => toDto(row, canWrite));
}

export async function getSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { id: string } | string,
): Promise<PlanningSourceDto> {
  requireRead(ctx);
  const rawId = typeof query === "string" ? query : query.id;
  const parsed = z.strictObject({ id: uuidSchema }).safeParse({ id: rawId });
  if (!parsed.success) throw new PlanningSourceValidationError();
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<PlanningSourceRow>(sql`
    ${BASE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
     limit 1
  `);
  const row = rows.rows[0];
  if (!row) throw new PlanningSourceNotFoundError(parsed.data.id);
  return toDto(row, canWrite);
}
