import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

// Magic-Link-Token werden gehasht gespeichert (storeToken: "hashed") — der
// Klartext-Token ist also NUR im Versandweg zu bekommen. Deshalb wird der
// Mailversand abgefangen statt aus der DB gelesen; genau das ist auch der
// Beweis, dass in auth_verification kein verwendbares Credential liegt.
const { sentMails } = vi.hoisted(() => ({
  sentMails: [] as { to: string; subject: string; text: string }[],
}));
vi.mock("@/lib/mail", () => ({
  sendAuthMail: async (to: string, subject: string, text: string) => {
    sentMails.push({ to, subject, text });
  },
}));

function lastMagicLinkToken(): string {
  const mail = sentMails.at(-1);
  expect(mail, "es wurde keine Mail versendet").toBeDefined();
  const token = new URL(mail!.text).searchParams.get("token");
  expect(token, `kein token in der Magic-Link-URL: ${mail!.text}`).toBeTruthy();
  return token!;
}

// Boot- und Hook-Tests brauchen POSTGRES_URL (lib/auth.ts baut den
// Drizzle-Adapter beim Modul-Import über getAuthDb() auf, lib/db/auth-client.ts
// ist sonst lazy) und BETTER_AUTH_SECRET — beides wird hier gesetzt statt
// Entwickler-Setup zu verlangen (siehe Task-Brief). POSTGRES_URL_TEST steht
// bereits aus dem globalSetup (embedded-postgres) zur Verfügung.
//
// BETTER_AUTH_SECRET per ??=: ein von außen gesetztes Secret ist harmlos.
process.env.BETTER_AUTH_SECRET ??= "test-secret-mindestens-32-zeichen-lang!!";

// Codex-Review #8: hier stand `process.env.POSTGRES_URL ??= POSTGRES_URL_TEST`.
// Das ist genau der gefährliche Fall — eine ambient gesetzte Dev-/Prod-
// POSTGRES_URL wäre erhalten geblieben, und better-auth hätte im Test gegen
// DIESE Datenbank geschrieben (Nutzer anlegen, Verification-Zeilen, Hook-Insert
// in user_identity). Deshalb wird der Auth-Client hier HART auf die Test-DB
// gezwungen, nicht per ??=. lib/db/auth-client.ts liest POSTGRES_URL_AUTH mit
// Vorrang vor POSTGRES_URL.
process.env.POSTGRES_URL_AUTH = process.env.POSTGRES_URL_TEST;
// Das magicLink-Plugin baut aus baseURL die Callback-URL; ohne diesen Wert
// wirft es "Invalid URL". In Produktion liefert Vercel die URL automatisch.
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

afterAll(async () => {
  const { closeAuthDb } = await import("@/lib/db/auth-client");
  await closeAuthDb();
});

describe("auth-Schema", () => {
  it("better-auth-Tabellen existieren nach Migration", async () => {
    const { rows } = await testPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public' and table_name like 'auth_%' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "auth_account",
      "auth_rate_limit",
      "auth_session",
      "auth_user",
      "auth_verification",
    ]);
  });

  // Codex-Review #19 (MUSS vor Merge): das Schema war mit CLI 1.4.22 erzeugt,
  // die Runtime ist 1.7.1. auth_account.issuer und der Unique-Key
  // (issuer, accountId) fehlten dadurch komplett.
  it("auth_account trägt issuer + Unique-Key (issuer, account_id) — CLI/Runtime angeglichen", async () => {
    const col = await testPool.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_name = 'auth_account' and column_name = 'issuer'`,
    );
    expect(col.rows, "auth_account.issuer fehlt — CLI/Runtime-Drift").toHaveLength(1);
    expect(col.rows[0].is_nullable).toBe("NO");

    const idx = await testPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'auth_account' and indexname = 'auth_account_issuer_accountId_uidx'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE/);
  });

  it("auth-Instanz bootet", async () => {
    const { auth } = await import("@/lib/auth");
    expect(auth.handler).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Hook-Regressionstest (Codex-MUSS, Review #17a).
  //
  // Der Nachweis läuft über eine Superuser-Verbindung, weil user_identity eine
  // membership-basierte SELECT-Policy hat: die Zeile, die der Hook beim
  // Erst-Login anlegt, ist für JEDE normale Verbindung unsichtbar (es gibt zu
  // diesem Zeitpunkt per Definition noch keine Membership).
  // ═══════════════════════════════════════════════════════════════════════
  it("Erst-Login legt user_identity an und koppelt sie an den better-auth-User", async () => {
    const { auth } = await import("@/lib/auth");
    // Gemischte Schreibweise: der Hook MUSS kanonisch kleinschreiben (#18).
    const email = `Hook-${randomUUID()}@Example.TEST`;

    // Der Nutzer entsteht erst beim VERIFY, nicht beim Anfordern des Links.
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
    await auth.api.magicLinkVerify({
      query: { token: lastMagicLinkToken() },
      headers: new Headers(),
      asResponse: true,
    });

    const authUser = await superuserPool().query<{ id: string; email: string }>(
      "select id, email from auth_user where lower(email) = $1",
      [email.toLowerCase()],
    );
    expect(authUser.rows, "better-auth hat keinen Nutzer angelegt").toHaveLength(1);

    const identity = await superuserPool().query<{ id: string; email: string; auth_user_id: string | null }>(
      "select id, email, auth_user_id from user_identity where lower(email) = $1",
      [email.toLowerCase()],
    );
    expect(identity.rows, "Hook hat keine user_identity angelegt").toHaveLength(1);
    // (a) E-Mail ist kanonisch kleingeschrieben GESPEICHERT, nicht nur eindeutig.
    expect(identity.rows[0].email).toBe(email.toLowerCase());
    // (b) Kopplung zeigt auf genau diesen better-auth-Nutzer.
    expect(identity.rows[0].auth_user_id).toBe(authUser.rows[0].id);
  }, 30_000);

  // ═══════════════════════════════════════════════════════════════════════
  // SELBSTHEILUNG (Codex-Finalcheck, Restrisiko zu F11).
  //
  // `user.create.after` läuft NACH dem Auth-Commit. Schlägt der Reconcile dort
  // fehl, bleibt ein auth_user ohne Identität zurück — und der create-Hook
  // feuert nie wieder. Der Session-Hook ist der produktive Retry: er läuft bei
  // JEDEM Login.
  //
  // Der Fehlschlag wird hier nachgestellt, indem die Identity-Zeile über die
  // Superuser-Verbindung gelöscht wird (unter RLS ist DELETE auf user_identity
  // vollständig verboten — deshalb der Bootstrap-Weg).
  // ═══════════════════════════════════════════════════════════════════════
  it("Selbstheilung: eine fehlende Identität wird beim nächsten Login nachgezogen", async () => {
    const { auth } = await import("@/lib/auth");
    const email = `heal-${randomUUID()}@example.test`;

    async function login(): Promise<void> {
      await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
      await auth.api.magicLinkVerify({
        query: { token: lastMagicLinkToken() },
        headers: new Headers(),
        asResponse: true,
      });
    }

    await login();
    const ersteRunde = await superuserPool().query<{ auth_user_id: string | null }>(
      "select auth_user_id from user_identity where lower(email) = $1",
      [email],
    );
    expect(ersteRunde.rows, "Erst-Login hat keine Identität angelegt").toHaveLength(1);
    const authUserId = ersteRunde.rows[0].auth_user_id;
    expect(authUserId).toBeTruthy();

    // Fehlgeschlagener create-Hook nachgestellt.
    await superuserPool().query("delete from user_identity where lower(email) = $1", [email]);
    const geloescht = await superuserPool().query(
      "select 1 from user_identity where lower(email) = $1",
      [email],
    );
    expect(geloescht.rows, "Vorbedingung: Identität musste weg sein").toHaveLength(0);

    // Zweiter Login — derselbe auth_user, neue Session.
    await login();

    const geheilt = await superuserPool().query<{ auth_user_id: string | null }>(
      "select auth_user_id from user_identity where lower(email) = $1",
      [email],
    );
    expect(geheilt.rows, "Session-Hook hat die Identität NICHT nachgezogen").toHaveLength(1);
    expect(geheilt.rows[0].auth_user_id, "nachgezogen, aber nicht gekoppelt").toBe(authUserId);
  }, 30_000);

  it("Magic-Link-Token liegt NICHT im Klartext in auth_verification (Codex #15)", async () => {
    const { auth } = await import("@/lib/auth");
    const email = `token-${randomUUID()}@example.test`;

    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
    const plaintextToken = lastMagicLinkToken();

    const { rows } = await superuserPool().query<{ identifier: string; value: string }>(
      "select identifier, value from auth_verification",
    );
    expect(rows.length).toBeGreaterThan(0);
    // storeToken: "hashed" — der versendete Token darf NIRGENDS im Klartext
    // in der Tabelle stehen, weder als value noch als identifier.
    for (const row of rows) {
      expect(row.value, "Magic-Link-Token liegt im Klartext in der DB").not.toContain(plaintextToken);
      expect(row.identifier, "Magic-Link-Token liegt im Klartext in der DB").not.toContain(plaintextToken);
    }
  }, 30_000);

  it("OTP liegt NICHT im Klartext in auth_verification (Codex #15, storeOTP: encrypted)", async () => {
    const { auth } = await import("@/lib/auth");
    const email = `otp-${randomUUID()}@example.test`;

    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: new Headers() });
    const mail = sentMails.at(-1);
    expect(mail, "keine OTP-Mail versendet").toBeDefined();
    const otp = mail!.text.replace(/\D/g, "");
    expect(otp, "kein OTP in der Mail").toMatch(/^\d{6}$/);

    const { rows } = await superuserPool().query<{ value: string }>(
      "select value from auth_verification",
    );
    // Ein 6-stelliger OTP hat ~20 Bit Entropie; ein nackter Hash wäre offline
    // brute-forcebar. "encrypted" macht den Wert ohne BETTER_AUTH_SECRET
    // unbrauchbar — geprüft wird hier, dass der Klartext-Code nirgends steht.
    for (const row of rows) {
      expect(row.value, "OTP liegt im Klartext in der DB").not.toContain(otp);
    }
  }, 30_000);
});
