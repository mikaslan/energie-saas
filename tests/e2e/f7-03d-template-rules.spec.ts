import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-03D Template-Regeln (Katalog Zeile 217) — Chromium-E2E (isolierter
 * Workspace). Admin setzt Regel in Vorlage, wendet an; abhängiger Punkt
 * erscheint erst nach Abhaken der Referenz (Reload-fest).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  adminEmail: string;
  viewerEmail: string;
};

function state(): E2EState {
  const full = fixtureState() as unknown as Record<string, unknown>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "adminEmail", "viewerEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F7-03D-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

async function resolveAdminId(): Promise<string> {
  return poolOne(async (pool) => {
    const result = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [state().adminEmail],
    );
    const id = (result.rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error("E2E-Adminidentitaet fehlt.");
    return id;
  });
}

async function grantViewerMembership(workspaceId: string): Promise<void> {
  await poolOne(async (pool) => {
    const found = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [state().viewerEmail],
    );
    const viewerId = (found.rows[0] as { id: string } | undefined)?.id;
    if (!viewerId) throw new Error("E2E-Vieweridentitaet fehlt.");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      await client.query(
        `insert into public.membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'viewer', '{}'::jsonb)`,
        [workspaceId, viewerId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  await expect(page).toHaveTitle(/.+/u);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}
async function seedCatalogComponents(workspaceId: string): Promise<void> {
  await poolOne(async (pool) => {
    await pool.query(
      `insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
       select gen_random_uuid(), $1::uuid, sku, 'inverter', u.id
         from (values ('F7-3D-WR'), ('F7-3D-MOD')) as s(sku)
         join user_identity u on u.email = $2
        limit 2`,
      [workspaceId, state().adminEmail],
    );
  });
}

test("F7-03D-E2E-01: Vorlagen-Regel blendet Punkt bis Referenz-Erledigung aus", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const workspaceId = await seedIsolatedWorkspace(await resolveAdminId());
  await seedCatalogComponents(workspaceId);
  await grantViewerMembership(workspaceId);
  const settingsPath = `/w/${workspaceId}/einstellungen/checklisten-vorlagen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.adminEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Checklisten-Vorlagen", level: 1 })).toBeVisible();

  const templateName = `Regel-Vorlage ${Date.now()}`;
  await page.getByLabel("Name").fill(templateName);
  await page.getByRole("button", { name: "Position hinzufügen" }).click();
  await page.getByLabel("Komponente 1").selectOption({ label: "F7-3D-WR" });
  await page.getByRole("button", { name: "Position hinzufügen" }).click();
  await page.getByLabel("Komponente 2").selectOption({ label: "F7-3D-MOD" });
  await page.getByLabel("Regel 2").selectOption({ label: "F7-3D-WR erledigt" });
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Vorlage angelegt.", { exact: true })).toBeVisible();

  // Projekt anlegen und Vorlage anwenden.
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Template-Regel");
  await form.getByLabel("Telefon").fill("0151 45678910");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  const url = `/w/${workspaceId}/anfragen/${projectId}/checkliste`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await page.getByLabel("Vorlage").selectOption({ label: templateName });
  await page.getByRole("button", { name: "Checkliste erstellen" }).click();
  await expect(page.getByText("Vorlage angewendet (Version 1).", { exact: true })).toBeVisible();

  // Abhängiger Punkt versteckt, bis Referenz abgehakt (client-seitig).
  const refCheckbox = page.getByRole("checkbox", { name: "F7-3D-WR × 1", exact: true });
  const depCheckbox = page.getByRole("checkbox", { name: "F7-3D-MOD × 1", exact: true });
  await expect(refCheckbox).toBeVisible();
  await expect(depCheckbox).toHaveCount(0);
  await refCheckbox.check();
  await expect(depCheckbox).toBeVisible();

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "F7-3D-WR × 1", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "F7-3D-MOD × 1", exact: true })).toBeVisible();

  // Viewer (lesend): gleiche Bedingungs-Sicht (Referenz erledigt → sichtbar).
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByText(/F7-3D-MOD × 1/u)).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F7-03D-Regeln");

  expect(errors, "Browser-Konsole und Page-Errors der Template-Regeln").toEqual([]);
});
