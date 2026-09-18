import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  PROJECT_TEAM_ASSIGNMENT_MAX_TEAMS,
  projectTeamAssignmentCommandV1Schema,
  type ProjectTeamAssignmentCommandV1,
} from "./team-assignment-contract";

export type ProjectTeamAssignment = {
  teamId: string;
  label: string;
};

export type ProjectTeamAssignmentContext = {
  projectId: string;
  teamAssignmentRevision: number;
  teams: ProjectTeamAssignment[];
  canAssign: boolean;
};

export type ProjectTeamAssignmentResult = {
  projectId: string;
  teamAssignmentRevision: number;
  changed: boolean;
};

export class ProjectTeamAssignmentValidationError extends Error {
  readonly code = "invalid_team_assignment_command";

  constructor() {
    super("project team assignment command is invalid");
    this.name = "ProjectTeamAssignmentValidationError";
  }
}

export class ProjectTeamAssignmentNotFoundError extends Error {
  readonly code = "project_not_found";

  constructor() {
    super("project was not found");
    this.name = "ProjectTeamAssignmentNotFoundError";
  }
}

export class ProjectTeamAssignmentTargetError extends Error {
  readonly code = "team_target_not_found";

  constructor() {
    super("project team assignment target was not found");
    this.name = "ProjectTeamAssignmentTargetError";
  }
}

export class ProjectTeamAssignmentConflictError extends Error {
  readonly code = "team_assignment_revision_conflict";
  readonly currentRevision: number | null;

  constructor(currentRevision: number | null = null) {
    super("project team assignment revision is stale");
    this.name = "ProjectTeamAssignmentConflictError";
    this.currentRevision = currentRevision;
  }
}

export class ProjectTeamAssignmentLimitError extends Error {
  readonly code = "team_assignment_limit_reached";

  constructor() {
    super("project team assignment limit was reached");
    this.name = "ProjectTeamAssignmentLimitError";
  }
}

type LockedTeamProjectRow = {
  project_id: string;
  team_assignment_revision: number;
  [key: string]: unknown;
};

function requireTeamAssignmentMutation(ctx: ServiceCtx): void {
  if (!can(ctx, "project.assign")) {
    throw new PermissionDeniedError(
      "project.assign",
      "project_team_assignment",
      undefined,
      ctx.actor,
    );
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

// F1-12-Muster: Team muss AKTIV im Actor-Workspace sein, sonst Target-Fehler
// (kein Existenz-Leak; archiviert/fremd/unbekannt identischer Code).
async function requireActiveTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  teamId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string }>(sql`
    select id
      from team
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${teamId}::uuid
       and active = true
     for share
  `);
  if (result.rows.length !== 1) throw new ProjectTeamAssignmentTargetError();
}

// Entzug wirkt auch auf archivierte Teams (nur Existenz im Workspace,
// sonst Target-Fehler) — sonst belegte eine archivierte Zuweisung ewig
// einen Cap-Slot und blockierte per RESTRICT den Team-Delete.
async function requireTeamInWorkspace(
  tx: TenantTx,
  ctx: ServiceCtx,
  teamId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string }>(sql`
    select id
      from team
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${teamId}::uuid
     for share
  `);
  if (result.rows.length !== 1) throw new ProjectTeamAssignmentTargetError();
}

export async function getProjectTeamAssignmentContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectTeamAssignmentContext | null> {
  // F1-14: External sieht NICHTS (keine External-Sicht wie M1-09) — null
  // blendet die Sektion aus, ohne Existenz zu leaken.
  if (isExternalOnly(ctx)) return null;
  if (!can(ctx, "project.read")) return null;
  const projectResult = await tx.execute<LockedTeamProjectRow>(sql`
    select id as project_id, team_assignment_revision
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
     for share
  `);
  const project = projectResult.rows[0];
  if (!project) return null;

  const assignmentResult = await tx.execute<{
    team_id: string;
    label: string;
    [key: string]: unknown;
  }>(sql`
    select assignment_record.team_id,
           team_record.name as label
      from project_team_assignment assignment_record
      join team team_record
        on team_record.workspace_id = assignment_record.workspace_id
       and team_record.id = assignment_record.team_id
     where assignment_record.workspace_id = ${ctx.workspaceId}::uuid
       and assignment_record.project_id = ${projectId}::uuid
     order by lower(team_record.name), assignment_record.team_id
  `);
  return {
    projectId: project.project_id,
    teamAssignmentRevision: project.team_assignment_revision,
    teams: assignmentResult.rows.map((row) => ({
      teamId: row.team_id,
      label: row.label,
    })),
    canAssign: can(ctx, "project.assign"),
  };
}

export async function changeProjectTeamAssignment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectTeamAssignmentCommandV1,
): Promise<ProjectTeamAssignmentResult> {
  requireTeamAssignmentMutation(ctx);
  const parsed = projectTeamAssignmentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectTeamAssignmentValidationError();
  const command = parsed.data;

  const locked = await tx.execute<LockedTeamProjectRow>(sql`
    select id as project_id, team_assignment_revision
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     for update
  `);
  const project = locked.rows[0];
  if (!project) throw new ProjectTeamAssignmentNotFoundError();
  if (project.team_assignment_revision !== command.expectedTeamAssignmentRevision) {
    throw new ProjectTeamAssignmentConflictError(project.team_assignment_revision);
  }

  // Kein Workspace-Gegenlock (anders als M1-09): Team-Archiv/Delete nimmt
  // keine Workspace-Locks, es gibt keinen Lock-Zyklus mit Membership-DML.
  // Das Team wird aktiv-geprueft (FOR SHARE); Delete-vs-Assign-Race faengt
  // der RESTRICT-FK plus 23503-Mapping fail-closed.
  if (command.kind === "assign_team") {
    await requireActiveTeam(tx, ctx, command.teamId);
  } else {
    await requireTeamInWorkspace(tx, ctx, command.teamId);
  }

  // KEIN FOR UPDATE auf den Zuweisungszeilen: Das Projekt-Lock oben
  // serialisiert alle Mutationen je Projekt bereits; so bleibt der
  // Rollenvertrag ohne UPDATE-Grant (F7-05b-ACL-Form).
  const currentResult = await tx.execute<{
    team_id: string;
    [key: string]: unknown;
  }>(sql`
    select team_id
      from project_team_assignment
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
     order by team_id
  `);
  const current = currentResult.rows;
  const existing = current.some((row) => row.team_id === command.teamId);

  let changed = false;
  let eventType = "";

  if (command.kind === "assign_team") {
    if (existing) {
      return {
        projectId: project.project_id,
        teamAssignmentRevision: project.team_assignment_revision,
        changed: false,
      };
    }
    if (current.length >= PROJECT_TEAM_ASSIGNMENT_MAX_TEAMS) {
      throw new ProjectTeamAssignmentLimitError();
    }
    try {
      await tx.execute(sql`
        insert into project_team_assignment (
          workspace_id, project_id, team_id, assigned_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
          ${command.teamId}::uuid, ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      // Team zwischen Check und Insert geloescht/archiviert.
      if (code === "23503") throw new ProjectTeamAssignmentTargetError();
      // Gleichzeitiges Doppel-Assign: UNIQUE gewinnt, Verlierer Conflict.
      if (code === "23505") throw new ProjectTeamAssignmentConflictError();
      throw error;
    }
    changed = true;
    eventType = "project.team_assigned";
  } else {
    if (!existing) {
      return {
        projectId: project.project_id,
        teamAssignmentRevision: project.team_assignment_revision,
        changed: false,
      };
    }
    await tx.execute(sql`
      delete from project_team_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and team_id = ${command.teamId}::uuid
    `);
    changed = true;
    eventType = "project.team_unassigned";
  }

  if (!changed) {
    return {
      projectId: project.project_id,
      teamAssignmentRevision: project.team_assignment_revision,
      changed: false,
    };
  }
  if (project.team_assignment_revision >= 2_147_483_647) {
    throw new ProjectTeamAssignmentConflictError(project.team_assignment_revision);
  }
  const teamAssignmentRevision = project.team_assignment_revision + 1;
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update project
       set team_assignment_revision = ${teamAssignmentRevision}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
       and team_assignment_revision = ${project.team_assignment_revision}
     returning id
  `);
  if (!updated.rows[0]) throw new ProjectTeamAssignmentConflictError();

  const evidence = {
    projectId: command.projectId,
    teamId: command.teamId,
    teamAssignmentRevision,
    commandKind: command.kind,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: command.projectId,
    eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.assign",
    resource: "project_team_assignment",
    allowed: true,
    details: evidence,
  });
  return { projectId: command.projectId, teamAssignmentRevision, changed: true };
}
