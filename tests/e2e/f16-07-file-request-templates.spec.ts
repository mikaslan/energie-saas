import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F16-07 Datei-Anfragen-Vorlagen — Chromium-E2E (isolierter Workspace).
 * Einstellungen: Vorlage anlegen → Projektakte: aus Vorlage anlegen →
 * offene Datei-Anfrage mit Titel-Preset sichtbar. (Viewer fail-closed ist
 * DB-seitig belegt; der isolierte Harness kennt nur den Editor.)
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
      throw new Error(`Der private F16-07-E2E-State ist unvollständig (${key}).`);
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

test("F16-07-E2E-01: Editor legt Datei-Vorlage an und wendet sie am Projekt an", async ({ page }) => {
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
  const templateName = `F16-07 E2E Vorlage ${stamp}`;
  const templateTitle = `F16-07 E2E Stromrechnung ${stamp}`;

  const settingsPath = `/w/${workspaceId}/einstellungen/datei-anfragen-vorlagen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Datei-Anfragen-Vorlagen", level: 1 })).toBeVisible();

  const createSection = page.locator("section[aria-label=\"Neue Vorlage\"]");
  await createSection.getByLabel("Name").fill(templateName);
  await createSection.getByLabel("Anfrage-Titel").fill(templateTitle);
  await createSection.getByLabel("Beschreibung (optional)").fill("Jahresabrechnung als PDF");
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.locator("section[aria-label=\"Vorlagen\"]").getByRole("heading", { name: templateName })).toBeVisible();

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Dateivorlage");
  await form.getByLabel("Telefon").fill("0151 45678904");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const files = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await files.getByLabel("Dateivorlage").selectOption({ label: `${templateName} – ${templateTitle}` });
  await files.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
  await expect(files.getByTestId("file-request-apply-feedback")).toContainText("aus Vorlage angelegt");
  const item = files.locator("li", { hasText: templateTitle });
  await expect(item).toBeVisible();
  await expect(item.getByTestId("file-request-status")).toHaveText("Offen");

  expect(errors, "Browser-Konsole und Page-Errors der Vorlagen-Grenze").toEqual([]);
});
