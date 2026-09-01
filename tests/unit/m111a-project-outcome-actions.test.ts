import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class ProjectOutcomeValidationError extends Error {}
  class ProjectOutcomeNotFoundError extends Error {}
  class ProjectOutcomeConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("project outcome revision is stale");
    }
  }
  class ProjectOutcomeIllegalTransitionError extends Error {}
  class ProjectLossReasonUnavailableError extends Error {}
  class ProjectLossReasonValidationError extends Error {}
  class ProjectLossReasonNotFoundError extends Error {}
  class ProjectLossReasonConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("project loss reason revision is stale");
    }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    ProjectOutcomeValidationError,
    ProjectOutcomeNotFoundError,
    ProjectOutcomeConflictError,
    ProjectOutcomeIllegalTransitionError,
    ProjectLossReasonUnavailableError,
    ProjectLossReasonValidationError,
    ProjectLossReasonNotFoundError,
    ProjectLossReasonConflictError,
    authorizedAction: vi.fn(),
    changeProjectOutcome: vi.fn(),
    changeProjectLossReason: vi.fn(),
    revalidatePath: vi.fn(),
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
vi.mock("@/modules/projects", async () => {
  const contract = await import("@/modules/projects/outcome-contract");
  return {
    ...contract,
    changeProjectOutcome: deps.changeProjectOutcome,
    changeProjectLossReason: deps.changeProjectLossReason,
    ProjectOutcomeValidationError: deps.ProjectOutcomeValidationError,
    ProjectOutcomeNotFoundError: deps.ProjectOutcomeNotFoundError,
    ProjectOutcomeConflictError: deps.ProjectOutcomeConflictError,
    ProjectOutcomeIllegalTransitionError: deps.ProjectOutcomeIllegalTransitionError,
    ProjectLossReasonUnavailableError: deps.ProjectLossReasonUnavailableError,
    ProjectLossReasonValidationError: deps.ProjectLossReasonValidationError,
    ProjectLossReasonNotFoundError: deps.ProjectLossReasonNotFoundError,
    ProjectLossReasonConflictError: deps.ProjectLossReasonConflictError,
  };
});

import {
  changeProjectOutcomeAction,
  type ProjectOutcomeActionState,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/outcome-actions";
import {
  changeProjectLossReasonAction,
  type ProjectLossReasonActionState,
} from "@/app/w/[workspaceId]/einstellungen/verlustgruende/actions";

const WORKSPACE_ID = "abcdef00-0000-4000-8000-000000000001";
const PROJECT_ID = "a0000000-0000-4000-8000-00000000000a";
const REASON_ID = "b0000000-0000-4000-8000-00000000000b";
const OUTCOME_VERSION = "project-outcome-command.v1";
const REASON_VERSION = "project-loss-reason-command.v1";
const OUTCOME_IDLE: ProjectOutcomeActionState = { status: "idle" };
const REASON_IDLE: ProjectLossReasonActionState = { status: "idle" };
const TX = { tx: true };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };

function outcomeForm(kind: "mark_won" | "mark_lost" | "reopen"): FormData {
  const form = new FormData();
  form.set("schemaVersion", OUTCOME_VERSION);
  form.set("kind", kind);
  form.set("projectId", PROJECT_ID.toUpperCase());
  form.set("expectedOutcomeRevision", "7");
  form.set("confirmation", kind);
  if (kind === "mark_lost") {
    form.set("lossReasonId", REASON_ID.toUpperCase());
    form.set("lossReasonText", "  Ｋｅｉｎ Budget  ");
  }
  return form;
}

function reasonForm(kind: "create" | "archive" | "reactivate"): FormData {
  const form = new FormData();
  form.set("schemaVersion", REASON_VERSION);
  form.set("kind", kind);
  if (kind === "create") {
    form.set("label", "  Ｋｅｉｎ Budget  ");
  } else {
    form.set("reasonId", REASON_ID.toUpperCase());
    form.set("expectedRevision", "7");
    if (kind === "archive") form.set("archiveConfirmation", "archive");
  }
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback(TX, CTX));
  deps.changeProjectOutcome.mockImplementation(async (
    _tx: object,
    _ctx: object,
    command: { kind: "mark_won" | "mark_lost" | "reopen"; projectId: string },
  ) => ({
    projectId: command.projectId,
    outcome: command.kind === "reopen"
      ? "open"
      : command.kind === "mark_won" ? "won" : "lost",
    outcomeRevision: 8,
  }));
  deps.changeProjectLossReason.mockImplementation(async (
    _tx: object,
    _ctx: object,
    command: { kind: "create" | "archive" | "reactivate" },
  ) => ({ revision: command.kind === "create" ? 1 : 8 }));
});

describe("M1-11a Project-Outcome Server Action", () => {
  it.each([
    ["mark_won", "won"],
    ["mark_lost", "lost"],
    ["reopen", "open"],
  ] as const)("autorisiert %s exakt, liefert Erfolg und revalidiert alle drei Sichten", async (
    kind,
    outcome,
  ) => {
    await expect(changeProjectOutcomeAction(
      WORKSPACE_ID.toUpperCase(),
      OUTCOME_IDLE,
      outcomeForm(kind),
    )).resolves.toEqual({
      status: "success",
      outcome,
      outcomeRevision: 8,
    });

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.outcome.write",
      "project_outcome",
      expect.any(Function),
    );
    expect(deps.changeProjectOutcome).toHaveBeenCalledWith(
      TX,
      CTX,
      expect.objectContaining({
        schemaVersion: OUTCOME_VERSION,
        kind,
        projectId: PROJECT_ID,
        expectedOutcomeRevision: 7,
        confirmation: kind,
      }),
    );
    if (kind === "mark_lost") {
      expect(deps.changeProjectOutcome).toHaveBeenCalledWith(
        TX,
        CTX,
        expect.objectContaining({
          lossReasonId: REASON_ID,
          lossReasonText: "Kein Budget",
        }),
      );
    }
    expect(deps.revalidatePath.mock.calls).toEqual([
      [`/w/${WORKSPACE_ID}/anfragen`],
      [`/w/${WORKSPACE_ID}/anfragen/abgeschlossen`],
      [`/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`],
    ]);
  });

  it("verwirft fehlende, doppelte, unbekannte und nicht-string Felder sowie falsche Bestätigung", async () => {
    const missing = outcomeForm("mark_won");
    missing.delete("confirmation");
    const duplicate = outcomeForm("mark_won");
    duplicate.append("projectId", PROJECT_ID);
    const unknown = outcomeForm("mark_won");
    unknown.set("actorId", "browser-trust");
    const binary = outcomeForm("mark_won");
    binary.set("confirmation", new File(["mark_won"], "confirmation.txt"));
    const wrongConfirmation = outcomeForm("mark_won");
    wrongConfirmation.set("confirmation", "reopen");

    for (const candidate of [missing, duplicate, unknown, binary, wrongConfirmation]) {
      await expect(changeProjectOutcomeAction(WORKSPACE_ID, OUTCOME_IDLE, candidate))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.changeProjectOutcome).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["", "-1", "+7", "01", "7.0", "7e0", " 7", "7 ", "2147483647"])(
    "verwirft die nicht-kanonische oder unzulässige Outcome-Revision %j",
    async (revision) => {
      const form = outcomeForm("mark_won");
      form.set("expectedOutcomeRevision", revision);
      await expect(changeProjectOutcomeAction(WORKSPACE_ID, OUTCOME_IDLE, form))
        .resolves.toEqual({ status: "invalid" });
      expect(deps.authorizedAction).not.toHaveBeenCalled();
    },
  );

  it("bildet ausschließlich erwartete Auth- und Fachfehler auf öffentliche Zustände ab", async () => {
    const cases = [
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.ProjectOutcomeValidationError(), { status: "invalid" }],
      [new deps.ProjectOutcomeNotFoundError(), { status: "not_found" }],
      [
        new deps.ProjectOutcomeIllegalTransitionError(),
        { status: "illegal_transition" },
      ],
      [
        new deps.ProjectLossReasonUnavailableError(),
        { status: "loss_reason_unavailable" },
      ],
      [new deps.ProjectOutcomeConflictError(9), { status: "conflict", currentRevision: 9 }],
      [new deps.ProjectOutcomeConflictError(), { status: "conflict" }],
    ] as const;

    for (const [error, expected] of cases) {
      deps.revalidatePath.mockClear();
      deps.authorizedAction.mockRejectedValueOnce(error);
      await expect(changeProjectOutcomeAction(
        WORKSPACE_ID,
        OUTCOME_IDLE,
        outcomeForm("mark_won"),
      )).resolves.toEqual(expected);
      const refreshExpected = expected.status === "conflict"
        || expected.status === "illegal_transition"
        || expected.status === "loss_reason_unavailable"
        || expected.status === "not_found";
      expect(deps.revalidatePath).toHaveBeenCalledTimes(refreshExpected ? 3 : 0);
    }
  });

  it("lässt unbekannte Fehler laut und revalidiert dabei nichts", async () => {
    const error = new Error("private database detail");
    deps.authorizedAction.mockRejectedValueOnce(error);

    await expect(changeProjectOutcomeAction(
      WORKSPACE_ID,
      OUTCOME_IDLE,
      outcomeForm("mark_won"),
    )).rejects.toBe(error);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("M1-11a Verlustgrund Server Action", () => {
  it.each([
    ["create", 1],
    ["archive", 8],
    ["reactivate", 8],
  ] as const)("autorisiert %s exakt, liefert Erfolg und revalidiert Settings plus Anfrage-Layout", async (
    kind,
    revision,
  ) => {
    await expect(changeProjectLossReasonAction(
      WORKSPACE_ID.toUpperCase(),
      REASON_IDLE,
      reasonForm(kind),
    )).resolves.toEqual({ status: "success", operation: kind, revision });

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "settings.manage",
      "project_loss_reason",
      expect.any(Function),
    );
    expect(deps.changeProjectLossReason).toHaveBeenCalledWith(
      TX,
      CTX,
      expect.objectContaining({
        schemaVersion: REASON_VERSION,
        kind,
        ...(kind === "create"
          ? { label: "Kein Budget" }
          : { reasonId: REASON_ID, expectedRevision: 7 }),
      }),
    );
    if (kind === "archive") {
      expect(deps.changeProjectLossReason).toHaveBeenCalledWith(
        TX,
        CTX,
        expect.objectContaining({ archiveConfirmation: "archive" }),
      );
    }
    expect(deps.revalidatePath.mock.calls).toEqual([
      [`/w/${WORKSPACE_ID}/einstellungen/verlustgruende`],
      [`/w/${WORKSPACE_ID}/anfragen`, "layout"],
    ]);
  });

  it("verwirft fehlende, doppelte, unbekannte und nicht-string Felder sowie falsche Archivbestätigung", async () => {
    const missing = reasonForm("create");
    missing.delete("label");
    const duplicate = reasonForm("create");
    duplicate.append("label", "Doppelt");
    const unknown = reasonForm("create");
    unknown.set("actorId", "browser-trust");
    const binary = reasonForm("create");
    binary.set("label", new File(["Kein Budget"], "label.txt"));
    const wrongConfirmation = reasonForm("archive");
    wrongConfirmation.set("archiveConfirmation", "yes");

    for (const candidate of [missing, duplicate, unknown, binary, wrongConfirmation]) {
      await expect(changeProjectLossReasonAction(WORKSPACE_ID, REASON_IDLE, candidate))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.changeProjectLossReason).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-1", "+7", "01", "7.0", "7e0", " 7", "7 ", "2147483647"])(
    "verwirft die nicht-kanonische oder unzulässige Verlustgrund-Revision %j",
    async (revision) => {
      const form = reasonForm("archive");
      form.set("expectedRevision", revision);
      await expect(changeProjectLossReasonAction(WORKSPACE_ID, REASON_IDLE, form))
        .resolves.toEqual({ status: "invalid" });
      expect(deps.authorizedAction).not.toHaveBeenCalled();
    },
  );

  it("bildet ausschließlich erwartete Auth- und Fachfehler auf öffentliche Zustände ab", async () => {
    const cases = [
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.ProjectLossReasonValidationError(), { status: "invalid" }],
      [new deps.ProjectLossReasonNotFoundError(), { status: "not_found" }],
      [
        new deps.ProjectLossReasonConflictError(9),
        { status: "conflict", currentRevision: 9 },
      ],
      [new deps.ProjectLossReasonConflictError(), { status: "conflict" }],
    ] as const;

    for (const [error, expected] of cases) {
      deps.revalidatePath.mockClear();
      deps.authorizedAction.mockRejectedValueOnce(error);
      await expect(changeProjectLossReasonAction(
        WORKSPACE_ID,
        REASON_IDLE,
        reasonForm("archive"),
      )).resolves.toEqual(expected);
      expect(deps.revalidatePath).toHaveBeenCalledTimes(
        expected.status === "conflict" ? 1 : 0,
      );
    }
  });

  it("lässt unbekannte Fehler laut und revalidiert dabei nichts", async () => {
    const error = new Error("private database detail");
    deps.authorizedAction.mockRejectedValueOnce(error);

    await expect(changeProjectLossReasonAction(
      WORKSPACE_ID,
      REASON_IDLE,
      reasonForm("create"),
    )).rejects.toBe(error);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });
});
