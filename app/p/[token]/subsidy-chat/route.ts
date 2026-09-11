import { NextResponse } from "next/server";
import { publicTokenCapsule } from "@/lib/action";
import {
  parsePortalLang,
  PORTAL_LANG_COOKIE,
  PORTAL_LANG_COOKIE_MAX_AGE,
} from "@/lib/integrations/portal/portal-language";
import {
  postSubsidyMessageByToken,
  SubsidyCaseNotFoundError,
  SubsidyCaseValidationError,
} from "@/modules/subsidy-cases";
import { PortalNotFoundError } from "@/modules/portal";

// F13-10 Chat-Antwort des Kunden (dritter anonymer Schreibpfad des
// Portals): Route statt Server-Action (Muster F13-06-Bestätigung,
// ohne-JS-fähig). Autorisierung ist allein das hoch-entropische
// Portal-Token (F10.1-Kapsel, kein Session-Kontext); die Akte kennt der
// Client nie (Kapsel löst die eine Projekt-Akte auf). Ergebnis per
// ?chat= (beobachtbar ohne JS). Fremd/entzogen/ungültig fällt uniform
// auf „fehler" (kein Orakel über Existenz oder Stand).
async function chatOutcome(
  token: string,
  form: FormData | null,
): Promise<"ok" | "fehler"> {
  if (!form) return "fehler";
  const body = form.get("body");
  if (typeof body !== "string") return "fehler";
  try {
    const posted = await publicTokenCapsule((pool) =>
      postSubsidyMessageByToken(pool, { token, caseId: null, body }),
    );
    return posted.outcome === "ok" ? "ok" : "fehler";
  } catch (error) {
    if (error instanceof SubsidyCaseValidationError) return "fehler";
    if (error instanceof SubsidyCaseNotFoundError) return "fehler";
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
  const outcome = await chatOutcome(token, form);
  // F10-06: Sprache aus dem Formular (Allowlist) in Redirect + Cookie
  // übernehmen, damit Chat-Feedback und Folgebesuche sprachstabil sind.
  const lang = parsePortalLang(form?.get("lang"));
  const response = NextResponse.redirect(
    new URL(`/p/${token}?chat=${outcome}&lang=${lang}`, request.url),
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
