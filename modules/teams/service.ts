// F1-12 Teams (Slice 1: Stammdaten + Termin-Bindung): benannte Teams mit
// Mitgliedern (Membership-Bindung, M1-09-Muster). Verwaltung
// settings.manage (Admin, internalOnly; Verlustgrund-Präzedenz), Lesen
// calendar.read (Termin-Kontext). Archiv statt Delete; Revision-CAS bei
// Umbenennen/Aktivieren; Mitglieder Voll-Replace (Last-Writer-Wins).
// Hinweis: KEIN "server-only"-Import — Muster modules/lead-sources.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  TEAM_LIST_MAX,
  createTeamCommandSchema,
  renameTeamCommandSchema,
  setTeamActiveCommandSchema,
  setTeamMembersCommandSchema,
  teamDtoSchema,
  teamMembershipSchema,
  teamOptionSchema,
  type TeamDto,
  type TeamMembership,
  type TeamOption,
} from "@/lib/integrations/teams/contract";

export type { TeamDto, TeamMembership, TeamOption } from "@/lib/integrations/teams/contract";

export class TeamValidationError extends Error {
  constructor(message = "team input invalid") {
    super(message);
    this.name = "TeamValidationError";
  }
}

export class TeamNotFoundError extends Error {
  constructor() {
    super("team not found");
    this.name = "TeamNotFoundError";
  }
}

export class TeamConflictError extends Error {
  constructor(message = "team conflict") {
    super(message);
    this.name = "TeamConflictError";
  }
}

function requireManage(ctx: ServiceCtx): void {
  if (!can(ctx, "settings.manage") || isExternalOnly(ctx)) {
    throw new PermissionDeniedError("settings.manage", "team", undefined, ctx.actor);
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "calendar.read")) {
    throw new PermissionDeniedError("calendar.read", "team", undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type TeamRow = {
  id: string;
  name: string;
  active: boolean;
  revision: number;
  // Roh-tx.execute liefert timestamptz als String (kein Date-Parsing).
  created_at: string;
  updated_at: string;
};

type TeamMemberRow = {
  team_id: string;
  membership_id: string;
  label: string;
};

// Nur interne Memberships (Viewer/Editor/Admin, kein external_only) —
// M1-09-Muster wie Termin-Teilnehmer (kein stiller Ausschluss: der
// Service wirft Validation, wenn eine ID nicht intern ist).
async function requireInternalMemberships(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<void> {
  const expected = [...new Set(membershipIds)];
  if (expected.length === 0) return;
  const found = await tx.execute<{ id: string }>(sql`
    select id
      from membership
     where workspace_id = ${workspaceId}::uuid
       and id in (${sql.join(expected.map((id) => sql`${id}::uuid`), sql`, `)})
       and role in ('viewer', 'editor', 'admin')
       and jsonb_typeof(capabilities) = 'object'
       and not exists (
         select 1
           from jsonb_each(capabilities) as capability(key, value)
          where jsonb_typeof(capability.value) <> 'boolean'
       )
       and (
         not (capabilities ? 'external_only')
         or capabilities->'external_only' = 'false'::jsonb
       )
  `);
  if (found.rows.length !== expected.length) throw new TeamValidationError("unknown membership");
}

async function listMembersByTeam(
  tx: TenantTx,
  workspaceId: string,
): Promise<Map<string, { membershipId: string; label: string }[]>> {
  const result = await tx.execute<TeamMemberRow>(sql`
    select member.team_id, member.membership_id, identity_record.email as label
      from team_member member
      join membership membership_record
        on membership_record.workspace_id = member.workspace_id
       and membership_record.id = member.membership_id
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where member.workspace_id = ${workspaceId}::uuid
     order by lower(identity_record.email), member.membership_id
  `);
  const byTeam = new Map<string, { membershipId: string; label: string }[]>();
  for (const row of result.rows) {
    const list = byTeam.get(row.team_id) ?? [];
    list.push({ membershipId: row.membership_id, label: row.label });
    byTeam.set(row.team_id, list);
  }
  return byTeam;
}

function toDto(row: TeamRow, members: { membershipId: string; label: string }[]): TeamDto {
  return teamDtoSchema.parse({
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    active: row.active,
    revision: row.revision,
    members,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export async function listTeams(tx: TenantTx, ctx: ServiceCtx): Promise<TeamDto[]> {
  requireManage(ctx);
  const result = await tx.execute<TeamRow>(sql`
    select id, name, active, revision, created_at, updated_at
      from team
     where workspace_id = ${ctx.workspaceId}::uuid
     order by active desc, lower(name), id
     limit ${TEAM_LIST_MAX}
  `);
  const members = await listMembersByTeam(tx, ctx.workspaceId);
  return result.rows.map((row) => toDto(row, members.get(row.id) ?? []));
}

// Aktive Teams für den Termindialog (Termin-Kontext, kein Admin nötig).
export async function listTeamOptions(tx: TenantTx, ctx: ServiceCtx): Promise<TeamOption[]> {
  requireRead(ctx);
  const result = await tx.execute<{ id: string; name: string }>(sql`
    select id, name
      from team
     where workspace_id = ${ctx.workspaceId}::uuid
       and active = true
     order by lower(name), id
     limit ${TEAM_LIST_MAX}
  `);
  return teamOptionSchema.array().parse(result.rows);
}

// F7-07: Zugehörigkeit je Membership über aktive Teams (Lesekontext,
// calendar.read wie listTeamOptions; keine PII — nur UUIDs, Labels kommen
// aus dem Board-Member-Lesepfad). Deterministisch nach Teamname/IDs.
export async function listTeamMemberships(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<TeamMembership[]> {
  requireRead(ctx);
  const result = await tx.execute<{ team_id: string; team_name: string; membership_id: string }>(sql`
    select team_record.id as team_id,
           team_record.name as team_name,
           member_record.membership_id as membership_id
      from team team_record
      join team_member member_record
        on member_record.workspace_id = team_record.workspace_id
       and member_record.team_id = team_record.id
     where team_record.workspace_id = ${ctx.workspaceId}::uuid
       and team_record.active = true
     order by lower(team_record.name), team_record.id, member_record.membership_id
     limit ${TEAM_LIST_MAX}
  `);
  return teamMembershipSchema.array().parse(result.rows.map((row) => ({
    teamId: row.team_id,
    teamName: row.team_name,
    membershipId: row.membership_id,
  })));
}

// Interne Memberships für die Mitglieder-Checkboxen (Verwaltungs-Kontext).
export async function listTeamMemberOptions(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<{ membershipId: string; label: string }[]> {
  requireManage(ctx);
  const result = await tx.execute<{ membership_id: string; label: string }>(sql`
    select membership_record.id as membership_id, identity_record.email as label
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${ctx.workspaceId}::uuid
       and membership_record.role in ('viewer', 'editor', 'admin')
       and jsonb_typeof(membership_record.capabilities) = 'object'
       and not exists (
         select 1
           from jsonb_each(membership_record.capabilities) as capability(key, value)
          where jsonb_typeof(capability.value) <> 'boolean'
       )
       and (
         not (membership_record.capabilities ? 'external_only')
         or membership_record.capabilities->'external_only' = 'false'::jsonb
       )
     order by lower(identity_record.email), membership_record.id
     limit ${TEAM_LIST_MAX}
  `);
  return result.rows.map((row) => ({ membershipId: row.membership_id, label: row.label }));
}

async function lockTeam(tx: TenantTx, workspaceId: string, id: string): Promise<TeamRow> {
  const result = await tx.execute<TeamRow>(sql`
    select id, name, active, revision, created_at, updated_at
      from team
     where workspace_id = ${workspaceId}::uuid
       and id = ${id}::uuid
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new TeamNotFoundError();
  return row;
}

export async function createTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { name: string },
): Promise<TeamDto> {
  requireManage(ctx);
  const parsed = createTeamCommandSchema.safeParse({ schemaVersion: 1, ...input });
  if (!parsed.success) throw new TeamValidationError();
  const id = randomUUID();
  try {
    await tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, created_by)
      values (
        ${id}::uuid, ${ctx.workspaceId}::uuid,
        ${parsed.data.name}, lower(btrim(${parsed.data.name})),
        ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    if (postgresErrorCode(error) === "23505") throw new TeamConflictError("duplicate team name");
    throw error;
  }
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: "team",
    allowed: true,
    details: { operation: "create", teamId: id },
  });
  const row = await lockTeam(tx, ctx.workspaceId, id);
  return toDto(row, []);
}

export async function renameTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; name: string; expectedRevision: number },
): Promise<TeamDto> {
  requireManage(ctx);
  const parsed = renameTeamCommandSchema.safeParse({ schemaVersion: 1, ...input });
  if (!parsed.success) throw new TeamValidationError();
  const row = await lockTeam(tx, ctx.workspaceId, parsed.data.id);
  if (row.revision !== parsed.data.expectedRevision) {
    throw new TeamConflictError("stale revision");
  }
  try {
    await tx.execute(sql`
      update team
         set name = ${parsed.data.name},
             name_normalized = lower(btrim(${parsed.data.name})),
             revision = revision + 1,
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${parsed.data.id}::uuid
    `);
  } catch (error) {
    if (postgresErrorCode(error) === "23505") throw new TeamConflictError("duplicate team name");
    throw error;
  }
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: "team",
    allowed: true,
    details: { operation: "rename", teamId: parsed.data.id },
  });
  const updated = await lockTeam(tx, ctx.workspaceId, parsed.data.id);
  const members = await listMembersByTeam(tx, ctx.workspaceId);
  return toDto(updated, members.get(updated.id) ?? []);
}

export async function setTeamActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; active: boolean; expectedRevision: number },
): Promise<TeamDto> {
  requireManage(ctx);
  const parsed = setTeamActiveCommandSchema.safeParse({ schemaVersion: 1, ...input });
  if (!parsed.success) throw new TeamValidationError();
  const row = await lockTeam(tx, ctx.workspaceId, parsed.data.id);
  if (row.revision !== parsed.data.expectedRevision) {
    throw new TeamConflictError("stale revision");
  }
  try {
    await tx.execute(sql`
      update team
         set active = ${parsed.data.active},
             revision = revision + 1,
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${parsed.data.id}::uuid
    `);
  } catch (error) {
    // Reaktivierung gegen belegten aktiven Namen (Partial-Unique).
    if (postgresErrorCode(error) === "23505") throw new TeamConflictError("duplicate team name");
    throw error;
  }
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: "team",
    allowed: true,
    details: { operation: parsed.data.active ? "restore" : "archive", teamId: parsed.data.id },
  });
  const updated = await lockTeam(tx, ctx.workspaceId, parsed.data.id);
  const members = await listMembersByTeam(tx, ctx.workspaceId);
  return toDto(updated, members.get(updated.id) ?? []);
}

export async function setTeamMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; membershipIds: string[] },
): Promise<TeamDto> {
  requireManage(ctx);
  const parsed = setTeamMembersCommandSchema.safeParse({ schemaVersion: 1, ...input });
  if (!parsed.success) throw new TeamValidationError();
  const row = await lockTeam(tx, ctx.workspaceId, parsed.data.id);
  const membershipIds = [...new Set(parsed.data.membershipIds)];
  await requireInternalMemberships(tx, ctx.workspaceId, membershipIds);
  await tx.execute(sql`
    delete from team_member
     where workspace_id = ${ctx.workspaceId}::uuid
       and team_id = ${row.id}::uuid
  `);
  for (const membershipId of membershipIds) {
    await tx.execute(sql`
      insert into team_member (workspace_id, team_id, membership_id)
      values (${ctx.workspaceId}::uuid, ${row.id}::uuid, ${membershipId}::uuid)
    `);
  }
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: "team",
    allowed: true,
    details: { operation: "set_members", teamId: row.id, count: membershipIds.length },
  });
  const members = await listMembersByTeam(tx, ctx.workspaceId);
  return toDto(row, members.get(row.id) ?? []);
}
