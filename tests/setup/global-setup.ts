export default async function globalSetup() {
  if (!process.env.POSTGRES_URL_TEST) {
    throw new Error("POSTGRES_URL_TEST ist nicht gesetzt — Tests laufen NIE gegen die Dev-DB.");
  }
  // Task 2 ergänzt hier: Migrationen gegen die Test-DB ausführen.
}
