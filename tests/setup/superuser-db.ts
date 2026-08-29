import { Pool } from "pg";
import {
  assertDestructiveTestDatabase,
  parsePostgresConnectionUrl,
  postgresConnectionTarget,
  postgresConnectionTargetKey,
} from "../../lib/db/postgres-url";

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
  const rawUrl = process.env.POSTGRES_URL_TEST_SUPERUSER;
  const rawTestUrl = process.env.POSTGRES_URL_TEST;
  if (!rawUrl || !rawTestUrl) {
    throw new Error(
      "POSTGRES_URL_TEST_SUPERUSER oder POSTGRES_URL_TEST ist nicht gesetzt. " +
        "Die embedded-Test-DB setzt beide " +
        "automatisch; für eine externe Test-DB muss sie explizit gesetzt werden " +
        "(siehe .github/workflows/ci.yml).",
    );
  }

  const testUrl = parsePostgresConnectionUrl("POSTGRES_URL_TEST", rawTestUrl);
  const superuserUrl = parsePostgresConnectionUrl("POSTGRES_URL_TEST_SUPERUSER", rawUrl);
  const target = postgresConnectionTarget(testUrl);
  const targetKey = postgresConnectionTargetKey(testUrl);
  assertDestructiveTestDatabase("POSTGRES_URL_TEST", testUrl);
  if (
    !target.database.includes("test") ||
    postgresConnectionTargetKey(superuserUrl) !== targetKey ||
    process.env.POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET !== targetKey
  ) {
    throw new Error(
      "Die Superuser-Testverbindung wurde nicht für exakt dieselbe Testdatenbank validiert.",
    );
  }

  poolInstance ??= new Pool({ connectionString: rawUrl, max: 2 });
  return poolInstance;
}

export async function closeSuperuserPool(): Promise<void> {
  const pool = poolInstance;
  poolInstance = undefined;
  await pool?.end();
}
