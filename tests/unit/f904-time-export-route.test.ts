import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class TimeTrackingNotFoundError extends Error {}
  class TimeTrackingValidationError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    TimeTrackingNotFoundError,
    TimeTrackingValidationError,
    authorizedQuery: vi.fn(),
    exportTimeEntries: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/time-tracking", () => ({
  exportTimeEntries: deps.exportTimeEntries,
  TimeTrackingNotFoundError: deps.TimeTrackingNotFoundError,
  TimeTrackingValidationError: deps.TimeTrackingValidationError,
}));

import { GET } from "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/export/route";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const USER_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };
const CSV = "\uFEFFdatum;beginn\r\n";

function context(overrides: Partial<{ workspaceId: string; projectId: string }> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      ...overrides,
    }),
  };
}

function request(query = ""): Request {
  return new Request(`https://clone.test/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}/zeiterfassung/export${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.exportTimeEntries.mockResolvedValue({
    content: CSV,
    contentType: "text/csv; charset=utf-8",
    fileName: "zeiterfassung-20000000-20260905.csv",
  });
});

describe("F9.4 Zeiterfassung CSV-Export-Route", () => {
  it("liefert CSV mit privatem Attachment und reicht gültige userIds durch", async () => {
    const response = await GET(request(`?userId=${USER_ID}`), context());

    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "time.read",
      "time_tracking_export",
      expect.any(Function),
    );
    expect(deps.exportTimeEntries).toHaveBeenCalledWith(TX, CTX, {
      projectId: PROJECT_ID,
      userIds: [USER_ID],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(await response.text()).toBe(CSV);
  });

  it.each([
    ["eine ungültige UUID", "?userId=kein-uuid"],
    ["eine ungültige unter gültigen", `?userId=${USER_ID}&userId=xyz`],
    ["einen ungültigen komma-getrennten Wert", `?userId=${USER_ID},nonsense`],
    ["einen leeren userId-Param", "?userId="],
  ])("wirft 400 statt still alle Nutzer zu exportieren (%s)", async (_label, query) => {
    const response = await GET(request(query), context());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Ungültiger Filter");
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.exportTimeEntries).not.toHaveBeenCalled();
  });
});
