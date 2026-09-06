import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class PlanningSettingsValidationError extends Error {}
  class PlanningSettingsConflictError extends Error {
    constructor(public readonly currentRevision?: number) { super("conflict"); }
  }
  class PlanningSettingsIntegrityError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    PlanningSettingsValidationError,
    PlanningSettingsConflictError,
    PlanningSettingsIntegrityError,
    authorizedAction: vi.fn(),
    upsertPlanningSettings: vi.fn(),
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
vi.mock("@/modules/planning", () => ({
  PlanningSettingsValidationError: deps.PlanningSettingsValidationError,
  PlanningSettingsConflictError: deps.PlanningSettingsConflictError,
  PlanningSettingsIntegrityError: deps.PlanningSettingsIntegrityError,
  upsertPlanningSettings: deps.upsertPlanningSettings,
}));

import {
  upsertPlanningSettingsAction,
  type PlanningSettingsActionState,
} from "@/app/w/[workspaceId]/einstellungen/planung/actions";
import { PlanningSettingsForm } from "@/app/w/[workspaceId]/einstellungen/planung/planning-settings-form";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "20000000-0000-4000-8000-000000000002" };
const IDLE: PlanningSettingsActionState = { status: "idle" };

function validForm(): FormData {
  const form = new FormData();
  form.set("schemaVersion", "workspace-planning-settings-command.v1");
  form.set("workspaceId", WORKSPACE_ID);
  form.set("baseRevision", "0");
  form.set("defaultPlanningMode", "2d");
  return form;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.upsertPlanningSettings.mockResolvedValue({
    schemaVersion: "workspace-planning-settings.v1",
    revision: 1,
    defaultPlanningMode: "2d",
    permissions: { canWrite: true },
  });
});

describe("F3.1 Workspace-Planungsstandard — Action und Oberfläche", () => {
  it("F301-UI-01: autorisiert settings.manage und übergibt nur den strict Command", async () => {
    await expect(upsertPlanningSettingsAction(IDLE, validForm())).resolves.toEqual({
      status: "success",
      revision: 1,
      created: true,
    });
    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "settings.manage",
      "workspace_planning_settings",
      expect.any(Function),
    );
    expect(deps.upsertPlanningSettings).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "workspace-planning-settings-command.v1",
      baseRevision: 0,
      defaultPlanningMode: "2d",
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/einstellungen/planung`,
    );
  });

  it("F301-UI-02: weist fehlende, doppelte, binäre und unbekannte Felder vor Autorisierung ab", async () => {
    const missing = validForm();
    missing.delete("defaultPlanningMode");
    const duplicate = validForm();
    duplicate.append("baseRevision", "0");
    const binary = validForm();
    binary.set("defaultPlanningMode", new Blob(["2d"]), "mode.txt");
    const unknown = validForm();
    unknown.set("actorId", CTX.actor);
    const fakeReact = validForm();
    fakeReact.set("$ACTION_PRIVATE", "poison");

    for (const form of [missing, duplicate, binary, unknown, fakeReact]) {
      await expect(upsertPlanningSettingsAction(IDLE, form))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("F301-UI-03: akzeptiert ausschließlich echte React-Action-Metafelder", async () => {
    const form = validForm();
    form.set("$ACTION_ID_react123", "opaque");
    await expect(upsertPlanningSettingsAction(IDLE, form)).resolves.toMatchObject({
      status: "success",
    });
  });

  it("F301-UI-04: mappt CAS-, Auth-, Validierungs- und Integritätsfehler fail-closed", async () => {
    const cases: Array<[Error, PlanningSettingsActionState]> = [
      [new deps.PlanningSettingsConflictError(5), { status: "conflict", currentRevision: 5 }],
      [new deps.PlanningSettingsConflictError(), { status: "conflict" }],
      [new deps.PlanningSettingsValidationError(), { status: "invalid" }],
      [new deps.PlanningSettingsIntegrityError(), { status: "unavailable" }],
      [new deps.PermissionDeniedError(), { status: "denied" }],
      [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    ];
    for (const [error, expected] of cases) {
      deps.authorizedAction.mockRejectedValueOnce(error);
      await expect(upsertPlanningSettingsAction(IDLE, validForm())).resolves.toEqual(expected);
    }
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("F301-UI-05: zeigt Viewer alle Modi ohne aktives Steuerelement", () => {
    const markup = renderToStaticMarkup(createElement(PlanningSettingsForm, {
      workspaceId: WORKSPACE_ID,
      settings: {
        schemaVersion: "workspace-planning-settings.v1",
        revision: 0,
        defaultPlanningMode: "3d",
        permissions: { canWrite: false },
      },
    }));
    expect(markup).toContain("Planungsstandard");
    expect(markup).toContain("Quick");
    expect(markup).toContain("2D");
    expect(markup).toContain("3D");
    expect(markup).toContain("Aktuell");
    expect(markup).toContain("Revision 0");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain("<button");
  });

  it("F301-UI-06: zeigt Admin alle drei Modi mit CAS- und Versionsbindung", () => {
    const markup = renderToStaticMarkup(createElement(PlanningSettingsForm, {
      workspaceId: WORKSPACE_ID,
      settings: {
        schemaVersion: "workspace-planning-settings.v1",
        revision: 4,
        defaultPlanningMode: "2d",
        permissions: { canWrite: true },
      },
    }));
    expect(markup.match(/name="defaultPlanningMode"/gu)).toHaveLength(3);
    expect(markup).toContain('name="baseRevision" value="4"');
    expect(markup).toContain("workspace-planning-settings-command.v1");
    expect(markup).toMatch(/checked="" value="2d"/u);
    expect(markup).toContain("Bestehende Varianten bleiben unverändert");
  });

  it("F301-UI-07: bindet die geschützte Route und den Einstellungen-Link", async () => {
    const route = await readFile(resolve(
      process.cwd(),
      "app/w/[workspaceId]/einstellungen/planung/page.tsx",
    ), "utf8");
    const economics = await readFile(resolve(
      process.cwd(),
      "app/w/[workspaceId]/einstellungen/wirtschaftlichkeit/page.tsx",
    ), "utf8");
    expect(route).toContain('"planning.settings.read"');
    expect(route).toContain("getPlanningSettings(tx, ctx)");
    expect(route).toContain("<PlanningSettingsForm");
    expect(economics).toContain("/einstellungen/planung");
  });
});
