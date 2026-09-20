// F3-05c String-Zell-Ranges Stufe-0 (Katalog F3.5): Rechteck-Ranges
// je String-Member (Gruppen-Ref + Zeilen-/Spalten-Fenster).
// Deselect-Schnittmenge als Effektiv-Count, Ueberlapp-Reject im selben
// String, Zell-Doppelbelegung in anderem String desselben WR hart.
// member_json bleibt daneben lesbar (Bestandsschutz). Rechte analog
// F3-04a ueber project.read/write (keine neuen Permission-Keys).
// Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { planningStringMember } from "@/lib/db/schema/planning-string-member";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  effectiveMemberCount,
  PLANNING_STRING_MEMBER_VERSION,
  planningStringMemberAddV1Schema,
  rangesOverlap,
} from "@/lib/integrations/planning/contracts/string-member";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningStringMemberNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning string member not found: ${id}`
        : "planning string member not found",
    );
    this.name = "PlanningStringMemberNotFoundError";
  }
}

export class PlanningStringMemberValidationError extends Error {
  constructor(message = "planning string member input is invalid") {
    super(message);
    this.name = "PlanningStringMemberValidationError";
  }
}

export { PlanningStringMemberNotFoundError as NotFoundError };
export { PlanningStringMemberValidationError as ValidationError };

// Anker auf die zentral verwaltete Drizzle-Tabelle (legt der
// Koordinator an, Muster analog F3-04a/F3-04b). Queries laufen als
// Raw-SQL mit expliziten RLS-Praedikaten; der Import verankert den
// Schema-Pfad als Single-Source.
export type PlanningStringMemberTable = typeof planningStringMember;
export type PlanningStringMemberTableRow =
  typeof planningStringMember.$inferSelect;

const RESOURCE = "planning_string_member";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type PlanningStringMemberDto = {
  id: string;
  stringId: string;
  groupId: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
  effectiveCount: number;
  createdAt: string;
  permissions: { canWrite: boolean };
};

export type AddMemberInput = {
  stringId: string;
  groupId: string;
  rowFrom: unknown;
  rowTo: unknown;
  colFrom: unknown;
  colTo: unknown;
};

export type PlanningStringMemberEffectiveCount = {
  stringId: string;
  memberCount: number;
  cellCount: number;
  deselectedCount: number;
  effectiveCount: number;
};

type MemberRow = {
  id: string;
  string_id: string;
  group_id: string;
  row_from: number;
  row_to: number;
  col_from: number;
  col_to: number;
  created_at: string | Date;
};

type MemberRangeRow = {
  group_id: string;
  row_from: number;
  row_to: number;
  col_from: number;
  col_to: number;
};

type StringScopeRow = {
  id: string;
  inverter_id: string;
  project_id: string;
};

type GroupScopeRow = {
  id: string;
  rows: number;
  cols: number;
  project_id: string;
};

type DeselectCellRow = {
  group_id?: string;
  row: number;
  col: number;
};

type MemberRange = {
  groupId: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
};

function requireRead(ctx: ServiceCtx, resource: string): void {
  // F3-05c: External fail-closed (Belegungsdaten sind sensitiv).
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

function parseContractAdd(input: AddMemberInput): MemberRange & {
  stringId: string;
} {
  const parsed = planningStringMemberAddV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_MEMBER_VERSION,
    stringId: input.stringId,
    groupId: input.groupId,
    rowFrom: input.rowFrom,
    rowTo: input.rowTo,
    colFrom: input.colFrom,
    colTo: input.colTo,
  });
  if (!parsed.success) throw new PlanningStringMemberValidationError();
  const stringId = uuidSchema.safeParse(parsed.data.stringId);
  if (!stringId.success) {
    throw new PlanningStringMemberValidationError("string id is invalid");
  }
  const groupId = uuidSchema.safeParse(parsed.data.groupId);
  if (!groupId.success) {
    throw new PlanningStringMemberValidationError("panel group id is invalid");
  }
  return {
    stringId: stringId.data,
    groupId: groupId.data,
    rowFrom: parsed.data.rowFrom,
    rowTo: parsed.data.rowTo,
    colFrom: parsed.data.colFrom,
    colTo: parsed.data.colTo,
  };
}

function toMemberRange(row: MemberRangeRow): MemberRange {
  return {
    groupId: row.group_id.toLowerCase(),
    rowFrom: row.row_from,
    rowTo: row.row_to,
    colFrom: row.col_from,
    colTo: row.col_to,
  };
}

async function requireStringInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<StringScopeRow> {
  // String mit WR-Projekt (String -> WR -> Projekt) fuer
  // Zugehoerigkeitspruefung und WR-weite Doppelbelegung.
  const scope = await tx.execute<StringScopeRow>(sql`
    select s.id, s.inverter_id, i.project_id
      from planning_string s
      join planning_inverter i
        on i.workspace_id = s.workspace_id
       and i.id = s.inverter_id
     where s.workspace_id = ${ctx.workspaceId}::uuid
       and s.id = ${stringId}::uuid
     limit 1
  `);
  const found = scope.rows[0];
  if (!found) throw new PlanningStringMemberNotFoundError(stringId);
  return found;
}

async function requirePanelGroupInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
): Promise<GroupScopeRow> {
  // Gruppe mit Dach-Projekt (Gruppe -> Dach -> Quelle -> Projekt)
  // fuer Zugehoerigkeitspruefung und Raster-Range.
  const scope = await tx.execute<GroupScopeRow>(sql`
    select g.id, g.rows, g.cols, s.project_id
      from planning_panel_group g
      join planning_roof_min r
        on r.workspace_id = g.workspace_id
       and r.id = g.roof_id
      join planning_source s
        on s.workspace_id = r.workspace_id
       and s.id = r.source_id
     where g.workspace_id = ${ctx.workspaceId}::uuid
       and g.id = ${groupId}::uuid
     limit 1
  `);
  const group = scope.rows[0];
  if (!group) throw new PlanningStringMemberNotFoundError(groupId);
  return group;
}

async function selectDeselectCells(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupIds: string[],
): Promise<Map<string, { row: number; col: number }[]>> {
  // Deselect-Zellen der Range-Gruppen (workspace+group); Aufrufer
  // schneidet je Range zu.
  const unique = [...new Set(groupIds.map((id) => id.toLowerCase()))];
  const byGroup = new Map<string, { row: number; col: number }[]>();
  for (const id of unique) byGroup.set(id, []);
  if (unique.length === 0) return byGroup;
  const idList = sql.join(
    unique.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const found = await tx.execute<DeselectCellRow>(sql`
    select group_id, "row", "col"
      from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id in (${idList})
  `);
  for (const cell of found.rows) {
    const key = (cell.group_id ?? "").toLowerCase();
    const list = byGroup.get(key);
    if (list) list.push({ row: cell.row, col: cell.col });
  }
  return byGroup;
}

function isRangeFullyDeselected(
  range: MemberRange,
  deselected: { row: number; col: number }[],
): boolean {
  const cells = new Set(deselected.map((cell) => `${cell.row}:${cell.col}`));
  for (let row = range.rowFrom; row <= range.rowTo; row += 1) {
    for (let col = range.colFrom; col <= range.colTo; col += 1) {
      if (!cells.has(`${row}:${col}`)) return false;
    }
  }
  return true;
}

function toMemberDto(
  row: MemberRow,
  effectiveCountValue: number,
  canWrite: boolean,
): PlanningStringMemberDto {
  const base = z
    .strictObject({
      stringId: z.uuid(),
      groupId: z.uuid(),
      rowFrom: z.number().int().min(1),
      rowTo: z.number().int().min(1),
      colFrom: z.number().int().min(1),
      colTo: z.number().int().min(1),
    })
    .safeParse({
      stringId: row.string_id,
      groupId: row.group_id,
      rowFrom: row.row_from,
      rowTo: row.row_to,
      colFrom: row.col_from,
      colTo: row.col_to,
    });
  if (!base.success) {
    throw new PlanningStringMemberValidationError(
      "planning string member data is invalid",
    );
  }
  return {
    id: row.id,
    stringId: base.data.stringId,
    groupId: base.data.groupId,
    rowFrom: base.data.rowFrom,
    rowTo: base.data.rowTo,
    colFrom: base.data.colFrom,
    colTo: base.data.colTo,
    effectiveCount: effectiveCountValue,
    createdAt: new Date(row.created_at).toISOString(),
    permissions: { canWrite },
  };
}

async function selectStringMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<MemberRow[]> {
  const found = await tx.execute<MemberRow>(sql`
    select id, string_id, group_id, row_from, row_to,
           col_from, col_to, created_at
      from planning_string_member
     where workspace_id = ${ctx.workspaceId}::uuid
       and string_id = ${stringId}::uuid
     order by row_from, col_from, row_to, col_to
  `);
  return found.rows;
}

export async function addMember(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: AddMemberInput,
): Promise<PlanningStringMemberDto> {
  requireWrite(ctx, RESOURCE);
  const validated = parseContractAdd(input);
  const stringScope = await requireStringInScope(tx, ctx, validated.stringId);
  const group = await requirePanelGroupInScope(tx, ctx, validated.groupId);

  // Gruppe muss zu einem Dach desselben Projekts gehoeren wie der
  // WR des Strings, sonst NotFound (Fremdprojekt tarnt sich nie als
  // ValidationError).
  if (
    group.project_id.toLowerCase() !== stringScope.project_id.toLowerCase()
  ) {
    throw new PlanningStringMemberNotFoundError(validated.groupId);
  }

  // Range gegen das Gruppen-Raster.
  if (
    validated.rowTo > group.rows ||
    validated.colTo > group.cols
  ) {
    throw new PlanningStringMemberValidationError(
      "member range exceeds panel group raster",
    );
  }

  const range: MemberRange = {
    groupId: validated.groupId,
    rowFrom: validated.rowFrom,
    rowTo: validated.rowTo,
    colFrom: validated.colFrom,
    colTo: validated.colTo,
  };

  // Voll-Deselect-Range rejectet hart (MEMBER_DESELECT_HARD).
  const deselects = await selectDeselectCells(tx, ctx, [group.id]);
  const groupCells = deselects.get(group.id.toLowerCase()) ?? [];
  if (isRangeFullyDeselected(range, groupCells)) {
    throw new PlanningStringMemberValidationError(
      "member range is fully deselected",
    );
  }

  // Ueberlapp mit einer Range desselben Strings rejectet.
  const siblings = await selectStringMembers(tx, ctx, stringScope.id);
  for (const sibling of siblings) {
    if (rangesOverlap(range, toMemberRange(sibling))) {
      throw new PlanningStringMemberValidationError(
        "member range overlaps another range of this string",
      );
    }
  }

  // Zell-Doppelbelegung in einem anderen String desselben WR ist
  // hart (pro WR, App-Level).
  const foreign = await tx.execute<MemberRangeRow>(sql`
    select m.group_id, m.row_from, m.row_to, m.col_from, m.col_to
      from planning_string_member m
      join planning_string s
        on s.workspace_id = m.workspace_id
       and s.id = m.string_id
     where m.workspace_id = ${ctx.workspaceId}::uuid
       and s.inverter_id = ${stringScope.inverter_id}::uuid
       and m.string_id <> ${stringScope.id}::uuid
  `);
  for (const other of foreign.rows) {
    if (rangesOverlap(range, toMemberRange(other))) {
      throw new PlanningStringMemberValidationError(
        "member range cell is already assigned to another string of this inverter",
      );
    }
  }

  let inserted;
  try {
    inserted = await tx.execute<MemberRow>(sql`
      insert into planning_string_member (
        workspace_id, string_id, group_id,
        row_from, row_to, col_from, col_to, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${stringScope.id}::uuid, ${group.id}::uuid,
        ${validated.rowFrom}, ${validated.rowTo},
        ${validated.colFrom}, ${validated.colTo},
        ${ctx.actor}::uuid
      )
      returning id, string_id, group_id, row_from, row_to,
                col_from, col_to, created_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningStringMemberNotFoundError(validated.stringId);
    }
    if (code === "23514") throw new PlanningStringMemberValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningStringMemberValidationError(
      "planning string member insert failed",
    );
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_string_member.added",
    actor: ctx.actor,
    payload: { stringId: stringScope.id, groupId: group.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string_member.add",
    resource: RESOURCE,
    allowed: true,
    details: { memberId: row.id, stringId: stringScope.id, groupId: group.id },
  });

  return toMemberDto(
    row,
    effectiveMemberCount({ ranges: [range], deselected: groupCells }),
    true,
  );
}

export async function removeMember(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningStringMemberValidationError(
      "planning string member id is invalid",
    );
  }
  const deleted = await tx.execute<{
    id: string;
    string_id: string;
    group_id: string;
  }>(sql`
    delete from planning_string_member
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     returning id, string_id, group_id
  `);
  const removed = deleted.rows[0];
  if (!removed) throw new PlanningStringMemberNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: removed.id,
    eventType: "planning_string_member.removed",
    actor: ctx.actor,
    payload: { stringId: removed.string_id, groupId: removed.group_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string_member.remove",
    resource: RESOURCE,
    allowed: true,
    details: {
      memberId: removed.id,
      stringId: removed.string_id,
      groupId: removed.group_id,
    },
  });

  return { id: removed.id };
}

export async function listMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<PlanningStringMemberDto[]> {
  requireRead(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(stringId);
  if (!parsed.success) {
    throw new PlanningStringMemberValidationError("string id is invalid");
  }
  const stringScope = await requireStringInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await selectStringMembers(tx, ctx, stringScope.id);
  const deselects = await selectDeselectCells(
    tx,
    ctx,
    rows.map((row) => row.group_id),
  );
  return rows.map((row) => {
    const range = toMemberRange(row);
    const cells = deselects.get(range.groupId) ?? [];
    return toMemberDto(
      row,
      effectiveMemberCount({ ranges: [range], deselected: cells }),
      canWrite,
    );
  });
}

export async function effectiveStringCount(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<PlanningStringMemberEffectiveCount> {
  requireRead(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(stringId);
  if (!parsed.success) {
    throw new PlanningStringMemberValidationError("string id is invalid");
  }
  const stringScope = await requireStringInScope(tx, ctx, parsed.data);
  const rows = await selectStringMembers(tx, ctx, stringScope.id);
  const deselects = await selectDeselectCells(
    tx,
    ctx,
    rows.map((row) => row.group_id),
  );
  let cellCount = 0;
  let effectiveCount = 0;
  for (const row of rows) {
    const range = toMemberRange(row);
    const cells = deselects.get(range.groupId) ?? [];
    const effective = effectiveMemberCount({ ranges: [range], deselected: cells });
    cellCount += (range.rowTo - range.rowFrom + 1) * (range.colTo - range.colFrom + 1);
    effectiveCount += effective;
  }
  return {
    stringId: stringScope.id,
    memberCount: rows.length,
    cellCount,
    deselectedCount: cellCount - effectiveCount,
    effectiveCount,
  };
}
