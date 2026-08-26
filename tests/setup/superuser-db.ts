import { Pool } from "pg";

// ═══════════════════════════════════════════════════════════════════════
// Superuser-Verbindung — NUR für Testaussagen, die sich unter RLS strukturell
// nicht treffen lassen.
//
// Der einzige legitime Anwendungsfall in M0: nachweisen, dass eine Zeile
// existiert, die AUSSERHALB jedes Mandantenkontexts geschrieben wurde (der
// Auth-Hook beim Erst-Login). user_identity hat eine membership-basierte
// SELECT-Policy; beim Erst-Login gibt es per Definition noch keine Membership,
// also ist die Zeile für JEDE normale Verbindung unsichtbar — auch für den
// Tabellen-Owner, weil RLS mit FORCE läuft.
//
// NICHT benutzen, um RLS in fachlichen Tests zu umgehen. Wer damit prüft, ob
// „die Daten ja doch da sind", testet an der Sicherheitsgarantie vorbei.
//
// Fehlt POSTGRES_URL_TEST_SUPERUSER (externe Test-DB ohne Superuser, z. B.
// Neon), wird hart geworfen statt still zu überspringen: ein Sicherheitstest,
// der sich selbst wegoptimiert, ist schlimmer als keiner.
// ═══════════════════════════════════════════════════════════════════════
let poolInstance: Pool | undefined;

export function superuserPool(): Pool {
  const url = process.env.POSTGRES_URL_TEST_SUPERUSER;
  if (!url) {
    throw new Error(
      "POSTGRES_URL_TEST_SUPERUSER ist nicht gesetzt. Die embedded-Test-DB setzt sie " +
        "automatisch; für eine externe Test-DB muss sie explizit gesetzt werden " +
        "(siehe .github/workflows/ci.yml).",
    );
  }
  poolInstance ??= new Pool({ connectionString: url, max: 2 });
  return poolInstance;
}

export async function closeSuperuserPool(): Promise<void> {
  const pool = poolInstance;
  poolInstance = undefined;
  await pool?.end();
}
