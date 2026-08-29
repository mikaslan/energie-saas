import { execSync } from "node:child_process";
import {
  assertDestructiveTestDatabase,
  assertNoAmbientPostgresOverrides,
  parsePostgresConnectionUrl,
  postgresConnectionTarget,
  postgresConnectionTargetKey,
  postgresTestTargetConfirmation,
} from "../../lib/db/postgres-url";
import { startEmbeddedPostgres } from "./embedded-postgres";

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #8: der Test-DB-Schutz prüfte bisher nur, dass die Variable
// POSTGRES_URL_TEST *heißt* — nicht, worauf sie zeigt. Eine von außen
// gesetzte Produktions-URL wäre migriert und beschrieben worden, und das
// Superuser-Gate in scripts/migrate.mts fängt das NICHT ab: eine normale
// Produktionsrolle ist weder Superuser noch BYPASSRLS und passiert es
// anstandslos.
//
// Zwei zusätzliche Schranken, beide hart:
//  1. Der DATENBANKNAME muss "test" enthalten.
//  2. POSTGRES_URL_TEST darf nicht auf dasselbe Ziel zeigen wie POSTGRES_URL
//     (Host + Port + Datenbank), sonst laufen Tests gegen die Dev-/Prod-DB.
//
// Die embedded-Instanz erfüllt beides bauartbedingt (energie_saas_test auf
// einem eigenen, zufälligen Port); der Guard läuft trotzdem über beide Fälle,
// damit er nicht nur auf dem selten benutzten Pfad getestet wird.
// ═══════════════════════════════════════════════════════════════════════
const SERVICE_URL_ENV_NAMES = [
  "POSTGRES_URL",
  "POSTGRES_URL_AUTH",
  "POSTGRES_URL_WORKER",
  "POSTGRES_URL_MIGRATE",
  "POSTGRES_URL_SYSTEM",
] as const;

export function assertTestDatenbank(rawUrl: string): string {
  const testUrl = parsePostgresConnectionUrl("POSTGRES_URL_TEST", rawUrl);
  const z = postgresConnectionTarget(testUrl);
  const testTargetKey = postgresConnectionTargetKey(testUrl);
  assertDestructiveTestDatabase("POSTGRES_URL_TEST", testUrl);

  for (const envName of SERVICE_URL_ENV_NAMES) {
    const rawServiceUrl = process.env[envName];
    if (!rawServiceUrl) continue;
    const serviceUrl = parsePostgresConnectionUrl(envName, rawServiceUrl);
    if (postgresConnectionTargetKey(serviceUrl) === testTargetKey) {
      throw new Error(
        `POSTGRES_URL_TEST und ${envName} zeigen auf dasselbe Ziel ` +
          `(${z.host}:${z.port}/${z.database}). Tests laufen NIE gegen die Dev-/Prod-DB.`,
      );
    }
  }

  const rawSuperuserUrl = process.env.POSTGRES_URL_TEST_SUPERUSER;
  if (rawSuperuserUrl) {
    const superuserUrl = parsePostgresConnectionUrl(
      "POSTGRES_URL_TEST_SUPERUSER",
      rawSuperuserUrl,
    );
    if (postgresConnectionTargetKey(superuserUrl) !== testTargetKey) {
      throw new Error(
        "POSTGRES_URL_TEST_SUPERUSER muss exakt Host, Port und Datenbank von " +
          "POSTGRES_URL_TEST verwenden.",
      );
    }
    process.env.POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET = testTargetKey;
  }

  return testTargetKey;
}

export default async function globalSetup() {
  // Wenn POSTGRES_URL_TEST bereits gesetzt ist (CI mit echtem Postgres-Service,
  // oder eine echte Neon-Test-DB), wird sie unverändert übernommen — es wird
  // NIE eine embedded-Instanz gebootet, wenn eine externe DB vorgegeben ist.
  let stopEmbedded: (() => Promise<void>) | undefined;

  try {
    assertNoAmbientPostgresOverrides("Testsuite");
    // Ein Marker aus einem früheren/verschachtelten Lauf darf nie genügen.
    delete process.env.POSTGRES_TEST_SUPERUSER_VALIDATED_TARGET;

    if (!process.env.POSTGRES_URL_TEST) {
      const embedded = await startEmbeddedPostgres();
      process.env.POSTGRES_URL_TEST = embedded.url;
      // Separate Superuser-Verbindung für Aussagen, die unter RLS strukturell
      // nicht prüfbar sind (siehe tests/setup/superuser-db.ts). Wird NIE als
      // POSTGRES_URL_TEST verwendet — sonst wären alle RLS-Tests wirkungslos.
      process.env.POSTGRES_URL_TEST_SUPERUSER = embedded.superuserUrl;
      process.env.POSTGRES_TEST_TARGET_CONFIRM = postgresTestTargetConfirmation(
        parsePostgresConnectionUrl("POSTGRES_URL_TEST", embedded.url),
      );
      stopEmbedded = embedded.stop;
    }

    const url = process.env.POSTGRES_URL_TEST;
    if (!url) {
      throw new Error("POSTGRES_URL_TEST ist nicht gesetzt — Tests laufen NIE gegen die Dev-DB.");
    }
    assertTestDatenbank(url);

    // Die eigentlichen Vitest-Module laufen absichtlich weiter über die
    // historische Ein-Rollen-Testverbindung. Die Ausnahme ist sichtbar,
    // test-only und zusätzlich an den Datenbanknamen gebunden; ohne diesen
    // Wert würden die neuen Runtime-/Auth-URL-Gates korrekt Strict-Rollen
    // verlangen und die Kompatibilitätssuite könnte nicht booten.
    process.env.DB_ROLE_MODE = "test-legacy-single";

    // Ausschließlich die explizite Migrationsvariable setzen. Der Migrator hat
    // seit M1-03 keinen Runtime-Fallback mehr; ein ambient gesetztes Dev-/Prod-
    // POSTGRES_URL kann den Testlauf damit nicht umlenken. Der test-only Modus
    // ist zusätzlich oben an Umgebung und Datenbankname gebunden.
    execSync("npx tsx scripts/migrate.mts", {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DB_ROLE_MODE: "test-legacy-single",
        POSTGRES_URL_MIGRATE: url,
      },
      stdio: "inherit",
    });
  } catch (err) {
    // Wenn die Migration fehlschlägt, nachdem embedded-postgres schon gestartet
    // wurde, darf weder der Prozess noch das Datenverzeichnis zurückbleiben.
    await stopEmbedded?.();
    throw err;
  }

  return async () => {
    await stopEmbedded?.();
  };
}
