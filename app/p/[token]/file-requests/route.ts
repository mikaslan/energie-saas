import { NextResponse } from "next/server";
import { z } from "zod";
import { publicTokenCapsule } from "@/lib/action";
import {
  parsePortalLang,
  PORTAL_LANG_COOKIE,
  PORTAL_LANG_COOKIE_MAX_AGE,
} from "@/lib/integrations/portal/portal-language";
import {
  FileRequestConflictError,
  FileRequestNotFoundError,
  FileRequestValidationError,
  fulfillFileRequestByToken,
} from "@/modules/file-requests";
import { PortalNotFoundError } from "@/modules/portal";

// F10-04 Datei-Upload (erster anonymer Schreibpfad des Portals):
// Route statt Server-Action, weil Uploads bis 10 MiB gehen und das
// globale 1-MB-Action-Limit unangetastet bleibt. Autorisierung ist
// allein das hoch-entropische Portal-Token (F10.1-Kapsel, kein
// Session-Kontext). Ergebnis per ?upload= (beobachtbar ohne JS).
const uuidSchema = z.uuid();

async function uploadOutcome(
  token: string,
  form: FormData | null,
): Promise<"erfolg" | "ungueltig" | "konflikt" | "fehler"> {
  if (!form) return "ungueltig";
  const requestId = form.get("requestId");
  const file = form.get("datei");
  if (typeof requestId !== "string" || !uuidSchema.safeParse(requestId).success) {
    return "ungueltig";
  }
  if (!(file instanceof File) || file.size === 0) return "ungueltig";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return "ungueltig";
  }
  try {
    await publicTokenCapsule((pool) =>
      fulfillFileRequestByToken(pool, {
        token,
        requestId,
        filename: file.name,
        contentType: file.type,
        bytes,
      }),
    );
    return "erfolg";
  } catch (error) {
    if (error instanceof FileRequestValidationError) return "ungueltig";
    if (error instanceof FileRequestConflictError) return "konflikt";
    if (error instanceof FileRequestNotFoundError) return "fehler";
    if (error instanceof PortalNotFoundError) return "fehler";
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const form = await request.formData().catch(() => null);
  const outcome = await uploadOutcome(token, form);
  // F10-06: Sprache aus dem Formular (Allowlist) in Redirect + Cookie
  // übernehmen, damit Upload-Feedback und Folgebesuche sprachstabil sind.
  const lang = parsePortalLang(form?.get("lang"));
  const response = NextResponse.redirect(
    new URL(`/p/${token}?tab=dateien&upload=${outcome}&lang=${lang}`, request.url),
    // 303 wie redirect(): Der Browser lädt die Zielseite per GET neu;
    // 307 würde den POST (inkl. Datei) erneut senden.
    303,
  );
  response.cookies.set(PORTAL_LANG_COOKIE, lang, {
    path: "/",
    maxAge: PORTAL_LANG_COOKIE_MAX_AGE,
    sameSite: "lax",
    httpOnly: true,
  });
  return response;
}
