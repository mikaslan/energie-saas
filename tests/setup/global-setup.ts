import { execSync } from "node:child_process";
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
interface Ziel {
  host: string;
  port: string;
  database: string;
}

function ziel(rawUrl: string): Ziel {
  const u = new URL(rawUrl);
  return {
    host: u.hostname.toLowerCase(),
    // Postgres-Default, damit "…:5432/db" und "…/db" als gleich gelten.
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase(),
  };
}

function assertTestDatenbank(url: string): void {
  let z: Ziel;
  try {
    z = ziel(url);
  } catch {
    throw new Error("POSTGRES_URL_TEST ist keine gültige URL.");
  }

  if (!z.database.includes("test")) {
    throw new Error(
      `POSTGRES_URL_TEST zeigt auf die Datenbank "${z.database}" — der Name MUSS "test" ` +
        `enthalten. Schutz davor, versehentlich gegen eine Dev-/Prod-Datenbank zu migrieren ` +
        `und zu schreiben (das Superuser-Gate in scripts/migrate.mts fängt das NICHT ab: ` +
        `eine normale Produktionsrolle ist weder Superuser noch BYPASSRLS).`,
    );
  }

  const prod = process.env.POSTGRES_URL;
  if (prod) {
    let p: Ziel | undefined;
    try {
      p = ziel(prod);
    } catch {
      p = undefined; // unlesbares POSTGRES_URL ist hier kein Grund abzubrechen
    }
    if (p && p.host === z.host && p.port === z.port && p.database === z.database) {
      throw new Error(
        `POSTGRES_URL_TEST und POSTGRES_URL zeigen auf dasselbe Ziel ` +
          `(${z.host}:${z.port}/${z.database}). Tests laufen NIE gegen die Dev-/Prod-DB.`,
      );
    }
  }
}

export default async function globalSetup() {
  // Wenn POSTGRES_URL_TEST bereits gesetzt ist (CI mit echtem Postgres-Service,
  // oder eine echte Neon-Test-DB), wird sie unverändert übernommen — es wird
  // NIE eine embedded-Instanz gebootet, wenn eine externe DB vorgegeben ist.
  let stopEmbedded: (() => Promise<void>) | undefined;

  try {
    if (!process.env.POSTGRES_URL_TEST) {
      const embedded = await startEmbeddedPostgres();
      process.env.POSTGRES_URL_TEST = embedded.url;
      // Separate Superuser-Verbindung für Aussagen, die unter RLS strukturell
      // nicht prüfbar sind (siehe tests/setup/superuser-db.ts). Wird NIE als
      // POSTGRES_URL_TEST verwendet — sonst wären alle RLS-Tests wirkungslos.
      process.env.POSTGRES_URL_TEST_SUPERUSER = embedded.superuserUrl;
      stopEmbedded = embedded.stop;
    }

    const url = process.env.POSTGRES_URL_TEST;
    if (!url) {
      throw new Error("POSTGRES_URL_TEST ist nicht gesetzt — Tests laufen NIE gegen die Dev-DB.");
    }
    assertTestDatenbank(url);

    execSync("npx tsx scripts/migrate.mts", { env: { ...process.env, POSTGRES_URL: url }, stdio: "inherit" });
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
