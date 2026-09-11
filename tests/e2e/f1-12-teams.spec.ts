import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F1-12 Teams Slice 1 — Chromium-E2E (isolierter Workspace, Actor ist
 * dort Admin): Team anlegen + Mitglied zuordnen → Termin mit Team
 * anlegen → Teamname sichtbar; Archivieren entfernt das Team aus dem
 * Dropdown, der Termin behält den Namen.
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
      throw new Error(`Der private F1-12-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedTenancyCalendar(workspaceId: string, email: string): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select gen_random_uuid(), $1::uuid, 'F1-12 E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'F1-12 E2E Kalender'
          )
        limit 1`,
      [workspaceId, email],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
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

test("F1-12-E2E-01: Team anlegen, zuordnen, archivieren", async ({ page }) => {
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
  await seedTenancyCalendar(workspaceId, data.editorEmail);
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  const stamp = Date.now();
  const teamName = `Montageteam E2E ${stamp}`;
  const appointmentTitle = `Team-Montage ${stamp}`;

  // 1) Team anlegen + Mitglied zuordnen (Admin-Einstellungen).
  const settingsPath = `/w/${workspaceId}/einstellungen/teams`;
  await page.goto(settingsPath);
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();
  const teamRow = page.locator("section").filter({ has: page.getByRole("heading", { name: teamName }) });
  await teamRow.getByRole("checkbox", { name: data.editorEmail }).check();
  await teamRow.getByRole("button", { name: "Mitglieder speichern", exact: true }).click();
  await expect(teamRow.getByText("Mitglieder gespeichert.")).toBeVisible();

  // 2) Projekt anlegen, Termin mit Team anlegen.
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Teams");
  await leadForm.getByLabel("Telefon").fill("0151 45678908");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectPath = new URL(page.url()).pathname;

  const section = page.locator("#project-appointments");
  await expect(section.getByRole("heading", { name: "Termine", level: 2 })).toBeVisible();
  await section.getByRole("button", { name: "Termin anlegen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Termin anlegen", level: 2 })).toBeVisible();
  await dialog.getByLabel("Titel").fill(appointmentTitle);
  await dialog.getByLabel("Typ").selectOption("installation");
  const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Beginn").fill(`${day}T10:00`);
  await dialog.getByLabel("Ende", { exact: true }).fill(`${day}T12:00`);
  await dialog.getByLabel("Team").selectOption({ label: teamName });
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  const created = section.getByRole("article").filter({ hasText: appointmentTitle });
  await expect(created.getByText(appointmentTitle, { exact: true })).toBeVisible();
  await expect(created.getByText(`Team: ${teamName}`, { exact: true })).toBeVisible();

  // 3) Archivieren: Dropdown ohne Team, Termin behält den Namen.
  await page.goto(settingsPath);
  const archivedRow = page.locator("section").filter({ has: page.getByRole("heading", { name: teamName }) });
  await archivedRow.getByRole("button", { name: "Archivieren", exact: true }).click();
  await expect(archivedRow.getByText("Team archiviert.")).toBeVisible();

  await page.goto(projectPath);
  const reread = page.locator("#project-appointments");
  const kept = reread.getByRole("article").filter({ hasText: appointmentTitle });
  await expect(kept.getByText(`Team: ${teamName}`, { exact: true })).toBeVisible();
  await kept.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByRole("heading", { name: "Termin bearbeiten", level: 2 })).toBeVisible();
  await expect(editDialog.getByLabel("Team").locator("option")).toHaveText(["Ohne Team"]);
  await editDialog.getByRole("button", { name: "Termineditor schließen" }).click();

  expect(errors, "Browser-Konsole und Page-Errors der Team-Grenze").toEqual([]);
});
