import { sql } from "drizzle-orm";
import { z } from "zod";
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
  PROJECT_APPOINTMENT_TEAM_ASSIGNMENT_MAX_TEAMS,
  projectAppointmentTeamAssignmentCommandV1Schema,
  type ProjectAppointmentTeamAssignmentCommandV1,
} from "@/lib/integrations/calendar/contract";
import { AppointmentNotFoundError } from "./errors";

// F7-11 Termin-Mehr-Team: Junction-Zuweisung mehrerer Teams je Termin.
// 1:1-Vorlage modules/tasks/team-assignment-service.ts (F1-20): eigene
// CAS-Domäne team_assignment_revision (Fach-Revision bumpt nicht,
// Guard-Carve-out 0320), Cap 50, Events ID-only + Audit PII-frei.
// Unabhängigkeits-Regel (SPEC): team_id (Single, F1-12/F7-06) und Junction
// sind zwei unabhängige Zuordnungen; Disjunktheit NUR beim Assign.

export type AppointmentTeamAssignment = {
  id: string;
  name: string;
};

export type AppointmentTeamAssignmentContext = {
  appointmentId: string;
  teamAssignmentRevision: number;
  teams: AppointmentTeamAssignment[];
  canAssign: boolean;
};

export type AppointmentTeamAssignmentResult = {
  appointmentId: string;
  teamAssignmentRevision: number;
  changed: boolean;
};

export class AppointmentTeamValidationError extends Error {
  readonly code = "invalid_appointment_team_assignment_command";

  constructor() {
    super("appointment team assignment command is invalid");
    this.name = "AppointmentTeamValidationError";
  }
}

export class AppointmentTeamTargetError extends Error {
  readonly code = "appointment_team_target_not_found";

  constructor() {
    super("appointment team assignment target was not found");
    this.name = "AppointmentTeamTargetError";
  }
}

export class AppointmentTeamConflictError extends Error {
  readonly code = "appointment_team_assignment_revision_conflict";
  readonly currentRevision: number | null;

  constructor(currentRevision: number | null = null) {
    super("appointment team assignment revision is stale");
    this.name = "AppointmentTeamConflictError";
    this.currentRevision = currentRevision;
  }
}

export class AppointmentTeamLimitError extends Error {
  readonly code = "appointment_team_assignment_limit_reached";

  constructor() {
    super("appointment team assignment limit was reached");
    this.name = "AppointmentTeamLimitError";
  }
}

type LockedAppointmentTeamRow = {
  appointment_id: string;
  project_id: string;
  team_id: string | null;
  team_assignment_revision: number;
  [key: string]: unknown;
};

function requireAppointmentTeamAssignmentMutation(ctx: ServiceCtx): void {
  if (!can(ctx, "appointment.write")) {
    throw new PermissionDeniedError(
      "appointment.write",
      "project_appointment_team_assignment",
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

const teamIdSchema = z.uuid();

// Deforme Team-IDs sind TargetError (kein Orakel, F711-DB-05) — das
// Command-Schema lässt teamId bewusst als rohe Zeichenkette durch.
function requireCanonicalTeamId(teamId: string): string {
  const parsed = teamIdSchema.safeParse(teamId);
  if (!parsed.success) throw new AppointmentTeamTargetError();
  return parsed.data.toLowerCase();
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
  if (result.rows.length !== 1) throw new AppointmentTeamTargetError();
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
  if (result.rows.length !== 1) throw new AppointmentTeamTargetError();
}

export async function getAppointmentTeamAssignmentContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  appointmentId: string,
): Promise<AppointmentTeamAssignmentContext | null> {
  // F1-20: External sieht NICHTS — null blendet die Sektion aus,
  // ohne Existenz zu leaken.
  if (isExternalOnly(ctx)) return null;
  if (!can(ctx, "appointment.read")) return null;
  // Bewusst KEIN FOR SHARE (F1-20-Kommentar): Sperrende Lesezugriffe
  // würden die restriktive UPDATE-Policy auswerten und Viewer (ohne
  // appointment.write) die Zeile filtern. Der Lesepfad braucht kein Lock.
  const appointmentResult = await tx.execute<LockedAppointmentTeamRow>(sql`
    select id as appointment_id, project_id, team_id, team_assignment_revision
      from project_appointment
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${appointmentId}::uuid
     limit 1
  `);
  const appointment = appointmentResult.rows[0];
  if (!appointment) return null;

  // Archivierte Junction-Teams bleiben lesbar (Name) — kein Aktiv-Filter.
  const assignmentResult = await tx.execute<{
    team_id: string;
    name: string;
    [key: string]: unknown;
  }>(sql`
    select assignment_record.team_id,
           team_record.name
      from project_appointment_team_assignment assignment_record
      join team team_record
        on team_record.workspace_id = assignment_record.workspace_id
       and team_record.id = assignment_record.team_id
     where assignment_record.workspace_id = ${ctx.workspaceId}::uuid
       and assignment_record.appointment_id = ${appointmentId}::uuid
     order by lower(team_record.name), assignment_record.team_id
  `);
  return {
    appointmentId: appointment.appointment_id,
    teamAssignmentRevision: appointment.team_assignment_revision,
    teams: assignmentResult.rows.map((row) => ({
      id: row.team_id,
      name: row.name,
    })),
    canAssign: can(ctx, "appointment.write"),
  };
}

export async function changeAppointmentTeamAssignment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectAppointmentTeamAssignmentCommandV1,
): Promise<AppointmentTeamAssignmentResult> {
  requireAppointmentTeamAssignmentMutation(ctx);
  const parsed = projectAppointmentTeamAssignmentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new AppointmentTeamValidationError();
  const command = parsed.data;
  const teamId = requireCanonicalTeamId(command.teamId);

  const locked = await tx.execute<LockedAppointmentTeamRow>(sql`
    select id as appointment_id, project_id, team_id, team_assignment_revision
      from project_appointment
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.appointmentId}::uuid
     for update
  `);
  const appointment = locked.rows[0];
  if (!appointment) throw new AppointmentNotFoundError();
  if (appointment.team_assignment_revision !== command.expectedTeamAssignmentRevision) {
    throw new AppointmentTeamConflictError(appointment.team_assignment_revision);
  }

  // Kein Workspace-Gegenlock (F1-20-Kommentar): Team-Archiv/Delete nimmt
  // keine Workspace-Locks, es gibt keinen Lock-Zyklus mit Membership-DML.
  // Das Team wird aktiv-geprüft (FOR SHARE); Delete-vs-Assign-Race fängt
  // der RESTRICT-FK plus 23503-Mapping fail-closed.
  if (command.kind === "assign_team") {
    await requireActiveTeam(tx, ctx, teamId);
  } else {
    await requireTeamInWorkspace(tx, ctx, teamId);
  }

  // KEIN FOR UPDATE auf den Zuweisungszeilen: Das Appointment-Lock oben
  // serialisiert alle Mutationen je Termin bereits; so bleibt der
  // Rollenvertrag ohne UPDATE-Grant (F7-05b-ACL-Form).
  const currentResult = await tx.execute<{
    team_id: string;
    [key: string]: unknown;
  }>(sql`
    select team_id
      from project_appointment_team_assignment
     where workspace_id = ${ctx.workspaceId}::uuid
       and appointment_id = ${command.appointmentId}::uuid
     order by team_id
  `);
  const current = currentResult.rows;
  const existing = current.some((row) => row.team_id === teamId);

  let changed = false;
  let eventType = "";

  if (command.kind === "assign_team") {
    if (existing) {
      return {
        appointmentId: appointment.appointment_id,
        teamAssignmentRevision: appointment.team_assignment_revision,
        changed: false,
      };
    }
    // Disjunktheit NUR beim Assign: das aktuelle team_id-Team steht
    // bereits als Single-Team — kein Junction-Duplikat (Validation).
    // Ein späterer team_id-Wechsel berührt die Junction NICHT.
    if (appointment.team_id === teamId) {
      throw new AppointmentTeamValidationError();
    }
    if (current.length >= PROJECT_APPOINTMENT_TEAM_ASSIGNMENT_MAX_TEAMS) {
      throw new AppointmentTeamLimitError();
    }
    try {
      await tx.execute(sql`
        insert into project_appointment_team_assignment (
          workspace_id, appointment_id, team_id, assigned_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.appointmentId}::uuid,
          ${teamId}::uuid, ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      // Team zwischen Check und Insert gelöscht/archiviert.
      if (code === "23503") throw new AppointmentTeamTargetError();
      // Gleichzeitiges Doppel-Assign: UNIQUE gewinnt, Verlierer Conflict.
      if (code === "23505") throw new AppointmentTeamConflictError();
      throw error;
    }
    changed = true;
    eventType = "project.appointment_team_assigned";
  } else {
    if (!existing) {
      return {
        appointmentId: appointment.appointment_id,
        teamAssignmentRevision: appointment.team_assignment_revision,
        changed: false,
      };
    }
    await tx.execute(sql`
      delete from project_appointment_team_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and appointment_id = ${command.appointmentId}::uuid
         and team_id = ${teamId}::uuid
    `);
    changed = true;
    eventType = "project.appointment_team_unassigned";
  }

  if (!changed) {
    return {
      appointmentId: appointment.appointment_id,
      teamAssignmentRevision: appointment.team_assignment_revision,
      changed: false,
    };
  }
  if (appointment.team_assignment_revision >= 2_147_483_647) {
    throw new AppointmentTeamConflictError(appointment.team_assignment_revision);
  }
  const teamAssignmentRevision = appointment.team_assignment_revision + 1;
  // Eigene CAS-Domäne (kein Fach-Revisions-Bump): Der _m115-Guard lässt
  // reine team_assignment_revision-Updates seit 0320 ohne Fach-Revision
  // zu (F1-20-Block-Muster). project_appointment hat kein updated_by —
  // nur updated_at wie updateAppointment.
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update project_appointment
       set team_assignment_revision = ${teamAssignmentRevision},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.appointmentId}::uuid
       and team_assignment_revision = ${appointment.team_assignment_revision}
     returning id
  `);
  if (!updated.rows[0]) throw new AppointmentTeamConflictError();

  const evidence = {
    projectId: appointment.project_id,
    appointmentId: command.appointmentId,
    teamId,
    teamAssignmentRevision,
    commandKind: command.kind,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: appointment.project_id,
    eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "appointment.write",
    resource: "project_appointment_team_assignment",
    allowed: true,
    details: evidence,
  });
  return { appointmentId: command.appointmentId, teamAssignmentRevision, changed: true };
}
