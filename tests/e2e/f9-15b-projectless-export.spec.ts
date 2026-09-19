import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-15b projektlos CSV-Export — Chromium-E2E.
 * Bindung: `docs/spec/F9-15-projektlos-folge.md` (Track R1b).
 * Seed: EIGENER isolierter Workspace (NIEMALS W3) + 1 Projekt per DB.
 * Erwartung: CSV-Download enthält projektlose Zeile, keine Projekt-Zeile.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  editorIdentityId: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "editorEmail",
    "editorIdentityId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9-15b-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
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
  throw new Error("Der echte F9-15b-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.goto(`/login?${new URLSearchParams({ next: expectedPath }).toString()}`);
  await page.waitForURL((url) => url.pathname === "/login");

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  await expect(page).toHaveTitle(/.+/u);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function seedIsolatedWorkspace(): Promise<{ workspaceId: string }> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email = $1",
      [data.editorEmail],
    );
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!editorId) throw new Error("F9-15b-E2E: Editor-Identität fehlt.");
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        workspaceId,
        "F9-15b isolierter Export-Workspace",
      ]);
      await client.query(
        "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
        [workspaceId],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb)`,
        [workspaceId, editorId],
      );
    } finally {
      client.release();
    }
    return { workspaceId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function seedProjectViaDb(
  databaseUrl: string,
  workspaceId: string,
  actorId: string,
  contactEmail: string,
  projectName: string,
): Promise<string> {
  const pool = createDrainTrackedPool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId]);
    const contactId = randomUUID();
    await client.query(
      `insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
      [contactId, workspaceId, projectName, "F9", "Fixture", contactEmail, contactEmail],
    );
    const siteId = randomUUID();
    await client.query(
      `insert into site (id, workspace_id, contact_id, label) values ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [siteId, workspaceId, contactId, projectName],
    );
    const projectId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id, intake_column.id, $5, 'fixture'
         from kanban_board board
         join kanban_column intake_column
           on intake_column.workspace_id = board.workspace_id
          and intake_column.board_id = board.id
          and intake_column.is_intake = true
          and intake_column.archived_at is null
        where board.workspace_id = $2::uuid
          and board.scope = 'residential'
          and board.is_default = true
          and board.archived_at is null
       returning id`,
      [projectId, workspaceId, contactId, siteId, projectName],
    );
    if (inserted.rows[0]?.id !== projectId) {
      throw new Error("F9-15b-E2E: Projekt-Seed ohne Default-Board.");
    }
    await client.query("commit");
    return projectId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F915b-E2E-01: projektlos CSV exportieren enthält nur projektlose Zeilen", async ({ page }) => {
  test.setTimeout(300_000);
  const data = state();
  const { workspaceId } = await seedIsolatedWorkspace();
  const stamp = randomUUID().slice(0, 8);
  const projectComment = `F915b Projekt ${stamp}`;
  const freeComment = `F915b Frei ${stamp}`;

  const projectId = await seedProjectViaDb(
    data.databaseUrl, workspaceId, data.editorIdentityId,
    `f915b-${stamp}@e2e.test`, `F915b Projekt ${stamp}`,
  );

  // Projekt-Eintrag auf der Projektseite anlegen (Negativ-Beleg).
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`;
  await loginWithRealOtp(page, data.editorEmail, projectPath);
  await page.getByLabel("Ereignistyp").selectOption({ label: "Travel" });
  await page.getByLabel("Beginn").fill("2026-09-06T08:00");
  await page.getByLabel("Ende").fill("2026-09-06T09:00");
  await page.getByLabel("Arbeitszeit (Minuten)").fill("60");
  await page.getByLabel("Kommentar").fill(projectComment);
  await page.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();

  // Projektlosen Eintrag auf der Workspace-Route anlegen.
  const freePath = `/w/${workspaceId}/zeiterfassung-ohne-projekt`;
  await page.goto(freePath);
  await page.getByLabel("Ereignistyp").selectOption({ label: "Office" });
  await page.getByLabel("Beginn").fill("2026-09-06T10:00");
  await page.getByLabel("Ende").fill("2026-09-06T12:00");
  await page.getByLabel("Arbeitszeit (Minuten)").fill("120");
  await page.getByLabel("Kommentar").fill(freeComment);
  await page.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();

  // Export laden und Inhalt prüfen (M2-03a-Download-Muster).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "CSV exportieren", exact: true }).click(),
  ]);
  const filePath = await download.path();
  if (!filePath) throw new Error("F915b-E2E: kein Download-Pfad.");
  const content = readFileSync(filePath, "utf8");
  expect(content).toContain("datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id");
  expect(content).toContain(freeComment);
  expect(content).not.toContain(projectComment);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F9-15b-Export");
});
