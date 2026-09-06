// Schließt den in tests/setup/test-db.ts erzeugten pg-Pool nach jeder
// Testdatei. Als Vitest-`setupFiles`-Eintrag registriert, läuft dies im
// selben isolierten Modul-Kontext wie die jeweilige Testdatei — der hier
// importierte `testPool` ist also exakt die Instanz, die die Tests nutzen.
import { afterAll } from "vitest";
import { testPool } from "./test-db";
import { closeSuperuserPool } from "./superuser-db";
import { endPoolAndWaitForClientRemoval } from "./pg-pool-drain";

export async function closePerFileTestPools(
  closeRuntimePool: () => Promise<void>,
  closeSuperuser: () => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(closeRuntimePool),
    Promise.resolve().then(closeSuperuser),
  ]);
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, "Testdatei-Pool-Teardown fehlgeschlagen");
  }
}

afterAll(async () => {
  await closePerFileTestPools(
    () => endPoolAndWaitForClientRemoval(testPool),
    // Nur wirksam, wenn die Datei den Superuser-Pool überhaupt angefasst hat.
    closeSuperuserPool,
  );
});
