import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-10 Kundenchat zur Förderakte — Chromium-E2E (isolierter
 * Workspace). Editor legt die Förderakte an und schreibt intern →
 * Portal zeigt die Nachricht; Kunde antwortet im Portal → intern
 * sichtbar mit Kunden-Kennzeichnung.
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
      throw new Error(`Der private F13-10-E2E-State ist unvollständig (${key}).`);
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

test("F13-10-E2E-01: Chat intern ↔ Portal in beide Richtungen", async ({ page }) => {
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
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Subsidy-Chat");
  await leadForm.getByLabel("Telefon").fill("0151 45678910");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectPath = new URL(page.url()).pathname;

  // Förderakte anlegen (idempotent).
  await page.getByTestId("subsidy-case-create").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("Status:");

  // Intern schreiben.
  const stamp = Date.now();
  const internalText = `BzA ist eingereicht ${stamp}.`;
  const customerText = `Wann kommt der Bescheid ${stamp}?`;
  const chat = page.getByTestId("subsidy-chat-block");
  await chat.getByTestId("subsidy-chat-body").fill(internalText);
  await chat.getByTestId("subsidy-chat-send").click();
  await expect(page.getByTestId("subsidy-chat-feedback")).toContainText("Nachricht gesendet.");

  // Portal-Link erstellen und Verlauf prüfen.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(tokenPath);
  const subsidy = page.getByTestId("portal-subsidy-section");
  await expect(subsidy).toBeVisible();
  await expect(subsidy.getByText(internalText, { exact: true })).toBeVisible();

  // Kunde antwortet im Portal.
  await subsidy.getByTestId("portal-chat-body").fill(customerText);
  await subsidy.getByTestId("portal-chat-send").click();
  await expect(page.getByTestId("portal-chat-feedback")).toContainText("Nachricht gesendet.");
  await expect(subsidy.getByText(customerText, { exact: true })).toBeVisible();

  // Intern ist die Kundennachricht mit Kennzeichnung sichtbar.
  await page.goto(projectPath);
  const chatAgain = page.getByTestId("subsidy-chat-block");
  await expect(chatAgain.getByText(customerText, { exact: true })).toBeVisible();
  await expect(chatAgain.getByText(internalText, { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Chat-Grenze").toEqual([]);
});
