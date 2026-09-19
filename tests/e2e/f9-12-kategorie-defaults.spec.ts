import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-12 Default-4er-Kategorie-Satz — Chromium-E2E (RED-first).
 *
 * Bindung: `docs/spec/F9-12-kategorie-defaults.md` (§4.3, F912-E2E-01).
 * Diese Datei MUSS rot sein, bis Migration 0149 existiert: Jeder neue
 * Workspace startet derzeit mit einer leeren Kategorie-Liste
 * (`listTimeEventTypes` → `[]`, „Noch keine Ereignistypen angelegt.").
 *
 * Seed (EIGENER isolierter Workspace per randomUUID + Membership-Insert,
 * NIEMALS W3 — die 4 Defaults sind nur in einem frischen Workspace exakt
 * zählbar; W3 trüge fremde Spec-Typen): Workspace + Editor-Membership per
 * DB (F9-11-Muster), ein Projekt per DB-Fixture (Kontakt + Site + Projekt
 * am Default-Board, F9.4-D-Muster — Projektanlage ist F1/F12-Fläche mit
 * eigener E2E-Abdeckung), Zeiteintrag per UI mit Typ-Auswahl `Travel`.
 *
 * Erwartung: `einstellungen/ereignistypen` listet genau die 4 Defaults in
 * Blaupause-Reihenfolge Travel/On-site/Office/Other; der Eintrag speichert
 * per UI-Select mit `Travel` und zeigt das Typ-Label.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  editorIdentityId: string;
};

const EXPECTED_DEFAULTS = ["Travel", "On-site", "Office", "Other"] as const;

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
    throw new Error("Der private F9-12-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F9-12-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

/** Eigener isolierter Workspace + Editor-Membership (F9-11/F16-14-Muster). */
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
    if (!editorId) throw new Error("F9-12-E2E: Editor-Identität fehlt.");
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        workspaceId,
        "F9-12 isolierter Kategorie-Workspace",
      ]);
      // Membership-DML verlangt Workspace-Kontext (RLS) auf derselben Verbindung.
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
      throw new Error("F9-12-E2E: Projekt-Seed ohne Default-Board.");
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

test("F912-E2E-01: Default-Kategorien in Reihenfolge, Eintrag mit Travel per UI", async ({ page }) => {
  test.setTimeout(300_000);
  const data = state();
  const { workspaceId } = await seedIsolatedWorkspace();
  const stamp = randomUUID().slice(0, 8);

  const projectId = await seedProjectViaDb(
    data.databaseUrl, workspaceId, data.editorIdentityId,
    `f912-${stamp}@e2e.test`, `F912 Projekt ${stamp}`,
  );

  // 1) Settings-Liste: genau die 4 Defaults in Blaupause-Reihenfolge.
  const settingsPath = `/w/${workspaceId}/einstellungen/ereignistypen`;
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Ereignistypen", level: 1 })).toBeVisible();

  const activeSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Aktive Ereignistypen", exact: true }),
  });
  await expect(activeSection).toBeVisible();
  await expect(
    activeSection.getByText("Noch keine Ereignistypen angelegt.", { exact: true }),
  ).toHaveCount(0);
  const items = activeSection.locator("li");
  await expect(items).toHaveCount(EXPECTED_DEFAULTS.length);
  for (const [index, name] of EXPECTED_DEFAULTS.entries()) {
    await expect(items.nth(index).getByText(name, { exact: true })).toBeVisible();
  }

  // Viewports ohne horizontales Scrollen + Axe auf der Settings-Seite.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F9-12-Ereignistypen");

  // 2) Zeiteintrag am Projekt per UI mit Typ-Auswahl `Travel` via UI-Select.
  const trackingPath = `/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`;
  await page.goto(trackingPath);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();

  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true }),
  });
  await expect(form).toBeVisible();
  const typeOptions = await form.getByLabel("Ereignistyp").locator("option").allTextContents();
  expect(typeOptions).toEqual(["Ohne Ereignistyp", ...EXPECTED_DEFAULTS]);

  const comment = `F912-Travel-Eintrag-${stamp}`;
  await form.getByLabel("Ereignistyp").selectOption({ label: "Travel" });
  await form.getByLabel("Beginn").fill("2026-03-10T10:00");
  await form.getByLabel("Ende").fill("2026-03-10T11:30");
  await form.getByLabel("Arbeitszeit (Minuten)").fill("90");
  await form.getByLabel("Kommentar").fill(comment);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();

  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  const row = page.locator("li").filter({ hasText: comment });
  await expect(row.getByText("Travel", { exact: true })).toBeVisible();

  // Viewports ohne horizontales Scrollen + Axe auf der Zeiterfassungsseite.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F9-12-Zeiterfassung");
});
