import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-24 Kommunikations-Events im Projekt-Feed — Chromium-E2E (RED).
 * Editor legt einen Termin an und schreibt eine Notiz mit @-Mention;
 * beide Einträge erscheinen in der Projekt-Timeline (section#project-activity
 * aus project-activity-panel.tsx — das Panel hat keine testids) und bleiben
 * nach Reload persistent. Keine Browser-Konsolenfehler.
 * ANNAHME (Spec legt Labels nicht fest): "Termin erstellt" / "Erwähnung".
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
      throw new Error(`Der private F1-24-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function berlinTomorrow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 36 * 3600 * 1000));
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

async function seedTenancyCalendar(workspaceId: string, actorId: string): Promise<void> {
  await poolOne(async (pool) => {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       values (gen_random_uuid(), $1::uuid, 'F1-24 E2E Kalender', 'tenancy', $2::uuid)`,
      [workspaceId, actorId],
    );
  });
}

test("F1-24-E2E-01: Termin + Mention erscheinen in der Timeline (persistent)", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  await seedTenancyCalendar(workspaceId, actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Kommunikations-Feed");
  await form.getByLabel("Telefon").fill("0151 45678924");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const stamp = Date.now();
  const appointmentTitle = `F1-24 E2E Termin ${stamp}`;

  const appointments = page.locator("#project-appointments");
  await expect(appointments.getByRole("heading", { name: "Termine", level: 2 })).toBeVisible();
  await appointments.getByRole("button", { name: "Termin anlegen" }).click();
  const appointmentDialog = page.getByRole("dialog");
  await expect(appointmentDialog.getByRole("heading", { name: "Termin anlegen", level: 2 }))
    .toBeVisible();
  const calendar = appointmentDialog.getByLabel("Kalender");
  await expect(calendar.locator("option")).toHaveText(["F1-24 E2E Kalender"]);
  const date = berlinTomorrow();
  await appointmentDialog.getByLabel("Titel").fill(appointmentTitle);
  await appointmentDialog.getByLabel("Typ").selectOption("on_site");
  await appointmentDialog.getByLabel("Beginn").fill(`${date}T10:00`);
  await appointmentDialog.getByLabel("Ende", { exact: true }).fill(`${date}T11:00`);
  await appointmentDialog.getByRole("checkbox", { name: data.editorEmail }).check();
  await appointmentDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(appointmentDialog).toHaveCount(0);
  await expect(
    appointments.locator("article").filter({ hasText: appointmentTitle }),
  ).toBeVisible();

  const noteText = `Bitte prüfen @${data.editorEmail} F1-24 ${stamp}`;
  const notes = page.locator("section#project-notes");
  await notes.getByRole("button", { name: "Notiz anlegen" }).click();
  const noteDialog = page.getByRole("dialog");
  await expect(noteDialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
  await noteDialog.getByRole("textbox", { name: "Notiztext" }).click();
  await noteDialog.getByRole("textbox", { name: "Notiztext" }).pressSequentially(noteText);
  await noteDialog.getByRole("button", { name: "Notiz anlegen" }).click();
  await expect(noteDialog).toHaveCount(0);

  const timeline = page.locator("section#project-activity");
  await expect(timeline.getByRole("heading", { name: "Interne Aktivität" })).toBeVisible();
  await page.reload();
  await expect(timeline.getByText("Notiz erstellt", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Termin erstellt", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Erwähnung", { exact: true })).toBeVisible();

  await page.reload();
  await expect(timeline.getByText("Termin erstellt", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Erwähnung", { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors des Kommunikations-Feeds").toEqual([]);
});
