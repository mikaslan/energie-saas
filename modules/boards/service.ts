import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import { kanbanColumnColors, kanbanColumnTypes } from "@/lib/db/schema/boards";
import { getProjectOfferValues } from "@/modules/offers";
import {
  computeLeadScore,
  type LeadScore,
  type LeadScoreBand,
} from "@/lib/lead-score";
import {
  followUpBandForDate,
  parseFollowUpAt,
  type FollowUpBand,
} from "@/lib/follow-up";
import {
  can,
  isExternalOnly,
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
  assignment: {
    assignmentRevision: number;
    keyAccountLabel: string | null;
  } | null;
  // F1-07 Lead-Score (Regel-Score v1, ESTIMATE): null für externe
  // Leser — internes Qualifizierungssignal, kein Kunden-Datum.
  score: LeadScore | null;
  // F1-06 Wiedervorlage: null ohne Termin oder für externe Leser
  // (internes Arbeitsdatum, kein Kunden-Datum).
  followUp: { at: string; band: FollowUpBand } | null;
};

// F1-06 Filter-Preset: "due" = anstehend + fällig, "overdue" =
// überfällig + eskaliert.
export type RequestBoardFollowUpFilter = "due" | "overdue";

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
  audience: "internal" | "assigned_external";
  columns: RequestBoardColumn[];
  permissions: { canMoveCards: boolean; canOpenCatalog: boolean };
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
  source_key: string | null;
  created_at: Date | string;
  target_storage_kwh: number | string | null;
  wallbox: boolean | null;
  bidirectional_charging: boolean | null;
  backup_power: boolean | null;
  contact_email: string | null;
  contact_phone: string | null;
  site_lat: number | string | null;
  site_lng: number | string | null;
  lead_source_id: string | null;
  follow_up_at: Date | string | null;
  profile_id: string | null;
  profile_confirmed: boolean | null;
  has_requirements: boolean;
  dedupe_review_required: boolean;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  catalog_resolution_status: string;
  assignment_revision: number;
  key_account_label: string | null;
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

export class BoardColumnValidationError extends Error {
  constructor(message = "board column input invalid") {
    super(message);
    this.name = "BoardColumnValidationError";
  }
}

export class BoardColumnConflictError extends Error {
  constructor(message = "board column state conflict") {
    super(message);
    this.name = "BoardColumnConflictError";
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
  if (action === "project.write" && isExternalOnly(ctx)) {
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

function isNonEmpty(value: string | null): boolean {
  return value !== null && value.trim() !== "";
}

// F1-06: Wiedervorlage je Karte (Leseregel über gespeicherten Wert;
// null ohne Termin oder für externe Leser).
function followUpForCard(
  row: CardRow,
  external: boolean,
  now: Date,
): RequestBoardCard["followUp"] {
  if (external) return null;
  const at = row.follow_up_at === null ? null : parseFollowUpAt(row.follow_up_at);
  if (at === null) return null;
  return { at: at.toISOString(), band: followUpBandForDate(at, now) };
}

function followUpMatchesFilter(
  followUp: RequestBoardCard["followUp"],
  filter: RequestBoardFollowUpFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (followUp === null) return false;
  return filter === "due"
    ? followUp.band === "scheduled" || followUp.band === "due"
    : followUp.band === "overdue" || followUp.band === "escalated";
}

function locationLabel(row: CardRow): string {
  const locality = [row.postal_code, row.city].filter(Boolean).join(" ");
  if (locality) return locality;
  if (row.address_mode === "regional_estimate") return row.formatted_address ?? "Region offen";
  return "Standort offen";
}

// F15-01: Board-Scope ist explizit (kein hartcodierter Residential-Pfad
// mehr). Ungültiger Scope und fehlendes Board brechen fail-closed ab —
// kein stiller Scope-Fallback.
export const REQUEST_BOARD_SCOPES = ["residential", "commercial"] as const;
export type RequestBoardScope = (typeof REQUEST_BOARD_SCOPES)[number];

export async function getDefaultRequestBoard(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<RequestBoard> {
  return getRequestBoard(tx, ctx, { scope: "residential" });
}

export async function getRequestBoard(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { scope: RequestBoardScope; scoreBand?: LeadScoreBand; followUpFilter?: RequestBoardFollowUpFilter },
): Promise<RequestBoard> {
  requireProjectAccess(ctx, "project.read", "kanban_board");
  const scope = input.scope;
  if (scope !== "residential" && scope !== "commercial") {
    throw new RequestBoardConfigurationError(`unknown board scope ${JSON.stringify(scope)}`);
  }
  // F1-07 Filter-Preset: unbekannte Bänder fail-closed, kein stiller
  // Alle-Fallback. Externe Leser haben keinen Score (internes Signal).
  const scoreBand = input.scoreBand;
  if (scoreBand !== undefined && scoreBand !== "hot" && scoreBand !== "warm" && scoreBand !== "cold") {
    throw new RequestBoardConfigurationError(`unknown score band ${JSON.stringify(scoreBand)}`);
  }
  const external = isExternalOnly(ctx);
  if (external && scoreBand !== undefined) {
    throw new RequestBoardConfigurationError("score filter is not available for external readers");
  }
  // F1-06 Filter-Preset: unbekannte Werte fail-closed; extern ohne
  // Wiedervorlage (internes Signal).
  const followUpFilter = input.followUpFilter;
  if (followUpFilter !== undefined && followUpFilter !== "due" && followUpFilter !== "overdue") {
    throw new RequestBoardConfigurationError(`unknown follow-up filter ${JSON.stringify(followUpFilter)}`);
  }
  if (external && followUpFilter !== undefined) {
    throw new RequestBoardConfigurationError("follow-up filter is not available for external readers");
  }

  const boardResult = await tx.execute<BoardRow>(sql`
    select b.id as board_id, b.name as board_name, b.scope as board_scope,
           c.id as column_id, c.name as column_name,
           c.column_type, c.position as column_position,
           c.color as column_color, c.is_intake
    from kanban_board b
    join kanban_column c
      on c.workspace_id = b.workspace_id and c.board_id = b.id
    where b.workspace_id = ${ctx.workspaceId}::uuid
      and b.scope = ${scope}
      and b.is_default = true
      and b.archived_at is null
      and c.archived_at is null
    order by c.position, c.id
  `);
  if (boardResult.rows.length === 0) {
    throw new RequestBoardConfigurationError(`default ${scope} request board is missing`);
  }
  const boardId = boardResult.rows[0].board_id;
  if (boardResult.rows.some((row) => row.board_id !== boardId)) {
    throw new RequestBoardConfigurationError(`multiple default ${scope} request boards found`);
  }

  const cardResult = await tx.execute<CardRow>(sql`
    select p.id as project_id, p.name as project_name,
           p.kanban_column_id as column_id,
           case when ${external} then null else p.source_key end as source_key,
           p.created_at,
           c.display_name as contact_name,
           s.postal_code, s.city, s.formatted_address, s.address_mode,
           case when ${external} then null else c.email_primary end as contact_email,
           case when ${external} then null
             else coalesce(c.phone_e164, c.phone_mobile, c.phone_raw)
           end as contact_phone,
           case when ${external} then null else s.lat end as site_lat,
           case when ${external} then null else s.lng end as site_lng,
           case when ${external} then null else p.lead_source_id end as lead_source_id,
           case when ${external} then null else p.follow_up_at end as follow_up_at,
           prof.profile_id as profile_id,
           (prof.confirmed_at is not null) as profile_confirmed,
           pr.requirements is not null as has_requirements,
           coalesce(p.dedupe_review_required, false)
             or coalesce(c.dedupe_review_required, false) as dedupe_review_required,
           s.address_follow_up_required, s.pin_confirmed,
           p.catalog_resolution_status,
           case when ${external} then 0 else p.assignment_revision end
             as assignment_revision,
           nullif(pr.requirements #>> '{requestedProducts,targetStorageKwh}', '')::numeric
             as target_storage_kwh,
           (pr.requirements #>> '{requestedProducts,wallbox}')::boolean as wallbox,
           (pr.requirements #>> '{requestedProducts,bidirectionalCharging}')::boolean
             as bidirectional_charging,
           (pr.requirements #>> '{requestedProducts,backupPower}')::boolean as backup_power,
           key_account.label as key_account_label
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
    left join lateral (
      select identity_record.email as label
      from project_assignment assignment_record
      join membership membership_record
        on membership_record.workspace_id = assignment_record.workspace_id
       and membership_record.id = assignment_record.membership_id
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
      where assignment_record.workspace_id = p.workspace_id
        and assignment_record.project_id = p.id
        and assignment_record.assignment_role = 'key_account'
        and ${!external}
      limit 1
    ) key_account on true
    left join lateral (
      -- F1-07: id als Existenz-Marker (IS NOT NULL wäre auch ohne Zeile
      -- FALSE statt NULL und damit als Marker unbrauchbar).
      select energy_profile.id as profile_id, energy_profile.confirmed_at
      from site_energy_profile energy_profile
      where energy_profile.workspace_id = p.workspace_id
        and energy_profile.site_id = p.site_id
      limit 1
    ) prof on true
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.kanban_board_id = ${boardId}::uuid
      and p.phase = 'request'
      and p.outcome = 'open'
      and (
        ${!external}
        or exists (
          select 1
          from membership actor_membership
          join project_assignment direct_assignment
            on direct_assignment.workspace_id = actor_membership.workspace_id
           and direct_assignment.membership_id = actor_membership.id
           and direct_assignment.project_id = p.id
           and direct_assignment.assignment_role in ('key_account', 'user')
          where actor_membership.workspace_id = p.workspace_id
            and actor_membership.user_id = ${ctx.actor}::uuid
        )
      )
    order by p.created_at desc, p.id desc
  `);

  const activeColumnIds = new Set(boardResult.rows.map((row) => row.column_id));
  const cardsByColumn = new Map<string, RequestBoardCard[]>();
  // F1-06: ein Lesezeitpunkt je Board-Aufruf (stabile Bänder über alle Karten).
  const boardNow = new Date();
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
      sourceLabel: external
        ? "Zugewiesene Anfrage"
        : row.source_key === "wmee-rechner-v3" ? "Solarrechner" : "Manuell",
      createdAt: iso(row.created_at),
      requestedProducts: {
        photovoltaics: external || row.source_key === "wmee-rechner-v3",
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
      assignment: external ? null : {
        assignmentRevision: row.assignment_revision,
        keyAccountLabel: row.key_account_label,
      },
      followUp: followUpForCard(row, external, boardNow),
      score: external ? null : computeLeadScore({
        hasEmail: isNonEmpty(row.contact_email),
        hasPhone: isNonEmpty(row.contact_phone),
        hasAddress: isNonEmpty(row.postal_code) && isNonEmpty(row.city),
        hasGeo: row.site_lat !== null && row.site_lng !== null,
        hasProfile: row.profile_id !== null,
        profileConfirmed: row.profile_id !== null && row.profile_confirmed === true,
        hasRequirements: row.has_requirements === true,
        hasKeyAccount: row.key_account_label !== null,
        hasSource: row.lead_source_id !== null,
      }),
    });
    cardsByColumn.set(row.column_id, cards);
  }

  const first = boardResult.rows[0];
  return {
    id: first.board_id,
    name: first.board_name,
    scope: first.board_scope,
    audience: external ? "assigned_external" : "internal",
    columns: boardResult.rows.map((row) => ({
      id: row.column_id,
      name: row.column_name,
      type: row.column_type,
      position: row.column_position,
      color: row.column_color,
      isIntake: row.is_intake,
      // F1-07 Filter-Preset: Ansichtslinse über Bänder; leere Spalten
      // bleiben stehen (stabile Struktur, keine Definitionsänderung).
      cards: (cardsByColumn.get(row.column_id) ?? []).filter(
        (card) =>
          (scoreBand === undefined || card.score?.band === scoreBand)
          && followUpMatchesFilter(card.followUp, followUpFilter),
      ),
    })),
    permissions: external
      ? { canMoveCards: false, canOpenCatalog: false }
      : {
          canMoveCards: can(ctx, "project.write"),
          canOpenCatalog: can(ctx, "catalog.read"),
        },
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

// ═══════════════════════════════════════════════════════════════════════
// F1-05a · Spaltenverwaltung (frei definierbare Spalten, Katalog F1.5)
// ═══════════════════════════════════════════════════════════════════════

export type BoardColumnType = (typeof kanbanColumnTypes)[number];
export type BoardColumnColor = (typeof kanbanColumnColors)[number];

type BoardColumnRow = {
  id: string;
  board_id: string;
  name: string;
  column_type: BoardColumnType;
  position: number;
  color: BoardColumnColor;
  is_intake: boolean;
  conversion_ratio_bps: number | null;
  archived_at: string | null;
};

function validatedColumnName(value: unknown): string {
  if (typeof value !== "string") throw new BoardColumnValidationError("name required");
  const name = value.trim();
  if (name.length < 1 || name.length > 120) {
    throw new BoardColumnValidationError("name must be 1..120 chars");
  }
  return name;
}

function validatedColumnType(value: unknown): BoardColumnType {
  if (typeof value !== "string" || !(kanbanColumnTypes as readonly string[]).includes(value)) {
    throw new BoardColumnValidationError("unknown column type");
  }
  return value as BoardColumnType;
}

function validatedColumnColor(value: unknown): BoardColumnColor {
  if (value === undefined) return "neutral";
  if (typeof value !== "string" || !(kanbanColumnColors as readonly string[]).includes(value)) {
    throw new BoardColumnValidationError("unknown column color");
  }
  return value as BoardColumnColor;
}

async function loadColumnForUpdate(
  tx: TenantTx,
  ctx: ServiceCtx,
  columnId: string,
): Promise<BoardColumnRow> {
  const found = await tx.execute<BoardColumnRow>(sql`
    select id, board_id, name, column_type, position, color, is_intake,
           conversion_ratio_bps, archived_at
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${columnId}::uuid
     for update
  `);
  const row = found.rows[0];
  if (!row) throw new BoardColumnConflictError("column not found");
  return row;
}

async function emitColumnEvent(
  tx: TenantTx,
  ctx: ServiceCtx,
  eventType: string,
  columnId: string,
  boardId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "kanban_column",
    aggregateId: columnId,
    eventType,
    actor: ctx.actor,
    payload: { columnId, boardId, ...details },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "kanban_column",
    allowed: true,
    details: { columnId, boardId, ...details },
  });
}

/**
 * Neue Spalte am Ende des Boards (Typ frei wählbar — F1.5
 * Spalten-Typen; Automatik je Typ bleibt Folgeslice).
 */
export type BoardColumnAdminEntry = {
  id: string;
  name: string;
  type: BoardColumnType;
  position: number;
  color: BoardColumnColor;
  isIntake: boolean;
  conversionRatioBps: number | null;
  archived: boolean;
  cardCount: number;
};

/**
 * Alle Spalten eines Boards inkl. archivierter (Verwaltung; Karten
 * zählen für das Archiv-Guard-Feedback).
 */
export async function listBoardColumnsForAdmin(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { boardId: string },
): Promise<BoardColumnAdminEntry[]> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  const found = await tx.execute<BoardColumnRow & { card_count: string }>(sql`
    select c.id, c.board_id, c.name, c.column_type, c.position, c.color,
           c.is_intake, c.conversion_ratio_bps, c.archived_at,
           count(p.id)::text as card_count
      from kanban_column c
      left join project p
        on p.workspace_id = c.workspace_id
       and p.kanban_column_id = c.id
     where c.workspace_id = ${ctx.workspaceId}::uuid
       and c.board_id = ${input.boardId}::uuid
     group by c.id
     order by c.archived_at nulls first, c.position asc, c.id asc
  `);
  return found.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.column_type,
    position: Number(row.position),
    color: row.color,
    isIntake: row.is_intake,
    conversionRatioBps: row.conversion_ratio_bps === null
      ? null
      : Number(row.conversion_ratio_bps),
    archived: row.archived_at !== null,
    cardCount: Number(row.card_count ?? 0),
  }));
}

export async function createBoardColumn(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { boardId: string; name: string; columnType: string; color?: string },
): Promise<{ id: string; position: number }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  const name = validatedColumnName(input.name);
  const columnType = validatedColumnType(input.columnType);
  const color = validatedColumnColor(input.color);

  const board = await tx.execute<{ id: string }>(sql`
    select id from kanban_board
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.boardId}::uuid
       and archived_at is null
     limit 1
  `);
  if (!board.rows[0]) throw new BoardColumnConflictError("board not found");

  const maxPosition = await tx.execute<{ position: number }>(sql`
    select coalesce(max(position), 0)::integer as position
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${input.boardId}::uuid
       and archived_at is null
  `);
  const position = Number(maxPosition.rows[0]?.position ?? 0) + 1;
  const id = randomUUID();
  await tx.execute(sql`
    insert into kanban_column (
      id, workspace_id, board_id, name, column_type, position, color, is_intake
    ) values (
      ${id}::uuid, ${ctx.workspaceId}::uuid, ${input.boardId}::uuid,
      ${name}, ${columnType}, ${position}, ${color}, false
    )
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.created", id, input.boardId, {
    name, columnType, color, position,
  });
  return { id, position };
}

export async function renameBoardColumn(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { columnId: string; name: string },
): Promise<{ id: string; name: string }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  const name = validatedColumnName(input.name);
  const column = await loadColumnForUpdate(tx, ctx, input.columnId);
  if (column.archived_at !== null) throw new BoardColumnConflictError("column archived");
  await tx.execute(sql`
    update kanban_column
       set name = ${name}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.columnId}::uuid
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.renamed", column.id, column.board_id, {
    name,
  });
  return { id: column.id, name };
}

export async function moveBoardColumn(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { columnId: string; direction: "left" | "right" },
): Promise<{ id: string; position: number; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  if (input.direction !== "left" && input.direction !== "right") {
    throw new BoardColumnValidationError("direction must be left or right");
  }
  const column = await loadColumnForUpdate(tx, ctx, input.columnId);
  if (column.archived_at !== null) throw new BoardColumnConflictError("column archived");
  const siblings = await tx.execute<BoardColumnRow>(sql`
    select id, board_id, name, column_type, position, color, is_intake,
           conversion_ratio_bps, archived_at
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${column.board_id}::uuid
       and archived_at is null
     order by position asc, id asc
  `);
  const index = siblings.rows.findIndex((row) => row.id === column.id);
  const neighbor = input.direction === "left"
    ? siblings.rows[index - 1]
    : siblings.rows[index + 1];
  if (!neighbor) return { id: column.id, position: column.position, changed: false };
  // Tausch über temporäre Position (Partial-Unique-Index bleibt gültig).
  const ceiling = await tx.execute<{ position: number }>(sql`
    select coalesce(max(position), 0)::integer as position
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${column.board_id}::uuid
  `);
  const temp = Number(ceiling.rows[0]?.position ?? 0) + 1;
  await tx.execute(sql`
    update kanban_column set position = ${temp}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${column.id}::uuid
  `);
  await tx.execute(sql`
    update kanban_column set position = ${column.position}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${neighbor.id}::uuid
  `);
  await tx.execute(sql`
    update kanban_column set position = ${neighbor.position}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${column.id}::uuid
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.moved", column.id, column.board_id, {
    fromPosition: column.position, toPosition: neighbor.position,
  });
  return { id: column.id, position: neighbor.position, changed: true };
}

export async function archiveBoardColumn(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { columnId: string },
): Promise<{ id: string; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  const column = await loadColumnForUpdate(tx, ctx, input.columnId);
  if (column.archived_at !== null) return { id: column.id, changed: false };
  // Intake-Spalte trägt die Anfrage-Lane (fail-closed, kein stiller
  // Verlust des genau-einen Intake-Pfads).
  if (column.is_intake) throw new BoardColumnValidationError("intake column cannot be archived");
  const cards = await tx.execute<{ count: string }>(sql`
    select count(*)::text as count from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and kanban_column_id = ${column.id}::uuid
  `);
  if (Number(cards.rows[0]?.count ?? 0) > 0) {
    throw new BoardColumnConflictError("column still holds cards");
  }
  await tx.execute(sql`
    update kanban_column
       set archived_at = now(), updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${column.id}::uuid
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.archived", column.id, column.board_id, {});
  return { id: column.id, changed: true };
}

export async function restoreBoardColumn(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { columnId: string },
): Promise<{ id: string; position: number; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  const column = await loadColumnForUpdate(tx, ctx, input.columnId);
  if (column.archived_at === null) {
    return { id: column.id, position: column.position, changed: false };
  }
  const taken = await tx.execute<{ id: string }>(sql`
    select id from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${column.board_id}::uuid
       and archived_at is null
       and position = ${column.position}
     limit 1
  `);
  let position = column.position;
  if (taken.rows[0]) {
    const ceiling = await tx.execute<{ position: number }>(sql`
      select coalesce(max(position), 0)::integer as position
        from kanban_column
       where workspace_id = ${ctx.workspaceId}::uuid
         and board_id = ${column.board_id}::uuid
    `);
    position = Number(ceiling.rows[0]?.position ?? 0) + 1;
  }
  await tx.execute(sql`
    update kanban_column
       set archived_at = null, position = ${position}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${column.id}::uuid
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.restored", column.id, column.board_id, {
    position,
  });
  return { id: column.id, position, changed: true };
}

// ═══════════════════════════════════════════════════════════════════════
// F1-05b · Conversion-Ratio + gewichtete Pipeline (Katalog F1.5)
// ═══════════════════════════════════════════════════════════════════════

export type PipelineColumnInput = {
  id: string;
  totalNetCents: number;
  conversionRatioBps: number | null;
};

export type PipelineWeightedColumn = PipelineColumnInput & {
  weightedNetCents: number | null;
};

/**
 * Reine Gewichtungsmathematik (centgenau, kaufmännisch gerundet):
 * Spalte ohne Ratio zählt NICHT zur gewichteten Pipeline (null statt 0,
 * damit „keine Ratio" von „0 %" unterscheidbar bleibt).
 */
export function applyConversionRatios(
  columns: readonly PipelineColumnInput[],
): { columns: PipelineWeightedColumn[]; weightedTotalNetCents: number | null } {
  let total: number | null = null;
  const weighted = columns.map((column) => {
    if (column.conversionRatioBps === null) {
      return { ...column, weightedNetCents: null };
    }
    const weightedNetCents = Math.round(
      (column.totalNetCents * column.conversionRatioBps) / 10_000,
    );
    total = (total ?? 0) + weightedNetCents;
    return { ...column, weightedNetCents };
  });
  return { columns: weighted, weightedTotalNetCents: total };
}

export type BoardPipelineSummary = {
  boardId: string;
  projectCount: number;
  totalNetCents: number;
  weightedTotalNetCents: number | null;
  columns: Array<{
    id: string;
    name: string;
    projectCount: number;
    totalNetCents: number;
    conversionRatioBps: number | null;
    weightedNetCents: number | null;
  }>;
};

/**
 * Pipeline-Kennzahlen eines Boards: Projektzahl und Angebotswerte je
 * aktiver Spalte (Angebotswert = aktueller Angebotswert je Projekt,
 * Projekte ohne Angebot zählen mit 0) plus gewichtete Summe über
 * Spalten mit Ratio. Leseschranke wie das Board (keine neue Permission).
 */
export async function getBoardPipelineSummary(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { boardId: string },
): Promise<BoardPipelineSummary> {
  requireProjectAccess(ctx, "project.read", "kanban_board");
  const columns = await tx.execute<{
    id: string; name: string; conversion_ratio_bps: number | null;
  }>(sql`
    select id, name, conversion_ratio_bps
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${input.boardId}::uuid
       and archived_at is null
     order by position asc, id asc
  `);
  const projects = await tx.execute<{ id: string; column_id: string }>(sql`
    select id, kanban_column_id as column_id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and kanban_board_id = ${input.boardId}::uuid
  `);
  // Externe Leser sehen keine Angebotswerte (Maskierung wie Karten);
  // Summen bleiben 0, Zähler intakt — fail-closed statt Board-Denial
  // (F1-05b-Regression: getProjectOfferValues lehnt Externe ab).
  const values: Record<string, number | null> = isExternalOnly(ctx)
    ? {}
    : await getProjectOfferValues(
      tx,
      ctx,
      projects.rows.map((row) => row.id),
    );
  const byColumn = new Map<string, { count: number; total: number }>();
  for (const project of projects.rows) {
    const entry = byColumn.get(project.column_id) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += values[project.id] ?? 0;
    byColumn.set(project.column_id, entry);
  }
  const weighted = applyConversionRatios(
    columns.rows.map((column) => ({
      id: column.id,
      totalNetCents: byColumn.get(column.id)?.total ?? 0,
      conversionRatioBps: column.conversion_ratio_bps === null
        ? null
        : Number(column.conversion_ratio_bps),
    })),
  );
  let projectCount = 0;
  let totalNetCents = 0;
  const summaryColumns = columns.rows.map((column, index) => {
    const entry = byColumn.get(column.id) ?? { count: 0, total: 0 };
    projectCount += entry.count;
    totalNetCents += entry.total;
    return {
      id: column.id,
      name: column.name,
      projectCount: entry.count,
      totalNetCents: entry.total,
      conversionRatioBps: weighted.columns[index]?.conversionRatioBps ?? null,
      weightedNetCents: weighted.columns[index]?.weightedNetCents ?? null,
    };
  });
  return {
    boardId: input.boardId,
    projectCount,
    totalNetCents,
    weightedTotalNetCents: weighted.weightedTotalNetCents,
    columns: summaryColumns,
  };
}

export async function setColumnConversionRatio(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { columnId: string; ratioBps: number | null },
): Promise<{ id: string; ratioBps: number | null }> {
  requireProjectAccess(ctx, "project.write", "kanban_column");
  if (
    input.ratioBps !== null
    && (!Number.isInteger(input.ratioBps) || input.ratioBps < 0 || input.ratioBps > 10_000)
  ) {
    throw new BoardColumnValidationError("ratio must be 0..10000 bps or null");
  }
  const column = await loadColumnForUpdate(tx, ctx, input.columnId);
  if (column.archived_at !== null) throw new BoardColumnConflictError("column archived");
  await tx.execute(sql`
    update kanban_column
       set conversion_ratio_bps = ${input.ratioBps}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${column.id}::uuid
  `);
  await emitColumnEvent(tx, ctx, "kanban_column.ratio_set", column.id, column.board_id, {
    ratioBps: input.ratioBps,
  });
  return { id: column.id, ratioBps: input.ratioBps };
}
