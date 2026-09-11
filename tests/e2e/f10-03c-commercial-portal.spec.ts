import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F10-03c Commercial-Portal ohne Angebot/Signatur — Chromium-E2E.
 *
 * Katalog F10.3: Kein Preis-/Signatur-Bereich im Commercial-Portal.
 * Gewerbe-Projekt per SQL seeden + Portal-Link per UI → öffentlicher
 * Link zeigt KEINEN Dokumentenbereich (kein „Dokumente", kein
 * „Angebot"), Termine-/Installation-Tabs bleiben. Wohnbau-Kontrolle
 * (f102) zeigt den Dokumentenbereich weiterhin.
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const COMMERCIAL_CONTACT_ID = "c003c000-0000-4000-8000-000000000001";
const COMMERCIAL_SITE_ID = "c003c000-0000-4000-8000-000000000002";
const COMMERCIAL_PROJECT_ID = "c003c000-0000-4000-8000-000000000003";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f102ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10-03c-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedCommercialProject(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
       values ($1::uuid, $2::uuid, 'F1003c Gewerbe GmbH', 'F10', 'Fixture',
               'gewerbe@f1003c.test', 'gewerbe@f1003c.test')
       on conflict (id) do update set display_name = excluded.display_name`,
      [COMMERCIAL_CONTACT_ID, data.w3WorkspaceId],
    );
    await pool.query(
      `insert into site (id, workspace_id, contact_id, label)
       values ($1::uuid, $2::uuid, $3::uuid, 'F1003c Gewerbe-Standort')
       on conflict (id) do update set label = excluded.label`,
      [COMMERCIAL_SITE_ID, data.w3WorkspaceId, COMMERCIAL_CONTACT_ID],
    );
    await pool.query(
      `insert into project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, source_key
       )
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id, intake_column.id,
              'F1003c Gewerbe-Projekt', 'fixture'
         from kanban_board board
         join kanban_column intake_column
           on intake_column.workspace_id = board.workspace_id
          and intake_column.board_id = board.id
          and intake_column.is_intake = true
          and intake_column.archived_at is null
        where board.workspace_id = $2::uuid
          and board.scope = 'commercial'
          and board.is_default = true
          and board.archived_at is null
       on conflict (id) do update set name = excluded.name`,
      [COMMERCIAL_PROJECT_ID, data.w3WorkspaceId, COMMERCIAL_CONTACT_ID, COMMERCIAL_SITE_ID],
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
  expect(current.pathname).toBe("/login");
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
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function createPortalTokenPath(page: Page, projectPath: string): Promise<string> {
  await page.goto(projectPath);
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
  return tokenPath;
}

test("F10-03c-E2E-01: Gewerbe-Portal ohne Dokumente, Wohnbau mit", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await seedCommercialProject();
  const commercialPath = `/w/${data.w3WorkspaceId}/anfragen/${COMMERCIAL_PROJECT_ID}`;
  await page.goto(commercialPath);
  await loginWithRealOtp(page, data.editorEmail, commercialPath);

  const commercialToken = await createPortalTokenPath(page, commercialPath);
  await page.goto(commercialToken);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Angebot/u).first()).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Termine/u })).toBeVisible();
  await expect(page.getByRole("link", { name: "Installation", exact: true })).toBeVisible();

  const residentialToken = await createPortalTokenPath(
    page, `/w/${data.w3WorkspaceId}/anfragen/${data.f102ProjectId}`,
  );
  await page.goto(residentialToken);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Portal-Grenze").toEqual([]);
});
