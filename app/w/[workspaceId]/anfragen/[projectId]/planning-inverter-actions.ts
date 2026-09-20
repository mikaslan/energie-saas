// F3-05a Wechselrichter-Registry: eigene Server-Action (WR anlegen).
// Muster: planning-panel-group-actions.ts (Gates, Scope-Checks,
// Revalidate) — Rechte project.read/write, KEINE neuen Permission-Keys
// (F3-BATCH-1-Vertrag). Validierung ueber den Stringplan-Contract,
// DB-CHECKs als zweite Linie.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_STRING_VERSION,
  planningInverterCreateV1Schema,
} from "@/lib/integrations/planning/contracts/string-plan";
import {
  toPlanningInverterDto,
  type PlanningInverterDto,
  type PlanningInverterRow,
} from "./planning-inverter-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Wechselrichter gespeichert.";
const LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const TRACKERS_MESSAGE = "Die Tracker-Zahl muss eine ganze Zahl von 1–12 sein.";

export type PlanningInverterActionState =
  | { status: "idle" }
  | { status: "success"; message: string; inverter: PlanningInverterDto | null }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningInverterNotFoundError extends Error {
  constructor() {
    super("planning inverter scope not found");
    this.name = "PlanningInverterNotFoundError";
  }
}

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function parseInteger(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function postgresErrorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function mapError(error: unknown): PlanningInverterActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningInverterNotFoundError) return { status: "not_found" };
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: TRACKERS_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

// WR anlegen: Contract-Gates (Label/Tracker) → Scope (Projekt im
// Workspace) → Insert (ohne Advisory-Max-Länge, UI-Stufe-0).
export async function savePlanningInverterAction(
  _previous: PlanningInverterActionState,
  formData: FormData,
): Promise<PlanningInverterActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: TRACKERS_MESSAGE };
  const createCheck = planningInverterCreateV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_VERSION,
    label: formData.get("label"),
    mppTrackers: parseInteger(formData.get("mppTrackers")),
  });
  if (!createCheck.success) {
    const paths = createCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("label")) return { status: "invalid", message: LABEL_MESSAGE };
    return { status: "invalid", message: TRACKERS_MESSAGE };
  }
  const validated = createCheck.data;

  try {
    const row = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_inverter",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_inverter",
            ids.projectId,
            ctx.actor,
          );
        }
        const scope = await tx.execute<{ id: string }>(sql`
          select id from project
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${ids.projectId}::uuid
           limit 1
        `);
        if (!scope.rows[0]) throw new PlanningInverterNotFoundError();
        const inserted = await tx.execute<PlanningInverterRow>(sql`
          insert into planning_inverter (
            workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${ids.projectId}::uuid,
            ${validated.label},
            ${validated.mppTrackers},
            null,
            ${ctx.actor}::uuid
          )
          returning id, project_id, label, mpp_trackers, max_string_modules, created_at
        `);
        const created = inserted.rows[0];
        if (!created) throw new PlanningInverterNotFoundError();
        return created;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: SAVED_MESSAGE, inverter: toPlanningInverterDto(row) };
  } catch (error) {
    return mapError(error);
  }
}
