import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-23c Gruppen-Status-Zählungen (Chromium):
 * Gruppe mit Entwurf + versendetem Dok → Zähl-Badges sichtbar;
 * leere Gruppe → keine Badges. Gruppe per UI (M3-01-Spiegel),
 * Dokumente per SQL.
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

const FULL_GROUP = "F823C-Voll";
const EMPTY_GROUP = "F823C-Leer";

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
    throw new Error("Der private F823C-E2E-State ist unvollständig.");
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

async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `update membership set capabilities = pg_catalog.jsonb_set(
         coalesce(capabilities, '{}'::jsonb), '{invoicing}', 'true'::jsonb, true)
       where workspace_id = $1::uuid
         and user_id = (select id from user_identity where email = $2 limit 1)`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function groupIdByName(name: string): Promise<string | null> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    const result = await client.query(
      `select id from commercial_document_group where workspace_id = $1::uuid and name = $2 limit 1`,
      [data.workspaceId, name],
    );
    return (result.rows[0]?.id as string | undefined) ?? null;
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function seedDoc(groupId: string, name: string, status: "draft" | "issued", sent: boolean): Promise<void> {
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
    await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date, sent_at, group_id
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', $2, $3,
         (select id from user_identity where email = $4 limit 1),
         case when $5 then (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin' else null end,
         case when $5 then '{"schemaVersion":"document-snapshot.v1"}'::jsonb else null end,
         case when $5 then decode($6, 'hex') else null end,
         case when $5 then (select id from user_identity where email = $4 limit 1) else null end,
         case when $5 then '2036-12-31'::date else null end,
         case when $5 then 'Rechnung-F823C-' || $3 else null end,
         case when $5 then extract(year from now() at time zone 'Europe/Berlin')::int else null end,
         case when $5 then 823001 else null end,
         10000, 1900, 11900, 'unpaid', 0, (now()::date + 14),
         case when $7 then now() else null end,
         $8::uuid
       )`,
      [data.workspaceId, status, name, data.editorEmail, issued, "00".repeat(32), sent, groupId],
    );
    await client.query("commit");
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F823C-E2E-01: Gruppen-Zähl-Badges + 0-Ausblendung", async ({ page }) => {
  test.setTimeout(180_000);
  await grantInvoicingCapability();
  const data = state();
  const groupsPath = `/w/${data.workspaceId}/rechnungen`;

  await page.goto(groupsPath);
  await loginWithRealOtp(page, data.editorEmail, groupsPath);

  for (const name of [FULL_GROUP, EMPTY_GROUP]) {
    if (!(await groupIdByName(name))) {
      await page.getByRole("button", { name: "Neue Gruppe" }).click();
      const dialog = page.getByRole("dialog", { name: "Neue Gruppe" });
      await dialog.getByLabel("Name").fill(name);
      await dialog.getByRole("button", { name: "Anlegen" }).click();
      await expect(page.getByText(name)).toBeVisible();
    }
  }
  const fullId = await groupIdByName(FULL_GROUP);
  if (!fullId) throw new Error("F823C-E2E: volle Gruppe fehlt.");
  await seedDoc(fullId, "F823C-Entwurf", "draft", false);
  await seedDoc(fullId, "F823C-Versendet", "issued", true);

  await page.goto(groupsPath);
  const fullRow = page.getByRole("row").filter({ hasText: FULL_GROUP });
  await expect(fullRow.getByTestId("group-draft-count")).toBeVisible();
  await expect(fullRow.getByTestId("group-sent-count")).toBeVisible();
  const emptyRow = page.getByRole("row").filter({ hasText: EMPTY_GROUP });
  await expect(emptyRow.getByTestId("group-draft-count")).toHaveCount(0);
  await expect(emptyRow.getByTestId("group-sent-count")).toHaveCount(0);
});
