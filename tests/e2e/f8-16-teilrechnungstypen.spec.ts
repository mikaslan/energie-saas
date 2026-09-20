import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-16 Teilrechnungstypen-Kennung — Chromium-E2E.
 * Rechnung per Dialog mit Kennung „Anzahlung" anlegen → Detail-Badge →
 * Art per Zeilen-Dialog auf „Abschlag" ändern → Listenfilter je Kennung →
 * ausstellen → Kennung eingefroren (kein Art-Dialog mehr).
 * Viewports 375/768/1440 + Axe (serious/critical) auf der Detailseite.
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

const BASIS_NAME = "F816-Basis";
const CHILD_NAME = "F816-Anzahlung";

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
    throw new Error("Der private F8-16-E2E-State ist unvollständig.");
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
    if (await otpInput.isVisible().catch(() => undefined)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
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

async function seedBasisInvoiceDraft(): Promise<void> {
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
    // Rerun-sicher: eigene F816-Zeilen (alle Status, wegen Ausstellung) zurücksetzen.
    await client.query(
      `delete from commercial_document_line
        where workspace_id = $1::uuid
          and document_id in (
            select id from commercial_document
             where workspace_id = $1::uuid and name like 'F816-%'
          )`,
      [data.workspaceId],
    );
    await client.query(
      `delete from commercial_document
        where workspace_id = $1::uuid and name like 'F816-%'`,
      [data.workspaceId],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         workspace_id, company_name, company_email,
         company_address_line1, company_postal_code, company_city,
         company_country, payment_account_holder, payment_iban,
         payment_bic, created_by
       ) values (
         $1::uuid, 'F816 GmbH', 'office@f816.example',
         'Strasse 1', '10115', 'Berlin', 'DE',
         'F816 GmbH', 'DE89370400440532013000', 'MARKDEF1100',
         (select id from user_identity where email = $2 limit 1)
       )
       on conflict (workspace_id) do update set
         company_name = excluded.company_name,
         updated_at = statement_timestamp()`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query(
      `insert into commercial_document (
         workspace_id, type, status, name, created_by,
         currency, net_cents, tax_cents, gross_cents,
         payment_status, paid_cents, due_date
       ) values (
         $1::uuid, 'invoice', 'draft', $2,
         (select id from user_identity where email = $3 limit 1),
         'EUR', 0, 0, 0, 'unpaid', 0, '2026-11-30'::date
       )`,
      [data.workspaceId, BASIS_NAME, data.editorEmail],
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

async function expectNoSeriousOrCriticalAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    }));
  expect(blocking).toEqual([]);
}

test("F816-E2E-01: Kennung anlegen → Badge → Art ändern → Filter → Ausstellung friert ein", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedBasisInvoiceDraft();

  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.editorEmail, invoicesPath());

  // Null-Kennung: Basis-Entwurf zeigt „Einfache Rechnung".
  const basisRow = page.getByRole("row").filter({ hasText: BASIS_NAME });
  await basisRow.getByRole("link", { name: BASIS_NAME }).click();
  await expect(page).toHaveURL(/\/rechnungen\/invoice\/[0-9a-f-]+$/u);
  await expect(page.getByTestId("invoice-kind-badge")).toContainText("Einfache Rechnung");
  await page.goto(invoicesPath());

  // Anlage mit Kennung „Anzahlung" per Erstelldialog.
  await page.getByRole("button", { name: "Rechnung anlegen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(CHILD_NAME);
  await dialog.getByLabel("Fällig am").fill("2026-11-30");
  await dialog.getByLabel("Rechnungsart").selectOption({ label: "Anzahlung" });
  await dialog.getByRole("button", { name: "Als Entwurf anlegen" }).click();
  await expect(dialog).toBeHidden();

  await page.goto(invoicesPath());
  const childRow = page.getByRole("row").filter({ hasText: CHILD_NAME });
  await expect(childRow).toBeVisible();

  // Detail-Badge zeigt die Kennung.
  await childRow.getByRole("link", { name: CHILD_NAME }).click();
  await expect(page).toHaveURL(/\/rechnungen\/invoice\/[0-9a-f-]+$/u);
  const badge = page.getByTestId("invoice-kind-badge");
  await expect(badge).toContainText("Anzahlung");
  await expectNoSeriousOrCriticalAxeViolations(page);

  // Viewports: Badge bleibt sichtbar.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(badge).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Art per Zeilen-Dialog auf „Abschlag" ändern.
  await page.goto(invoicesPath());
  await childRow.getByRole("button", { name: "Art", exact: true }).click();
  const kindDialog = page.getByRole("dialog");
  await expect(kindDialog).toBeVisible();
  await kindDialog.getByLabel("Rechnungsart").selectOption({ label: "Abschlag" });
  await kindDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(kindDialog).toBeHidden();

  await page.goto(invoicesPath());
  await childRow.getByRole("link", { name: CHILD_NAME }).click();
  await expect(page.getByTestId("invoice-kind-badge")).toContainText("Abschlag");

  // Listenfilter je Kennung (mit URL-Roundtrip + Aktiv-Zaehler + Axe).
  await page.goto(invoicesPath());
  await page.getByLabel("Rechnungsart").selectOption({ label: "Abschlag" });
  await page.getByRole("button", { name: "Filtern" }).click();
  await expect(page).toHaveURL(/art=abschlag/u);
  // Zaehler: archiv=active (Formular-Default) + art.
  await expect(page.getByText("2 Filter aktiv")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: CHILD_NAME })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: BASIS_NAME })).toBeHidden();
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.getByLabel("Rechnungsart").selectOption({ label: "Schlussrechnung" });
  await page.getByRole("button", { name: "Filtern" }).click();
  await expect(page.getByRole("row").filter({ hasText: CHILD_NAME })).toBeHidden();

  // Kennung per Art-Dialog loeschen → „Einfache Rechnung", dann erneut setzen.
  await page.goto(invoicesPath());
  await childRow.getByRole("button", { name: "Art", exact: true }).click();
  const clearDialog = page.getByRole("dialog");
  await clearDialog.getByLabel("Rechnungsart").selectOption({ label: "Einfache Rechnung" });
  await clearDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(clearDialog).toBeHidden();
  await page.goto(invoicesPath());
  await childRow.getByRole("link", { name: CHILD_NAME }).click();
  await expect(page.getByTestId("invoice-kind-badge")).toContainText("Einfache Rechnung");
  await page.goto(invoicesPath());
  await childRow.getByRole("button", { name: "Art", exact: true }).click();
  const resetDialog = page.getByRole("dialog");
  await resetDialog.getByLabel("Rechnungsart").selectOption({ label: "Abschlag" });
  await resetDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(resetDialog).toBeHidden();

  // Ausstellung friert die Kennung ein: kein Art-Dialog mehr.
  await page.goto(invoicesPath());
  await childRow.getByRole("button", { name: "Ausstellen" }).click();
  await expect(childRow.getByText("Ausgestellt")).toBeVisible();
  await expect(childRow.getByRole("button", { name: "Art", exact: true })).toBeHidden();
  await childRow.getByRole("link", { name: CHILD_NAME }).click();
  await expect(page.getByTestId("invoice-kind-badge")).toContainText("Abschlag");

  expect(errors, "Browser-Konsole und Page-Errors der Beleg-Grenze").toEqual([]);
});
