"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  executeProjectNoteCommand,
  PROJECT_NOTE_COMMAND_VERSION,
} from "@/modules/notes";
import {
  importManualLeadBulk,
  ManualLeadBulkFileError,
  type ManualLeadBulkReport,
} from "@/modules/projects";

const uuidSchema = z.uuid();

/** Reversibles ESTIMATE-Limit: max. CSV-Text pro Import. */
const BULK_CSV_MAX_CHARS = 1_000_000;

const manualLeadBulkFormSchema = z.strictObject({
  workspaceId: uuidSchema,
  mode: z.enum(["dry-run", "import"]),
  defaultScope: z.enum(["residential", "commercial"]),
  csvText: z.string().min(1).max(BULK_CSV_MAX_CHARS),
});

export type ManualLeadBulkActionState =
  | { status: "idle" }
  | { status: "report"; report: ManualLeadBulkReport }
  | { status: "file-error"; code: string; detail?: string }
  | { status: "too-large" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" };

export async function importManualLeadBulkAction(
  workspaceId: string,
  _previousState: ManualLeadBulkActionState,
  formData: FormData,
): Promise<ManualLeadBulkActionState> {
  const rawCsv = formData.get("csvText");
  if (typeof rawCsv === "string" && rawCsv.length > BULK_CSV_MAX_CHARS) {
    return { status: "too-large" };
  }
  const parsed = manualLeadBulkFormSchema.safeParse({
    workspaceId,
    mode: formData.get("mode"),
    defaultScope: formData.get("defaultScope"),
    csvText: typeof rawCsv === "string" ? rawCsv : undefined,
  });
  if (!parsed.success) return { status: "invalid" };
  const input = parsed.data;

  try {
    const report = await authorizedAction(
      input.workspaceId,
      "project.write",
      "manual_lead_bulk",
      (tx, ctx) => importManualLeadBulk(tx, ctx, {
        csvText: input.csvText,
        defaultScope: input.defaultScope,
        dryRun: input.mode === "dry-run",
        // Modulgrenze wie F1-11: Notizen schreibt die Action, der Service
        // prüft nur vor (gleiche Transaktion, fail-open je Zeile).
        writeNote: input.mode === "dry-run"
          ? undefined
          : async (projectId, textMarkdown) => {
            await executeProjectNoteCommand(tx, ctx, {
              schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
              kind: "create_note",
              projectId,
              textMarkdown,
              pinned: false,
            });
          },
      }),
    );
    if (input.mode === "import") revalidatePath(`/w/${input.workspaceId}/anfragen`);
    return { status: "report", report };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof ManualLeadBulkFileError) {
      return { status: "file-error", code: error.code, detail: error.detail };
    }
    throw error;
  }
}
