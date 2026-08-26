import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink, emailOTP } from "better-auth/plugins";
import { getAuthDb } from "./db/auth-client";
import { userIdentity } from "./db/schema/core";
import { sendAuthMail } from "./mail";

// Doku-Check (context7, better-auth@1.7.x): der Drizzle-Adapter lebt seit
// 1.7 in einem eigenen Paket @better-auth/drizzle-adapter (nicht mehr unter
// better-auth/adapters/drizzle wie im Task-Brief-Snippet) — Doku gewinnt.
//
// Jede Option unten wurde gegen die INSTALLIERTEN Typen von better-auth@1.7.1
// verifiziert, nicht aus der Erinnerung gesetzt (Fundstellen als Kommentar an
// der jeweiligen Option).
export const auth = betterAuth({
  database: drizzleAdapter(getAuthDb(), {
    provider: "pg",
    // Codex-Review #16: der Drizzle-Adapter defaultet auf `transaction: false`
    // und führt mehrstufige Verification-Operationen dann nur sequenziell aus.
    // Ein Abbruch zwischen dem Löschen der neuesten und älterer OTP-Zeilen
    // konnte so einen alten Code wiederbeleben.
    // Beleg: node_modules/@better-auth/drizzle-adapter/dist/index.d.mts:43
    //   `transaction?: boolean | undefined;` (@default false)
    transaction: true,
  }),
  emailAndPassword: { enabled: false },
  // Alle better-auth-Tabellen tragen das Präfix "auth_" (modelName pro
  // Kernmodell, lt. context7-Doku "Customize core table and column names" /
  // "Configure account options" — kein globales "prefix"-Feld dokumentiert).
  // Die Namen stehen als EXAKTE Allowlist in tests/setup/tenant-fixtures.ts
  // (kein Prefix-Match mehr, siehe Codex-Review #4).
  user: { modelName: "auth_user" },
  session: { modelName: "auth_session" },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  // Codex-Review #21: better-auth aktiviert Rate-Limiting in Produktion
  // standardmäßig mit In-Memory-Storage. Auf Vercel hat damit jede
  // Serverless-Instanz bzw. jeder Cold Start einen eigenen Zähler —
  // Mail-Flooding und OTP-Versuche lassen sich über Instanzwechsel
  // vervielfachen. `storage: "database"` zählt zentral in der DB.
  // Beleg: node_modules/@better-auth/core/dist/types/init-options.d.mts:217
  //   `storage?: ("memory" | "database" | "secondary-storage") | undefined;`
  //   sowie `BetterAuthRateLimitOptions` = … & Omit<BetterAuthDBOptions<
  //   "rateLimit", …>, "additionalFields"> → modelName ist zulässig.
  rateLimit: { storage: "database", modelName: "auth_rate_limit" },
  plugins: [
    magicLink({
      // Codex-Review #15: Magic-Link-Token wurden im Klartext in
      // auth_verification gespeichert — ein Lesefehler dort lieferte sofort
      // verwendbare Login-Credentials. Token sind hochentrop, ein Hash ist
      // hier die richtige Wahl (im Gegensatz zum 6-stelligen OTP unten).
      // Beleg: node_modules/better-auth/dist/plugins/magic-link/index.d.mts:69
      //   `storeToken?: ("plain" | "hashed" | { type: "custom-hasher"; … })`
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => sendAuthMail(email, "Dein Login-Link", url),
    }),
    emailOTP({
      // Codex-Review #15: ein sechsstelliger OTP hat nur ~20 Bit Entropie —
      // ein nackter SHA-256-Hash davon ist offline in Sekunden brute-forcebar.
      // Deshalb "encrypted" (symmetrisch mit dem BETTER_AUTH_SECRET) statt
      // "hashed": der Angreifer braucht zusätzlich den Schlüssel.
      // Beleg: node_modules/better-auth/dist/plugins/email-otp/types.d.mts:59
      //   `storeOTP?: ("hashed" | "plain" | "encrypted" | {…})`
      // Verifiziert in dist/plugins/email-otp/otp-token.mjs:7 (symmetricEncrypt).
      storeOTP: "encrypted",
      sendVerificationOTP: async ({ email, otp }) => sendAuthMail(email, "Dein Login-Code", `Code: ${otp}`),
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // ═══════════════════════════════════════════════════════════════
        // Erst-Login: Domänen-Identität anlegen und an den better-auth-User
        // koppeln (Codex-Review #17a).
        //
        // Ruling (Migration 0002 / Task-3-Ledger): user_identity hat eine
        // membership-basierte SELECT-Policy — bei Erst-Login existiert noch
        // keine Membership, RETURNING unterliegt derselben SELECT-Policy
        // (chicken-egg). Deshalb: client-generierte UUID statt
        // defaultRandom(), kein .returning(), kein Folge-SELECT.
        //
        // OFFEN / BLOCKED (siehe drizzle/0011 und final-fix-report.md F11):
        // Hier stand ursprünglich `.onConflictDoNothing()`, und der Brief
        // verlangte ein `onConflict (lower(email)) DO UPDATE`, um
        // auth_user_id auf eine bereits eingeladene Identität nachzutragen.
        // BEIDES ist unter der aktuellen RLS unmöglich: PostgreSQL verlangt
        // für JEDES `on conflict` (auch DO NOTHING) Sichtbarkeit der
        // kollidierenden Zeile unter den SELECT-Policies
        // (WCO_RLS_CONFLICT_CHECK) — beim Erst-Login gibt es weder Membership
        // noch app.workspace_id. Empirisch verifiziert, als Test festgehalten
        // in tests/db/identity-and-site-keys.test.ts.
        //
        // Konsequenz für M0: schlichter INSERT. Der Normalfall (neue Mail =
        // neue Identität) funktioniert damit vollständig. Der Fall „Identität
        // existiert bereits" (Invite vor erstem Login) ist ein M1-Feature —
        // dort MUSS zusammen mit dem Onboarding-Bootstrap (erste Membership)
        // entschieden werden, wie der privilegierte Reconcile-Pfad aussieht:
        // eng gefasste Bootstrap-Policy oder eigene Auth-DB-Rolle
        // (docs/adr/0003-db-rollen-trennung.md). Kein improvisiertes
        // Aufweichen der Identity-RLS an dieser Stelle.
        //
        // Fehler werden bewusst NICHT geschluckt: ein stiller Fehlschlag
        // hinterließe einen auth_user ohne Identität. Lieber ein sichtbar
        // fehlgeschlagener Signup.
        // ═══════════════════════════════════════════════════════════════
        after: async (user) => {
          await getAuthDb()
            .insert(userIdentity)
            // lower(): better-auth normalisiert E-Mails, der Unique-Index
            // liegt auf lower(email) (Codex-Review #18) — hier wird der
            // kanonische Wert auch tatsächlich GESPEICHERT.
            .values({ id: randomUUID(), email: user.email.toLowerCase(), authUserId: user.id });
        },
      },
    },
  },
});
