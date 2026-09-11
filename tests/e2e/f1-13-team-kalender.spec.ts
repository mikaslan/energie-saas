import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-13 Team-Kalender — Chromium-E2E (isolierter Workspace, Actor ist dort
 * Admin): Team anlegen + Editor zuordnen → Kalender-Seite: Umfang Team +
 * Team wählen → „Teamkalender angelegt.", Liste zeigt „Team — Name" →
 * Termindialog-Dropdown enthält den Teamkalender.
 */

type E2EState = {
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1-13-E2E-State ist unvollständig (${key}).`);
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

test("F1-13-E2E-01: Teamkalender anlegen und im Dialog sehen", async ({ page }) => {
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

  const stamp = Date.now();
  const teamName = `Kalender-Team E2E ${stamp}`;
  const calendarName = `Team-Montage E2E ${stamp}`;

  // 1) Team + Editor-Zuordnung (Admin-Einstellungen).
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  const createSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Team anlegen" }),
  });
  await createSection.getByLabel("Name", { exact: true }).fill(teamName);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();
  const teamRow = page.locator("section").filter({
    has: page.getByRole("heading", { name: teamName }),
  });
  await teamRow.getByRole("checkbox", { name: data.editorEmail }).check();
  await teamRow.getByRole("button", { name: "Mitglieder speichern", exact: true }).click();
  await expect(teamRow.getByText("Mitglieder gespeichert.")).toBeVisible();

  // 2) Teamkalender per Manager anlegen.
  await page.goto(`/w/${workspaceId}/kalender`);
  const createForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kalender anlegen" }),
  });
  await createForm.getByLabel("Name").fill(calendarName);
  await createForm.getByLabel("Umfang").selectOption("team");
  await page.waitForTimeout(500);
  await createForm.locator('select[name="teamId"]').selectOption({ label: teamName });
  await createForm.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Teamkalender angelegt.")).toBeVisible();
  await expect(page.getByText(`Team — ${teamName}`, { exact: false })).toBeVisible();

  // 3) Projekt + Dialog: Teamkalender steht in der Kalender-Auswahl.
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Teamkalender");
  await leadForm.getByLabel("Telefon").fill("0151 45678910");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const section = page.locator("#project-appointments");
  await section.getByRole("button", { name: "Termin anlegen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Kalender").locator("option", { hasText: calendarName }))
    .toHaveCount(1);

  expect(errors, "Browser-Konsole und Page-Errors der Kalender-Grenze").toEqual([]);
});
