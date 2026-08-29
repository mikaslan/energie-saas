import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import {
  can,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";

export type RequestBoardCard = {
  id: string;
  name: string;
  contactName: string;
  locationLabel: string;
  sourceLabel: string;
  createdAt: string;
  requestedProducts: {
    photovoltaics: boolean;
    targetStorageKwh: number | null;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  };
  blockers: {
    dedupeReviewRequired: boolean;
    addressFollowUpRequired: boolean;
    pinConfirmationRequired: boolean;
    catalogResolutionPending: boolean;
  };
};

export type RequestBoardColumn = {
  id: string;
  name: string;
  type: "lead" | "offer" | "won" | "lost";
  position: number;
  color: "neutral" | "blue" | "amber" | "green";
  isIntake: boolean;
  cards: RequestBoardCard[];
};

export type RequestBoard = {
  id: string;
  name: string;
  scope: "residential" | "commercial";
  columns: RequestBoardColumn[];
  permissions: { canMoveCards: boolean };
};

type BoardRow = {
  board_id: string;
  board_name: string;
  board_scope: "residential" | "commercial";
  column_id: string;
  column_name: string;
  column_type: "lead" | "offer" | "won" | "lost";
  column_position: number;
  column_color: "neutral" | "blue" | "amber" | "green";
  is_intake: boolean;
  [key: string]: unknown;
};

type CardRow = {
  project_id: string;
  project_name: string;
  column_id: string;
  contact_name: string;
  postal_code: string | null;
  city: string | null;
  formatted_address: string | null;
  address_mode: string;
  source_key: string;
  created_at: Date | string;
  target_storage_kwh: number | string | null;
  wallbox: boolean | null;
  bidirectional_charging: boolean | null;
  backup_power: boolean | null;
  dedupe_review_required: boolean;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  catalog_resolution_status: string;
  [key: string]: unknown;
};

type LockedProjectRow = {
  id: string;
  board_id: string;
  column_id: string;
  phase: string;
  outcome: string;
  [key: string]: unknown;
};

export class ProjectMoveConflictError extends Error {
  constructor() {
    super("project card changed since it was loaded");
    this.name = "ProjectMoveConflictError";
  }
}

class RequestBoardConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBoardConfigurationError";
  }
}

function requireProjectAccess(
  ctx: ServiceCtx,
  action: "project.read" | "project.write",
  resource: string,
): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (ctx.capabilities.external_only === true) {
    throw new PermissionDeniedError(
      action,
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RequestBoardConfigurationError("invalid project timestamp");
  return date.toISOString();
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function locationLabel(row: CardRow): string {
  const locality = [row.postal_code, row.city].filter(Boolean).join(" ");
  if (locality) return locality;
  if (row.address_mode === "regional_estimate") return row.formatted_address ?? "Region offen";
  return "Standort offen";
}

export async function getDefaultRequestBoard(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<RequestBoard> {
  requireProjectAccess(ctx, "project.read", "kanban_board");

  const boardResult = await tx.execute<BoardRow>(sql`
    select b.id as board_id, b.name as board_name, b.scope as board_scope,
           c.id as column_id, c.name as column_name,
           c.column_type, c.position as column_position,
           c.color as column_color, c.is_intake
    from kanban_board b
    join kanban_column c
      on c.workspace_id = b.workspace_id and c.board_id = b.id
    where b.workspace_id = ${ctx.workspaceId}::uuid
      and b.scope = 'residential'
      and b.is_default = true
      and b.archived_at is null
      and c.archived_at is null
    order by c.position, c.id
  `);
  if (boardResult.rows.length === 0) {
    throw new RequestBoardConfigurationError("default residential request board is missing");
  }
  const boardId = boardResult.rows[0].board_id;
  if (boardResult.rows.some((row) => row.board_id !== boardId)) {
    throw new RequestBoardConfigurationError("multiple default residential request boards found");
  }

  const cardResult = await tx.execute<CardRow>(sql`
    select p.id as project_id, p.name as project_name,
           p.kanban_column_id as column_id, p.source_key, p.created_at,
           c.display_name as contact_name,
           s.postal_code, s.city, s.formatted_address, s.address_mode,
           coalesce(p.dedupe_review_required, false)
             or coalesce(c.dedupe_review_required, false) as dedupe_review_required,
           s.address_follow_up_required, s.pin_confirmed,
           p.catalog_resolution_status,
           nullif(pr.requirements #>> '{requestedProducts,targetStorageKwh}', '')::numeric
             as target_storage_kwh,
           (pr.requirements #>> '{requestedProducts,wallbox}')::boolean as wallbox,
           (pr.requirements #>> '{requestedProducts,bidirectionalCharging}')::boolean
             as bidirectional_charging,
           (pr.requirements #>> '{requestedProducts,backupPower}')::boolean as backup_power
    from project p
    join contact c
      on c.workspace_id = p.workspace_id and c.id = p.contact_id
    join site s
      on s.workspace_id = p.workspace_id and s.id = p.site_id
    left join lateral (
      select requirement.requirements
      from project_requirement requirement
      where requirement.workspace_id = p.workspace_id
        and requirement.project_id = p.id
      order by requirement.revision desc
      limit 1
    ) pr on true
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.kanban_board_id = ${boardId}::uuid
      and p.phase = 'request'
      and p.outcome = 'open'
    order by p.created_at desc, p.id desc
  `);

  const activeColumnIds = new Set(boardResult.rows.map((row) => row.column_id));
  const cardsByColumn = new Map<string, RequestBoardCard[]>();
  for (const row of cardResult.rows) {
    if (!activeColumnIds.has(row.column_id)) {
      throw new RequestBoardConfigurationError(
        "an open request project references an inactive board column",
      );
    }
    const cards = cardsByColumn.get(row.column_id) ?? [];
    cards.push({
      id: row.project_id,
      name: row.project_name,
      contactName: row.contact_name,
      locationLabel: locationLabel(row),
      sourceLabel: row.source_key === "wmee-rechner-v3" ? "Solarrechner" : "Manuell",
      createdAt: iso(row.created_at),
      requestedProducts: {
        photovoltaics: row.source_key === "wmee-rechner-v3",
        targetStorageKwh: numberOrNull(row.target_storage_kwh),
        wallbox: row.wallbox === true,
        bidirectionalCharging: row.bidirectional_charging === true,
        backupPower: row.backup_power === true,
      },
      blockers: {
        dedupeReviewRequired: row.dedupe_review_required,
        addressFollowUpRequired: row.address_follow_up_required,
        pinConfirmationRequired: !row.pin_confirmed,
        catalogResolutionPending: row.catalog_resolution_status !== "resolved",
      },
    });
    cardsByColumn.set(row.column_id, cards);
  }

  const first = boardResult.rows[0];
  return {
    id: first.board_id,
    name: first.board_name,
    scope: first.board_scope,
    columns: boardResult.rows.map((row) => ({
      id: row.column_id,
      name: row.column_name,
      type: row.column_type,
      position: row.column_position,
      color: row.column_color,
      isIntake: row.is_intake,
      cards: cardsByColumn.get(row.column_id) ?? [],
    })),
    permissions: { canMoveCards: can(ctx, "project.write") },
  };
}

export async function moveProjectCard(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    expectedColumnId: string;
    targetColumnId: string;
  },
): Promise<{ projectId: string; columnId: string; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "project_kanban");

  const locked = await tx.execute<LockedProjectRow>(sql`
    select id, kanban_board_id as board_id, kanban_column_id as column_id,
           phase, outcome
    from project
    where workspace_id = ${ctx.workspaceId}::uuid
      and id = ${input.projectId}::uuid
    for update
  `);
  const current = locked.rows[0];
  if (!current) throw new ProjectMoveConflictError();
  if (current.column_id !== input.expectedColumnId) throw new ProjectMoveConflictError();
  if (current.phase !== "request" || current.outcome !== "open") {
    throw new ProjectMoveConflictError();
  }
  const target = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
    from kanban_column
    where workspace_id = ${ctx.workspaceId}::uuid
      and board_id = ${current.board_id}::uuid
      and id = ${input.targetColumnId}::uuid
      and column_type = 'lead'
      and archived_at is null
  `);
  if (!target.rows[0]) throw new ProjectMoveConflictError();
  if (current.column_id === input.targetColumnId) {
    return { projectId: current.id, columnId: current.column_id, changed: false };
  }

  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update project
    set kanban_column_id = ${input.targetColumnId}::uuid,
        updated_at = now()
    where workspace_id = ${ctx.workspaceId}::uuid
      and id = ${input.projectId}::uuid
      and kanban_column_id = ${input.expectedColumnId}::uuid
    returning id
  `);
  if (!updated.rows[0]) throw new ProjectMoveConflictError();

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "project.kanban_moved",
    actor: ctx.actor,
    payload: {
      projectId: input.projectId,
      fromColumnId: input.expectedColumnId,
      toColumnId: input.targetColumnId,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "project_kanban",
    allowed: true,
    details: {
      projectId: input.projectId,
      fromColumnId: input.expectedColumnId,
      toColumnId: input.targetColumnId,
    },
  });

  return { projectId: input.projectId, columnId: input.targetColumnId, changed: true };
}
