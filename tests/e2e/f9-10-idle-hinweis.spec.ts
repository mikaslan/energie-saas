import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9-10 Idle-Hinweis — Chromium-E2E (deterministisch via page.clock, keine
 * 5-min-Wartezeit).
 *
 * Stoppuhr starten → kein Hinweis → +5:06 min ohne Input → Hinweis mit
 * Inaktivitätszeit → „Weiter arbeiten" blendet aus → erneut +5:06 →
 * Hinweis → „Pause starten" → offene Pause („Pause läuft"), nichts wurde
 * automatisch gebucht. Nutzt das f94-Projekt (Muster f9-06).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f94ProjectId: string;
  editorEmail: string;
};

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f94ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.9-E2E-State ist unvollständig.");
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

test("F9-10-E2E-01: Idle-Hinweis erscheint, verwerfen und Pause starten", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const url = `/w/${data.w3WorkspaceId}/anfragen/${data.f94ProjectId}/zeiterfassung`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();

  // Ab hier gefrorene Zeit: Timer-Mounts unter Mock-Zeit (pre-install
  // Echtzeit-Intervalle würde die Mock-Clock nicht übernehmen).
  await page.clock.install();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();

  // Verwaiste laufende Einträge fremder Specs spurlos verwerfen (workers: 1,
  // normalerweise keiner vorhanden).
  const runningHeading = page.getByRole("heading", { name: "Stoppuhr läuft" });
  if (await runningHeading.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Verwerfen" }).click();
    await expect(runningHeading).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Stoppuhr starten" }).click();
  await expect(page.getByText("Stoppuhr gestartet.", { exact: true })).toBeVisible();
  await expect(runningHeading).toBeVisible();

  // Deterministische Inaktivität ohne 5-min-Wartezeit (Uhr läuft).
  // Belegt: fastForward feuert genau einen 5-s-Takt pro Aufruf.
  async function advanceIdle(): Promise<void> {
    for (let step = 0; step < 62; step += 1) {
      await page.clock.fastForward(5_000);
    }
  }
  const hint = page.getByTestId("idle-hint");
  await expect(hint).toHaveCount(0);

  await advanceIdle();
  await expect(hint).toBeVisible();
  await expect(hint.getByText(/Pause vergessen/u)).toBeVisible();

  await hint.getByTestId("idle-hint-dismiss").click();
  await expect(hint).toHaveCount(0);

  await advanceIdle();
  await expect(hint).toBeVisible();

  // Echte Aktion (kein Fake-Timer-Effekt): Uhr fortsetzen, damit die
  // Server-Action-Pipeline läuft; Banner bleibt bis zum nächsten 5-s-Takt
  // gemountet — der Klick landet sicher davor.
  await page.clock.resume();
  await hint.getByTestId("idle-hint-start-break").click();
  await expect(page.getByText(/Pause läuft/u).first()).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors des Idle-Hinweises").toEqual([]);
});
