// F3-02 Dachquellen-Registry: eigene Server-Actions (Upload mit
// Referenzlinie + Selbstzeichnen-Anlage). Muster: file-request-actions
// (Gates, WORM-Put, Idempotenz) — Rechte project.read/write, KEINE neuen
// Permission-Keys (F3-BATCH-1-vertrag).
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { immutableKey, resolveObjectStorage, sha256Hex } from "@/lib/storage";
import {
  toPlanningSourceDto,
  type PlanningSourceDto,
  type PlanningSourceRow,
} from "./planning-source-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

// Upload-Gates (F3-02-Spec, file-requests-Muster): 10 MiB, JPEG/PNG,
// scaleRef-Pflicht (Meter und Pixel > 0) — serverseitig, Fail-closed.
const MAX_BYTES = 10_485_760;
const ALLOWED_CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

const SAVED_MESSAGE = "Dachquelle gespeichert.";
const EXISTS_MESSAGE = "Dachquelle bereits vorhanden.";
const SELF_DRAWN_MESSAGE = "Selbstzeichnung angelegt.";
const TYPE_MESSAGE = "Nur JPEG- oder PNG-Bilder sind zulässig.";
const SIZE_MESSAGE = "Die Datei ist zu groß (max. 10 MiB).";
const SCALE_MESSAGE = "Bitte eine gültige Referenzlinie angeben (Meter und Pixel > 0).";
const MISSING_FILE_MESSAGE = "Bitte eine Bilddatei für die Dachquelle wählen.";

export type PlanningSourceActionState =
  | { status: "idle" }
  | { status: "success"; message: string; source: PlanningSourceDto | null }
  | { status: "exists"; message: string }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningSourceNotFoundError extends Error {
  constructor() {
    super("planning source scope not found");
    this.name = "PlanningSourceNotFoundError";
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

function sanitizeStem(name: string): string {
  const stem = name.split(".").slice(0, -1).join(".") || name;
  const clean = stem.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 80);
  return clean.length > 0 ? clean : "datei";
}

function parseScale(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function mapError(error: unknown): PlanningSourceActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningSourceNotFoundError) return { status: "not_found" };
  throw error;
}

// Upload mit Referenzlinie: Gates → WORM-Put (immutableKey +
// putImmutable, einziger Key-Weg) → Insert mit (project_id, sha256)-
// Idempotenz. Gleicher Inhalt erneut → EXISTS, kein Duplikat.
export async function uploadPlanningSourceAction(
  _previous: PlanningSourceActionState,
  formData: FormData,
): Promise<PlanningSourceActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: SCALE_MESSAGE };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "invalid", message: MISSING_FILE_MESSAGE };
  }
  const contentType = file.type.toLowerCase();
  const extension = (ALLOWED_CONTENT_TYPES as Record<string, string>)[contentType];
  if (!extension) return { status: "invalid", message: TYPE_MESSAGE };
  if (file.size > MAX_BYTES) return { status: "invalid", message: SIZE_MESSAGE };
  const meters = parseScale(formData.get("scaleMeters"));
  const pixelLength = parseScale(formData.get("scalePixels"));
  if (meters === null || pixelLength === null) {
    return { status: "invalid", message: SCALE_MESSAGE };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return { status: "invalid", message: MISSING_FILE_MESSAGE };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    return { status: "invalid", message: SIZE_MESSAGE };
  }
  const digest = sha256Hex(bytes);
  const storageKey = immutableKey(
    ids.workspaceId,
    "planning-sources",
    `${sanitizeStem(file.name)}_${digest.slice(0, 8)}.${extension}`,
  );
  const scaleRefJson = JSON.stringify({ meters, pixelLength });
  try {
    const outcome = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_source",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError("project.write", "planning_source", ids.projectId, ctx.actor);
        }
        const scope = await tx.execute<{ id: string }>(sql`
          select id from project
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${ids.projectId}::uuid
           limit 1
        `);
        if (!scope.rows[0]) throw new PlanningSourceNotFoundError();
        // WORM-Put zuerst (file-requests-Muster): existiert der Key, klaert
        // der DB-Befund, ob es ein Duplikat ist — backend-neutral, ohne
        // Fehlermeldungs-Vergleich.
        try {
          const stored = await resolveObjectStorage().putImmutable(
            storageKey,
            bytes,
            contentType,
          );
          if (stored.sha256 !== digest) throw new PlanningSourceNotFoundError();
        } catch (error) {
          const probe = await tx.execute<PlanningSourceRow>(sql`
            select id, kind, storage_key, scale_ref_json, created_at
              from planning_source
             where workspace_id = ${ctx.workspaceId}::uuid
               and project_id = ${ids.projectId}::uuid
               and sha256 = ${digest}
             limit 1
          `);
          if (probe.rows[0]) return { duplicate: true as const, row: probe.rows[0] };
          throw error;
        }
        const inserted = await tx.execute<PlanningSourceRow>(sql`
          insert into planning_source (
            workspace_id, project_id, kind, storage_key, sha256, byte_size, scale_ref_json, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${ids.projectId}::uuid,
            'upload',
            ${storageKey},
            ${digest},
            ${bytes.byteLength},
            ${scaleRefJson}::jsonb,
            ${ctx.actor}::uuid
          )
          on conflict (project_id, sha256) do nothing
          returning id, kind, storage_key, scale_ref_json, created_at
        `);
        const created = inserted.rows[0];
        if (created) return { duplicate: false as const, row: created };
        const existing = await tx.execute<PlanningSourceRow>(sql`
          select id, kind, storage_key, scale_ref_json, created_at
            from planning_source
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${ids.projectId}::uuid
             and sha256 = ${digest}
           limit 1
        `);
        const row = existing.rows[0];
        if (!row) throw new PlanningSourceNotFoundError();
        return { duplicate: true as const, row };
      },
    );
    if (outcome.duplicate) return { status: "exists", message: EXISTS_MESSAGE };
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: SAVED_MESSAGE,
      source: toPlanningSourceDto(outcome.row),
    };
  } catch (error) {
    return mapError(error);
  }
}

// Selbstzeichnen-Anlage: DB-Zeile ohne Storage/Skala (CHECK-konform),
// sofort in der Liste sichtbar.
export async function createSelfDrawnSourceAction(
  _previous: PlanningSourceActionState,
  formData: FormData,
): Promise<PlanningSourceActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: SCALE_MESSAGE };
  try {
    const row = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_source",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError("project.write", "planning_source", ids.projectId, ctx.actor);
        }
        const scope = await tx.execute<{ id: string }>(sql`
          select id from project
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${ids.projectId}::uuid
           limit 1
        `);
        if (!scope.rows[0]) throw new PlanningSourceNotFoundError();
        const inserted = await tx.execute<PlanningSourceRow>(sql`
          insert into planning_source (workspace_id, project_id, kind, created_by)
          values (
            ${ctx.workspaceId}::uuid,
            ${ids.projectId}::uuid,
            'self_drawn',
            ${ctx.actor}::uuid
          )
          returning id, kind, storage_key, scale_ref_json, created_at
        `);
        const created = inserted.rows[0];
        if (!created) throw new PlanningSourceNotFoundError();
        return created;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: SELF_DRAWN_MESSAGE, source: toPlanningSourceDto(row) };
  } catch (error) {
    return mapError(error);
  }
}
