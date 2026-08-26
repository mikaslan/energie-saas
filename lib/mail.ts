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
  await resend.emails.send({ from: "login@transactional.example.invalid", to, subject, text });
  // Absender-Domain wird beim Go-Live-Setup konfiguriert; bis dahin nur dev-Logging nutzen.
}
