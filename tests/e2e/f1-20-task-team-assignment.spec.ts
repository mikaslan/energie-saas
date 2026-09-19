import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F1-20 Aufgaben-Team-Zuweisung — Chromium-E2E (W3-Workspace, Seed-Projekt
 * f114 wie F1-14, M1_05_E2E_STATE).
 *
 * - Editor: Schnellaufgabe anlegen → „Bearbeiten" → Teams-Sektion im Dialog
 *   („Keine Teams zugewiesen.", Stand 0) → Team im Dropdown wählen +
 *   Zuweisen → Team erscheint, Stand 1, Feedback → Dialog schließen +
 *   erneut öffnen persistent → Entfernen → Stand 2, Sektion wieder leer.
 * - Viewer: kein „Bearbeiten"-Button an der Aufgabenkarte — der Dialog
 *   (und damit die Teams-Sektion) ist per UI nicht erreichbar. Die
 *   lesbare Sektion (canAssign false) und die Schreibsperre sind
 *   DB-seitig abgedeckt (F1020-DB-10).
 * - External: Der W3-Workspace hat keine External-Membership (run.mts) —
 *   kein UI-Login im W3-Kontext möglich. Ausblendung (Kontext null) und
 *   Schreibsperre sind DB-seitig abgedeckt (F1020-DB-10).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  f114ProjectId: string;
  editorEmail: string;
  viewerEmail: string;
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
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "f114ProjectId",
    "editorEmail",
    "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F1-20-E2E-State ist unvollständig.");
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
    if (match) return match[1];
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  await expect(page).toHaveTitle(/.+/u);
  // F1-20: Scope auf die eigene Sektion — der Dialog enthaelt belegte
  // Fremd-Verletzungen ausserhalb (Out-of-Scope).
  const result = await new AxeBuilder({ page })
    .include("#task-team-assignment")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function seedActiveTeam(teamName: string): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const created = await pool.query(
      `insert into team (id, workspace_id, name, name_normalized, created_by)
       select $1::uuid, $2::uuid, $3, lower(btrim($3)), u.id
         from user_identity u where u.email = $4
        limit 1`,
      [randomUUID(), data.w3WorkspaceId, teamName, data.editorEmail],
    );
    if (created.rowCount !== 1) {
      throw new Error("Der F1-20-E2E-Seed konnte das Team nicht anlegen.");
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function detailPath(): string {
  return `/w/${state().w3WorkspaceId}/anfragen/${state().f114ProjectId}`;
}

function taskCard(page: Page, title: string): Locator {
  return page.locator("#project-tasks article").filter({
    has: page.getByRole("heading", { name: title, level: 4, exact: true }),
  });
}

async function createQuickTask(page: Page, title: string): Promise<Locator> {
  const tasks = page.locator("#project-tasks");
  await tasks.getByLabel("Neue Aufgabe").fill(title);
  await tasks.getByRole("button", { name: "Aufgabe anlegen", exact: true }).click();
  await expect(tasks.getByRole("status")).toHaveText("Die Aufgabe wurde erstellt.");
  const card = taskCard(page, title);
  await expect(card).toHaveCount(1);
  return card;
}

async function openEditDialogTeams(page: Page, card: Locator): Promise<Locator> {
  await card.getByRole("button", { name: "Bearbeiten" }).click();
  const dialog = page.getByRole("dialog", { name: "Aufgabe bearbeiten" });
  await expect(dialog).toBeVisible();
  const section = dialog.locator("#task-team-assignment");
  await expect(section.getByRole("heading", { name: "Teams", level: 2 })).toBeVisible();
  return section;
}

test("F1-20-E2E-01: Editor weist Team im Task-Dialog zu, persistent, entfernt es", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = detailPath();
  const teamName = `F120 Taskteam E2E ${Date.now()}`;
  const taskTitle = `F120 Teamaufgabe E2E ${Date.now()}`;

  await seedActiveTeam(teamName);
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  const card = await createQuickTask(page, taskTitle);
  const section = await openEditDialogTeams(page, card);
  await expect(section.getByText("Keine Teams zugewiesen.", { exact: true })).toBeVisible();
  await expect(section.getByText("Stand 0", { exact: true })).toBeVisible();

  await section.getByLabel("Team").selectOption({ label: teamName });
  await section.getByRole("button", { name: "Zuweisen" }).click();
  await expect(section.getByText("Die Teamzuweisung wurde gespeichert.", { exact: true }))
    .toBeVisible();
  await expect(section.getByText("Stand 1", { exact: true })).toBeVisible();
  await expect(section.getByText(teamName, { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F1-20-Task-Dialog mit Team");

  await page.getByRole("dialog", { name: "Aufgabe bearbeiten" })
    .getByRole("button", { name: "Aufgabeneditor schließen" }).click();
  await expect(page.getByRole("dialog", { name: "Aufgabe bearbeiten" })).toHaveCount(0);

  const reopened = await openEditDialogTeams(page, taskCard(page, taskTitle));
  await expect(reopened.getByText("Stand 1", { exact: true })).toBeVisible();
  await expect(reopened.getByText(teamName, { exact: true })).toBeVisible();

  await reopened.getByRole("button", { name: `${teamName} von der Aufgabe entfernen` }).click();
  await expect(reopened.getByText("Die Teamzuweisung wurde gespeichert.", { exact: true }))
    .toBeVisible();
  await expect(reopened.getByText("Stand 2", { exact: true })).toBeVisible();
  await expect(reopened.getByText("Keine Teams zugewiesen.", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  await page.setViewportSize({ width: 768, height: 900 });
  await expectNoHorizontalOverflow(page, 768);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page, 1440);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F1-20-E2E-02: Viewer erreicht den Task-Dialog nicht", async ({ browser }) => {
  test.setTimeout(120_000);
  const data = state();
  const path = detailPath();
  const taskTitle = `F120 Viewer-Teamaufgabe E2E ${Date.now()}`;

  const editorContext = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const editorPage = await editorContext.newPage();
  const editorErrors = trackBrowserErrors(editorPage);
  try {
    await editorPage.goto(path);
    await loginWithRealOtp(editorPage, data.editorEmail, path);
    await createQuickTask(editorPage, taskTitle);
  } finally {
    await editorContext.close();
  }
  expect(editorErrors, "Browser-Konsole des Editor-Seeds").toEqual([]);

  const viewerContext = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const viewerPage = await viewerContext.newPage();
  const viewerErrors = trackBrowserErrors(viewerPage);
  try {
    await viewerPage.goto(path);
    await loginWithRealOtp(viewerPage, data.viewerEmail, path);

    // Der Bearbeiten-Button (und damit Dialog + Teams-Sektion) ist
    // schreibgesteuert — Viewer sehen die Karte, aber keinen Einstieg.
    const card = taskCard(viewerPage, taskTitle);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Bearbeiten" })).toHaveCount(0);
    await expect(viewerPage.getByRole("dialog")).toHaveCount(0);
  } finally {
    await viewerContext.close();
  }
  expect(viewerErrors, "Browser-Konsole und Page-Errors der Rollengrenze").toEqual([]);
});
