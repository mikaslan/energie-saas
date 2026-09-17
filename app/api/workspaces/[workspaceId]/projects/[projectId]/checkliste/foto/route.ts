import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ChecklistNotFoundError,
  ChecklistValidationError,
  readChecklistItemPhoto,
  uploadChecklistItemPhoto,
} from "@/modules/checklists";

// F7-02G Bild-Punkt: Foto-Upload (POST) und Foto-Lesen (GET) als Route
// statt Server-Action, weil Uploads bis 10 MiB gehen und das globale
// 1-MB-Action-Limit unangetastet bleibt (F10-04-Praezedenz). Session-
// Route (intern): checklist.write fuers Hochladen, checklist.read fuers
// Lesen (Viewer sieht Fotos). Fehler sind uniform (kein Key-Leak).
const uuidSchema = z.uuid();

type RouteParams = { workspaceId: string; projectId: string };

function invalid(): NextResponse {
  return NextResponse.json({ error: "invalid" }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  const { workspaceId, projectId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success) return invalid();
  if (!uuidSchema.safeParse(projectId).success) return invalid();
  const form = await request.formData().catch(() => null);
  if (!form) return invalid();
  const checklistValue = form.get("checklistId");
  const itemValue = form.get("itemId");
  const file = form.get("datei");
  if (
    (typeof checklistValue !== "string" && checklistValue !== null)
    || (typeof checklistValue === "string" && checklistValue !== ""
      && !uuidSchema.safeParse(checklistValue).success)
    || typeof itemValue !== "string"
    || !uuidSchema.safeParse(itemValue).success
    || !(file instanceof File)
    || file.size === 0
  ) {
    return invalid();
  }
  const checklistId = typeof checklistValue === "string" && checklistValue !== ""
    ? checklistValue
    : null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return invalid();
  }
  try {
    const result = await authorizedAction(
      workspaceId,
      "checklist.write",
      "project_checklist",
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId,
        checklistId,
        itemId: itemValue,
        bytes: new Uint8Array(bytes),
        filename: file.name,
        contentType: file.type,
      }),
    );
    return NextResponse.json({ photoKey: result.photoKey });
  } catch (error) {
    if (error instanceof ChecklistValidationError) return invalid();
    if (error instanceof ChecklistNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("[checkliste] foto POST: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<Response> {
  const { workspaceId, projectId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success) return invalid();
  if (!uuidSchema.safeParse(projectId).success) return invalid();
  const url = new URL(request.url);
  const checklistId = url.searchParams.get("checklistId");
  const itemId = url.searchParams.get("itemId");
  if (
    checklistId === null
    || !uuidSchema.safeParse(checklistId).success
    || itemId === null
    || !uuidSchema.safeParse(itemId).success
  ) {
    return invalid();
  }
  try {
    const photo = await authorizedQuery(
      workspaceId,
      "checklist.read",
      "project_checklist",
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, { projectId, checklistId, itemId }),
    );
    return new Response(new Uint8Array(photo.body), {
      headers: {
        "content-type": photo.contentType,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ChecklistValidationError) return invalid();
    if (error instanceof ChecklistNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("[checkliste] foto GET: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}
