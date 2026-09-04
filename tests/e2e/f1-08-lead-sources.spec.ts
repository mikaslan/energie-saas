import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

/**
 * F1.8 Lead Sources — Chromium-E2E.
 *
 * - Editor legt eine Quelle an (wmee-rechner-v5), sieht sie aktiv,
 *   lädt sie persistiert, archiviert und reaktiviert sie.
 * - Viewer: Seite lesbar, kein Anlege-/Bearbeitungsformular.
 * - External bleibt fail-closed (Zugriffs-Sperrseite).
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
    throw new Error("Der private F1.8-E2E-State ist unvollständig.");
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

function settingsPath(): string {
  return `/w/${state().workspaceId}/einstellungen/lead-quellen`;
}

test("F1.8-E2E-01: Editor legt Quelle an, lädt sie persistiert, archiviert und reaktiviert", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();
  await expect(page.getByText("Noch keine aktiven Lead-Quellen angelegt.")).toBeVisible();

  await page.getByLabel("Name").fill("wmee-rechner-v5");
  await page.getByLabel("Bereich").selectOption("residential");
  await page.getByLabel("Farbe").fill("#3B82F6");
  await page.getByRole("button", { name: "Anlegen" }).click();

  await expect(page.getByText("Lead-Quelle angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText("wmee-rechner-v5", { exact: true })).toBeVisible();

  // Persistenz über Reload.
  await page.reload();
  await expect(page.getByText("wmee-rechner-v5", { exact: true })).toBeVisible();

  // Bearbeiten: Bereich ändern (Felder auf den Listeneintrag scopen —
  // das Anlegeformular trägt ebenfalls ein „Name"-Feld).
  const row = page.getByRole("listitem").filter({ hasText: "wmee-rechner-v5" });
  await row.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(row.getByLabel("Name")).toHaveValue("wmee-rechner-v5");
  await row.getByLabel("Bereich").selectOption("commercial");
  await row.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Lead-Quelle aktualisiert.", { exact: true })).toBeVisible();
  // Der Domain-Badge im Listeneintrag (nicht die Select-Optionen).
  await expect(row.locator("span").filter({ hasText: /^Gewerbe$/ })).toBeVisible();

  // Archivieren → verschwindet aus den aktiven, erscheint unter Archivierte.
  await page.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByText("Lead-Quelle archiviert.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Archivierte Quellen" })).toBeVisible();
  await expect(page.getByText("Noch keine aktiven Lead-Quellen angelegt.")).toBeVisible();

  // Reaktivieren → wieder aktiv; die Archiv-Sektion bleibt mit Leer-Hinweis
  // und Feedback sichtbar, das Element wandert zurück in die aktive Liste.
  await page.getByRole("button", { name: "Reaktivieren" }).click();
  await expect(page.getByText("Lead-Quelle reaktiviert.", { exact: true })).toBeVisible();
  await expect(page.getByText("Keine archivierten Quellen.")).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "wmee-rechner-v5" }),
  ).toHaveCount(1);

  await expectNoWcagAaAxeViolations(page, "F1.8-Einstellungsseite");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F1.8-E2E-02: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);
  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();
  await expect(page.getByText(/Du hast Lesezugriff\./u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archivieren" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(path);
  await loginWithRealOtp(page, data.externalEmail, path);
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
