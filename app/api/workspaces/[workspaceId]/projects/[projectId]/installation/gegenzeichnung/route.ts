import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  HANDOVER_COUNTERSIGN_MAX_BYTES,
  InstallationNotFoundError,
  InstallationValidationError,
  readHandoverCountersignature,
  recordHandoverCountersignature,
} from "@/modules/installations";

// F7-07B Handover-Gegenzeichnung: Unterschrift-Upload (POST) und Lesen
// (GET) als Route statt Server-Action, weil Uploads bis 10 MiB gehen
// und das globale 1-MB-Action-Limit unangetastet bleibt (F10-04-/
// F7-02G-Praezedenz). Session-Route (intern): installation.write fuers
// Gegenzeichnen, installation.read fuers Lesen (Viewer sieht Name
// und Vorschau). Fehler sind uniform (kein Key-Leak).
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
  const nameValue = form.get("byName");
  const file = form.get("datei");
  if (
    typeof nameValue !== "string"
    || nameValue.trim() === ""
    || !(file instanceof File)
    || file.size === 0
    || file.size > HANDOVER_COUNTERSIGN_MAX_BYTES
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
      "installation.write",
      "installation",
      (tx, ctx) => recordHandoverCountersignature(tx, ctx, {
        projectId,
        byName: nameValue,
        bytes: new Uint8Array(bytes),
        filename: file.name,
        contentType: file.type,
      }),
    );
    return NextResponse.json({
      byName: result.handoverCustomerName,
      signedAt: result.handoverCustomerSignedAt,
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
    console.error("[installation] gegenzeichnung POST: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<Response> {
  const { workspaceId, projectId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success) return invalid();
  if (!uuidSchema.safeParse(projectId).success) return invalid();
  try {
    const signature = await authorizedQuery(
      workspaceId,
      "installation.read",
      "installation",
      (tx, ctx) => readHandoverCountersignature(tx, ctx, { projectId }),
    );
    return new Response(new Uint8Array(signature.body), {
      headers: {
        "content-type": signature.contentType,
        "cache-control": "private, max-age=60",
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
    console.error("[installation] gegenzeichnung GET: unerwarteter Fehler", error);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}
