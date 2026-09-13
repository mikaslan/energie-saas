import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F16-10 E-Mail-Vorlagen — Chromium-E2E (isolierter Workspace).
 * Einstellungen: 8 fixe Schlüssel sichtbar, Vorschau mit Beispielwerten,
 * Editor ändert Betreff von Portal-Link → Erfolg → nach Reload persistent.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F16-10-E2E-State ist unvollständig (${key}).`);
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

test("F16-10-E2E-01: Editor ändert Portal-Link-Betreff, Vorschau und Persistenz", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const stamp = Date.now();
  const subject = `F16-10 E2E Portal-Betreff ${stamp}`;

  const settingsPath = `/w/${workspaceId}/einstellungen/e-mail-vorlagen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "E-Mail-Vorlagen", level: 1 })).toBeVisible();

  const list = page.locator("section[aria-label=\"Vorlagen\"]");
  await expect(list.locator("article")).toHaveCount(8);

  const portal = list.locator("article").filter({
    has: page.getByRole("heading", { name: "Portal-Link", exact: true }),
  });
  await portal.getByText("Bearbeiten", { exact: true }).click();
  await expect(portal.getByText("Max Mustermann").first()).toBeVisible();
  await portal.getByLabel("Betreff").fill(subject);
  await portal.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(portal.getByText("E-Mail-Vorlage gespeichert.")).toBeVisible();
  await expect(portal.getByLabel("Betreff")).toHaveValue(subject);

  await page.reload();
  await expect(page.getByRole("heading", { name: "E-Mail-Vorlagen", level: 1 })).toBeVisible();
  const portalAfter = page.locator("section[aria-label=\"Vorlagen\"]").locator("article").filter({
    has: page.getByRole("heading", { name: "Portal-Link", exact: true }),
  });
  await portalAfter.getByText("Bearbeiten", { exact: true }).click();
  await expect(portalAfter.getByLabel("Betreff")).toHaveValue(subject);

  expect(errors, "Browser-Konsole und Page-Errors der Vorlagen-Grenze").toEqual([]);
});
