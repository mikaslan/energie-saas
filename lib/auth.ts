import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink, emailOTP } from "better-auth/plugins";
import { getDb } from "./db/client";
import { userIdentity } from "./db/schema";
import { sendAuthMail } from "./mail";

// Doku-Check (context7, better-auth@1.7.x): der Drizzle-Adapter lebt seit
// 1.7 in einem eigenen Paket @better-auth/drizzle-adapter (nicht mehr unter
// better-auth/adapters/drizzle wie im Task-Brief-Snippet) — Doku gewinnt.
export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "pg" }),
  emailAndPassword: { enabled: false },
  // Alle better-auth-Tabellen tragen das Präfix "auth_" (modelName pro
  // Kernmodell, lt. context7-Doku "Customize core table and column names" /
  // "Configure account options" — kein globales "prefix"-Feld dokumentiert).
  // Ziel: TENANT_EXEMPT_PREFIXES=["auth_", ...] (tests/setup/tenant-fixtures.ts)
  // greift automatisch, keine Exempt-Einzelnamen nötig.
  user: { modelName: "auth_user" },
  session: { modelName: "auth_session" },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => sendAuthMail(email, "Dein Login-Link", url),
    }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }) => sendAuthMail(email, "Dein Login-Code", `Code: ${otp}`),
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // Ruling (Migration 0002 / Task-3-Ledger): user_identity hat eine
        // membership-basierte SELECT-Policy — bei Erst-Login existiert noch
        // keine Membership, RETURNING unterliegt derselben SELECT-Policy
        // (chicken-egg). Deshalb: client-generierte UUID statt defaultRandom(),
        // kein .returning(), kein Folge-SELECT. Die INSERT-Policy ist
        // uneingeschränkt (with check (true)), der Hook läuft außerhalb einer
        // withTenant-Transaktion (kein app.workspace_id nötig).
        after: async (user) => {
          await getDb()
            .insert(userIdentity)
            .values({ id: randomUUID(), email: user.email })
            .onConflictDoNothing();
        },
      },
    },
  },
});
