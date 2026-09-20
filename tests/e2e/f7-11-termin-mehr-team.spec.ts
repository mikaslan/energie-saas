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
 * F7-11 Termin-Mehr-Team — Chromium-E2E (isolierter Workspace, Actor ist
 * dort Admin): 2 Teams anlegen → Termin ohne Team anlegen → Drawer-Sektion
 * „Weitere Teams": beide anhaken → Speichern → 2 Extra-Chips → Reload
 * persistent → eines entziehen → 1 Chip → archiviertes Team nicht erneut
 * zuweisbar (Checkbox disabled/nicht vorhanden) → keine Browser-Fehler.
 * RED-Spec: UI (Form, Checkboxen, Chips) existiert noch nicht.
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
      throw new Error(`Der private F7-11-E2E-State ist unvollständig (${key}).`);
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
       select gen_random_uuid(), $1::uuid, 'F7-11 E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'F7-11 E2E Kalender'
          )
        limit 1`,
      [workspaceId, email],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function resolveTeamId(workspaceId: string, teamName: string): Promise<string> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select id from team where workspace_id = $1::uuid and name = $2 limit 1`,
      [workspaceId, teamName],
    );
    const id = result.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`F7-11-E2E: Team nicht gefunden (${teamName}).`);
    return id;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function resolveAppointmentId(workspaceId: string, title: string): Promise<string> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select id from project_appointment
        where workspace_id = $1::uuid and title = $2 limit 1`,
      [workspaceId, title],
    );
    const id = result.rows[0]?.id as string | undefined;
    if (!id) throw new Error(`F7-11-E2E: Termin nicht gefunden (${title}).`);
    return id;
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

test("F7-11-E2E-01: Mehrere Teams parallel je Termin (Weitere Teams)", async ({ page }) => {
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
  const teamAName = `Mehr-Team A E2E ${stamp}`;
  const teamBName = `Mehr-Team B E2E ${stamp}`;
  const appointmentTitle = `Mehr-Team-Termin ${stamp}`;

  // 1) Zwei Teams anlegen (Admin-Einstellungen; auf die Anlage-Sektion
  // scopiert — jede Team-Karte hat ein eigenes "Name"-Rename-Feld).
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  const createSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Team anlegen" }) });
  await createSection.getByLabel("Name", { exact: true }).fill(teamAName);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();
  // UI-settled je Team (CI-Befund 35515454330: generisches Feedback steht noch
  // vom Vorgänger — erst die Karten-Überschrift beweist die Persistenz).
  await expect(page.getByRole("heading", { name: teamAName })).toBeVisible();
  await createSection.getByLabel("Name", { exact: true }).fill(teamBName);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByRole("heading", { name: teamBName })).toBeVisible();
  const teamAId = await resolveTeamId(workspaceId, teamAName);
  const teamBId = await resolveTeamId(workspaceId, teamBName);

  // 2) Projekt + Termin OHNE (Legacy-)Team.
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Mehr-Team");
  await leadForm.getByLabel("Telefon").fill("0151 45678909");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const section = page.locator("#project-appointments");
  await section.getByRole("button", { name: "Termin anlegen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titel").fill(appointmentTitle);
  await dialog.getByLabel("Typ").selectOption("installation");
  const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Beginn").fill(`${day}T10:00`);
  await dialog.getByLabel("Ende", { exact: true }).fill(`${day}T12:00`);
  await dialog.getByLabel("Team").selectOption("Ohne Team");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  const createdArticle = section.getByRole("article").filter({ hasText: appointmentTitle });
  await expect(createdArticle.getByText(appointmentTitle, { exact: true })).toBeVisible();
  const appointmentId = await resolveAppointmentId(workspaceId, appointmentTitle);

  const chipA = page.getByTestId(`planning-board-extra-team-chip-${appointmentId}-${teamAId}`);
  const chipB = page.getByTestId(`planning-board-extra-team-chip-${appointmentId}-${teamBId}`);
  const boxA = page.getByTestId(`planning-board-extra-team-${teamAId}`);
  const boxB = page.getByTestId(`planning-board-extra-team-${teamBId}`);
  const extraForm = page.getByTestId("planning-board-extra-teams-form");
  const saveButton = extraForm.getByRole("button", { name: "Speichern", exact: true });
  const feedback = extraForm.getByText(/zugewiesen|entzogen|gespeichert|erfolgreich|aktualisiert/iu);

  // 3) Tafel: keine Extra-Chips, Bestand („Ohne Team") unverändert, Sektion sichtbar.
  const boardPath = `/w/${workspaceId}/plantafel?week=${day}`;
  await page.goto(boardPath);
  const entryCell = page.locator("li", { hasText: appointmentTitle });
  await expect(entryCell).toBeVisible();
  await expect(chipA).toHaveCount(0);
  await expect(chipB).toHaveCount(0);
  await entryCell.getByRole("link").click();
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText("Ohne Team");
  await expect(page.getByTestId("planning-board-assign-team")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weitere Teams" })).toBeVisible();
  await expect(extraForm).toBeVisible();
  await expect(boxA).toBeEnabled();
  await expect(boxB).toBeEnabled();

  // 4) Beide „Weitere Teams" anhaken → Speichern → 2 Chips → Reload persistent.
  await boxA.check();
  await boxB.check();
  await saveButton.click();
  await expect(feedback).toBeVisible();
  await expect(chipA).toBeVisible();
  await expect(chipA).toHaveAttribute("title", teamAName);
  await expect(chipB).toBeVisible();
  await expect(chipB).toHaveAttribute("title", teamBName);
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText("Ohne Team");
  await page.reload();
  await expect(chipA).toBeVisible();
  await expect(chipA).toHaveAttribute("title", teamAName);
  await expect(chipB).toBeVisible();
  await expect(chipB).toHaveAttribute("title", teamBName);
  await expect(boxA).toBeChecked();
  await expect(boxB).toBeChecked();
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText("Ohne Team");

  // 5) Eines entziehen → 1 Chip → Reload persistent.
  await boxB.uncheck();
  await saveButton.click();
  await expect(feedback).toBeVisible();
  await expect(chipA).toBeVisible();
  await expect(chipB).toHaveCount(0);
  await page.reload();
  await expect(chipA).toBeVisible();
  await expect(chipA).toHaveAttribute("title", teamAName);
  await expect(chipB).toHaveCount(0);
  await expect(boxA).toBeChecked();
  await expect(boxB).not.toBeChecked();

  // 6) Entzogenes Team archivieren → nicht erneut zuweisbar (disabled/nicht
  // vorhanden, kein stiller Fail) → Chip-Stand bleibt 1.
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  const archivedRow = page.locator("section").filter({
    has: page.getByRole("heading", { name: teamBName }),
  });
  await archivedRow.getByRole("button", { name: "Archivieren", exact: true }).click();
  await expect(archivedRow.getByText("Team archiviert.")).toBeVisible();
  await page.goto(boardPath);
  await page.locator("li", { hasText: appointmentTitle }).getByRole("link").click();
  await expect(extraForm).toBeVisible();
  const archivedBoxCount = await boxB.count();
  if (archivedBoxCount > 0) {
    await expect(boxB).toBeDisabled();
  } else {
    expect(archivedBoxCount, "Archiv-Team-Checkbox ist entfernt statt disabled").toBe(0);
  }
  await expect(chipA).toBeVisible();
  await expect(chipB).toHaveCount(0);
  await page.reload();
  await expect(chipA).toBeVisible();
  await expect(chipA).toHaveAttribute("title", teamAName);
  await expect(chipB).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Mehr-Team-Grenze").toEqual([]);
});
