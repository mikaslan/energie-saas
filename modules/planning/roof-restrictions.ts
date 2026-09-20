// F3-03b Dach-Sperrzonen Stufe-0 (Katalog F3.3): generisches Rechteck
// je Dach (Schornstein/Fenster/Sonstige + optionale Hoehe). Kein
// Schattenwurf-Modell, keine Ueberlapp-Pruefung (Folge). Rechteck-in-
// Polygon auf App-Ebene (Contract rectInsidePolygon); Rechte analog
// F3-02/F3-03 ueber project.read/write (keine neuen Permission-Keys).
// DELETE-Grant analog project_assignment (Sperrzonen sind frei
// revidierbare Skizzen-Objekte). Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  PLANNING_ROOF_RESTRICTION_VERSION,
  planningRoofRestrictionCreateV1Schema,
  rectInsidePolygon,
  type PlanningRoofRestrictionKind,
  type PlanningRoofRestrictionRectV1,
} from "@/lib/integrations/planning/contracts";
import { groupRestrictionCollisions } from "@/lib/integrations/planning/contracts/panel-collision";
import { groupRect } from "@/lib/integrations/planning/contracts/panel-group";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PlanningRoofRestrictionNotFoundError,
  PlanningRoofRestrictionValidationError,
} from "./roof-restrictions-errors";

export {
  PlanningRoofRestrictionNotFoundError,
  PlanningRoofRestrictionValidationError,
} from "./roof-restrictions-errors";

const RESOURCE = "planning_roof_restriction";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type RoofRestrictionRectDto = PlanningRoofRestrictionRectV1;

export type CollidingGroupDto = {
  groupId: string;
  label: string;
};

export type PlanningRoofRestrictionDto = {
  id: string;
  roofId: string;
  kind: PlanningRoofRestrictionKind;
  label: string;
  rect: RoofRestrictionRectDto;
  heightM: number | null;
  collidingGroups: CollidingGroupDto[];
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type CreateRestrictionInput = {
  roofId: string;
  kind: unknown;
  label: unknown;
  rect: unknown;
  heightM?: unknown;
};

type RestrictionRow = {
  id: string;
  roof_id: string;
  kind: string;
  label: string;
  rect_json: unknown;
  height_m: number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type RoofScopeRow = {
  id: string;
  polygon_json: unknown;
};

const roofPointDtoSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

function requireRead(ctx: ServiceCtx): void {
  // F3-03b: External fail-closed (Dach-/Upload-Daten sind sensitiv).
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", RESOURCE, undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", RESOURCE, undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function parseContractCreate(input: CreateRestrictionInput): {
  kind: PlanningRoofRestrictionKind;
  label: string;
  rect: PlanningRoofRestrictionRectV1;
  heightM: number | null;
} {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_ROOF_RESTRICTION_VERSION,
    kind: input.kind,
    label: input.label,
    rect: input.rect,
  };
  if (input.heightM !== undefined && input.heightM !== null) {
    candidate.heightM = input.heightM;
  }
  const parsed = planningRoofRestrictionCreateV1Schema.safeParse(candidate);
  if (!parsed.success) throw new PlanningRoofRestrictionValidationError();
  return {
    kind: parsed.data.kind,
    label: parsed.data.label,
    rect: parsed.data.rect,
    heightM: parsed.data.heightM ?? null,
  };
}

type PanelGroupRefRow = {
  id: string;
  label: string;
  origin_json: unknown;
  rows: number;
  cols: number;
  module_w_m: number;
  module_h_m: number;
  gap_m: number;
};

type PanelGroupRef = {
  id: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
};

const groupRefOriginSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

const groupRefMeasuresSchema = z.strictObject({
  rows: z.number().int(),
  cols: z.number().int(),
  moduleWM: z.number().finite(),
  moduleHM: z.number().finite(),
  gapM: z.number().finite(),
});

function isPositiveRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

async function loadGroupRefs(
  tx: TenantTx,
  ctx: ServiceCtx,
  roofId: string,
): Promise<PanelGroupRef[]> {
  // F3-04c: Panel-Gruppen desselben Dachs fuer die advisory-only
  // Kollisions-Anreicherung. Ungueltige Zeilen werden uebersprungen
  // (Warnung darf Reads nie brechen).
  const found = await tx.execute<PanelGroupRefRow>(sql`
    select id, label, origin_json, rows, cols, module_w_m, module_h_m, gap_m
      from planning_panel_group
     where workspace_id = ${ctx.workspaceId}::uuid
       and roof_id = ${roofId}::uuid
     order by created_at, id
  `);
  const refs: PanelGroupRef[] = [];
  for (const row of found.rows) {
    const origin = groupRefOriginSchema.safeParse(row.origin_json);
    const measures = groupRefMeasuresSchema.safeParse({
      rows: row.rows,
      cols: row.cols,
      moduleWM: row.module_w_m,
      moduleHM: row.module_h_m,
      gapM: row.gap_m,
    });
    if (!origin.success || !measures.success || typeof row.label !== "string") {
      continue;
    }
    const rect = groupRect({
      origin: origin.data,
      rows: measures.data.rows,
      cols: measures.data.cols,
      moduleWM: measures.data.moduleWM,
      moduleHM: measures.data.moduleHM,
      gapM: measures.data.gapM,
    });
    if (!isPositiveRect(rect)) continue;
    refs.push({ id: row.id, label: row.label, rect });
  }
  return refs;
}

function collidingGroupsForRestriction(
  restriction: { id: string; kind: string; label: string; rect: RoofRestrictionRectDto },
  groups: PanelGroupRef[],
): CollidingGroupDto[] {
  const colliding: CollidingGroupDto[] = [];
  for (const group of groups) {
    const hits = groupRestrictionCollisions({
      group: { id: group.id, rect: group.rect },
      restrictions: [restriction],
    });
    if (hits.length > 0) {
      colliding.push({ groupId: group.id, label: group.label });
    }
  }
  return colliding;
}

function toDto(
  row: RestrictionRow,
  canWrite: boolean,
  collidingGroups: CollidingGroupDto[],
): PlanningRoofRestrictionDto {
  const kind = z.enum(["chimney", "window", "other"]).safeParse(row.kind);
  const rect = z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .safeParse(row.rect_json);
  if (!kind.success || !rect.success || typeof row.label !== "string") {
    throw new PlanningRoofRestrictionValidationError(
      "planning roof restriction data is invalid",
    );
  }
  return {
    id: row.id,
    roofId: row.roof_id,
    kind: kind.data,
    label: row.label,
    rect: rect.data,
    heightM: row.height_m,
    collidingGroups,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

async function requireRoofInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  roofId: string,
): Promise<RoofScopeRow> {
  // Dach muss workspace-eigen sein; RLS blendet Fremddaecher aus,
  // der Service mappt das auf NotFound.
  const scope = await tx.execute<RoofScopeRow>(sql`
    select id, polygon_json
      from planning_roof_min
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${roofId}::uuid
     limit 1
  `);
  const roof = scope.rows[0];
  if (!roof) throw new PlanningRoofRestrictionNotFoundError(roofId);
  return roof;
}

export async function createRestriction(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateRestrictionInput,
): Promise<PlanningRoofRestrictionDto> {
  requireWrite(ctx);
  const roofId = uuidSchema.safeParse(input.roofId);
  if (!roofId.success) {
    throw new PlanningRoofRestrictionValidationError("roof id is invalid");
  }
  const validated = parseContractCreate(input);
  const roof = await requireRoofInScope(tx, ctx, roofId.data);

  // App-Ebene (Spec F3-03b): Rechteck muss im Dach-Polygon liegen
  // (Ecken-Test, Kante = drin). DB-CHECKs sichern nur Maße/Hoehe.
  const polygon = z
    .array(roofPointDtoSchema)
    .min(3)
    .max(64)
    .safeParse(roof.polygon_json);
  if (!polygon.success || !rectInsidePolygon(validated.rect, polygon.data)) {
    throw new PlanningRoofRestrictionValidationError(
      "restriction rect must lie within the roof polygon",
    );
  }

  let inserted;
  try {
    inserted = await tx.execute<RestrictionRow>(sql`
      insert into planning_roof_restriction (
        workspace_id, roof_id, kind, label, rect_json, height_m, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${roofId.data}::uuid,
        ${validated.kind}, ${validated.label},
        ${JSON.stringify(validated.rect)}::jsonb,
        ${validated.heightM},
        ${ctx.actor}::uuid
      )
      returning id, roof_id, kind, label, rect_json, height_m,
                created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningRoofRestrictionNotFoundError(roofId.data);
    }
    if (code === "23514") throw new PlanningRoofRestrictionValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningRoofRestrictionValidationError(
      "planning roof restriction insert failed",
    );
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_roof_restriction.created",
    actor: ctx.actor,
    payload: { roofId: roof.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_roof_restriction.create",
    resource: RESOURCE,
    allowed: true,
    details: { restrictionId: row.id, roofId: roof.id },
  });

  // F3-04c: Create bleibt zulaessig (advisory-only, kein Reject).
  const created = toDto(row, true, []);
  const createdGroups = await loadGroupRefs(tx, ctx, created.roofId);
  return {
    ...created,
    collidingGroups: collidingGroupsForRestriction(
      { id: created.id, kind: created.kind, label: created.label, rect: created.rect },
      createdGroups,
    ),
  };
}

export async function removeRestriction(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { id: string },
): Promise<{ id: string }> {
  requireWrite(ctx);
  const id = uuidSchema.safeParse(query.id);
  if (!id.success) {
    throw new PlanningRoofRestrictionValidationError("restriction id is invalid");
  }
  const deleted = await tx.execute<{ id: string; roof_id: string }>(sql`
    delete from planning_roof_restriction
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id.data}::uuid
     returning id, roof_id
  `);
  const row = deleted.rows[0];
  if (!row) throw new PlanningRoofRestrictionNotFoundError(id.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_roof_restriction.removed",
    actor: ctx.actor,
    payload: { roofId: row.roof_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_roof_restriction.remove",
    resource: RESOURCE,
    allowed: true,
    details: { restrictionId: row.id, roofId: row.roof_id },
  });

  return { id: row.id };
}

export async function getRestriction(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { id: string },
): Promise<PlanningRoofRestrictionDto> {
  requireRead(ctx);
  const id = uuidSchema.safeParse(query.id);
  if (!id.success) {
    throw new PlanningRoofRestrictionValidationError("restriction id is invalid");
  }
  const found = await tx.execute<RestrictionRow>(sql`
    select id, roof_id, kind, label, rect_json, height_m, created_at, updated_at
      from planning_roof_restriction
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id.data}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new PlanningRoofRestrictionNotFoundError(id.data);
  const base = toDto(row, can(ctx, "project.write"), []);
  const groups = await loadGroupRefs(tx, ctx, base.roofId);
  return {
    ...base,
    collidingGroups: collidingGroupsForRestriction(
      { id: base.id, kind: base.kind, label: base.label, rect: base.rect },
      groups,
    ),
  };
}

export async function listRestrictions(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { roofId: string },
): Promise<PlanningRoofRestrictionDto[]> {
  requireRead(ctx);
  const roofId = uuidSchema.safeParse(query.roofId);
  if (!roofId.success) {
    throw new PlanningRoofRestrictionValidationError("roof id is invalid");
  }
  await requireRoofInScope(tx, ctx, roofId.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<RestrictionRow>(sql`
    select id, roof_id, kind, label, rect_json, height_m, created_at, updated_at
      from planning_roof_restriction
     where workspace_id = ${ctx.workspaceId}::uuid
       and roof_id = ${roofId.data}::uuid
     order by created_at, id
  `);
  const groups = await loadGroupRefs(tx, ctx, roofId.data);
  return rows.rows.map((row) => {
    const base = toDto(row, canWrite, []);
    return {
      ...base,
      collidingGroups: collidingGroupsForRestriction(
        { id: base.id, kind: base.kind, label: base.label, rect: base.rect },
        groups,
      ),
    };
  });
}
