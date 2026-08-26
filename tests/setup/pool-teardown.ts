// Schließt den in tests/setup/test-db.ts erzeugten pg-Pool nach jeder
// Testdatei. Als Vitest-`setupFiles`-Eintrag registriert, läuft dies im
// selben isolierten Modul-Kontext wie die jeweilige Testdatei — der hier
// importierte `testPool` ist also exakt die Instanz, die die Tests nutzen.
import { afterAll } from "vitest";
import { testPool } from "./test-db";

afterAll(async () => {
  await testPool.end();
});
