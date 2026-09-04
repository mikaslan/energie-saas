import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_DESCRIPTION_MAX_LENGTH,
  APPOINTMENT_LOCATION_MAX_LENGTH,
  APPOINTMENT_TITLE_MAX_LENGTH,
  CALENDAR_CATEGORY_NAME_MAX_LENGTH,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  PROJECT_APPOINTMENT_MAX_ATTENDEES,
  appointmentErrorCodeSchema,
  calendarCategoryItemV1Schema,
  projectAppointmentCommandV1Schema,
  projectAppointmentItemV1Schema,
  projectAppointmentRangeV1Schema,
} from "@/lib/integrations/calendar/contract";

const BASE = {
  schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

function createCommand(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE,
    kind: "create_appointment",
    title: "Beratungstermin",
    start: "2026-07-01T10:00:00",
    end: "2026-07-01T11:00:00",
    allDay: false,
    type: "on_site",
    location: "Musterstraße 1",
    description: "Erstgespräch",
    calendarId: "22222222-2222-4222-8222-222222222222",
    attendeeMembershipIds: ["33333333-3333-4333-8333-333333333333"],
    ...overrides,
  };
}

describe("M1-15 Kalender-Vertrag (project-appointment-command.v1)", () => {
  it("akzeptiert einen gültigen create-Befehl", () => {
    const parsed = projectAppointmentCommandV1Schema.safeParse(createCommand());
    expect(parsed.success).toBe(true);
  });

  it("akzeptiert leere optionale Felder und leere Teilnehmer", () => {
    const parsed = projectAppointmentCommandV1Schema.safeParse(createCommand({
      location: null,
      description: null,
      attendeeMembershipIds: [],
    }));
    expect(parsed.success).toBe(true);
  });

  it("lehnt end <= start ab", () => {
    const parsed = projectAppointmentCommandV1Schema.safeParse(createCommand({
      start: "2026-07-01T10:00:00",
      end: "2026-07-01T10:00:00",
    }));
    expect(parsed.success).toBe(false);
  });

  it("lehnt ganztägige Termine unter einem vollen Tag ab", () => {
    const parsed = projectAppointmentCommandV1Schema.safeParse(createCommand({
      allDay: true,
      start: "2026-07-01T00:00:00",
      end: "2026-07-01T23:59:59",
    }));
    expect(parsed.success).toBe(false);
  });

  it("akzeptiert ganztägige Termine ab einem vollen Tag", () => {
    const parsed = projectAppointmentCommandV1Schema.safeParse(createCommand({
      allDay: true,
      start: "2026-07-01T00:00:00",
      end: "2026-07-02T00:00:00",
    }));
    expect(parsed.success).toBe(true);
  });

  it("erzwingt das Typ-Enum", () => {
    expect(projectAppointmentCommandV1Schema.safeParse(createCommand({ type: "nope" })).success).toBe(false);
    for (const type of ["on_site", "phone", "installation", "maintenance", "consultation", "other"]) {
      expect(projectAppointmentCommandV1Schema.safeParse(createCommand({ type })).success).toBe(true);
    }
  });

  it("erzwingt die Feldlängen 2000/5000/2000", () => {
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ title: "x".repeat(APPOINTMENT_TITLE_MAX_LENGTH + 1) }),
    ).success).toBe(false);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ description: "x".repeat(APPOINTMENT_DESCRIPTION_MAX_LENGTH + 1) }),
    ).success).toBe(false);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ location: "x".repeat(APPOINTMENT_LOCATION_MAX_LENGTH + 1) }),
    ).success).toBe(false);
  });

  it("erzwingt 0–100 Teilnehmer und lehnt Duplikate ab", () => {
    const many = Array.from({ length: PROJECT_APPOINTMENT_MAX_ATTENDEES }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ attendeeMembershipIds: many }),
    ).success).toBe(true);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ attendeeMembershipIds: [...many, "99999999-9999-4999-8999-999999999999"] }),
    ).success).toBe(false);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({
        attendeeMembershipIds: [
          "33333333-3333-4333-8333-333333333333",
          "33333333-3333-4333-8333-333333333333",
        ],
      }),
    ).success).toBe(false);
  });

  it("verlangt Berliner Wanduhrzeit ohne Offset", () => {
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-07-01T10:00:00.000Z" }),
    ).success).toBe(false);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-07-01T10:00:00+02:00" }),
    ).success).toBe(false);
  });

  it("lehnt Wanduhrzeiten in der DST-Lücke ab, akzeptiert Mehrdeutigkeit", () => {
    // Frühjahrs-Lücke 29.03.2026: 02:30 existiert in Europe/Berlin nicht.
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-03-29T02:30:00", end: "2026-03-29T03:30:00" }),
    ).success).toBe(false);
    // Herbst-Mehrdeutigkeit 25.10.2026: 02:30 existiert zweimal (CEST/CET).
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-10-25T02:30:00", end: "2026-10-25T03:30:00" }),
    ).success).toBe(true);
    // Normale Sommer-/Winterzeiten bleiben gültig.
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-07-01T10:00:00", end: "2026-07-01T11:00:00" }),
    ).success).toBe(true);
    expect(projectAppointmentCommandV1Schema.safeParse(
      createCommand({ start: "2026-01-15T10:00:00", end: "2026-01-15T11:00:00" }),
    ).success).toBe(true);
  });

  it("erzwingt Revisions-CAS bei update/delete", () => {
    const update = {
      ...BASE,
      kind: "update_appointment",
      appointmentId: "44444444-4444-4444-8444-444444444444",
      expectedRevision: 1,
      title: "Beratungstermin",
      start: "2026-07-01T10:00:00",
      end: "2026-07-01T11:00:00",
      allDay: false,
      type: "on_site",
      location: null,
      description: null,
      calendarId: "22222222-2222-4222-8222-222222222222",
      attendeeMembershipIds: [],
    };
    const parsed = projectAppointmentCommandV1Schema.safeParse(update);
    expect(parsed.success).toBe(true);
    expect(projectAppointmentCommandV1Schema.safeParse({
      ...update,
      expectedRevision: 0,
    }).success).toBe(false);
  });

  it("klassifiziert die Fehlercodes", () => {
    expect(appointmentErrorCodeSchema.safeParse("invalid").success).toBe(true);
    expect(appointmentErrorCodeSchema.safeParse("nope").success).toBe(false);
  });
});

describe("M1-15 minimierte DTOs", () => {
  it("project-appointment-item.v1 trägt calendarId/Name/Farbe, verbietet workspace_id", () => {
    const valid = {
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      title: "Termin",
      description: null,
      location: null,
      start: "2026-07-01T10:00:00.000",
      end: "2026-07-01T11:00:00.000",
      allDay: false,
      type: "phone",
      calendarId: "22222222-2222-4222-8222-222222222222",
      calendarName: "Unternehmen",
      calendarColor: null,
      attendees: [],
    };
    expect(projectAppointmentItemV1Schema.safeParse(valid).success).toBe(true);
    expect(projectAppointmentItemV1Schema.safeParse({
      ...valid,
      workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }).success).toBe(false);
    expect(projectAppointmentItemV1Schema.safeParse({
      ...valid,
      calendarId: null,
    }).success).toBe(false);
  });

  it("calendar-category-item.v1 trägt { id, name, order } ohne color", () => {
    expect(calendarCategoryItemV1Schema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Beratung",
      order: 0,
    }).success).toBe(true);
    expect(calendarCategoryItemV1Schema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Beratung",
      order: 0,
      color: "#ff0000",
    }).success).toBe(false);
    expect(calendarCategoryItemV1Schema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "x".repeat(CALENDAR_CATEGORY_NAME_MAX_LENGTH + 1),
      order: 0,
    }).success).toBe(false);
  });

  it("project-appointment-range.v1 trägt Items, Kalender, Mitglieder und Rechte", () => {
    expect(projectAppointmentRangeV1Schema.safeParse({
      schemaVersion: "project-appointment-range.v1",
      projectId: "11111111-1111-4111-8111-111111111111",
      permissions: { canWrite: true },
      rangeStart: "2026-01-01T00:00:00.000",
      rangeEnd: "2026-12-31T23:59:59.000",
      view: "month",
      items: [],
      calendars: [],
      members: [],
    }).success).toBe(true);
  });
});
