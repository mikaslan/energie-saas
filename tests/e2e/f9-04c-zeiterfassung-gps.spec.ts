import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.4 Slice C GPS am Start-Event — Chromium-E2E (Welle 03/04).
 *
 * Mit Consent-Haken + gemockter Geolocation starten → „Standort:"-Zeile
 * sichtbar; ohne Haken kein Standort (Fail-open). Timer werden je Phase
 * gestoppt (kein laufender Eintrag bleibt zurück). Eigenes f94c-Projekt.
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f94cProjectId: string;
  editorEmail: string;
};

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f94cProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.4c-E2E-State ist unvollständig.");
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

async function stopRunning(page: Page, minutes: string): Promise<void> {
  const running = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr läuft", exact: true }),
  });
  await running.getByLabel("Arbeitszeit (Minuten)").fill(minutes);
  await running.getByRole("button", { name: "Stoppen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stoppuhr", exact: true })).toBeVisible();
}

test("F9.4-E2E-04: Start mit Consent speichert Standort, ohne nicht", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 52.52, longitude: 13.405 });

  const url = `/w/${data.w3WorkspaceId}/anfragen/${data.f94cProjectId}/zeiterfassung`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);

  const starter = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr", exact: true }),
  });
  await starter.getByLabel("Standort beim Start speichern").check();
  await starter.getByRole("button", { name: "Stoppuhr starten", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft", exact: true })).toBeVisible();
  await stopRunning(page, "30");

  await expect(
    page.getByText("Standort: 52.5200, 13.4050", { exact: true }),
  ).toBeVisible();

  // Ohne Haken: Start gelingt, aber ohne Standort-Zeile (weiter genau eine).
  const starterAgain = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr", exact: true }),
  });
  await starterAgain.getByRole("button", { name: "Stoppuhr starten", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft", exact: true })).toBeVisible();
  await expect(page.getByText(/Standort:/u)).toHaveCount(1);
  await stopRunning(page, "15");

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
