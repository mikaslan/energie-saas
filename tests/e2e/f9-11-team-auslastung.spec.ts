import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-11 Workspace-Team-Auslastung — Chromium-E2E (RED-first).
 *
 * Bindung: `docs/spec/F9-11-team-auslastung.md` (Abschnitte UI + Tests).
 * Diese Datei MUSS rot sein, bis Seite und Service existieren: Die Seite
 * `/w/[workspaceId]/team-auslastung` gibt es noch nicht.
 *
 * Seed (EIGENER isolierter Workspace per randomUUID + Membership-Insert,
 * NIEMALS W3 — der Read ist workspace-weit, W3-Projekte wuerden fremde
 * Spec-Eintraege mitsummieren): Zwei Projekte per DB-Fixture (Kontakt +
 * Site + Projekt am Default-Board, F9.4-D-Muster — Projektanlage ist
 * F1/F12-Flaeche mit eigener E2E-Abdeckung), je ein Zeiteintrag per UI
 * (90 + 60), dazu ein Zweitmitglied-Eintrag per UI (zweite
 * Login-Session, F9.3-Muster).
 * Die Team-Seite zeigt das Mitglied mit „2 Std. 30 Min."; der Nutzerfilter
 * blendet das Zweitmitglied aus.
 *
 * Festgeschriebene UI-Namen (fuer die Implementierung bindend, F9.4-D-Muster):
 * - Tabelle mit Spalten Mitglied / Einträge / Summe / Status
 *   (`formatDuration`-Muster: „2 Std. 30 Min.", Status „läuft" / „—").
 * - GET-Filterformular (UserFilterForm-Muster): Mitglieder-Checkboxen mit
 *   E-Mail-Label, Von/Bis-Datumsfelder, Button „Filtern" (exact),
 *   Reset-Link „Zurücksetzen".
 * - Leere Menge → „Keine Einträge im Filter." (gleicher Wortlaut).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  editorIdentityId: string;
  restrictedEditorEmail: string;
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
    "restrictedEditorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9-11-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F9-11-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

/** Eigener isolierter Workspace + Editor- und Zweitmitglied-Membership (F16-14-Muster). */
async function seedIsolatedWorkspace(): Promise<{ workspaceId: string }> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email in ($1, $2)",
      [data.editorEmail, data.restrictedEditorEmail],
    );
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    const secondId = identities.rows.find((row) => row.email === data.restrictedEditorEmail)?.id;
    if (!editorId) throw new Error("F9-11-E2E: Editor-Identität fehlt.");
    if (!secondId) throw new Error("F9-11-E2E: Zweitmitglied-Identität fehlt.");
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        workspaceId,
        "F9-11 isolierter Team-Workspace",
      ]);
      // Membership-DML verlangt Workspace-Kontext (RLS) auf derselben Verbindung.
      await client.query(
        "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
        [workspaceId],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb),
                ($1::uuid, $3::uuid, 'editor', '{}'::jsonb)`,
        [workspaceId, editorId, secondId],
      );
    } finally {
      client.release();
    }
    return { workspaceId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

/** Projekt per DB-Fixture (F9.4-D-Muster): Kontakt + Site + Projekt am Default-Board. */
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
      throw new Error("F9-11-E2E: Projekt-Seed ohne Default-Board.");
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

async function createEntryViaUi(
  page: Page,
  start: string,
  end: string,
  minutes: string,
  comment: string,
): Promise<void> {
  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true }),
  });
  await expect(form).toBeVisible();
  await form.getByLabel("Beginn").fill(start);
  await form.getByLabel("Ende").fill(end);
  await form.getByLabel("Arbeitszeit (Minuten)").fill(minutes);
  await form.getByLabel("Kommentar").fill(comment);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F9-11-E2E-01: Team-Auslastung summiert workspace-weit, Nutzerfilter blendet aus", async ({ page }) => {
  test.setTimeout(300_000);
  const data = state();
  const { workspaceId } = await seedIsolatedWorkspace();
  const stamp = randomUUID().slice(0, 8);

  const projectA = await seedProjectViaDb(
    data.databaseUrl, workspaceId, data.editorIdentityId,
    `f911-a-${stamp}@e2e.test`, `F911 Projekt A ${stamp}`,
  );
  const projectB = await seedProjectViaDb(
    data.databaseUrl, workspaceId, data.editorIdentityId,
    `f911-b-${stamp}@e2e.test`, `F911 Projekt B ${stamp}`,
  );

  await loginWithRealOtp(page, data.editorEmail, `/w/${workspaceId}/anfragen/${projectA}/zeiterfassung`);

  const commentA = `F911-Eintrag-A-${stamp}`;
  await page.goto(`/w/${workspaceId}/anfragen/${projectA}/zeiterfassung`);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntryViaUi(page, "2026-03-10T10:00", "2026-03-10T11:30", "90", commentA);

  const commentB = `F911-Eintrag-B-${stamp}`;
  await page.goto(`/w/${workspaceId}/anfragen/${projectB}/zeiterfassung`);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntryViaUi(page, "2026-03-11T14:00", "2026-03-11T15:00", "60", commentB);

  // Zweitmitglied bucht per UI in Projekt A (zweite Login-Session, F9.3-Muster).
  const secondComment = `F911-Eintrag-Zweit-${stamp}`;
  const projectAPath = `/w/${workspaceId}/anfragen/${projectA}/zeiterfassung`;
  await page.context().clearCookies();
  await loginWithRealOtp(page, data.restrictedEditorEmail, projectAPath);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntryViaUi(page, "2026-03-10T14:00", "2026-03-10T14:30", "30", secondComment);

  // Team-Seite (RED-first: Route existiert noch nicht).
  const teamPath = `/w/${workspaceId}/team-auslastung`;
  await page.context().clearCookies();
  await loginWithRealOtp(page, data.editorEmail, teamPath);

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Mitglied" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Einträge" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Summe" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Status" })).toBeVisible();

  // 90 + 60 = 150 Minuten = „2 Std. 30 Min." (eine Zeile, workspace-weit).
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(table.getByText("2 Std. 30 Min.", { exact: true })).toBeVisible();
  await expect(table.getByText(data.restrictedEditorEmail, { exact: true })).toBeVisible();

  // Filterformular (GET-Muster): Mitglieder-Checkboxen + Von/Bis + Filtern + Reset.
  await expect(page.getByLabel("Von")).toBeVisible();
  await expect(page.getByLabel("Bis")).toBeVisible();
  await page.getByLabel(data.editorEmail).check();
  await page.getByRole("button", { name: "Filtern", exact: true }).click();
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(table.getByText("2 Std. 30 Min.", { exact: true })).toBeVisible();
  await expect(table.getByText(data.restrictedEditorEmail, { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Zurücksetzen" }).click();
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(table.getByText(data.restrictedEditorEmail, { exact: true })).toBeVisible();

  // Leere Menge: Zeitraum außerhalb aller Einträge → Spec-Wortlaut, kein toter Kopf.
  await page.getByLabel("Von").fill("2030-01-01");
  await page.getByRole("button", { name: "Filtern", exact: true }).click();
  await expect(page.getByText("Keine Einträge im Filter.", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);

  await page.getByRole("link", { name: "Zurücksetzen" }).click();
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();

  // Toleranz-Pins (P1-Review): ungueltiges Datum + gedrehter Zeitraum
  // fallen tolerant auf ungefiltert zurueck (200, kein 500).
  await page.goto(`${teamPath}?startDate=2026-02-30`);
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(table.getByText(data.restrictedEditorEmail, { exact: true })).toBeVisible();
  await page.goto(`${teamPath}?startDate=2030-01-02&endDate=2030-01-01`);
  await expect(table.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(table.getByText(data.restrictedEditorEmail, { exact: true })).toBeVisible();

  // Breakpoints ohne horizontales Scrollen + Axe (M1-09-Muster).
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F9-11-Team-Auslastung");
});
