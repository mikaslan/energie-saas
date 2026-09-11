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
 * F7-06 Disposition Slice 1 — Chromium-E2E (isolierter Workspace, Actor ist
 * dort Admin): Termin ohne Team anlegen → Tafel ohne Chip → Drawer zeigt
 * „Ohne Team" → Team zuweisen → Chip sichtbar → entziehen → Chip weg →
 * Anlageformular kennt das Team-Dropdown → Anlage mit Team trägt Chip.
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
      throw new Error(`Der private F7-06-E2E-State ist unvollständig (${key}).`);
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
       select gen_random_uuid(), $1::uuid, 'F7-06 E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'F7-06 E2E Kalender'
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

test("F7-06-E2E-01: Team-Blockzuweisung auf der Plantafel", async ({ page }) => {
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
  const teamName = `Dispo-Team E2E ${stamp}`;
  const appointmentTitle = `Dispo-Termin ${stamp}`;
  const createdTitle = `Dispo-Anlage ${stamp}`;

  // 1) Team anlegen (Admin-Einstellungen).
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  await page.getByLabel("Name", { exact: true }).fill(teamName);
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();

  // 2) Projekt + Termin OHNE Team (Dialog wie bisher).
  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Dispo");
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

  // 3) Tafel: kein Chip, Drawer „Ohne Team".
  const boardPath = `/w/${workspaceId}/plantafel?week=${day}`;
  await page.goto(boardPath);
  const entryCell = page.locator("li", { hasText: appointmentTitle });
  await expect(entryCell).toBeVisible();
  await expect(entryCell.getByText(teamName, { exact: true })).toHaveCount(0);
  await entryCell.getByRole("link").click();
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText("Ohne Team");

  // 4) Zuweisen → Feedback → nach Reload Chip + Drawer-Team.
  await page.getByTestId("planning-board-assign-team").selectOption({ label: teamName });
  await page.getByTestId("planning-board-assign-submit").click();
  await expect(page.getByTestId("planning-board-assign-feedback")).toHaveText(
    "Team zugewiesen — der Eintrag trägt das Team in der Tafelwoche.",
  );
  await page.reload();
  await expect(
    page.locator("li", { hasText: appointmentTitle }).getByText(teamName, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText(teamName);

  // 5) Entziehen → nach Reload kein Chip, Drawer „Ohne Team".
  await page.getByTestId("planning-board-assign-team").selectOption("Ohne Team");
  await page.getByTestId("planning-board-assign-submit").click();
  await expect(page.getByTestId("planning-board-assign-feedback")).toHaveText(
    "Team entzogen — der Eintrag steht ohne Team in der Tafelwoche.",
  );
  await page.reload();
  await expect(
    page.locator("li", { hasText: appointmentTitle }).getByText(teamName, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("planning-board-drawer-team")).toHaveText("Ohne Team");

  // 6) Anlageformular: Team-Dropdown vorhanden, Anlage mit Team trägt Chip.
  await page.goto(boardPath);
  await page.getByRole("link", { name: `Termin am ${day} für` }).first().click();
  const createForm = page.locator("section[aria-label='Termin anlegen']");
  await expect(createForm).toBeVisible();
  await createForm.getByLabel("Titel").fill(createdTitle);
  await createForm.getByLabel("Team (optional)").selectOption({ label: teamName });
  await createForm.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Termin angelegt — er steht in der Tafelwoche.")).toBeVisible();
  await page.goto(boardPath);
  await expect(
    page.locator("li", { hasText: createdTitle }).getByText(teamName, { exact: true }),
  ).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Dispositions-Grenze").toEqual([]);
});
