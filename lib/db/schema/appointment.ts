import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { calendar } from "./calendar";
import { membership, workspace } from "./core";
import { project } from "./project";

// M1-15 Termine & Kalender (F1.9). Termine hängen direkt am Projekt
// (ADR 0021 E2: kein calendar-Objekt); Kategorien sind eine eigene,
// workspace-gebundene, in M1-15 read-only geführte Tabelle (ADR 0021 E1).
export const appointmentTypes = [
  "on_site",
  "phone",
  "installation",
  "maintenance",
  "consultation",
  "other",
] as const;

export type AppointmentType = (typeof appointmentTypes)[number];

export const calendarCategory = pgTable(
  "calendar_category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("calendar_category_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("calendar_category_ws_name_uq").on(
      t.workspaceId,
      sql`lower(btrim(${t.name}))`,
    ),
    check(
      "calendar_category_name_ck",
      sql`length(btrim(${t.name})) between 1 and 200
          and ${t.name} = normalize(${t.name}, NFKC)
          and ${t.name} !~ '[[:cntrl:]]'
          and ${t.name} !~ '(^[[:space:]])|([[:space:]]$)'`,
    ),
    check("calendar_category_order_ck", sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "calendar_category_workspace_id_fk",
    }),
  ],
);

export const projectAppointment = pgTable(
  "project_appointment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    appointmentType: text("appointment_type")
      .$type<AppointmentType>()
      .notNull(),
    // M1-15b: Kategorie wandert an den Kalender (Spec §4.2); calendar_id ist
    // API-treu Pflicht (Appointment.calendarId required).
    calendarId: uuid("calendar_id").notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_appointment_ws_id_uq").on(t.workspaceId, t.id),
    index("project_appointment_ws_project_range_idx").on(
      t.workspaceId,
      t.projectId,
      t.startAt,
      t.endAt,
      t.id,
    ),
    index("project_appointment_ws_project_start_idx").on(
      t.workspaceId,
      t.projectId,
      t.startAt.desc().nullsFirst(),
      t.id.asc().nullsLast(),
    ),
    index("project_appointment_ws_calendar_range_idx").on(
      t.workspaceId,
      t.calendarId,
      t.startAt,
      t.endAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_appointment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_appointment_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.calendarId],
      foreignColumns: [calendar.workspaceId, calendar.id],
      name: "project_appointment_calendar_fk",
    }).onDelete("restrict"),
    check(
      "project_appointment_title_ck",
      sql`length(btrim(${t.title})) between 1 and 2000`,
    ),
    check(
      "project_appointment_description_ck",
      sql`${t.description} is null or length(btrim(${t.description})) between 1 and 5000`,
    ),
    check(
      "project_appointment_location_ck",
      sql`${t.location} is null or length(btrim(${t.location})) between 1 and 2000`,
    ),
    check(
      "project_appointment_type_ck",
      sql`${t.appointmentType} in ('on_site', 'phone', 'installation', 'maintenance', 'consultation', 'other')`,
    ),
    check(
      "project_appointment_window_ck",
      sql`${t.endAt} > ${t.startAt}
          and (not ${t.allDay}
               or (${t.endAt} at time zone 'Europe/Berlin')::date
                  >= (${t.startAt} at time zone 'Europe/Berlin')::date + 1)
          and isfinite(${t.startAt})
          and isfinite(${t.endAt})`,
    ),
    check(
      "project_appointment_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "project_appointment_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
          and isfinite(${t.createdAt})
          and isfinite(${t.updatedAt})`,
    ),
  ],
);

export const projectAppointmentAttendee = pgTable(
  "project_appointment_attendee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    appointmentId: uuid("appointment_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_appointment_attendee_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_appointment_attendee_ws_appt_membership_uq").on(
      t.workspaceId,
      t.appointmentId,
      t.membershipId,
    ),
    index("project_appointment_attendee_ws_membership_appt_idx").on(
      t.workspaceId,
      t.membershipId,
      t.appointmentId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_appointment_attendee_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.appointmentId],
      foreignColumns: [projectAppointment.workspaceId, projectAppointment.id],
      name: "project_appointment_attendee_appointment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "project_appointment_attendee_membership_fk",
    }).onDelete("restrict"),
  ],
);
