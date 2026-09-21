import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-23d Detail-Kopf Status-Badge (Chromium):
 * versendete Rechnung → „Versendet“-Badge im Kopf;
 * Entwurf → „Entwurf“-Badge. Dokumente per SQL.
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

const SENT_NAME = "F823D-Versendet";
const DRAFT_NAME = "F823D-Entwurf";

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
    throw new Error("Der private F823D-E2E-State ist unvollständig.");
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

async function seedDoc(name: string, status: "draft" | "issued", sent: boolean): Promise<string> {
  const data = state();
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
    await client.query(`delete from commercial_document where workspace_id = $1::uuid and name = $2`, [data.workspaceId, name]);
    const issued = status === "issued";
    const inserted = await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date, sent_at
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', $2, $3,
         (select id from user_identity where email = $4 limit 1),
         case when $5 then (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin' else null end,
         case when $5 then '{"schemaVersion":"document-snapshot.v1"}'::jsonb else null end,
         case when $5 then decode($6, 'hex') else null end,
         case when $5 then (select id from user_identity where email = $4 limit 1) else null end,
         case when $5 then '2036-12-31'::date else null end,
         case when $5 then 'Rechnung-F823D-' || $3 else null end,
         case when $5 then extract(year from now() at time zone 'Europe/Berlin')::int else null end,
         case when $5 then 823401 else null end,
         10000, 1900, 11900, 'unpaid', 0, (now()::date + 14),
         case when $7 then now() else null end
       )
       returning id`,
      [data.workspaceId, status, name, data.editorEmail, issued, "00".repeat(32), sent],
    );
    await client.query("commit");
    return inserted.rows[0].id as string;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F823D-E2E-01: Kopf-Badge Versendet + Entwurf", async ({ page }) => {
  test.setTimeout(180_000);
  const sentId = await seedDoc(SENT_NAME, "issued", true);
  const draftId = await seedDoc(DRAFT_NAME, "draft", false);
  const data = state();
  const sentPath = `/w/${data.workspaceId}/rechnungen/invoice/${sentId}`;
  const draftPath = `/w/${data.workspaceId}/rechnungen/invoice/${draftId}`;

  await page.goto(sentPath);
  await loginWithRealOtp(page, data.editorEmail, sentPath);
  await expect(page.getByTestId("document-status-badge")).toHaveText("Versendet");

  await page.goto(draftPath);
  await expect(page.getByTestId("document-status-badge")).toHaveText("Entwurf");
});
