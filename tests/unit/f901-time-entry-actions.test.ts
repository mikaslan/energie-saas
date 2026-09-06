import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class TimeTrackingConflictError extends Error {}
  class TimeTrackingNotFoundError extends Error {}
  class TimeTrackingValidationError extends Error {}

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    TimeTrackingConflictError,
    TimeTrackingNotFoundError,
    TimeTrackingValidationError,
    authorizedAction: vi.fn(),
    archiveTimeEntry: vi.fn(),
    createTimeEntry: vi.fn(),
    discardTimeEntry: vi.fn(),
    lockTimeEntryInstantsForUpdate: vi.fn(),
    revalidatePath: vi.fn(),
    startTimeEntry: vi.fn(),
    stopTimeEntry: vi.fn(),
    updateTimeEntry: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/time-tracking", () => ({
  archiveTimeEntry: deps.archiveTimeEntry,
  createTimeEntry: deps.createTimeEntry,
  discardTimeEntry: deps.discardTimeEntry,
  lockTimeEntryInstantsForUpdate: deps.lockTimeEntryInstantsForUpdate,
  startTimeEntry: deps.startTimeEntry,
  stopTimeEntry: deps.stopTimeEntry,
  updateTimeEntry: deps.updateTimeEntry,
  TimeTrackingConflictError: deps.TimeTrackingConflictError,
  TimeTrackingNotFoundError: deps.TimeTrackingNotFoundError,
  TimeTrackingValidationError: deps.TimeTrackingValidationError,
}));

import {
  createTimeEntryAction,
  updateTimeEntryAction,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const ENTRY_ID = "30000000-0000-4000-8000-000000000003";
const IDLE = { status: "idle" as const };

function form(overrides: Record<string, string> = {}): FormData {
  const result = new FormData();
  const values = {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    id: ENTRY_ID,
    typeId: "",
    startAt: "2026-03-29T01:30",
    endAt: "2026-03-29T03:30",
    workingTimeMinutes: "60",
    breakDurationMinutes: "0",
    comment: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

const originalTimeZone = process.env.TZ;

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _capability: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.createTimeEntry.mockResolvedValue(undefined);
  deps.lockTimeEntryInstantsForUpdate.mockResolvedValue({
    startAt: "2026-03-29T00:30:00.000Z",
    endAt: "2026-03-29T01:30:00.000Z",
  });
  deps.updateTimeEntry.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

describe("F9.1 Europe/Berlin-Wandzeit", () => {
  it("wandelt ein DST-Intervall hostzonenunabhängig in Instants um", async () => {
    process.env.TZ = "Pacific/Honolulu";
    await expect(createTimeEntryAction(IDLE, form())).resolves.toEqual({
      status: "success",
      message: "Zeiteintrag angelegt.",
    });

    expect(deps.createTimeEntry).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      expect.objectContaining({
        projectId: PROJECT_ID,
        fields: expect.objectContaining({
          startAt: "2026-03-29T00:30:00.000Z",
          endAt: "2026-03-29T01:30:00.000Z",
        }),
      }),
    );
  });

  it("leitet den Januar-Offset serverseitig aus Europe/Berlin ab", async () => {
    await createTimeEntryAction(IDLE, form({
      startAt: "2026-01-15T08:00",
      endAt: "2026-01-15T10:00",
      workingTimeMinutes: "120",
    }));

    expect(deps.createTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-01-15T07:00:00.000Z",
          endAt: "2026-01-15T09:00:00.000Z",
        }),
      }),
    );
  });

  it("akzeptiert den Schalttag 2028-02-29", async () => {
    await expect(createTimeEntryAction(IDLE, form({
      startAt: "2028-02-29T08:00",
      endAt: "2028-02-29T10:00",
      workingTimeMinutes: "120",
    }))).resolves.toEqual({
      status: "success",
      message: "Zeiteintrag angelegt.",
    });

    expect(deps.createTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2028-02-29T07:00:00.000Z",
          endAt: "2028-02-29T09:00:00.000Z",
        }),
      }),
    );
  });

  it("pinnt die doppelte Berliner Herbststunde auf den früheren Instant (ESTIMATE)", async () => {
    await expect(createTimeEntryAction(IDLE, form({
      startAt: "2026-10-25T02:30",
      endAt: "2026-10-25T03:30",
      workingTimeMinutes: "120",
    }))).resolves.toEqual({
      status: "success",
      message: "Zeiteintrag angelegt.",
    });

    expect(deps.createTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-10-25T00:30:00.000Z",
          endAt: "2026-10-25T02:30:00.000Z",
        }),
      }),
    );
  });

  it("erhält bei Kommentaränderungen die späte Herbststunde und Sekunden exakt", async () => {
    deps.lockTimeEntryInstantsForUpdate.mockResolvedValueOnce({
      startAt: "2026-10-25T01:30:42.123Z",
      endAt: "2026-10-25T02:31:17.456Z",
    });
    await expect(updateTimeEntryAction(IDLE, form({
      startAt: "2026-10-25T02:30",
      endAt: "2026-10-25T03:31",
      workingTimeMinutes: "60",
      comment: "Nur Kommentar geändert",
    }))).resolves.toEqual({
      status: "success",
      message: "Zeiteintrag aktualisiert.",
    });

    expect(deps.updateTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-10-25T01:30:42.123Z",
          endAt: "2026-10-25T02:31:17.456Z",
        }),
      }),
    );
  });

  it("ignoriert einen gültig aussehenden gefälschten Client-Originalwert", async () => {
    deps.lockTimeEntryInstantsForUpdate.mockResolvedValueOnce({
      startAt: "2026-10-25T00:30:11.222Z",
      endAt: "2026-10-25T02:30:33.444Z",
    });
    await expect(updateTimeEntryAction(IDLE, form({
      startAt: "2026-10-25T02:30",
      endAt: "2026-10-25T03:30",
      originalStartAt: "2026-10-25T01:30:59.999Z",
      originalEndAt: "2026-10-25T02:30:59.999Z",
    }))).resolves.toEqual({ status: "success", message: "Zeiteintrag aktualisiert." });

    expect(deps.updateTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-10-25T00:30:11.222Z",
          endAt: "2026-10-25T02:30:33.444Z",
        }),
      }),
    );
  });

  it("akzeptiert ein reales Fold-Intervall mit rückläufiger Berliner Wanduhr", async () => {
    deps.lockTimeEntryInstantsForUpdate.mockResolvedValueOnce({
      startAt: "2026-10-25T00:45:00.000Z",
      endAt: "2026-10-25T01:15:00.000Z",
    });

    await expect(updateTimeEntryAction(IDLE, form({
      startAt: "2026-10-25T02:45",
      endAt: "2026-10-25T02:15",
      workingTimeMinutes: "30",
    }))).resolves.toEqual({ status: "success", message: "Zeiteintrag aktualisiert." });

    expect(deps.updateTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-10-25T00:45:00.000Z",
          endAt: "2026-10-25T01:15:00.000Z",
        }),
      }),
    );
  });

  it("ignoriert manipulierte Browser-Offsets und hält die Berliner Zone", async () => {
    process.env.TZ = "Pacific/Honolulu";
    await createTimeEntryAction(IDLE, form({
      startAt: "2026-07-15T10:00",
      endAt: "2026-07-15T11:00",
      startTzOffsetMinutes: "840",
      endTzOffsetMinutes: "840",
    }));

    expect(deps.createTimeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        fields: expect.objectContaining({
          startAt: "2026-07-15T08:00:00.000Z",
          endAt: "2026-07-15T09:00:00.000Z",
        }),
      }),
    );
  });

  it.each([
    ["nicht existente Berliner Frühlingszeit", { startAt: "2026-03-29T02:30" }],
    ["ungültiges Kalenderdatum", { startAt: "2026-02-30T10:00" }],
  ])("verweigert %s vor Autorisierung", async (_label, overrides) => {
    await expect(updateTimeEntryAction(IDLE, form(overrides))).resolves.toEqual({
      status: "invalid",
    });
    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.updateTimeEntry).not.toHaveBeenCalled();
  });
});
