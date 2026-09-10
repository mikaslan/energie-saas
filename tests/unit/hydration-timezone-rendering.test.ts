import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/actions",
  () => ({
    approveTimeEntryAction: vi.fn(),
    archiveTimeEntryAction: vi.fn(),
    createTimeEntryAction: vi.fn(),
    discardTimeEntryAction: vi.fn(),
    startTimeEntryAction: vi.fn(),
    stopTimeEntryAction: vi.fn(),
    unapproveTimeEntryAction: vi.fn(),
    updateTimeEntryAction: vi.fn(),
  }),
);
vi.mock(
  "@/app/w/[workspaceId]/anfragen/[projectId]/appointment-calendar",
  () => ({ AppointmentCalendar: () => null }),
);
vi.mock(
  "@/app/w/[workspaceId]/anfragen/[projectId]/appointment-dialog",
  () => ({ AppointmentDialog: () => null }),
);

type TimeEntryModule = typeof import(
  "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/time-entry-manager"
);
type AppointmentModule = typeof import(
  "@/app/w/[workspaceId]/anfragen/[projectId]/appointment-calendar-section"
);
type BerlinWallClockModule = typeof import(
  "@/lib/integrations/time-tracking/berlin-wall-clock"
);

let timeEntryModule: TimeEntryModule;
let appointmentModule: AppointmentModule;
let berlinWallClockModule: BerlinWallClockModule;
const originalTimeZone = process.env.TZ;

beforeAll(async () => {
  [timeEntryModule, appointmentModule, berlinWallClockModule] = await Promise.all([
    import("@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/time-entry-manager"),
    import("@/app/w/[workspaceId]/anfragen/[projectId]/appointment-calendar-section"),
    import("@/lib/integrations/time-tracking/berlin-wall-clock"),
  ]);
});

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe("SSR-stabile Zeitdarstellung", () => {
  it("interpretiert Wandzeiten auch auf einem Honolulu-Host als Europe/Berlin", () => {
    process.env.TZ = "Pacific/Honolulu";

    expect(berlinWallClockModule.berlinWallClockToIso("2026-01-15T10:00"))
      .toBe("2026-01-15T09:00:00.000Z");
    expect(berlinWallClockModule.berlinWallClockToIso("2026-07-15T10:00"))
      .toBe("2026-07-15T08:00:00.000Z");
    expect(berlinWallClockModule.berlinWallClockToIso("2026-03-29T01:30"))
      .toBe("2026-03-29T00:30:00.000Z");
    expect(berlinWallClockModule.berlinWallClockToIso("2026-03-29T03:30"))
      .toBe("2026-03-29T01:30:00.000Z");
    expect(berlinWallClockModule.berlinWallClockToIso("2028-02-29T10:00"))
      .toBe("2028-02-29T09:00:00.000Z");
  });

  it("wählt in der doppelten Berliner Herbststunde den früheren Instant (ESTIMATE)", () => {
    process.env.TZ = "Pacific/Honolulu";

    expect(berlinWallClockModule.berlinWallClockToIso("2026-10-25T02:30"))
      .toBe("2026-10-25T00:30:00.000Z");
  });

  it("erhält einen bestehenden späten Herbst-Instant samt Sekunden", () => {
    expect(berlinWallClockModule.berlinWallClockToIso(
      "2026-10-25T02:30",
      "2026-10-25T01:30:42.123Z",
    )).toBe("2026-10-25T01:30:42.123Z");
    expect(berlinWallClockModule.berlinWallClockToIso(
      "2026-07-15T10:00",
      "2026-07-15T08:00:59.987Z",
    )).toBe("2026-07-15T08:00:59.987Z");
  });

  it.each([
    "2026-03-29T02:30",
    "2026-02-30T10:00",
    "2026-13-01T10:00",
    "0000-01-01T10:00",
    "kein-datum",
    "",
  ])("verweigert ungültige oder nicht existente Berliner Wandzeit %s", (value) => {
    process.env.TZ = "Pacific/Honolulu";

    expect(berlinWallClockModule.berlinWallClockToIso(value)).toBeNull();
  });

  it("formatiert UTC-Instants immer als Europe/Berlin", () => {
    process.env.TZ = "UTC";

    expect(timeEntryModule.formatTimeEntryRange(
      "2026-07-01T08:00:00.000Z",
      "2026-07-01T09:00:00.000Z",
    )).toBe("01.07.2026 · 10:00–11:00 Uhr");
    expect(timeEntryModule.formatTimeEntryRange(
      "2026-01-15T08:00:00.000Z",
      null,
    )).toBe("15.01.2026 · läuft seit 09:00 Uhr");
  });

  it("kennzeichnet die rückläufige Herbst-Fold-Anzeige mit beiden UTC-Offsets", () => {
    expect(timeEntryModule.formatTimeEntryRange(
      "2026-10-25T00:45:00.000Z",
      "2026-10-25T01:15:00.000Z",
    )).toBe("25.10.2026 · 02:45–02:15 Uhr (UTC+02:00→UTC+01:00)");
  });

  it("zeigt eine offsetlose Berliner Wanduhr ohne Laufzeitverschiebung", () => {
    process.env.TZ = "UTC";

    expect(appointmentModule.formatAppointmentWallClock("2026-07-01T10:00:00"))
      .toBe("01.07.2026, 10:00");
    expect(appointmentModule.formatAppointmentWallClock("kein-datum"))
      .toBe("kein-datum");
  });

  it("rendert keine vertrauensbedürftigen Browser-Offsetfelder", () => {
    process.env.TZ = "Pacific/Honolulu";
    const Manager = timeEntryModule.TimeEntryManager as ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(createElement(Manager, {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      projectId: "20000000-0000-4000-8000-000000000002",
      list: { schemaVersion: 1, entries: [], totalWorkingMinutes: 0 },
      types: [],
      members: [],
      revisionsByEntry: {},
      utilization: { schemaVersion: 1, rows: [] },
      canWrite: true,
    }));

    expect(html).not.toContain("TzOffsetMinutes");
    expect(html).not.toContain('name="tzOffsetMinutes"');
  });

  it("füllt Editorwerte in Europe/Berlin statt in der Browserzone", () => {
    process.env.TZ = "Pacific/Honolulu";

    expect(berlinWallClockModule.isoToBerlinLocalInput("2026-07-01T08:15:00.000Z"))
      .toBe("2026-07-01T10:15");
    expect(berlinWallClockModule.isoToBerlinLocalInput("2026-01-15T08:15:00.000Z"))
      .toBe("2026-01-15T09:15");
  });

  it("hält den Editor beim SSR geschlossen und zeigt die feste Berliner Zone", () => {
    process.env.TZ = "UTC";
    const Manager = timeEntryModule.TimeEntryManager as ComponentType<Record<string, unknown>>;
    const projectId = "20000000-0000-4000-8000-000000000002";
    const html = renderToStaticMarkup(createElement(Manager, {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      projectId,
      list: {
        schemaVersion: 1,
        entries: [{
          schemaVersion: 1,
          id: "30000000-0000-4000-8000-000000000003",
          userId: "40000000-0000-4000-8000-000000000004",
          projectId,
          typeId: null,
          startAt: "2026-07-01T08:15:00.000Z",
          endAt: "2026-07-01T09:15:00.000Z",
          startLat: null,
          startLng: null,
          workingTimeMinutes: 60,
          running: false,
          breakDurationMinutes: 0,
          comment: null,
          archivedAt: null,
          createdAt: "2026-07-01T08:15:00.000Z",
          updatedAt: "2026-07-01T09:15:00.000Z",
          permissions: { canWrite: true },
        }],
        totalWorkingMinutes: 60,
      },
      types: [],
      members: [],
      revisionsByEntry: {},
      utilization: { schemaVersion: 1, rows: [] },
      canWrite: true,
    }));

    expect(html).toContain("01.07.2026 · 10:15–11:15 Uhr");
    expect(html.match(/type="datetime-local"/gu)).toHaveLength(2);
    expect(html).not.toContain('value="2026-07-01T08:15"');
  });
});
