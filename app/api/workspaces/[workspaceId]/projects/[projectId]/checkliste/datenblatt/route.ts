import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  InstallationNotFoundError,
  InstallationValidationError,
  readWorkbookDatasheet,
} from "@/modules/installations";
import { OfferIntegrityError } from "@/modules/offers";

// F7-02K2 Datenblatt-Download: Session-Route (intern) im Foto-Pfad-Muster
// (Params uuid, ?componentId=, checklist.read) × Dateien-Header-Muster
// (attachment, no-store). Die Op gatet zusaetzlich installation.read
// (keine Bytes ohne sichtbare Refs). Fehler uniform, ohne Key-Leak.
const uuidSchema = z.uuid();

type RouteParams = { workspaceId: string; projectId: string };

function invalid(): NextResponse {
  return NextResponse.json({ error: "invalid" }, { status: 400 });
}

// RFC-5987 (Dateien-Praezedenz): ASCII-Fallback plus kodierter Originalname.
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/["\\\r\n]/g, "_").slice(0, 100) || "datei";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<Response> {
  const { workspaceId, projectId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success) return invalid();
  if (!uuidSchema.safeParse(projectId).success) return invalid();
  const url = new URL(request.url);
  const componentId = url.searchParams.get("componentId");
  if (componentId === null || !uuidSchema.safeParse(componentId).success) {
    return invalid();
  }
  try {
    const file = await authorizedQuery(
      workspaceId,
      "checklist.read",
      "project_checklist",
      (tx, ctx) => readWorkbookDatasheet(tx, ctx, { projectId, componentId }),
    );
    return new Response(new Uint8Array(file.body), {
      headers: {
        // Hart gepinnt (nie Snapshot-Echo, MIME-Pin der Op).
        "content-type": "application/pdf",
        "content-length": String(file.body.byteLength),
        "content-disposition": contentDisposition(file.filename),
        // Bindungswechsel = gleiche URL, andere Bytes (Dateien-Muster).
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof InstallationValidationError) return invalid();
    if (error instanceof InstallationNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof PermissionDeniedError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (error instanceof OfferIntegrityError) {
      console.error("[checkliste] datenblatt GET: Integritaetsfehler");
      return NextResponse.json({ error: "error" }, { status: 500 });
    }
    console.error("[checkliste] datenblatt GET: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}
