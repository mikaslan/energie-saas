import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { projectAppointment } from "./appointment";
import { workspace } from "./core";
import { team } from "./team";

// F7-11 Termin-Mehr-Team (Katalog F7.5 Block-Ebene): mehrere Teams parallel
// je Termin. Muster F1-20 (0233): Seitentabelle + eigene CAS-Domäne
// team_assignment_revision (kein Fach-Revisions-Bump, Guard-Carve-out).
// team-FK RESTRICT (F1-20); unabhängig von team_id (Legacy, F1-12).
export const projectAppointmentTeamAssignment = pgTable(
  "project_appointment_team_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    appointmentId: uuid("appointment_id").notNull(),
    teamId: uuid("team_id").notNull(),
    assignedBy: uuid("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_appointment_team_assignment_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_appointment_team_assignment_ws_appt_team_uq").on(
      t.workspaceId,
      t.appointmentId,
      t.teamId,
    ),
    index("project_appointment_team_assignment_ws_team_appt_idx").on(
      t.workspaceId,
      t.teamId,
      t.appointmentId,
    ),
    check(
      "project_appointment_team_assignment_time_ck",
      sql`pg_catalog.isfinite(${t.assignedAt})`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_appointment_team_assignment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.appointmentId],
      foreignColumns: [projectAppointment.workspaceId, projectAppointment.id],
      name: "project_appointment_team_assignment_appointment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
      name: "project_appointment_team_assignment_team_fk",
    }).onDelete("restrict"),
  ],
);
