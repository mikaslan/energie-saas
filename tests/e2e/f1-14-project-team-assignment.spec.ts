import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F1-14 Projekt-Team-Zuweisung — Chromium-E2E (W3-Workspace, Seed-Projekt
 * f114, M1_05_E2E_STATE wie f7-03).
 *
 * - Editor: leere Sektion („Keine Teams zugewiesen.", Stand 0) → Team im
 *   Dropdown wählen + Zuweisen → Team erscheint, Stand 1, Feedback →
 *   Reload persistent → Entfernen → Stand 2, Sektion wieder leer.
 * - Viewer: Sektion lesbar („Du kannst die Teams sehen, aber nicht
 *   verändern."), keine Zuweisen-/Entfernen-Buttons.
 * - External: Der W3-Workspace hat keine External-Membership (run.mts) —
 *   kein UI-Login im W3-Kontext möglich. Ausblendung (Kontext null) und
 *   Schreibsperre sind DB-seitig abgedeckt (F1014-DB-10).
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
    throw new Error("Der private F1-14-E2E-State ist unvollständig.");
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
  // F1-14: Scope auf die eigene Sektion — die Akte enthaelt belegte
  // Fremd-Verletzungen (ul[role="alert"]-listitem ausserhalb, Out-of-Scope).
  const result = await new AxeBuilder({ page })
    .include("#project-team-assignment")
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
      throw new Error("Der F1-14-E2E-Seed konnte das Team nicht anlegen.");
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function detailPath(): string {
  return `/w/${state().w3WorkspaceId}/anfragen/${state().f114ProjectId}`;
}

test("F1-14-E2E-01: Editor weist Team zu, lädt persistent, entfernt es", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = detailPath();
  const teamName = `F114 Projektteam E2E ${Date.now()}`;

  await seedActiveTeam(teamName);
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  const panel = page.locator("#project-team-assignment");
  await expect(panel.getByRole("heading", { name: "Teams", level: 2 })).toBeVisible();
  await expect(panel.getByText("Keine Teams zugewiesen.", { exact: true })).toBeVisible();
  await expect(panel.getByText("Stand 0", { exact: true })).toBeVisible();

  await panel.getByLabel("Team").selectOption({ label: teamName });
  await panel.getByRole("button", { name: "Zuweisen" }).click();
  await expect(panel.getByText("Die Teamzuweisung wurde gespeichert.", { exact: true }))
    .toBeVisible();
  await expect(panel.getByText("Stand 1", { exact: true })).toBeVisible();
  await expect(panel.getByText(teamName, { exact: true })).toBeVisible();

  await page.reload();
  await expect(panel.getByText("Stand 1", { exact: true })).toBeVisible();
  await expect(panel.getByText(teamName, { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F1-14-Projektakte mit Team");

  await panel.getByRole("button", { name: `${teamName} vom Projekt entfernen` }).click();
  await expect(panel.getByText("Die Teamzuweisung wurde gespeichert.", { exact: true }))
    .toBeVisible();
  await expect(panel.getByText("Stand 2", { exact: true })).toBeVisible();
  await expect(panel.getByText("Keine Teams zugewiesen.", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  await page.setViewportSize({ width: 768, height: 900 });
  await expectNoHorizontalOverflow(page, 768);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page, 1440);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F1-14-E2E-02: Viewer sieht Teams lesbar, keine Mutation", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = detailPath();

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);

  const panel = page.locator("#project-team-assignment");
  await expect(panel.getByRole("heading", { name: "Teams", level: 2 })).toBeVisible();
  await expect(panel.getByText("Du kannst die Teams sehen, aber nicht verändern.", { exact: true }))
    .toBeVisible();
  await expect(panel.getByRole("button", { name: "Zuweisen" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Entfernen" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenze").toEqual([]);
});
