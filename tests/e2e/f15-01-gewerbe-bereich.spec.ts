import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F15-01 Gewerbe-Bereich — Chromium-E2E (isolierter Workspace).
 * Umschalter Wohnbau/Gewerbe zeigt je das eigene Default-Board;
 * unbekannter bereich-Wert landet auf der 404-Seite.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
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
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F15-01-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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

test("F15-01-E2E-01: Bereichs-Umschalter zeigt Wohnbau- und Gewerbe-Board", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  // Wohnbau-Default.
  const residentialPath = `/w/${workspaceId}/anfragen`;
  await page.goto(residentialPath);
  await loginWithRealOtp(page, data.editorEmail, residentialPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(page.getByTestId("board-scope-toggle")).toContainText("Wohnbau-Bereich");

  // Umschalten auf Gewerbe: eigenes Board, eigener Badge.
  await page.getByTestId("board-scope-toggle").getByRole("link", { name: "Gewerbe" }).click();
  await expect(page).toHaveURL(/bereich=gewerbe/);
  await expect(page.getByRole("heading", { name: "Anfragen Gewerbe", level: 1 })).toBeVisible();
  await expect(page.getByTestId("board-scope-toggle")).toContainText("Gewerbe-Bereich");

  // Zurück auf Wohnbau.
  await page.getByTestId("board-scope-toggle").getByRole("link", { name: "Wohnbau" }).click();
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  // Unbekannter Bereich → 404-Seite (fail-closed, kein stiller Default,
  // kein Board, keine Karten — das Repo hat keine eigene not-found.tsx,
  // daher zählt der beobachtbare Inhalt, nicht der Statuscode).
  await page.goto(`/w/${workspaceId}/anfragen?bereich=industrie`);
  await expect(page.locator("h1").first()).toHaveText("404");
  await expect(page.getByTestId("board-scope-toggle")).toHaveCount(0);
  await expect(page.getByText("Anfragen Gewerbe")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Bereichs-Grenze").toEqual([]);
});
