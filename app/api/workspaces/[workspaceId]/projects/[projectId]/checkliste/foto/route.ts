import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { CHECKLIST_ITEM_PHOTOS_MAX } from "@/lib/integrations/checklists/contract";
import {
  CHECKLIST_PHOTO_MAX_BYTES,
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
    || file.size > CHECKLIST_PHOTO_MAX_BYTES
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
  // F7-15: optionaler Galerie-Index (Default 0); Ziffern unter dem
  // Galerie-Maximum, sonst invalid (nie adressierbar = 400, OOB = 404).
  const indexRaw = url.searchParams.get("index");
  let index = 0;
  if (indexRaw !== null) {
    if (!/^[0-9]+$/.test(indexRaw)) return invalid();
    index = Number(indexRaw);
    if (!Number.isSafeInteger(index) || index >= CHECKLIST_ITEM_PHOTOS_MAX) return invalid();
  }
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
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, { projectId, checklistId, itemId, index }),
    );
    return new Response(new Uint8Array(photo.body), {
      headers: {
        "content-type": photo.contentType,
        // F7-15: no-store — index-adressierte Galerie-URLs aendern ihre
        // Bytes bei jedem Tree-Write (Version/Remove/Reorder); max-age
        // wuerde nach Reload/Back-Navigation veraltete Vorgaenger-Bytes
        // liefern (E-03-Befund: Foto 1 zeigte Cover-v1 statt Rot-v2).
        "cache-control": "no-store",
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
