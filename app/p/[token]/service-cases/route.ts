import { NextResponse } from "next/server";
import { z } from "zod";
import { publicTokenCapsule } from "@/lib/action";
import {
  parsePortalLang,
  PORTAL_LANG_COOKIE,
  PORTAL_LANG_COOKIE_MAX_AGE,
} from "@/lib/integrations/portal/portal-language";
import {
  confirmServiceCaseByToken,
  ServiceCaseNotFoundError,
  ServiceCaseValidationError,
} from "@/modules/service-cases";
import { PortalNotFoundError } from "@/modules/portal";

// F13-06 Kundenbestätigung (zweiter anonymer Schreibpfad des Portals):
// Route statt Server-Action (Muster F10-04-Upload, ohne-JS-fähig).
// Autorisierung ist allein das hoch-entropische Portal-Token
// (F10.1-Kapsel, kein Session-Kontext). Ergebnis per ?confirm=
// (beobachtbar ohne JS). Fremd/nicht-erledigt fällt uniform auf
// „fehler" (kein Orakel über Existenz oder Stand).
const uuidSchema = z.uuid();

async function confirmOutcome(
  token: string,
  form: FormData | null,
): Promise<"ok" | "bereits" | "fehler"> {
  if (!form) return "fehler";
  const caseId = form.get("caseId");
  if (typeof caseId !== "string" || !uuidSchema.safeParse(caseId).success) {
    return "fehler";
  }
  try {
    const confirmed = await publicTokenCapsule((pool) =>
      confirmServiceCaseByToken(pool, { token, caseId }),
    );
    return confirmed.outcome === "ok" ? "ok" : "bereits";
  } catch (error) {
    if (error instanceof ServiceCaseValidationError) return "fehler";
    if (error instanceof ServiceCaseNotFoundError) return "fehler";
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
  const outcome = await confirmOutcome(token, form);
  // F10-06: Sprache aus dem Formular (Allowlist) in Redirect + Cookie
  // übernehmen, damit Bestätigungs-Feedback und Folgebesuche sprachstabil sind.
  const lang = parsePortalLang(form?.get("lang"));
  const response = NextResponse.redirect(
    new URL(`/p/${token}?confirm=${outcome}&lang=${lang}`, request.url),
    // 303 wie redirect(): Der Browser lädt die Zielseite per GET neu;
    // 307 würde den POST erneut senden.
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
