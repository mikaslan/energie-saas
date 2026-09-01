import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class ProjectTaskValidationError extends Error {}
  class ProjectTaskNotFoundError extends Error {}
  class ProjectTaskConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("project task revision is stale");
    }
  }
  class ProjectTaskIllegalTransitionError extends Error {}
  class ProjectTaskArchivedError extends Error {}
  class ProjectTaskLimitError extends Error {}

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    ProjectTaskValidationError,
    ProjectTaskNotFoundError,
    ProjectTaskConflictError,
    ProjectTaskIllegalTransitionError,
    ProjectTaskArchivedError,
    ProjectTaskLimitError,
    authorizedAction: vi.fn(),
    authorizedQuery: vi.fn(),
    executeProjectTaskCommand: vi.fn(),
    findProjectTaskMembers: vi.fn(),
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
vi.mock("@/modules/tasks", async () => {
  const contract = await import("@/lib/integrations/tasks/contract");
  return {
    ...contract,
    executeProjectTaskCommand: deps.executeProjectTaskCommand,
    searchProjectTaskMembers: deps.findProjectTaskMembers,
    ProjectTaskValidationError: deps.ProjectTaskValidationError,
    ProjectTaskNotFoundError: deps.ProjectTaskNotFoundError,
    ProjectTaskConflictError: deps.ProjectTaskConflictError,
    ProjectTaskIllegalTransitionError: deps.ProjectTaskIllegalTransitionError,
    ProjectTaskArchivedError: deps.ProjectTaskArchivedError,
    ProjectTaskLimitError: deps.ProjectTaskLimitError,
  };
});

import {
  changeProjectTask,
  type ProjectTaskActionState,
  type ProjectTaskMemberSearchState,
  searchProjectTaskMembers,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/task-actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_PROJECT_ID = "20000000-0000-4000-8000-000000000003";
const TASK_ID = "30000000-0000-4000-8000-000000000003";
const ITEM_ID = "40000000-0000-4000-8000-000000000004";
const VERSION = "project-task-command.v1";
const IDLE: ProjectTaskActionState = { status: "idle" };
const MEMBER_SEARCH_IDLE: ProjectTaskMemberSearchState = { status: "idle" };
const BODY = {
  schemaVersion: "task-rich-text.v1",
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Termin abstimmen" }] }],
  },
};

function baseForm(kind: string): FormData {
  const result = new FormData();
  result.set("schemaVersion", VERSION);
  result.set("kind", kind);
  result.set("projectId", PROJECT_ID);
  return result;
}

function quickForm(): FormData {
  const result = baseForm("quick_create");
  result.set("title", "  Unterlagen prüfen  ");
  return result;
}

function memberSearchForm(query = "  Ｍｉｋａ  "): FormData {
  const result = new FormData();
  result.set("query", query);
  return result;
}

function fullForm(kind: "create" | "update" = "create"): FormData {
  const result = baseForm(kind);
  if (kind === "update") {
    result.set("taskId", TASK_ID);
    result.set("expectedRevision", "7");
  }
  result.set("title", "Montage vorbereiten");
  result.set("bodyJson", JSON.stringify(BODY));
  result.set("dueDate", "2026-10-25");
  result.set("assigneeIdsJson", "[]");
  result.set("checklistJson", "[]");
  result.set("labelsJson", "[]");
  return result;
}

function revisionForm(kind: "toggle_checklist_item" | "complete" | "reopen" | "archive"): FormData {
  const result = baseForm(kind);
  result.set("taskId", TASK_ID);
  result.set("expectedRevision", "7");
  if (kind === "toggle_checklist_item") {
    result.set("checklistItemId", ITEM_ID);
    result.set("done", "true");
  }
  if (kind === "archive") result.set("archiveConfirmation", "archive");
  return result;
}

function deeplyNestedTaskBody(depth: number): string {
  let node = '{"type":"paragraph","content":[]}';
  for (let index = 0; index < depth; index += 1) {
    node = `{"type":"bulletList","content":[{"type":"listItem","content":[${node}]}]}`;
  }
  return `{"schemaVersion":"task-rich-text.v1","doc":{"type":"doc","content":[${node}]}}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({ tx: true }, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({ tx: true }, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.executeProjectTaskCommand.mockResolvedValue({
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    revision: 1,
    changed: true,
  });
  deps.findProjectTaskMembers.mockResolvedValue({
    schemaVersion: "project-task-member-search-page.v1",
    query: "Mika",
    members: [{ membershipId: "50000000-0000-4000-8000-000000000005", label: "mika@example.test" }],
    hasMore: true,
  });
});

describe("M1-10 Project-Task-Action", () => {
  it("führt Quick Create gebunden, autorisiert und kanonisiert aus", async () => {
    await expect(changeProjectTask(
      WORKSPACE_ID.toUpperCase(),
      PROJECT_ID.toUpperCase(),
      IDLE,
      quickForm(),
    )).resolves.toEqual({
      status: "success",
      operation: "quick_create",
      taskId: TASK_ID,
      revision: 1,
      changed: true,
    });

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "task.write",
      "project_task",
      expect.any(Function),
    );
    expect(deps.executeProjectTaskCommand).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: VERSION,
        kind: "quick_create",
        projectId: PROJECT_ID,
        title: "Unterlagen prüfen",
      },
    );
  });

  it("parst Full Create und leere Fälligkeit ausschließlich serverseitig", async () => {
    const form = fullForm();
    form.set("dueDate", "");
    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, form))
      .resolves.toMatchObject({ status: "success", operation: "create" });
    expect(deps.executeProjectTaskCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        projectId: PROJECT_ID,
        body: BODY,
        dueDate: null,
        assigneeMembershipIds: [],
        checklist: [],
        labels: [],
      }),
    );
  });

  it("akzeptiert die vertragsgültige UTF-8-Maximalcheckliste", async () => {
    const form = fullForm();
    const checklist = Array.from({ length: 100 }, (_, index) => ({
      text: `${index}`.padStart(3, "0") + "ü".repeat(497),
      done: false,
    }));
    form.set("checklistJson", JSON.stringify(checklist));

    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, form))
      .resolves.toMatchObject({ status: "success", operation: "create" });
    expect(deps.executeProjectTaskCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ checklist }),
    );
  });

  it("verwirft tief verschachtelten Richtext vor der rekursiven Zod-Prüfung", async () => {
    const form = fullForm();
    const bodyJson = deeplyNestedTaskBody(400);
    expect(new TextEncoder().encode(bodyJson).byteLength).toBeLessThan(34 * 1024);
    form.set("bodyJson", bodyJson);

    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, form))
      .resolves.toEqual({ status: "invalid" });
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it.each([
    ["update", () => fullForm("update")],
    ["toggle_checklist_item", () => revisionForm("toggle_checklist_item")],
    ["complete", () => revisionForm("complete")],
    ["reopen", () => revisionForm("reopen")],
    ["archive", () => revisionForm("archive")],
  ] as const)("führt %s revisionsgebunden aus", async (operation, formFactory) => {
    deps.executeProjectTaskCommand.mockResolvedValue({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      revision: 8,
      changed: true,
    });
    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, formFactory()))
      .resolves.toMatchObject({ status: "success", operation, revision: 8 });
    expect(deps.executeProjectTaskCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: operation, expectedRevision: 7 }),
    );
  });

  it("weist zusätzliche, fehlende, doppelte, binäre und fremd gebundene Felder vor Autorisierung ab", async () => {
    const additional = quickForm();
    additional.set("actorId", "browser-trust");
    const missing = quickForm();
    missing.delete("title");
    const duplicate = quickForm();
    duplicate.append("projectId", PROJECT_ID);
    const binary = quickForm();
    binary.set("title", new File(["secret"], "title.txt"));
    const wrongRoute = quickForm();
    wrongRoute.set("projectId", OTHER_PROJECT_ID);
    const fakeReact = quickForm();
    fakeReact.set("$ACTION_FAKE!", "browser-trust");

    for (const candidate of [additional, missing, duplicate, binary, wrongRoute, fakeReact]) {
      await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, candidate))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.executeProjectTaskCommand).not.toHaveBeenCalled();
  });

  it("akzeptiert nur echte React-Metafelder", async () => {
    const form = quickForm();
    form.set("$ACTION_ID_projectTask", "");
    form.set("$ACTION_REF_projectTask", "");
    form.set("$ACTION_projectTask:0", "");
    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, form))
      .resolves.toMatchObject({ status: "success" });
  });

  it("begrenzt Anzahl und Byteumfang echter React-Metafelder", async () => {
    const tooMany = quickForm();
    for (let index = 0; index < 17; index += 1) {
      tooMany.set(`$ACTION_ID_projectTask_${index}`, "");
    }
    const tooLarge = quickForm();
    tooLarge.set("$ACTION_ID_projectTask", "x".repeat(128 * 1024 + 1));

    for (const candidate of [tooMany, tooLarge]) {
      await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, candidate))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "7.0", "7e0", "-1", "+7", " 7", "7 ", "2147483648"])(
    "weist die nicht-kanonische Revision %s ab",
    async (revision) => {
      const form = revisionForm("complete");
      form.set("expectedRevision", revision);
      await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, form))
        .resolves.toEqual({ status: "invalid" });
      expect(deps.authorizedAction).not.toHaveBeenCalled();
    },
  );

  it("begrenzt JSON-Felder vor JSON.parse und Autorisierung", async () => {
    const oversized = fullForm();
    oversized.set("bodyJson", `{"padding":"${"x".repeat(40_000)}"}`);
    const malformed = fullForm();
    malformed.set("labelsJson", "[");
    for (const candidate of [oversized, malformed]) {
      await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, candidate))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("übersetzt Konflikte und Fachfehler stabil ohne Eingabewerte", async () => {
    const cases = [
      [new deps.ProjectTaskConflictError(9), { status: "conflict", currentRevision: 9 }],
      [new deps.ProjectTaskIllegalTransitionError(), { status: "illegal_transition" }],
      [new deps.ProjectTaskArchivedError(), { status: "archived" }],
      [new deps.ProjectTaskLimitError(), { status: "limit_reached" }],
      [new deps.ProjectTaskNotFoundError(), { status: "not_found" }],
      [new deps.ProjectTaskValidationError(), { status: "invalid" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    ] as const;
    for (const [error, state] of cases) {
      deps.authorizedAction.mockRejectedValueOnce(error);
      await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, quickForm()))
        .resolves.toEqual(state);
    }
  });

  it("behandelt unbekannte Persistenzfehler fail-closed ohne Rohfehler", async () => {
    deps.authorizedAction.mockRejectedValueOnce(new Error("private database detail"));

    await expect(changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, quickForm()))
      .resolves.toEqual({ status: "invalid" });
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidiert ausschließlich die tatsächlich existierenden Lesepfade", async () => {
    await changeProjectTask(WORKSPACE_ID, PROJECT_ID, IDLE, quickForm());
    // Seit M1-12a liest die globale Aufgaben-Inbox dieselben Aggregate. Sie ist
    // der zweite und letzte Pfad, der nach einer Task-Mutation veralten kann.
    expect(deps.revalidatePath.mock.calls).toEqual([
      [`/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`],
      [`/w/${WORKSPACE_ID}/aufgaben`],
    ]);
  });

  it("sucht Members ausschließlich task.write-gated, kanonisiert und gibt hasMore sichtbar weiter", async () => {
    await expect(searchProjectTaskMembers(
      WORKSPACE_ID.toUpperCase(),
      PROJECT_ID.toUpperCase(),
      MEMBER_SEARCH_IDLE,
      memberSearchForm(),
    )).resolves.toEqual({
      status: "results",
      query: "Mika",
      members: [{
        membershipId: "50000000-0000-4000-8000-000000000005",
        label: "mika@example.test",
      }],
      hasMore: true,
    });
    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "task.write",
      "project_task_member_search",
      expect.any(Function),
    );
    expect(deps.findProjectTaskMembers).toHaveBeenCalledWith(
      { tx: true },
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      PROJECT_ID,
      { query: "Mika" },
    );
  });

  it("weist ungültige Membersuchen vor Autorisierung ab", async () => {
    const extra = memberSearchForm();
    extra.set("projectId", OTHER_PROJECT_ID);
    const duplicate = memberSearchForm();
    duplicate.append("query", "Admin");
    const tooShort = memberSearchForm("x");

    for (const form of [extra, duplicate, tooShort]) {
      await expect(searchProjectTaskMembers(
        WORKSPACE_ID,
        PROJECT_ID,
        MEMBER_SEARCH_IDLE,
        form,
      )).resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.findProjectTaskMembers).not.toHaveBeenCalled();
  });

  it("übersetzt Member-Suchergebnis und Fehler fail-closed", async () => {
    deps.findProjectTaskMembers.mockResolvedValueOnce({
      schemaVersion: "project-task-member-search-page.v1",
      query: "Nobody",
      members: [],
      hasMore: false,
    });
    await expect(searchProjectTaskMembers(
      WORKSPACE_ID,
      PROJECT_ID,
      MEMBER_SEARCH_IDLE,
      memberSearchForm("Nobody"),
    )).resolves.toEqual({ status: "empty", query: "Nobody" });

    for (const [error, state] of [
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.ProjectTaskNotFoundError(), { status: "not_found" }],
      [new Error("private database detail"), { status: "invalid" }],
    ] as const) {
      deps.authorizedQuery.mockRejectedValueOnce(error);
      await expect(searchProjectTaskMembers(
        WORKSPACE_ID,
        PROJECT_ID,
        MEMBER_SEARCH_IDLE,
        memberSearchForm("Mika"),
      )).resolves.toEqual(state);
    }
  });
});
