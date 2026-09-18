import { NextResponse } from "next/server";
import { z } from "zod";
import { publicTokenCapsule } from "@/lib/action";
import {
  parsePortalLang,
  PORTAL_LANG_COOKIE,
  PORTAL_LANG_COOKIE_MAX_AGE,
} from "@/lib/integrations/portal/portal-language";
import { PortalNotFoundError } from "@/modules/portal";
import { SIGNATURE_PNG_MAX_BYTES } from "@/lib/integrations/offers/signature-contract";
import {
  revokeSignatureByInviteToken,
  SignatureConflictError,
  SignatureNotFoundError,
  SignatureValidationError,
  signSignatureByInviteToken,
  signSignatureDrawByInviteToken,
} from "@/modules/signatures";

// F10-02c Portal-Signatur schreiben (dritter anonymer Schreibpfad des
// Portals): Annehmen (Klick-Modus) und Kunden-Widerruf je freigegebener
// Ausstellungsfassung. Route statt Server-Action (Muster F10-04-Upload,
// ohne-JS-fähig). Autorisierung ist allein das hoch-entropische
// Portal-Token (F10.1-Kapsel, kein Session-Kontext); das Signatur-Token
// verlässt nie den Server. Ergebnis per ?sign= / ?revoke= (beobachtbar
// ohne JS). Fremd/abgelaufen/falscher Stand fällt uniform auf „fehler"
// (kein Orakel über Existenz oder Stand).
const uuidSchema = z.uuid();

type Outcome = "ok" | "bereits" | "fehler";

async function signOutcome(
  token: string,
  form: FormData | null,
): Promise<Outcome> {
  if (!form) return "fehler";
  const issuance = form.get("issuanceId");
  if (typeof issuance !== "string" || !uuidSchema.safeParse(issuance).success) return "fehler";
  try {
    const signed = await publicTokenCapsule((pool) =>
      signSignatureByInviteToken(pool, { token, issuanceId: issuance }),
    );
    return signed.status === "already_signed" ? "bereits" : "ok";
  } catch (error) {
    if (error instanceof SignatureNotFoundError) return "fehler";
    if (error instanceof SignatureValidationError) return "fehler";
    if (error instanceof SignatureConflictError) return "fehler";
    if (error instanceof PortalNotFoundError) return "fehler";
    throw error;
  }
}

async function signDrawOutcome(
  token: string,
  form: FormData | null,
): Promise<Outcome> {
  if (!form) return "fehler";
  const issuance = form.get("issuanceId");
  if (typeof issuance !== "string" || !uuidSchema.safeParse(issuance).success) return "fehler";
  // F2.8 Draw: PNG der gezeichneten Unterschrift als Multipart-Datei.
  // Alles Unsaubere faellt uniform auf "fehler" (kein Orakel).
  const file = form.get("signature");
  if (!(file instanceof File) || file.type !== "image/png") return "fehler";
  if (file.size < 1 || file.size > SIGNATURE_PNG_MAX_BYTES) return "fehler";
  const artifactBytes = Buffer.from(await file.arrayBuffer());
  if (artifactBytes.byteLength !== file.size) return "fehler";
  try {
    const signed = await publicTokenCapsule((pool) =>
      signSignatureDrawByInviteToken(pool, {
        token,
        issuanceId: issuance,
        artifactMimeType: "image/png",
        artifactBytes,
      }),
    );
    return signed.status === "already_signed" ? "bereits" : "ok";
  } catch (error) {
    if (error instanceof SignatureNotFoundError) return "fehler";
    if (error instanceof SignatureValidationError) return "fehler";
    if (error instanceof SignatureConflictError) return "fehler";
    if (error instanceof PortalNotFoundError) return "fehler";
    throw error;
  }
}

async function revokeOutcome(
  token: string,
  form: FormData | null,
): Promise<Outcome> {
  if (!form) return "fehler";
  const issuance = form.get("issuanceId");
  if (typeof issuance !== "string" || !uuidSchema.safeParse(issuance).success) return "fehler";
  try {
    const revoked = await publicTokenCapsule((pool) =>
      revokeSignatureByInviteToken(pool, { token, issuanceId: issuance }),
    );
    return revoked.replayed ? "bereits" : "ok";
  } catch (error) {
    if (error instanceof SignatureNotFoundError) return "fehler";
    if (error instanceof SignatureValidationError) return "fehler";
    if (error instanceof SignatureConflictError) return "fehler";
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
  const action = form?.get("action");
  const outcome = action === "revoke"
    ? await revokeOutcome(token, form)
    : action === "sign"
      ? await signOutcome(token, form)
      : action === "sign_draw"
        ? await signDrawOutcome(token, form)
        : ("fehler" as Outcome);
  const param = action === "revoke" ? "revoke" : "sign";
  // F10-06: Sprache aus dem Formular (Allowlist) in Redirect + Cookie
  // übernehmen, damit Feedback und Folgebesuche sprachstabil sind.
  const lang = parsePortalLang(form?.get("lang"));
  const response = NextResponse.redirect(
    new URL(`/p/${token}?${param}=${outcome}&lang=${lang}`, request.url),
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
