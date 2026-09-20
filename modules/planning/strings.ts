// F3-05a manuelle Stringplanung Stufe-0 (Katalog F3.5): WR-Registry je
// Projekt (Label, MPP-Tracker-Zahl, optionale Advisory-Max-Laenge) +
// manuelle Strings aus ganzen Panel-Gruppen (WR-Ref, Slot, Member-Liste).
// Kein Auto-Fill, kein Optimierer, keine Stromstaerken (Folge). Slot-Range
// nur App-Level (DB nur Slot >= 1); Doppelbelegung derselben Gruppe in
// zwei Strings desselben WR ist hart, Advisories (H/V-Mix, Ueberlaenge)
// landen im Response-DTO und blocken nie. Rechte analog F3-04a ueber
// project.read/write (keine neuen Permission-Keys). DELETE-Grants analog
// planning_panel_group (Strings sind frei revidierbare Skizzen-Objekte).
// Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { planningInverter } from "@/lib/db/schema/planning-inverter";
import type { planningString } from "@/lib/db/schema/planning-string";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  PLANNING_STRING_VERSION,
  planningInverterCreateV1Schema,
  planningStringCreateV1Schema,
  stringAdvisories,
  type PlanningStringAdvisory,
} from "@/lib/integrations/planning/contracts/string-plan";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningStringNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning string resource not found: ${id}`
        : "planning string resource not found",
    );
    this.name = "PlanningStringNotFoundError";
  }
}

export class PlanningStringValidationError extends Error {
  constructor(message = "planning string input is invalid") {
    super(message);
    this.name = "PlanningStringValidationError";
  }
}

export { PlanningStringNotFoundError as NotFoundError };
export { PlanningStringValidationError as ValidationError };

// Anker auf die zentral verwalteten Drizzle-Tabellen (legt der
// Koordinator an, Muster analog F3-04a). Queries laufen als Raw-SQL mit
// expliziten RLS-Praedikaten; die Imports verankern die Schema-Pfade als
// Single-Source.
export type PlanningInverterTable = typeof planningInverter;
export type PlanningInverterTableRow = typeof planningInverter.$inferSelect;
export type PlanningStringTable = typeof planningString;
export type PlanningStringTableRow = typeof planningString.$inferSelect;

const INVERTER_RESOURCE = "planning_inverter";
const STRING_RESOURCE = "planning_string";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type PlanningStringAdvisoryDto = PlanningStringAdvisory;

export type PlanningInverterDto = {
  id: string;
  projectId: string;
  label: string;
  mppTrackers: number;
  maxStringModules: number | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type PlanningStringMemberDto = {
  groupId: string;
};

export type PlanningStringDto = {
  id: string;
  inverterId: string;
  trackerSlot: number;
  label: string;
  members: PlanningStringMemberDto[];
  advisories: PlanningStringAdvisoryDto[];
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type CreateInverterInput = {
  projectId: string;
  label: unknown;
  mppTrackers: unknown;
  maxStringModules?: unknown;
};

export type CreateStringInput = {
  inverterId: string;
  trackerSlot: unknown;
  label: unknown;
  members: unknown;
};

type InverterRow = {
  id: string;
  project_id: string;
  label: string;
  mpp_trackers: number;
  max_string_modules: number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type InverterScopeRow = {
  id: string;
  project_id: string;
  mpp_trackers: number;
  max_string_modules: number | null;
};

type StringRow = {
  id: string;
  inverter_id: string;
  tracker_slot: number;
  label: string;
  member_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

type StringGroupRow = {
  id: string;
  kind: string;
  rows: number;
  cols: number;
  project_id: string;
};

const memberJsonSchema = z
  .array(z.object({ group_id: z.uuid() }))
  .min(1);

const memberJsonLenientSchema = z.array(
  z.object({ group_id: z.string() }),
);

function requireRead(ctx: ServiceCtx, resource: string): void {
  // F3-05a: External fail-closed (Belegungsdaten sind sensitiv).
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", resource, undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, resource: string): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", resource, undefined, ctx.actor);
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

function parseContractInverter(input: CreateInverterInput): {
  label: string;
  mppTrackers: number;
  maxStringModules: number | null;
} {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_STRING_VERSION,
    label: input.label,
    mppTrackers: input.mppTrackers,
  };
  if (input.maxStringModules !== undefined && input.maxStringModules !== null) {
    candidate.maxStringModules = input.maxStringModules;
  }
  const parsed = planningInverterCreateV1Schema.safeParse(candidate);
  if (!parsed.success) throw new PlanningStringValidationError();
  return {
    label: parsed.data.label,
    mppTrackers: parsed.data.mppTrackers,
    maxStringModules: parsed.data.maxStringModules ?? null,
  };
}

function parseContractString(input: CreateStringInput): {
  inverterId: string;
  trackerSlot: number;
  label: string;
  members: PlanningStringMemberDto[];
} {
  const parsed = planningStringCreateV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_VERSION,
    inverterId: input.inverterId,
    trackerSlot: input.trackerSlot,
    label: input.label,
    members: input.members,
  });
  if (!parsed.success) throw new PlanningStringValidationError();
  const inverterId = uuidSchema.safeParse(parsed.data.inverterId);
  if (!inverterId.success) {
    throw new PlanningStringValidationError("inverter id is invalid");
  }
  const members: PlanningStringMemberDto[] = [];
  for (const member of parsed.data.members) {
    const groupId = uuidSchema.safeParse(member.groupId);
    if (!groupId.success) {
      throw new PlanningStringValidationError("panel group id is invalid");
    }
    members.push({ groupId: groupId.data });
  }
  return {
    inverterId: inverterId.data,
    trackerSlot: parsed.data.trackerSlot,
    label: parsed.data.label,
    members,
  };
}

function toInverterDto(row: InverterRow, canWrite: boolean): PlanningInverterDto {
  const validated = z
    .strictObject({
      projectId: z.uuid(),
      label: z.string().min(1),
      mppTrackers: z.number().int(),
      maxStringModules: z.number().int().nullable(),
    })
    .safeParse({
      projectId: row.project_id,
      label: row.label,
      mppTrackers: row.mpp_trackers,
      maxStringModules: row.max_string_modules,
    });
  if (!validated.success) {
    throw new PlanningStringValidationError(
      "planning inverter data is invalid",
    );
  }
  return {
    id: row.id,
    projectId: validated.data.projectId,
    label: validated.data.label,
    mppTrackers: validated.data.mppTrackers,
    maxStringModules: validated.data.maxStringModules,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

function toStringDto(
  row: StringRow,
  groups: Map<string, { kind: string; moduleCount: number }>,
  maxStringModules: number | null,
  canWrite: boolean,
): PlanningStringDto {
  const members = memberJsonSchema.safeParse(row.member_json);
  const base = z
    .strictObject({
      inverterId: z.uuid(),
      trackerSlot: z.number().int(),
      label: z.string().min(1),
    })
    .safeParse({
      inverterId: row.inverter_id,
      trackerSlot: row.tracker_slot,
      label: row.label,
    });
  if (!members.success || !base.success) {
    throw new PlanningStringValidationError("planning string data is invalid");
  }
  const memberDtos = members.data.map((member) => ({
    groupId: member.group_id.toLowerCase(),
  }));
  // Advisories: Warnliste, nie Reject. Dangling Refs (Gruppe geloescht)
  // fallen aus der Advisory-Betrachtung, bleiben aber im DTO sichtbar.
  const advisoryGroups = memberDtos.flatMap((member) => {
    const info = groups.get(member.groupId);
    if (!info) return [];
    return [{ id: member.groupId, kind: info.kind, moduleCount: info.moduleCount }];
  });
  return {
    id: row.id,
    inverterId: base.data.inverterId,
    trackerSlot: base.data.trackerSlot,
    label: base.data.label,
    members: memberDtos,
    advisories: stringAdvisories({
      groups: advisoryGroups,
      maxStringModules,
    }),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

async function requireProjectInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<{ id: string }> {
  // Projekt muss workspace-eigen sein; RLS blendet Fremdprojekte aus,
  // der Service mappt das auf NotFound.
  const scope = await tx.execute<{ id: string }>(sql`
    select id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  const project = scope.rows[0];
  if (!project) throw new PlanningStringNotFoundError(projectId);
  return project;
}

async function requireInverterInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  inverterId: string,
): Promise<InverterScopeRow> {
  const scope = await tx.execute<InverterScopeRow>(sql`
    select id, project_id, mpp_trackers, max_string_modules
      from planning_inverter
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${inverterId}::uuid
     limit 1
  `);
  const inverter = scope.rows[0];
  if (!inverter) throw new PlanningStringNotFoundError(inverterId);
  return inverter;
}

async function loadStringGroups(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupIds: string[],
): Promise<StringGroupRow[]> {
  // Gruppen mit Dach-Projekt (Gruppe -> Dach -> Quelle -> Projekt) fuer
  // Zugehoerigkeitspruefung und Advisory-Ableitung.
  const unique = [...new Set(groupIds.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return [];
  const idList = sql.join(
    unique.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const found = await tx.execute<StringGroupRow>(sql`
    select g.id, g.kind, g.rows, g.cols, s.project_id
      from planning_panel_group g
      join planning_roof_min r
        on r.workspace_id = g.workspace_id
       and r.id = g.roof_id
      join planning_source s
        on s.workspace_id = r.workspace_id
       and s.id = r.source_id
     where g.workspace_id = ${ctx.workspaceId}::uuid
       and g.id in (${idList})
  `);
  return found.rows;
}

export async function createInverter(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateInverterInput,
): Promise<PlanningInverterDto> {
  requireWrite(ctx, INVERTER_RESOURCE);
  const projectId = uuidSchema.safeParse(input.projectId);
  if (!projectId.success) {
    throw new PlanningStringValidationError("project id is invalid");
  }
  const validated = parseContractInverter(input);
  await requireProjectInScope(tx, ctx, projectId.data);

  let inserted;
  try {
    inserted = await tx.execute<InverterRow>(sql`
      insert into planning_inverter (
        workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${projectId.data}::uuid,
        ${validated.label}, ${validated.mppTrackers},
        ${validated.maxStringModules},
        ${ctx.actor}::uuid
      )
      returning id, project_id, label, mpp_trackers, max_string_modules,
                created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningStringNotFoundError(projectId.data);
    }
    if (code === "23514") throw new PlanningStringValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningStringValidationError("planning inverter insert failed");
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: INVERTER_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_inverter.created",
    actor: ctx.actor,
    payload: { projectId: projectId.data },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_inverter.create",
    resource: INVERTER_RESOURCE,
    allowed: true,
    details: { inverterId: row.id, projectId: projectId.data },
  });

  return toInverterDto(row, true);
}

export async function createString(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateStringInput,
): Promise<PlanningStringDto> {
  requireWrite(ctx, STRING_RESOURCE);
  const validated = parseContractString(input);
  const inverter = await requireInverterInScope(tx, ctx, validated.inverterId);

  // Spec F3-05a (STRING_SLOT_APP): Slot <= Tracker nur App-Level.
  if (validated.trackerSlot > inverter.mpp_trackers) {
    throw new PlanningStringValidationError(
      "tracker slot exceeds inverter mpp trackers",
    );
  }

  // Jede Gruppe muss existieren und zu einem Dach desselben Projekts
  // gehoeren, sonst NotFound.
  const groupRows = await loadStringGroups(
    tx,
    ctx,
    validated.members.map((member) => member.groupId),
  );
  const byId = new Map(groupRows.map((row) => [row.id.toLowerCase(), row]));
  for (const member of validated.members) {
    const group = byId.get(member.groupId);
    if (!group || group.project_id.toLowerCase() !== inverter.project_id.toLowerCase()) {
      throw new PlanningStringNotFoundError(member.groupId);
    }
  }

  // Doppelbelegung derselben Gruppe in einem anderen String desselben
  // WR ist hart (App-Level, member_json ist schemaloses jsonb).
  const existing = await tx.execute<{ id: string; member_json: unknown }>(sql`
    select id, member_json
      from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and inverter_id = ${inverter.id}::uuid
  `);
  const used = new Set<string>();
  for (const row of existing.rows) {
    const members = memberJsonLenientSchema.safeParse(row.member_json);
    if (!members.success) continue;
    for (const member of members.data) {
      used.add(member.group_id.toLowerCase());
    }
  }
  for (const member of validated.members) {
    if (used.has(member.groupId)) {
      throw new PlanningStringValidationError(
        "panel group is already assigned to another string of this inverter",
      );
    }
  }

  const memberJson = validated.members.map((member) => ({
    group_id: member.groupId,
  }));
  let inserted;
  try {
    inserted = await tx.execute<StringRow>(sql`
      insert into planning_string (
        workspace_id, inverter_id, tracker_slot, label, member_json, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${inverter.id}::uuid,
        ${validated.trackerSlot}, ${validated.label},
        ${JSON.stringify(memberJson)}::jsonb,
        ${ctx.actor}::uuid
      )
      returning id, inverter_id, tracker_slot, label, member_json,
                created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningStringNotFoundError(validated.inverterId);
    }
    if (code === "23514") throw new PlanningStringValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningStringValidationError("planning string insert failed");
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: STRING_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_string.created",
    actor: ctx.actor,
    payload: { inverterId: inverter.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string.create",
    resource: STRING_RESOURCE,
    allowed: true,
    details: { stringId: row.id, inverterId: inverter.id },
  });

  const advisoryInfo = new Map(
    groupRows.map((group) => [
      group.id.toLowerCase(),
      { kind: group.kind, moduleCount: group.rows * group.cols },
    ]),
  );
  return toStringDto(row, advisoryInfo, inverter.max_string_modules, true);
}

export async function listInverters(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<PlanningInverterDto[]> {
  requireRead(ctx, INVERTER_RESOURCE);
  const parsed = uuidSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new PlanningStringValidationError("project id is invalid");
  }
  await requireProjectInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<InverterRow>(sql`
    select id, project_id, label, mpp_trackers, max_string_modules,
           created_at, updated_at
      from planning_inverter
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data}::uuid
     order by created_at, id
  `);
  return rows.rows.map((row) => toInverterDto(row, canWrite));
}

export async function listStrings(
  tx: TenantTx,
  ctx: ServiceCtx,
  inverterId: string,
): Promise<PlanningStringDto[]> {
  requireRead(ctx, STRING_RESOURCE);
  const parsed = uuidSchema.safeParse(inverterId);
  if (!parsed.success) {
    throw new PlanningStringValidationError("inverter id is invalid");
  }
  const inverter = await requireInverterInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<StringRow>(sql`
    select id, inverter_id, tracker_slot, label, member_json,
           created_at, updated_at
      from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and inverter_id = ${inverter.id}::uuid
     order by created_at, id
  `);
  const memberIds = rows.rows.flatMap((row) => {
    const members = memberJsonLenientSchema.safeParse(row.member_json);
    if (!members.success) return [];
    return members.data.map((member) => member.group_id);
  });
  const groupRows = await loadStringGroups(tx, ctx, memberIds);
  const advisoryInfo = new Map(
    groupRows.map((group) => [
      group.id.toLowerCase(),
      { kind: group.kind, moduleCount: group.rows * group.cols },
    ]),
  );
  return rows.rows.map((row) =>
    toStringDto(row, advisoryInfo, inverter.max_string_modules, canWrite),
  );
}

export async function getString(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<PlanningStringDto> {
  requireRead(ctx, STRING_RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningStringValidationError("planning string id is invalid");
  }
  const found = await tx.execute<StringRow>(sql`
    select id, inverter_id, tracker_slot, label, member_json,
           created_at, updated_at
      from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new PlanningStringNotFoundError(parsed.data);
  const inverter = await requireInverterInScope(tx, ctx, row.inverter_id);
  const members = memberJsonLenientSchema.safeParse(row.member_json);
  const groupRows = await loadStringGroups(
    tx,
    ctx,
    members.success ? members.data.map((member) => member.group_id) : [],
  );
  const advisoryInfo = new Map(
    groupRows.map((group) => [
      group.id.toLowerCase(),
      { kind: group.kind, moduleCount: group.rows * group.cols },
    ]),
  );
  return toStringDto(
    row,
    advisoryInfo,
    inverter.max_string_modules,
    can(ctx, "project.write"),
  );
}

export async function removeString(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx, STRING_RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningStringValidationError("planning string id is invalid");
  }
  const deleted = await tx.execute<{ id: string; inverter_id: string }>(sql`
    delete from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     returning id, inverter_id
  `);
  const row = deleted.rows[0];
  if (!row) throw new PlanningStringNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: STRING_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_string.removed",
    actor: ctx.actor,
    payload: { inverterId: row.inverter_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string.remove",
    resource: STRING_RESOURCE,
    allowed: true,
    details: { stringId: row.id, inverterId: row.inverter_id },
  });

  return { id: row.id };
}

export async function removeInverter(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx, INVERTER_RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningStringValidationError("inverter id is invalid");
  }
  const scope = await tx.execute<{ id: string; project_id: string }>(sql`
    select id, project_id
      from planning_inverter
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     limit 1
  `);
  const inverter = scope.rows[0];
  if (!inverter) throw new PlanningStringNotFoundError(parsed.data);

  // WR mit existierenden Strings ist nicht loeschbar (App-Level,
  // DB-FK ist RESTRICT und wuerfe 23503).
  const strings = await tx.execute<{ id: string }>(sql`
    select id
      from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and inverter_id = ${inverter.id}::uuid
     limit 1
  `);
  if (strings.rows.length > 0) {
    throw new PlanningStringValidationError(
      "inverter has strings and cannot be removed",
    );
  }

  let deleted;
  try {
    deleted = await tx.execute<{ id: string; project_id: string }>(sql`
      delete from planning_inverter
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${inverter.id}::uuid
       returning id, project_id
    `);
  } catch (error) {
    if (postgresErrorCode(error) === "23503") {
      throw new PlanningStringValidationError(
        "inverter has strings and cannot be removed",
      );
    }
    throw error;
  }
  const row = deleted.rows[0];
  if (!row) throw new PlanningStringNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: INVERTER_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_inverter.removed",
    actor: ctx.actor,
    payload: { projectId: row.project_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_inverter.remove",
    resource: INVERTER_RESOURCE,
    allowed: true,
    details: { inverterId: row.id, projectId: row.project_id },
  });

  return { id: row.id };
}
