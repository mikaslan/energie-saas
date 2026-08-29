import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Zwei Pfade, weil das Auth-Schema bewusst NICHT im Haupt-Barrel liegt
  // (siehe lib/db/schema/index.ts): Domänencode darf die auth_*-Tabellen nicht
  // sehen, Migrationen müssen sie aber vollständig erfassen.
  schema: ["./lib/db/schema/index.ts", "./lib/db/schema/auth.ts"],
  out: "./drizzle",
  dialect: "postgresql",
});
