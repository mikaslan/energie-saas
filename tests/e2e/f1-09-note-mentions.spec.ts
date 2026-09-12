import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-09 @-Mentions — Chromium-E2E (isolierter Workspace).
 * Editor erfasst eine Notiz mit auflösbarer @-Ref (eigene
 * Mitglieds-E-Mail) plus Phantom-Ref; nach Reload rendert die
 * auflösbare Ref als Mention-Chip, die Phantom-Ref als Rohtext.
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
      throw new Error(`Der private F1-09-E2E-State ist unvollständig (${key}).`);
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

test("F1-09-E2E-06: @-Ref wird Chip, Phantom-Ref bleibt Text", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Notiz-Mentions");
  await form.getByLabel("Telefon").fill("0151 45678906");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const editorLower = data.editorEmail.toLowerCase();
  const phantom = "phantom-f109@nicht-mitglied.test";
  const stamp = Date.now();
  const noteText = `Rückfrage ${stamp} an @${data.editorEmail} sowie @${phantom} bitte prüfen`;

  const notes = page.locator("section#project-notes");
  await notes.getByRole("button", { name: "Notiz anlegen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Notiztext" }).click();
  await dialog.getByRole("textbox", { name: "Notiztext" }).pressSequentially(noteText);
  await dialog.getByRole("button", { name: "Notiz anlegen" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  const notesAfterReload = page.locator("section#project-notes");
  await expect(notesAfterReload.getByTestId(`note-mention-${editorLower}`)).toBeVisible();
  await expect(notesAfterReload.getByText(`@${phantom}`, { exact: false })).toBeVisible();
  await expect(notesAfterReload.getByTestId(`note-mention-${phantom}`)).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Mention-Grenze").toEqual([]);
});
