import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F7.05 Slice 3 Lead Installer — Chromium-E2E.
 *
 * E2E-01: Editor legt die Installation per Direktanlage an (falls noch
 * nicht vorhanden, f71-Projekt exklusiv), weist sich als Lead Installer
 * zu (Label sichtbar + Erfolgsmeldung), hebt die Zuordnung wieder auf.
 * E2E-02: Viewer sieht das Label, aber kein Zuweisungsformular.
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f71ProjectId: string;
  editorEmail: string;
  viewerEmail: string;
};

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f71ProjectId",
    "editorEmail",
    "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7.05-E2E-State ist unvollständig.");
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

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

const path = (): string => `/w/${state().w3WorkspaceId}/anfragen/${state().f71ProjectId}`;

function installationSection(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Installation", exact: true }),
  });
}

test("F7.05-E2E-03: Editor weist Lead Installer zu und hebt auf", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  const section = installationSection(page);
  await expect(section).toBeVisible();

  // Direktanlage nur bei frischer Umgebung (eigener f71-Pfad, idempotent).
  const createButton = section.getByRole("button", { name: "Installation direkt anlegen", exact: true });
  if (await createButton.isVisible().catch(() => false)) {
    await createButton.click();
  }
  await expect(section.getByText("Lead Installer:", { exact: true })).toBeVisible();

  // Zuweisen.
  await section.getByLabel("Mitglied").selectOption({ label: data.editorEmail });
  await section.getByRole("button", { name: "Zuweisung speichern", exact: true }).click();
  await expect(section.getByText("Lead Installer zugewiesen.", { exact: true })).toBeVisible();
  await expect(section.locator("dl").getByText(data.editorEmail, { exact: true })).toBeVisible();

  // Aufheben.
  await section.getByLabel("Mitglied").selectOption({ value: "" });
  await section.getByRole("button", { name: "Zuweisung speichern", exact: true }).click();
  await expect(section.getByText("Lead-Zuordnung aufgehoben.", { exact: true })).toBeVisible();
  await expect(section.getByText("nicht zugewiesen", { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Lead-Zuweisung").toEqual([]);
});

test("F7.05-E2E-04: Viewer sieht Label ohne Formular", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  const section = installationSection(page);
  await expect(section.getByText("Lead Installer:", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Mitglied")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Zuweisung speichern", exact: true })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Viewer-Grenze").toEqual([]);
});
