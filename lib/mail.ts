import { Resend } from "resend";

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #20: ohne RESEND_API_KEY protokollierte diese Funktion auch in
// PRODUKTION vollständige Magic Links bzw. OTPs — und meldete better-auth
// anschließend einen erfolgreichen Versand. Wer Logzugriff hat (Vercel-Logs,
// Log-Drains, Monitoring), konnte sich damit als beliebiger Nutzer einloggen.
//
// Regel: Credential-Logging ausschließlich außerhalb von Produktion. Fehlt in
// Produktion die Mail-Konfiguration, ist das ein harter Fehler — kein
// stillschweigender Fallback und schon gar kein "Versand erfolgreich".
// ═══════════════════════════════════════════════════════════════════════
export async function sendAuthMail(to: string, subject: string, text: string) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Mail nicht konfiguriert: RESEND_API_KEY fehlt. Login-Links/OTPs werden in " +
          "Produktion NIEMALS ins Log geschrieben.",
      );
    }
    // Lokale Entwicklung/Tests: Link/Code landet in der Konsole statt in einem
    // echten Postfach — kein Entwickler-Setup nötig, um Magic-Link/OTP-Flows
    // lokal durchzuspielen.
    console.log(`[dev-mail] an ${to}: ${subject}\n${text}`);
    return;
  }

  const resend = new Resend(apiKey);
  // Fix (Review, Important #1): resend.emails.send() wirft NICHT bei
  // API-Fehlern (nicht verifizierte Domain, Rate-Limit, ungültiger
  // Empfänger) — nur Netzwerkfehler werfen. Ohne diese Prüfung meldet
  // better-auth einen "erfolgreichen" Magic-Link/OTP-Versand, obwohl die
  // Mail nie rausging. `error` ist laut installiertem SDK (resend@6.x,
  // node_modules/resend/dist/index.d.mts: type Response<T>) entweder
  // `null` oder `{ message: string; statusCode: number | null; name: ... }`.
  const { error } = await resend.emails.send({ from: mailFrom(), to, subject, text });
  if (error) {
    // Bewusst OHNE `text`: der Body enthält den Login-Link bzw. OTP.
    console.error("[mail] Versand fehlgeschlagen:", error);
    throw new Error(`Mail-Versand fehlgeschlagen: ${error.message}`);
  }
}

// Absender-Domain wird beim Go-Live-Setup konfiguriert (RESEND_FROM). Der
// Platzhalter bleibt bewusst eine .invalid-Adresse, damit ein vergessener
// Go-Live-Schritt beim ersten echten Versand auffällt statt still zu wirken.
function mailFrom(): string {
  return process.env.RESEND_FROM ?? "login@transactional.example.invalid";
}
