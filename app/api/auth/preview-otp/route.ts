import { previewOtpFor } from "@/lib/preview-auth";

export const dynamic = "force-dynamic";

// NUR im lokalen Demo-Betrieb aktiv; liefert den zuletzt versendeten OTP
// für die konfigurierte Demo-Adresse — außerhalb des Preview-Modus 404.
export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get("email");
  if (email === null) {
    return Response.json({ error: "missing email" }, { status: 400 });
  }
  const otp = previewOtpFor(email);
  if (otp === null) {
    return Response.json({ error: "not available" }, { status: 404 });
  }
  return Response.json({ otp });
}
