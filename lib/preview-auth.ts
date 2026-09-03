// Hinweis: KEIN "server-only"-Import — auth.ts wird auch von Build-/Unit-
// Tests ohne server-only-Mock importiert; die Aktivierung ist rein env-basiert.
// ═══════════════════════════════════════════════════════════════════════
// NUR lokaler Demo-/Preview-Betrieb (ENERGIE_SAAS_LOCAL_PREVIEW=1):
// fängt den Klartext-OTP aus dem emailOTP-Sendecallback ab, damit der
// Login ohne E-Mail-Postfach funktioniert. In Produktion ist jede dieser
// Funktionen inaktiv — kein Credential-Leak außerhalb des Demo-Modus.
// ═══════════════════════════════════════════════════════════════════════

const previewOtps = new Map<string, string>();

export function isLocalPreview(): boolean {
  return process.env.ENERGIE_SAAS_LOCAL_PREVIEW === "1";
}

export function capturePreviewOtp(email: string, otp: string): void {
  if (!isLocalPreview()) return;
  previewOtps.set(email.trim().toLowerCase(), otp);
}

// Liefert den letzten OTP NUR für die fest konfigurierte Demo-Adresse
// (DEMO_LOGIN_EMAIL) — beliebige E-Mails bleiben ohne Antwort.
export function previewOtpFor(email: string): string | null {
  if (!isLocalPreview()) return null;
  const demoEmail = process.env.DEMO_LOGIN_EMAIL;
  if (!demoEmail) return null;
  const normalized = email.trim().toLowerCase();
  if (normalized !== demoEmail.toLowerCase()) return null;
  return previewOtps.get(normalized) ?? null;
}
