import { execSync } from "node:child_process";
import { startEmbeddedPostgres } from "./embedded-postgres";

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
