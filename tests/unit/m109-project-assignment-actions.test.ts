import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class ProjectAssignmentValidationError extends Error {}
  class ProjectAssignmentNotFoundError extends Error {}
  class ProjectAssignmentTargetError extends Error {}
  class ProjectAssignmentConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("project assignment revision is stale");
    }
  }
  class ProjectAssignmentLimitError extends Error {}
  class ProjectAssignmentRoleError extends Error {}

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    ProjectAssignmentValidationError,
    ProjectAssignmentNotFoundError,
    ProjectAssignmentTargetError,
    ProjectAssignmentConflictError,
    ProjectAssignmentLimitError,
    ProjectAssignmentRoleError,
    authorizedAction: vi.fn(),
    authorizedQuery: vi.fn(),
    getProjectAssignmentContext: vi.fn(),
    persistProjectAssignment: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/projects", async () => {
  const contract = await import("@/modules/projects/assignment-contract");
  return {
    ...contract,
    changeProjectAssignment: deps.persistProjectAssignment,
    getProjectAssignmentContext: deps.getProjectAssignmentContext,
    ProjectAssignmentValidationError: deps.ProjectAssignmentValidationError,
    ProjectAssignmentNotFoundError: deps.ProjectAssignmentNotFoundError,
    ProjectAssignmentTargetError: deps.ProjectAssignmentTargetError,
    ProjectAssignmentConflictError: deps.ProjectAssignmentConflictError,
    ProjectAssignmentLimitError: deps.ProjectAssignmentLimitError,
    ProjectAssignmentRoleError: deps.ProjectAssignmentRoleError,
  };
});

import {
  changeProjectAssignment,
  membershipSearch,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/assignment-actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const MEMBERSHIP_ID = "30000000-0000-4000-8000-000000000003";
const SECOND_MEMBERSHIP_ID = "40000000-0000-4000-8000-000000000004";
const VERSION = "project-assignment-command.v1";
const ACTION_IDLE = { status: "idle" as const };
const SEARCH_IDLE = { status: "idle" as const };

function mutationForm(
  kind: "set_key_account" | "clear_key_account" | "add_user" | "remove_user" = "set_key_account",
): FormData {
  const result = new FormData();
  result.set("schemaVersion", VERSION);
  result.set("kind", kind);
  result.set("projectId", PROJECT_ID);
  result.set("expectedAssignmentRevision", "3");
  if (kind !== "clear_key_account") result.set("membershipId", MEMBERSHIP_ID);
  return result;
}

function searchForm(query = "  Mika  "): FormData {
  const result = new FormData();
  result.set("query", query);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _capability: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({ tx: true }, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _capability: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({ tx: true }, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.persistProjectAssignment.mockResolvedValue({
    projectId: PROJECT_ID,
    assignmentRevision: 4,
    changed: true,
  });
  deps.getProjectAssignmentContext.mockResolvedValue({
    projectId: PROJECT_ID,
    assignmentRevision: 3,
    keyAccount: null,
    users: [],
    canAssign: true,
    searchResults: [{
      membershipId: MEMBERSHIP_ID,
      label: "Mika Mustermann",
      alreadyAssigned: false,
      assignmentRole: null,
    }],
  });
});

describe("M1-09 Projektzuweisungs-Actions", () => {
  it.each([
    ["set_key_account", MEMBERSHIP_ID],
    ["clear_key_account", undefined],
    ["add_user", MEMBERSHIP_ID],
    ["remove_user", MEMBERSHIP_ID],
  ] as const)("führt %s autorisiert und revisionsgebunden aus", async (kind, membershipId) => {
    await expect(changeProjectAssignment(
      WORKSPACE_ID.toUpperCase(),
      ACTION_IDLE,
      mutationForm(kind),
    )).resolves.toEqual({
      status: "success",
      projectId: PROJECT_ID,
      assignmentRevision: 4,
      changed: true,
    });

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.assign",
      "project_assignment",
      expect.any(Function),
    );
    expect(deps.persistProjectAssignment).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: VERSION,
        kind,
        projectId: PROJECT_ID,
        expectedAssignmentRevision: 3,
        ...(membershipId ? { membershipId } : {}),
      },
    );
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      1,
      `/w/${WORKSPACE_ID}/anfragen`,
    );
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      2,
      `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
    );
  });

  it("akzeptiert nur echte React-Action-Metafelder neben der Fach-Allowlist", async () => {
    const accepted = mutationForm();
    accepted.set("$ACTION_ID_projectAssignment", "");
    accepted.set("$ACTION_REF_projectAssignment", "");
    accepted.set("$ACTION_projectAssignment:0", "");

    await expect(changeProjectAssignment(
      WORKSPACE_ID,
      ACTION_IDLE,
      accepted,
    )).resolves.toMatchObject({ status: "success" });

    const rejected = mutationForm();
    rejected.set("$ACTION_FAKE!", "browser-trust");
    await expect(changeProjectAssignment(
      WORKSPACE_ID,
      ACTION_IDLE,
      rejected,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.authorizedAction).toHaveBeenCalledTimes(1);
  });

  it("weist zusätzliche, fehlende, wiederholte und binäre Mutationsfelder vor der Autorisierung ab", async () => {
    const additional = mutationForm();
    additional.set("actorId", "browser-trust");
    const missing = mutationForm();
    missing.delete("projectId");
    const repeated = mutationForm();
    repeated.append("membershipId", SECOND_MEMBERSHIP_ID);
    const binary = mutationForm();
    binary.set("membershipId", new File(["browser-trust"], "membership.txt"));
    const clearWithTarget = mutationForm("clear_key_account");
    clearWithTarget.set("membershipId", MEMBERSHIP_ID);
    const targetWithoutMembership = mutationForm("add_user");
    targetWithoutMembership.delete("membershipId");
    const repeatedKind = mutationForm();
    repeatedKind.append("kind", "add_user");

    for (const candidate of [
      additional,
      missing,
      repeated,
      binary,
      clearWithTarget,
      targetWithoutMembership,
      repeatedKind,
    ]) {
      await expect(changeProjectAssignment(
        WORKSPACE_ID,
        ACTION_IDLE,
        candidate,
      )).resolves.toEqual({ status: "invalid" });
    }

    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.persistProjectAssignment).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["03", "3.0", "3e0", "-1", "+3", " 3", "3 ", "9007199254740992"])(
    "weist die nicht-kanonische Revision %s ab",
    async (revision) => {
      const candidate = mutationForm();
      candidate.set("expectedAssignmentRevision", revision);

      await expect(changeProjectAssignment(
        WORKSPACE_ID,
        ACTION_IDLE,
        candidate,
      )).resolves.toEqual({ status: "invalid" });
      expect(deps.authorizedAction).not.toHaveBeenCalled();
    },
  );

  it("weist ungültige gebundene IDs, Form-IDs und Schema-Versionen vor dem Service ab", async () => {
    const badProject = mutationForm();
    badProject.set("projectId", "not-a-project");
    const badMembership = mutationForm();
    badMembership.set("membershipId", "not-a-membership");
    const badVersion = mutationForm();
    badVersion.set("schemaVersion", "project-assignment-command.v2");

    await expect(changeProjectAssignment(
      "not-a-workspace",
      ACTION_IDLE,
      mutationForm(),
    )).resolves.toEqual({ status: "invalid" });
    for (const candidate of [badProject, badMembership, badVersion]) {
      await expect(changeProjectAssignment(
        WORKSPACE_ID,
        ACTION_IDLE,
        candidate,
      )).resolves.toEqual({ status: "invalid" });
    }

    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.persistProjectAssignment).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.ProjectAssignmentValidationError(), { status: "invalid" }],
    [new deps.ProjectAssignmentTargetError(), { status: "target_unavailable" }],
    [new deps.ProjectAssignmentLimitError(), { status: "limit_reached" }],
    [new deps.ProjectAssignmentRoleError(), { status: "key_account_requires_clear" }],
    [new deps.ProjectAssignmentNotFoundError(), { status: "not_found" }],
  ] as const)("übersetzt erwartete Fachfehler in serialisierbare Zustände", async (error, state) => {
    deps.persistProjectAssignment.mockRejectedValueOnce(error);

    await expect(changeProjectAssignment(
      WORKSPACE_ID,
      ACTION_IDLE,
      mutationForm(),
    )).resolves.toEqual(state);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("meldet Konflikte mit aktueller Revision und revalidiert Liste sowie Detail", async () => {
    deps.persistProjectAssignment.mockRejectedValueOnce(
      new deps.ProjectAssignmentConflictError(9),
    );

    await expect(changeProjectAssignment(
      WORKSPACE_ID,
      ACTION_IDLE,
      mutationForm(),
    )).resolves.toEqual({ status: "conflict", currentRevision: 9 });
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      1,
      `/w/${WORKSPACE_ID}/anfragen`,
    );
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      2,
      `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
    );
  });

  it("propagiert unbekannte Mutationsfehler unverändert", async () => {
    const fault = new Error("unexpected persistence fault");
    deps.persistProjectAssignment.mockRejectedValueOnce(fault);

    await expect(changeProjectAssignment(
      WORKSPACE_ID,
      ACTION_IDLE,
      mutationForm(),
    )).rejects.toBe(fault);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("normalisiert die Suche und gibt ausschließlich den schmalen Ergebnissatz zurück", async () => {
    await expect(membershipSearch(
      WORKSPACE_ID.toUpperCase(),
      PROJECT_ID.toUpperCase(),
      SEARCH_IDLE,
      searchForm(),
    )).resolves.toEqual({
      status: "results",
      query: "Mika",
      results: [{
        membershipId: MEMBERSHIP_ID,
        label: "Mika Mustermann",
        alreadyAssigned: false,
        assignmentRole: null,
      }],
    });

    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.assign",
      "project_assignment_search",
      expect.any(Function),
    );
    expect(deps.getProjectAssignmentContext).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      PROJECT_ID,
      { query: "Mika" },
    );
  });

  it("unterscheidet leere Suche, fehlendes Projekt und erwartete Suchfehler", async () => {
    deps.getProjectAssignmentContext.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      assignmentRevision: 3,
      keyAccount: null,
      users: [],
      canAssign: true,
      searchResults: [],
    });
    await expect(membershipSearch(
      WORKSPACE_ID,
      PROJECT_ID,
      SEARCH_IDLE,
      searchForm("Niemand"),
    )).resolves.toEqual({ status: "empty", query: "Niemand" });

    deps.getProjectAssignmentContext.mockResolvedValueOnce(null);
    await expect(membershipSearch(
      WORKSPACE_ID,
      PROJECT_ID,
      SEARCH_IDLE,
      searchForm("Mika"),
    )).resolves.toEqual({ status: "not_found" });

    for (const [error, expected] of [
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.ProjectAssignmentValidationError(), { status: "invalid" }],
    ] as const) {
      deps.getProjectAssignmentContext.mockRejectedValueOnce(error);
      await expect(membershipSearch(
        WORKSPACE_ID,
        PROJECT_ID,
        SEARCH_IDLE,
        searchForm("Mika"),
      )).resolves.toEqual(expected);
    }
  });

  it("weist manipulierte Suchformulare vor der Autorisierung ab", async () => {
    const short = searchForm(" x ");
    const additional = searchForm();
    additional.set("workspaceId", WORKSPACE_ID);
    const repeated = searchForm();
    repeated.append("query", "zweite Suche");
    const binary = searchForm();
    binary.set("query", new File(["Mika"], "query.txt"));
    const badRoute = searchForm();

    for (const [workspaceId, projectId, candidate] of [
      [WORKSPACE_ID, PROJECT_ID, short],
      [WORKSPACE_ID, PROJECT_ID, additional],
      [WORKSPACE_ID, PROJECT_ID, repeated],
      [WORKSPACE_ID, PROJECT_ID, binary],
      ["not-a-workspace", PROJECT_ID, badRoute],
      [WORKSPACE_ID, "not-a-project", badRoute],
    ] as const) {
      await expect(membershipSearch(
        workspaceId,
        projectId,
        SEARCH_IDLE,
        candidate,
      )).resolves.toEqual({ status: "invalid" });
    }

    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.getProjectAssignmentContext).not.toHaveBeenCalled();
  });
});
