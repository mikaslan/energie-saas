import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-05b Block-Team-Zuweisung — Chromium-E2E (isolierter Workspace).
 * Admin baut einen Block, weist zwei Teams parallel zu (Chips sichtbar,
 * Zähler neutral), lädt neu (persistent) und entfernt eines wieder.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  adminEmail: string;
};

function state(): E2EState {
  const full = fixtureState() as unknown as Record<string, unknown>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "adminEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F7-05b-E2E-State ist unvollständig (${key}).`);
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

async function seedTeam(workspaceId: string, adminId: string, name: string): Promise<string> {
  const id = randomUUID();
  await poolOne(async (pool) => {
    await pool.query(
      `insert into team (id, workspace_id, name, name_normalized, created_by)
       values ($1, $2, $3, lower(btrim($3)), $4)`,
      [id, workspaceId, name, adminId],
    );
  });
  return id;
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

test("F705B-E2E-01: Zwei Teams parallel am Block, eines wieder weg", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const adminId = await resolveAdminId();
  const workspaceId = await seedIsolatedWorkspace(adminId);
  const teamDach = `Dachteam ${Date.now()}`;
  const teamElektro = `Elektroteam ${Date.now()}`;
  await seedTeam(workspaceId, adminId, teamDach);
  await seedTeam(workspaceId, adminId, teamElektro);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.adminEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Blockteams");
  await form.getByLabel("Telefon").fill("0151 45678908");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.goto(`/w/${workspaceId}/anfragen/${projectId}/checkliste`);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  const blockName = `Montage ${Date.now()}`;
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill(blockName);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();
  await expect(page.getByText("keine zugewiesen", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `${blockName}: ${teamDach} zuweisen` }).click();
  await expect(page.getByText("Team zugewiesen (Version 1).", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `${blockName}: ${teamElektro} zuweisen` }).click();
  await expect(page.getByText(teamDach, { exact: true })).toBeVisible();
  await expect(page.getByText(teamElektro, { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F7-05b-Zuweisung");

  await page.reload();
  await expect(page.getByText(teamDach, { exact: true })).toBeVisible();
  await expect(page.getByText(teamElektro, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `${blockName}: ${teamDach} entfernen` }).click();
  await expect(page.getByText("Team-Zuweisung entfernt (Version 1).", { exact: true })).toBeVisible();
  await expect(page.getByText(teamDach, { exact: true })).toHaveCount(0);
  await expect(page.getByText(teamElektro, { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Blockteam-Grenze").toEqual([]);
});
