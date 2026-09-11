import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F10-03b Status-Timeline — Chromium-E2E.
 *
 * E2E-01: Editor legt Installation an (falls frisch), schließt sie ab,
 * erstellt den Portal-Link (UI), öffnet ihn ohne Login im
 * Installations-Tab: Verlauf zeigt „Angelegt" + „Abgeschlossen" mit
 * Berlin-Datum. Reiner UI-Pfad, keine Seeds.
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f101ProjectId: string;
  editorEmail: string;
};

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f101ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10-03b-E2E-State ist unvollständig.");
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

test("F10-03b-E2E-01: Portal zeigt Installations-Verlauf ohne Login", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f101ProjectId}`;

  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // Installation anlegen (idempotent) + abschließen.
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Installation", exact: true }),
  });
  await expect(section).toBeVisible();
  const createButton = section.getByRole("button", { name: "Installation direkt anlegen", exact: true });
  if (await createButton.isVisible().catch(() => false)) {
    await createButton.click();
  }
  const completeButton = section.getByRole("button", { name: "Installation abschließen", exact: true });
  // Nach der Anlage erst aufs Re-Render warten (kein sofortiges isVisible).
  await expect(completeButton).toBeVisible({ timeout: 15000 }).catch(() => undefined);
  if (await completeButton.isVisible().catch(() => false)) {
    await completeButton.click();
    await expect(section.getByText("Installation abgeschlossen.", { exact: true })).toBeVisible();
  }

  // Portal-Link: vorhandenen zurückziehen (Token zeigt sich nur einmal),
  // dann frisch erstellen und Token abgreifen (Muster F10-01).
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await expect(portal).toBeVisible();
  const withdrawButton = portal.getByRole("button", { name: "Link zurückziehen", exact: true });
  if (await withdrawButton.isVisible().catch(() => false)) {
    await withdrawButton.click();
    await expect(portal.getByText("Der Portal-Link wurde zurückgezogen.", { exact: true })).toBeVisible();
  }
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  await expect(portal.getByText("Der Portal-Link wurde erstellt. Kopiere ihn jetzt — er wird nicht erneut angezeigt.", { exact: true }))
    .toBeVisible();
  const tokenPath = ((await portal.locator("p.font-mono").textContent()) ?? "").trim();
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // Öffentlich ohne Login: Installations-Tab mit Verlauf.
  await page.context().clearCookies();
  await page.goto(`${tokenPath}?tab=installation`);
  await expect(page.getByRole("heading", { name: "Installation", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verlauf", exact: true })).toBeVisible();
  // F10-06: Timeline-Tage im Portal-Locale (de-DE), konsistent mit den
  // übrigen Datumsangaben der Seite (zuvor ISO-Rohformat). Verlauf ist die
  // Liste (li); der Stand (dd) kann denselben Wortlaut tragen.
  await expect(
    page.locator("li").filter({ hasText: /Angelegt am \d{2}\.\d{2}\.\d{4}/ }),
  ).toBeVisible();
  await expect(
    page.locator("li").filter({ hasText: /Abgeschlossen am \d{2}\.\d{2}\.\d{4}/ }),
  ).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Timeline").toEqual([]);
});
