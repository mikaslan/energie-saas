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
  PROJECT_TASK_TEAM_ASSIGNMENT_MAX_TEAMS,
  projectTaskTeamAssignmentCommandV1Schema,
  type ProjectTaskTeamAssignmentCommandV1,
} from "./team-assignment-contract";
import { ProjectTaskArchivedError } from "./errors";

export type TaskTeamAssignment = {
  teamId: string;
  label: string;
};

export type TaskTeamAssignmentContext = {
  taskId: string;
  teamAssignmentRevision: number;
  teams: TaskTeamAssignment[];
  canAssign: boolean;
};

export type TaskTeamAssignmentResult = {
  taskId: string;
  teamAssignmentRevision: number;
  changed: boolean;
};

export class TaskTeamAssignmentValidationError extends Error {
  readonly code = "invalid_task_team_assignment_command";

  constructor() {
    super("task team assignment command is invalid");
    this.name = "TaskTeamAssignmentValidationError";
  }
}

export class TaskTeamAssignmentNotFoundError extends Error {
  readonly code = "task_not_found";

  constructor() {
    super("task was not found");
    this.name = "TaskTeamAssignmentNotFoundError";
  }
}

export class TaskTeamAssignmentTargetError extends Error {
  readonly code = "task_team_target_not_found";

  constructor() {
    super("task team assignment target was not found");
    this.name = "TaskTeamAssignmentTargetError";
  }
}

export class TaskTeamAssignmentConflictError extends Error {
  readonly code = "task_team_assignment_revision_conflict";
  readonly currentRevision: number | null;

  constructor(currentRevision: number | null = null) {
    super("task team assignment revision is stale");
    this.name = "TaskTeamAssignmentConflictError";
    this.currentRevision = currentRevision;
  }
}

export class TaskTeamAssignmentLimitError extends Error {
  readonly code = "task_team_assignment_limit_reached";

  constructor() {
    super("task team assignment limit was reached");
    this.name = "TaskTeamAssignmentLimitError";
  }
}

type LockedTaskTeamRow = {
  task_id: string;
  project_id: string;
  team_assignment_revision: number;
  archived_at: Date | string | null;
  [key: string]: unknown;
};

function requireTaskTeamAssignmentMutation(ctx: ServiceCtx): void {
  if (!can(ctx, "task.write")) {
    throw new PermissionDeniedError(
      "task.write",
      "project_task_team_assignment",
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
  if (result.rows.length !== 1) throw new TaskTeamAssignmentTargetError();
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
  if (result.rows.length !== 1) throw new TaskTeamAssignmentTargetError();
}

export async function getTaskTeamAssignmentContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  taskId: string,
): Promise<TaskTeamAssignmentContext | null> {
  // F1-20: External sieht NICHTS (keine External-Sicht wie M1-09) — null
  // blendet die Sektion aus, ohne Existenz zu leaken.
  if (isExternalOnly(ctx)) return null;
  if (!can(ctx, "task.read")) return null;
  // Bewusst KEIN FOR SHARE: Sperrende Lesezugriffe wuerden zusaetzlich
  // die restriktive UPDATE-Policy auswerten und Viewer (ohne
  // task.write) die Zeile filtern. Der Lesepfad braucht kein Lock.
  const taskResult = await tx.execute<LockedTaskTeamRow>(sql`
    select id as task_id, project_id, team_assignment_revision, archived_at
      from project_task
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${taskId}::uuid
     limit 1
  `);
  const task = taskResult.rows[0];
  if (!task) return null;

  const assignmentResult = await tx.execute<{
    team_id: string;
    label: string;
    [key: string]: unknown;
  }>(sql`
    select assignment_record.team_id,
           team_record.name as label
      from project_task_team_assignment assignment_record
      join team team_record
        on team_record.workspace_id = assignment_record.workspace_id
       and team_record.id = assignment_record.team_id
     where assignment_record.workspace_id = ${ctx.workspaceId}::uuid
       and assignment_record.task_id = ${taskId}::uuid
     order by lower(team_record.name), assignment_record.team_id
  `);
  return {
    taskId: task.task_id,
    teamAssignmentRevision: task.team_assignment_revision,
    teams: assignmentResult.rows.map((row) => ({
      teamId: row.team_id,
      label: row.label,
    })),
    // Archivierte Aufgaben sind unveraenderlich (M1-10-Guard) — die
    // Sektion bleibt lesbar, Mutationen sind ausgeblendet.
    canAssign: can(ctx, "task.write") && task.archived_at === null,
  };
}

export async function changeTaskTeamAssignment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectTaskTeamAssignmentCommandV1,
): Promise<TaskTeamAssignmentResult> {
  requireTaskTeamAssignmentMutation(ctx);
  const parsed = projectTaskTeamAssignmentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new TaskTeamAssignmentValidationError();
  const command = parsed.data;

  const locked = await tx.execute<LockedTaskTeamRow>(sql`
    select id as task_id, project_id, team_assignment_revision, archived_at
      from project_task
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.taskId}::uuid
     for update
  `);
  const task = locked.rows[0];
  if (!task) throw new TaskTeamAssignmentNotFoundError();
  if (task.archived_at !== null) throw new ProjectTaskArchivedError();
  if (task.team_assignment_revision !== command.expectedTeamAssignmentRevision) {
    throw new TaskTeamAssignmentConflictError(task.team_assignment_revision);
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

  // KEIN FOR UPDATE auf den Zuweisungszeilen: Das Task-Lock oben
  // serialisiert alle Mutationen je Aufgabe bereits; so bleibt der
  // Rollenvertrag ohne UPDATE-Grant (F7-05b-ACL-Form).
  const currentResult = await tx.execute<{
    team_id: string;
    [key: string]: unknown;
  }>(sql`
    select team_id
      from project_task_team_assignment
     where workspace_id = ${ctx.workspaceId}::uuid
       and task_id = ${command.taskId}::uuid
     order by team_id
  `);
  const current = currentResult.rows;
  const existing = current.some((row) => row.team_id === command.teamId);

  let changed = false;
  let eventType = "";

  if (command.kind === "assign_team") {
    if (existing) {
      return {
        taskId: task.task_id,
        teamAssignmentRevision: task.team_assignment_revision,
        changed: false,
      };
    }
    if (current.length >= PROJECT_TASK_TEAM_ASSIGNMENT_MAX_TEAMS) {
      throw new TaskTeamAssignmentLimitError();
    }
    try {
      await tx.execute(sql`
        insert into project_task_team_assignment (
          workspace_id, task_id, team_id, assigned_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.taskId}::uuid,
          ${command.teamId}::uuid, ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      // Team zwischen Check und Insert geloescht/archiviert.
      if (code === "23503") throw new TaskTeamAssignmentTargetError();
      // Gleichzeitiges Doppel-Assign: UNIQUE gewinnt, Verlierer Conflict.
      if (code === "23505") throw new TaskTeamAssignmentConflictError();
      throw error;
    }
    changed = true;
    eventType = "project.task_team_assigned";
  } else {
    if (!existing) {
      return {
        taskId: task.task_id,
        teamAssignmentRevision: task.team_assignment_revision,
        changed: false,
      };
    }
    await tx.execute(sql`
      delete from project_task_team_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and task_id = ${command.taskId}::uuid
         and team_id = ${command.teamId}::uuid
    `);
    changed = true;
    eventType = "project.task_team_unassigned";
  }

  if (!changed) {
    return {
      taskId: task.task_id,
      teamAssignmentRevision: task.team_assignment_revision,
      changed: false,
    };
  }
  if (task.team_assignment_revision >= 2_147_483_647) {
    throw new TaskTeamAssignmentConflictError(task.team_assignment_revision);
  }
  const teamAssignmentRevision = task.team_assignment_revision + 1;
  // Eigene CAS-Domaene (kein Revisions-Bump): Der M1-10-Guard laesst
  // reine team_assignment_revision-Updates seit 0233 ohne Fach-Revision
  // zu; updated_by bleibt Actor-genau wie jeder andere Task-Edit.
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update project_task
       set team_assignment_revision = ${teamAssignmentRevision},
           updated_by = ${ctx.actor}::uuid,
           updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.taskId}::uuid
       and team_assignment_revision = ${task.team_assignment_revision}
     returning id
  `);
  if (!updated.rows[0]) throw new TaskTeamAssignmentConflictError();

  const evidence = {
    projectId: task.project_id,
    taskId: command.taskId,
    teamId: command.teamId,
    teamAssignmentRevision,
    commandKind: command.kind,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: task.project_id,
    eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "task.write",
    resource: "project_task_team_assignment",
    allowed: true,
    details: evidence,
  });
  return { taskId: command.taskId, teamAssignmentRevision, changed: true };
}
