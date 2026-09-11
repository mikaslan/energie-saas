import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-09 Netzstand im Portal — Chromium-E2E (isolierter Workspace).
 * Akte: Netzanmeldung anlegen → Betreiber/Zähler setzen → einreichen →
 * Portal-Link per UI → Übersicht zeigt Netzstand (ohne Zählernummer).
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
      throw new Error(`Der private F13-09-E2E-State ist unvollständig (${key}).`);
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

test("F13-09-E2E-01: Portal-Übersicht zeigt Netzstand ohne Zählernummer", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Netzportal");
  await form.getByLabel("Telefon").fill("0151 45678902");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  await page.getByTestId("grid-registration-create").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("In Vorbereitung");
  await page.getByTestId("grid-registration-operator").fill("Netz E2E GmbH");
  await page.getByTestId("grid-registration-meter").fill("1EZ9990001112");
  await page.getByTestId("grid-registration-save").click();
  await expect(page.getByTestId("grid-registration-details-feedback")).toContainText("Angaben gespeichert.");
  await page.getByTestId("grid-registration-to-eingereicht").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("Eingereicht");

  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(tokenPath);
  const grid = page.getByTestId("portal-grid-section");
  await expect(grid).toBeVisible();
  await expect(page.getByTestId("portal-grid-status")).toContainText("Eingereicht");
  await expect(page.getByTestId("portal-grid-status")).toContainText("Netz E2E GmbH");
  // Interne Betriebsreferenz tritt nie ins Portal aus.
  await expect(page.locator("main")).not.toContainText("1EZ9990001112");

  expect(errors, "Browser-Konsole und Page-Errors der Netzportal-Grenze").toEqual([]);
});
