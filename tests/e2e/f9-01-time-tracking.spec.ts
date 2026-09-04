import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.1 Zeiterfassung — Chromium-E2E.
 *
 * - Editor legt einen Ereignistyp an, erfasst einen Zeiteintrag am Projekt,
 *   sieht die Summe und archiviert den Eintrag.
 * - Viewer: beide Seiten read-only.
 * - External bleibt fail-closed.
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
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.1-E2E-State ist unvollständig.");
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
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function firstProjectId(): Promise<string> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ id: string }>(
      `select id from project
        where workspace_id = $1::uuid
        order by created_at desc
        limit 1`,
      [data.workspaceId],
    );
    if (!result.rows[0]) throw new Error("Kein Projekt im F9.1-E2E-State vorhanden.");
    return result.rows[0].id;
  } finally {
    await pool.end();
  }
}

const settingsPath = (): string => `/w/${state().workspaceId}/einstellungen/ereignistypen`;

test("F9.1-E2E-01: Editor legt Ereignistyp an, erfasst Zeiteintrag, sieht Summe, archiviert", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const projectId = await firstProjectId();
  const path = `/w/${data.workspaceId}/anfragen/${projectId}/zeiterfassung`;

  // 1) Ereignistyp in den Einstellungen anlegen.
  await page.goto(settingsPath());
  await loginWithRealOtp(page, data.editorEmail, settingsPath());
  await expect(page.getByRole("heading", { name: "Ereignistypen", level: 1 })).toBeVisible();
  await page.getByLabel("Name").fill("Montage");
  await page.getByLabel("Hintergrundfarbe").fill("#3B82F6");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Ereignistyp angelegt.", { exact: true })).toBeVisible();

  // 2) Zeiteintrag am Projekt erfassen — Session besteht bereits.
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();
  await expect(page.getByText("Noch keine Zeiteinträge erfasst.")).toBeVisible();

  await page.getByLabel("Ereignistyp").selectOption({ label: "Montage" });
  await page.getByLabel("Beginn").fill("2026-09-04T08:00");
  await page.getByLabel("Ende").fill("2026-09-04T10:00");
  await page.getByLabel("Arbeitszeit (Minuten)").fill("120");
  await page.getByLabel("Kommentar").fill("Anlage montiert");
  await page.getByRole("button", { name: "Erfassen" }).click();

  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Montage", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Summe: 2 Std. 0 Min.")).toBeVisible();
  // Kimi-P1-2: konkrete Uhrzeit im Browser-Round-Trip (Lokalzeit → UTC → lokal).
  await expect(page.getByText(/08:00–10:00 Uhr/u)).toBeVisible();

  // 3) Persistenz über Reload.
  await page.reload();
  await expect(page.getByText("Summe: 2 Std. 0 Min.")).toBeVisible();
  await expect(page.getByText(/08:00–10:00 Uhr/u)).toBeVisible();

  // 4) Ereignistyp archivieren → Eintrag behält den historischen Namen
  // (Kimi-P2-2), die Option erscheint im Edit-Select als „(archiviert)".
  await page.goto(settingsPath());
  await expect(page.getByRole("heading", { name: "Ereignistypen", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByText("Ereignistyp archiviert.", { exact: true })).toBeVisible();

  await page.goto(path);
  await expect(page.getByText("Montage", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(page.getByLabel("Ereignistyp", { exact: true })).toContainText("Montage (archiviert)");
  await page.getByRole("button", { name: "Abbrechen" }).click();

  // 5) Eintrag archivieren → Summe fällt auf 0, Eintrag verschwindet.
  await page.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByText("Zeiteintrag archiviert.", { exact: true })).toBeVisible();
  await expect(page.getByText("Noch keine Zeiteinträge erfasst.")).toBeVisible();
  await expect(page.getByText("Summe: 0 Min.")).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F9.1-Zeiterfassung");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F9.1-E2E-02: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const projectId = await firstProjectId();
  const path = `/w/${data.workspaceId}/anfragen/${projectId}/zeiterfassung`;

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();
  await expect(page.getByText(/Du hast Lesezugriff\./u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Erfassen" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(settingsPath());
  await loginWithRealOtp(page, data.viewerEmail, settingsPath());
  await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(path);
  await loginWithRealOtp(page, data.externalEmail, path);
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
