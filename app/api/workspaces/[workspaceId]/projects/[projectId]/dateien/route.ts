import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  downloadProjectFile,
  PROJECT_FILE_MAX_BYTES,
  ProjectFileNotFoundError,
  ProjectFileValidationError,
  uploadProjectFile,
} from "@/modules/project-files";

// F7-16 Projekt-Dateien: interner Upload (POST) und Download (GET) als
// Route statt Server-Action, weil Uploads bis 25 MiB gehen und das
// globale 1-MB-Action-Limit unangetastet bleibt (F10-04-Praezedenz).
// Session-Route (intern): project.write fuers Hochladen, project.read
// fuers Lesen (interner Viewer liest; Externe scheitern am Service-Gate).
// Fehler sind uniform (kein Key-Leak). GET liefert Downloads
// (attachment, kein Inline wie foto-GET).
const uuidSchema = z.uuid();

type RouteParams = { workspaceId: string; projectId: string };

function invalid(): NextResponse {
  return NextResponse.json({ error: "invalid" }, { status: 400 });
}

// RFC-5987 (Angebots-PDF-Praezedenz): ASCII-Fallback ohne Header-
// Sonderzeichen plus kodierter Originalname.
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/["\\\r\n]/g, "_").slice(0, 100) || "datei";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
  const file = form.get("datei");
  if (
    !(file instanceof File)
    || file.size === 0
    || file.size > PROJECT_FILE_MAX_BYTES
  ) {
    return invalid();
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return invalid();
  }
  try {
    const result = await authorizedAction(
      workspaceId,
      "project.write",
      "project_file",
      (tx, ctx) => uploadProjectFile(tx, ctx, {
        projectId,
        bytes: new Uint8Array(bytes),
        filename: file.name,
        contentType: file.type,
      }),
    );
    return NextResponse.json({ fileId: result.fileId });
  } catch (error) {
    if (error instanceof ProjectFileValidationError) return invalid();
    if (error instanceof ProjectFileNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("[projekt-dateien] POST: unerwarteter Fehler", error);
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
  const fileId = url.searchParams.get("fileId");
  if (fileId === null || !uuidSchema.safeParse(fileId).success) {
    return invalid();
  }
  try {
    const file = await authorizedQuery(
      workspaceId,
      "project.read",
      "project_file",
      (tx, ctx) => downloadProjectFile(tx, ctx, { projectId, fileId }),
    );
    return new Response(new Uint8Array(file.body), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.body.byteLength),
        "content-disposition": contentDisposition(file.filename),
        // F10-07-Praezedenz: private Downloads ohne Cache.
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ProjectFileValidationError) return invalid();
    if (error instanceof ProjectFileNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("[projekt-dateien] GET: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}
