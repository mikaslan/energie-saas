import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-03 Anzahlungs-Split — Chromium-E2E.
 * - Anzahlung 238 € auf zwei Finals je 119 € verteilen → Reste + Allokationen
 *   und Kandidaten-Rest im UI sichtbar.
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
    throw new Error("Der private F8-03-E2E-State ist unvollständig.");
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

async function seedIssuedInvoice(name: string, grossCents: number): Promise<void> {
  const data = state();
  const seedSequence = seedSequenceFor(name);
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
         voided_at, void_reason
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', 'issued', $2,
         (select id from user_identity where email = $3 limit 1),
         (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin',
         '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
         decode($4, 'hex'),
         (select id from user_identity where email = $3 limit 1),
         '2036-12-31'::date,
         'Rechnung-E2E-' || $5,
         extract(year from now() at time zone 'Europe/Berlin')::int, $5::int, $6, $7, $8, 'unpaid', 0, (now()::date + 14),
         null, null
       )`,
      [
        data.workspaceId,
        name,
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

async function openDocument(page: Page, name: string): Promise<void> {
  await page.goto(invoicesPath());
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

test("F8-03-E2E-01: Anzahlung splitten → Reste, Kandidaten-Rest und Allokationen sichtbar", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedIssuedInvoice("F803-Anzahlung", 238_00);
  await seedIssuedInvoice("F803-Schluss-A", 238_00);
  await seedIssuedInvoice("F803-Schluss-B", 238_00);

  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.editorEmail, invoicesPath());

  // 1) 119 € auf Schluss A.
  await openDocument(page, "F803-Schluss-A");
  const depositsA = page.locator('[data-invoice-detail="deposits"]');
  await depositsA.getByLabel("Anzahlung").selectOption({
    label: `Rechnung-E2E-${seedSequenceFor("F803-Anzahlung")} · 238,00 €`,
  });
  await depositsA.getByLabel("Betrag in EUR (optional)").fill("119,00");
  await depositsA.getByRole("button", { name: "Anrechnen" }).click();
  await expect(depositsA.getByText("119,00 € von 238,00 €")).toBeVisible();

  // 2) Kandidat zeigt Rest; Vorbelegung = min(Rest, Rest Final).
  await openDocument(page, "F803-Schluss-B");
  const depositsB = page.locator('[data-invoice-detail="deposits"]');
  await depositsB.getByLabel("Anzahlung").selectOption({
    label: `Rechnung-E2E-${seedSequenceFor("F803-Anzahlung")} · 238,00 € · noch 119,00 € verfügbar`,
  });
  await expect(depositsB.getByLabel("Betrag in EUR (optional)")).toHaveValue("119,00");
  await depositsB.getByRole("button", { name: "Anrechnen" }).click();
  await expect(depositsB.getByText("119,00 € von 238,00 €")).toBeVisible();

  // 3) Anzahlungs-Detail zeigt beide Allokationen + Rest 0.
  await openDocument(page, "F803-Anzahlung");
  const depositsD = page.locator('[data-invoice-detail="deposits"]');
  await expect(depositsD.getByText("Auf Schlussrechnungen verteilt")).toBeVisible();
  await expect(depositsD.getByText("Noch verfügbar:")).toBeVisible();
  await expect(depositsD.getByText("0,00 €", { exact: true }).first()).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors des Split-Journey").toEqual([]);
});
