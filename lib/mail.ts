import { Resend } from "resend";

// Ohne RESEND_API_KEY (lokale Entwicklung): Link/Code landet in der Konsole
// statt in einem echten Postfach — kein Entwickler-Setup nötig, um Magic-
// Link/OTP-Flows lokal durchzuspielen.
export async function sendAuthMail(to: string, subject: string, text: string) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev-mail] an ${to}: ${subject}\n${text}`);
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  // Fix (Review, Important #1): resend.emails.send() wirft NICHT bei
  // API-Fehlern (nicht verifizierte Domain, Rate-Limit, ungültiger
  // Empfänger) — nur Netzwerkfehler werfen. Ohne diese Prüfung meldet
  // better-auth einen "erfolgreichen" Magic-Link/OTP-Versand, obwohl die
  // Mail nie rausging. `error` ist laut installiertem SDK (resend@6.x,
  // node_modules/resend/dist/index.d.mts: type Response<T>) entweder
  // `null` oder `{ message: string; statusCode: number | null; name: ... }`.
  const { error } = await resend.emails.send({ from: "login@transactional.example.invalid", to, subject, text });
  if (error) {
    console.error("[mail] Versand fehlgeschlagen:", error);
    throw new Error(`Mail-Versand fehlgeschlagen: ${error.message}`);
  }
  // Absender-Domain wird beim Go-Live-Setup konfiguriert; bis dahin nur dev-Logging nutzen.
}
