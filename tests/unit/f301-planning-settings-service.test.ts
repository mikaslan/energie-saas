import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import {
  PLANNING_MODE_DEFAULT,
  PLANNING_MODE_DEFAULT_LOCK_VERSION,
  WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/planning/contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  PlanningSettingsConflictError,
  PlanningSettingsIntegrityError,
  PlanningSettingsValidationError,
  getPlanningModeDefaultForVariantCreation,
  getPlanningSettings,
  upsertPlanningSettings,
} from "@/modules/planning";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000002";

type ExecuteResponse = { rows: unknown[] } | Error;
type InsertValue = Record<string, unknown>;

function context(
  role: ServiceCtx["role"] = "admin",
  capabilities: ServiceCtx["capabilities"] = {},
): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities,
    featureFlags: {},
  };
}

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const inserts: InsertValue[] = [];
  const execute = vi.fn(async () => {
    const response = responses[index++] ?? { rows: [] };
    if (response instanceof Error) throw response;
    return response;
  });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: InsertValue) => { inserts.push(entry); },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function command(baseRevision: number, defaultPlanningMode: "quick" | "2d" | "3d") {
  return {
    schemaVersion: WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    defaultPlanningMode,
  };
}

function stored(revision: number, defaultPlanningMode: "quick" | "2d" | "3d") {
  return {
    revision,
    default_planning_mode: defaultPlanningMode,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("F3.1 Workspace-Planungsstandard — Service", () => {
  it("F301-SVC-01: liefert ohne Zeile 3D/Revision 0 und bildet Schreibrecht serverseitig ab", async () => {
    const viewer = transaction([{ rows: [] }]);
    await expect(getPlanningSettings(viewer.tx, context("viewer"))).resolves.toEqual({
      schemaVersion: "workspace-planning-settings.v1",
      revision: 0,
      defaultPlanningMode: PLANNING_MODE_DEFAULT,
      permissions: { canWrite: false },
    });

    const admin = transaction([{ rows: [] }]);
    await expect(getPlanningSettings(admin.tx, context("admin"))).resolves.toMatchObject({
      revision: 0,
      defaultPlanningMode: "3d",
      permissions: { canWrite: true },
    });
  });

  it("F301-SVC-02: sperrt und liest den commit-gültigen Default für Variantenerzeugung", async () => {
    const empty = transaction([{ rows: [] }, { rows: [] }]);
    await expect(getPlanningModeDefaultForVariantCreation(
      empty.tx,
      context("editor"),
    )).resolves.toBe("3d");
    expect(empty.execute).toHaveBeenCalledTimes(2);
    const emptySql = JSON.stringify(empty.execute.mock.calls);
    expect(emptySql).toContain("pg_advisory_xact_lock");
    expect(emptySql).toContain("hashtextextended");
    expect(emptySql).toContain(PLANNING_MODE_DEFAULT_LOCK_VERSION);
    expect(emptySql.indexOf("pg_advisory_xact_lock"))
      .toBeLessThan(emptySql.indexOf("workspace_planning_settings"));

    const configured = transaction([
      { rows: [] },
      { rows: [stored(4, "2d")] },
    ]);
    await expect(getPlanningModeDefaultForVariantCreation(
      configured.tx,
      context("editor"),
    )).resolves.toBe("2d");
  });

  it("F301-SVC-03: erstellt Revision 1 unter Lock und schreibt Event/Audit ohne Zusatzdaten", async () => {
    const harness = transaction([
      { rows: [] },
      { rows: [] },
      { rows: [stored(1, "2d")] },
    ]);
    await expect(upsertPlanningSettings(
      harness.tx,
      context(),
      command(0, "2d"),
    )).resolves.toEqual({
      schemaVersion: "workspace-planning-settings.v1",
      revision: 1,
      defaultPlanningMode: "2d",
      permissions: { canWrite: true },
    });

    expect(harness.execute).toHaveBeenCalledTimes(3);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("pg_advisory_xact_lock");
    expect(sqlCalls).toContain("insert into workspace_planning_settings");
    expect(harness.inserts).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        aggregateType: "workspace_planning_settings",
        aggregateId: WORKSPACE_ID,
        eventType: "workspace_planning_settings.upserted",
        actor: ACTOR_ID,
        payload: { defaultPlanningMode: "2d", revision: 1 },
      }),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actor: ACTOR_ID,
        action: "settings.manage",
        resource: "workspace_planning_settings",
        allowed: true,
        details: { baseRevision: 0, defaultPlanningMode: "2d", revision: 1 },
      }),
    ]);
  });

  it("F301-SVC-04: aktualisiert ausschließlich per CAS und meldet den aktuellen Stand", async () => {
    const updated = transaction([
      { rows: [] },
      { rows: [{ revision: 2 }] },
      { rows: [stored(2, "quick")] },
    ]);
    await expect(upsertPlanningSettings(
      updated.tx,
      context(),
      command(1, "quick"),
    )).resolves.toMatchObject({ revision: 2, defaultPlanningMode: "quick" });
    expect(JSON.stringify(updated.execute.mock.calls)).toContain("and revision =");

    const stale = transaction([
      { rows: [] },
      { rows: [] },
      { rows: [stored(7, "3d")] },
    ]);
    await expect(upsertPlanningSettings(
      stale.tx,
      context(),
      command(2, "2d"),
    )).rejects.toMatchObject({
      name: "PlanningSettingsConflictError",
      currentRevision: 7,
    });
    expect(stale.inserts).toEqual([]);
  });

  it("F301-SVC-05: mappt konkurrierenden Erst-Insert auf Conflict", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
    const harness = transaction([{ rows: [] }, duplicate]);
    await expect(upsertPlanningSettings(
      harness.tx,
      context(),
      command(0, "quick"),
    )).rejects.toBeInstanceOf(PlanningSettingsConflictError);
    expect(harness.inserts).toEqual([]);
  });

  it("F301-SVC-06: verweigert External/Viewer und invaliden Input vor fachlichem SQL", async () => {
    const external = transaction([]);
    await expect(getPlanningSettings(
      external.tx,
      context("viewer", { external_only: true }),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "planning.settings.read",
    });
    await expect(getPlanningModeDefaultForVariantCreation(
      external.tx,
      context("viewer", { external_only: true }),
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });

    const viewer = transaction([]);
    await expect(upsertPlanningSettings(
      viewer.tx,
      context("viewer"),
      command(0, "3d"),
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "settings.manage" });

    const invalid = transaction([]);
    await expect(upsertPlanningSettings(
      invalid.tx,
      context(),
      { ...command(0, "3d"), attackerField: true } as never,
    )).rejects.toBeInstanceOf(PlanningSettingsValidationError);

    expect(external.execute).not.toHaveBeenCalled();
    expect(viewer.execute).not.toHaveBeenCalled();
    expect(invalid.execute).not.toHaveBeenCalled();
  });

  it("F301-SVC-07: bricht bei ungültigen gespeicherten Modi fail-closed ab", async () => {
    const read = transaction([{ rows: [{
      revision: 1,
      default_planning_mode: "private-mode",
    }] }]);
    await expect(getPlanningSettings(read.tx, context("viewer")))
      .rejects.toBeInstanceOf(PlanningSettingsIntegrityError);

    const defaultRead = transaction([
      { rows: [] },
      { rows: [{ revision: 1, default_planning_mode: "private-mode" }] },
    ]);
    await expect(getPlanningModeDefaultForVariantCreation(
      defaultRead.tx,
      context("editor"),
    )).rejects.toBeInstanceOf(PlanningSettingsIntegrityError);
  });
});
