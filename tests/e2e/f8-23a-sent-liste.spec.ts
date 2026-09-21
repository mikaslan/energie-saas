import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-23a Sent-Sichtbarkeit Typ-Liste (Chromium):
 * versendete Rechnung → Sent-Badge in Zeile; ?versand=sent/unsent
 * filtert die Liste.
 *
 * Seeds per SQL direkt (eindeutige Namen F823A-*), Login per echtem
 * Dev-Mail-OTP (Spiegel M3-01).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const SENT_NAME = "F823A-Versendet";
const UNSENT_NAME = "F823A-Offen";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F823A-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(logPath: string, email: string, byteOffset: number): Promise<string> {
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

function seedSequenceFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 900000 + (Math.abs(hash) % 99000) + 1;
}

async function seedInvoice(name: string, sent: boolean): Promise<void> {
  const data = state();
  const seq = seedSequenceFor(name);
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date, sent_at
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', 'issued', $2,
         (select id from user_identity where email = $3 limit 1),
         (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin',
         '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
         decode($4, 'hex'),
         (select id from user_identity where email = $3 limit 1),
         '2036-12-31'::date,
         'Rechnung-F823A-' || $5, extract(year from now() at time zone 'Europe/Berlin')::int,
         $5::int, 10000, 1900, 11900, 'unpaid', 0, (now()::date + 14),
         case when $6 then now() else null end
       )
       on conflict do nothing`,
      [data.workspaceId, name, data.editorEmail, ZERO_HASH, seq, sent],
    );
    await client.query("commit");
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F823A-E2E-01: Sent-Badge + Versand-Filter", async ({ page }) => {
  await seedInvoice(SENT_NAME, true);
  await seedInvoice(UNSENT_NAME, false);
  const data = state();
  const listPath = `/w/${data.workspaceId}/rechnungen/invoice`;

  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  const sentRow = page.getByRole("row").filter({ hasText: SENT_NAME });
  await expect(sentRow).toBeVisible();
  await expect(sentRow.getByTestId("document-sent-badge")).toBeVisible();
  const unsentRow = page.getByRole("row").filter({ hasText: UNSENT_NAME });
  await expect(unsentRow).toBeVisible();
  await expect(unsentRow.getByTestId("document-sent-badge")).toHaveCount(0);

  await page.goto(`${listPath}?versand=sent`);
  await expect(page.getByRole("row").filter({ hasText: SENT_NAME })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: UNSENT_NAME })).toHaveCount(0);

  await page.goto(`${listPath}?versand=unsent`);
  await expect(page.getByRole("row").filter({ hasText: SENT_NAME })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: UNSENT_NAME })).toBeVisible();
});
