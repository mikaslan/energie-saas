import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F10.1 Kundenportal-Skeleton — Chromium-E2E (Nachholblock Welle 03).
 *
 * Create (Link erstellen, Token wird einmalig angezeigt) →
 * Resolve-View (öffentlich, Projektstand + Dokumentenbereich) →
 * Withdraw (Link zurückziehen) → Resolve-View zeigt „ungültig".
 * Das belegt den F10.1-Lifecycle Create/Withdraw/Resolve durch den
 * Browser. Eigenes f101-Projekt im W3-Workspace (f7-03-Lehre).
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
    throw new Error("Der private F10.1-E2E-State ist unvollständig.");
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

test("F10.1-E2E-01: Portal-Link Create, Resolve-View, Withdraw", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f101ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // Create: kein aktiver Link → Link erstellen → Token wird einmalig gezeigt.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await expect(portal.getByText("Kein aktiver Link.", { exact: false })).toBeVisible();
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  await expect(portal.getByText("Der Portal-Link wurde erstellt. Kopiere ihn jetzt — er wird nicht erneut angezeigt.", { exact: true }))
    .toBeVisible();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // Resolve-View (öffentlich): Stand + Dokumentenbereich sichtbar.
  await page.context().clearCookies();
  await page.goto(tokenPath);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();
  await expect(page.getByText("Aktuell liegen keine freigegebenen Dokumente vor.", { exact: true }))
    .toBeVisible();

  // Withdraw: nach Reload ist der aktive Link + Rückzug sichtbar.
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);
  await page.reload();
  await expect(portal.getByText("Aktiver Link", { exact: false })).toBeVisible();
  await portal.getByRole("button", { name: "Link zurückziehen", exact: true }).click();
  await expect(portal.getByText("Der Portal-Link wurde zurückgezogen.", { exact: true }))
    .toBeVisible();

  // Resolve-View nach Withdraw: identischer 404-Endzustand, kein Orakel.
  await page.context().clearCookies();
  await page.goto(tokenPath);
  await expect(page.getByRole("heading", { name: "Dieser Link ist ungültig.", exact: true }))
    .toBeVisible();

  // Die bewusste 404-Navigation erzeugt Chromium-Konsolenmeldungen
  // ("Failed to load resource: 404") — das ist der SPEZIFIZIERTE
  // Endzustand, kein Defekt. Muster m1-08b (injizierte 503): erwartete
  // Meldungen gezielt konsumieren, alles andere bleibt Fehler.
  const expected404 = "console: Failed to load resource: the server responded with a status of 404 (Not Found)";
  const consumed = errors.filter((error) => error === expected404).length;
  expect(consumed, "Erwartete 404-Konsolenmeldung nach Withdraw").toBeGreaterThan(0);
  const kept = errors.filter((error) => error !== expected404);
  errors.length = 0;
  errors.push(...kept);

  expect(errors, "Browser-Konsole und Page-Errors beider Grenzen").toEqual([]);
});
