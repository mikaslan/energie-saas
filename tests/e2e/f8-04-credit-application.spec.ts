import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-04 Gutschrift-Anrechnung — Chromium-E2E.
 * - Gutschrift 119 € voll auf 238-€-Rechnung → Rest 119 €, Allokation am
 *   Gutschrift-Detail, Kandidaten-Suffix „Gutschrift".
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

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId",
    "editorEmail", "viewerEmail", "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F8-04-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

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
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function seedSequenceFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 900000 + (Math.abs(hash) % 99000) + 1;
}

async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `update membership
          set capabilities = pg_catalog.jsonb_set(
            coalesce(capabilities, '{}'::jsonb),
            '{invoicing}',
            'true'::jsonb,
            true
          )
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

async function seedIssuedDocument(
  name: string,
  grossCents: number,
  type: "invoice" | "credit_note",
): Promise<void> {
  const data = state();
  const seedSequence = seedSequenceFor(`F804-${name}`);
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
    const netCents = Math.round((grossCents / 119) * 100);
    await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date,
         voided_at, void_reason, credit_note_type, delivery_date
       ) values (
         gen_random_uuid(), $1::uuid, $2, 'issued', $3,
         (select id from user_identity where email = $4 limit 1),
         (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin',
         '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
         decode($5, 'hex'),
         (select id from user_identity where email = $4 limit 1),
         '2036-12-31'::date,
         'Rechnung-E2E-' || $6,
         extract(year from now() at time zone 'Europe/Berlin')::int, $6::int, $7, $8, $9, 'unpaid', 0, (now()::date + 14),
         null, null,
         case when $2 = 'credit_note' then 'minderleistung' else null end,
         case when $2 = 'credit_note' then '2026-09-01'::date else null end
       )`,
      [
        data.workspaceId,
        type,
        `F804-${name}`,
        data.editorEmail,
        ZERO_HASH,
        seedSequence,
        netCents,
        grossCents - netCents,
        grossCents,
      ],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function invoicesPath(): string {
  return `/w/${state().workspaceId}/rechnungen/invoice`;
}

function creditNotesPath(): string {
  return `/w/${state().workspaceId}/rechnungen/credit_note`;
}

async function openDocument(page: Page, listPath: string, name: string): Promise<void> {
  await page.goto(listPath);
  const row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("link", { name }).click();
  await expect(page.locator('[data-invoice-detail="deposits"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F8-04-E2E-01: Gutschrift anrechnen → Rest, Allokation und Kandidaten-Suffix sichtbar", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedIssuedDocument("Gutschrift", 119_00, "credit_note");
  await seedIssuedDocument("Schluss", 238_00, "invoice");

  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.editorEmail, invoicesPath());

  await openDocument(page, invoicesPath(), "F804-Schluss");
  const deposits = page.locator('[data-invoice-detail="deposits"]');
  await deposits.getByLabel("Anzahlung / Gutschrift").selectOption({
    label: `Rechnung-E2E-${seedSequenceFor("F804-Gutschrift")} · 119,00 € · Gutschrift`,
  });
  // Vorbelegung = min(Rest Gutschrift, Rest Rechnung) = 119,00.
  await expect(deposits.getByLabel("Betrag in EUR (optional)")).toHaveValue("119,00");
  await deposits.getByRole("button", { name: "Anrechnen" }).click();
  await expect(deposits.getByRole("alert")).toHaveCount(0);
  await expect(deposits.getByText("Keine Anzahlungen angerechnet.")).toHaveCount(0);
  // Vollbetrag → Zeile zeigt nur „119,00 €" (kein „von"); Rest 238−119.
  await expect(deposits.locator("li", { hasText: "F804-Gutschrift" }).getByText("F804-Gutschrift · 119,00 €")).toBeVisible();
  await expect(deposits.locator("dd", { hasText: "119,00 €" })).toBeVisible();

  await openDocument(page, creditNotesPath(), "F804-Gutschrift");
  const creditDeposits = page.locator('[data-invoice-detail="deposits"]');
  await expect(creditDeposits.getByText("Auf Schlussrechnungen verteilt")).toBeVisible();
  await expect(creditDeposits.getByText("Noch verfügbar:")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Gutschrift-Journey").toEqual([]);
});
