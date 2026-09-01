import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import {
  expect,
  test,
  type Locator,
  type Page,
} from "playwright/test";

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
  mainContactName: string;
};

const LOSS_REASON = "M1-11a E2E – Budget nicht freigegeben";
const PRIVATE_LOSS_COMMENT = "M1-11a intern: Budgetentscheidung erst im Folgequartal.";

const browserErrors = new WeakMap<Page, string[]>();
let adminEmail = "";
let initialColumnId = "";
let lossReasonId = "";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
    "mainContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-11a-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  let otp: string | null = null;
  await expect.poll(() => {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    otp = pattern.exec(tail)?.[1] ?? null;
    return otp;
  }, {
    message: "Der echte M1-11a-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M1-11a-Dev-Mail-OTP fehlt.");
  return otp;
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
  await otpInput.fill(await otpFromPrivateDevMailLog(
    state().serverLogPath,
    email,
    logOffset,
  ));
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

async function seedAdminMembership(data: E2EState): Promise<string> {
  const identityId = randomUUID();
  const email = `m1-11a-admin-${randomUUID().slice(0, 8)}@example.test`;
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
        [data.workspaceId],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [identityId, email],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`,
        [data.workspaceId, identityId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
  return email;
}

async function expectNoWcagAaAxeViolations(
  page: Page,
  selector: string,
  stateName: string,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(selector)
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
  })), {
    message: `M1-11a: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
  }).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

function maximumCssDurationSeconds(value: string): number {
  return Math.max(0, ...value.split(",").map((part) => {
    const normalized = part.trim();
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) throw new Error(`Ungültige CSS-Dauer: ${normalized}`);
    return normalized.endsWith("ms") ? numeric / 1_000 : numeric;
  }));
}

async function expectReducedMotion(
  page: Page,
  control: Locator,
  stateName: string,
): Promise<void> {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    `${stateName}: Reduced Motion ist aktiv`).toBe(true);
  const motion = await control.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      animationDuration: computed.animationDuration,
      transitionDuration: computed.transitionDuration,
    };
  });
  expect(maximumCssDurationSeconds(motion.animationDuration),
    `${stateName}: Animation ist unter Reduced Motion deaktiviert`).toBeLessThanOrEqual(0.000_01);
  expect(maximumCssDurationSeconds(motion.transitionDuration),
    `${stateName}: Transition ist unter Reduced Motion deaktiviert`).toBeLessThanOrEqual(0.000_01);
}

function projectCard(page: Page, projectId: string): Locator {
  return page.locator(`article[data-project-id="${projectId}"]`);
}

function lossReasonRow(page: Page): Locator {
  return page.locator("li").filter({
    has: page.getByText(LOSS_REASON, { exact: true }),
  });
}

function closedProjectRow(page: Page, contactName: string): Locator {
  return page.locator("li").filter({
    has: page.getByRole("heading", { name: contactName, level: 2, exact: true }),
  });
}

async function expectSafeOutcomeActivity(
  page: Page,
  expectedLabels: string[],
): Promise<void> {
  const activity = page.locator("#project-activity");
  await expect(activity).toBeVisible();
  for (const label of expectedLabels) {
    await expect(activity.getByText(label, { exact: true }).first()).toBeVisible();
  }

  const text = await activity.innerText();
  expect(text).not.toContain(LOSS_REASON);
  expect(text).not.toContain(PRIVATE_LOSS_COMMENT);
  if (lossReasonId !== "") expect(text).not.toContain(lossReasonId);

  const html = await activity.innerHTML();
  expect(html).not.toMatch(
    /project\.outcome_(?:won|lost|reopened)|lossReason(?:Id|Text)|loss_reason_(?:id|text)|payload/iu,
  );
  if (lossReasonId !== "") expect(html).not.toContain(lossReasonId);
}

async function expectNoPrivateOutcomeData(page: Page): Promise<void> {
  const content = await page.content();
  expect(content).not.toContain(LOSS_REASON);
  expect(content).not.toContain(PRIVATE_LOSS_COMMENT);
  if (lossReasonId !== "") expect(content).not.toContain(lossReasonId);
  expect(content).not.toMatch(/lossReason(?:Id|Text)|loss_reason_(?:id|text)/iu);
}

async function ensureExternalAssignment(page: Page, data: E2EState): Promise<void> {
  const panel = page.locator("#project-assignment");
  await expect(panel.getByRole("heading", {
    name: "Projektverantwortung",
    level: 2,
  })).toBeVisible();
  await panel.getByLabel("Personensuche").fill(data.externalEmail);
  await panel.getByRole("button", { name: "Suchen" }).click();
  await expect(panel.getByText("1 passende Person gefunden.", { exact: true })).toBeVisible();
  await panel.getByRole("button", {
    name: `${data.externalEmail} zusätzlich zuweisen`,
  }).click();
  const feedback = panel.getByText(
    "Die Projektverantwortung wurde gespeichert.",
    { exact: true },
  );
  await expect(feedback).toBeVisible();
  await expect(feedback).toBeFocused();
  await expect(panel.getByRole("button", {
    name: `${data.externalEmail} vom Projekt entfernen`,
  })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M1-11a: Anfrageergebnis als durchgängiger Rollen- und Archivflow", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    adminEmail = await seedAdminMembership(state());
  });

  test("M1-11a: Admin legt einen Verlustgrund an, archiviert und reaktiviert ihn", async ({
    page,
  }) => {
    const data = state();
    const settingsPath = `/w/${data.workspaceId}/einstellungen/verlustgruende`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(settingsPath);
    await loginWithRealOtp(page, adminEmail, settingsPath);

    await expect(page.getByRole("heading", { name: "Verlustgründe", level: 1 })).toBeVisible();
    await page.getByLabel("Bezeichnung").fill(LOSS_REASON);
    await page.getByRole("button", { name: "Anlegen", exact: true }).click();
    let feedback = page.getByRole("status").filter({
      hasText: "Der Verlustgrund wurde angelegt.",
    });
    await expect(feedback).toHaveText("Der Verlustgrund wurde angelegt.");
    await expect(feedback).toBeFocused();

    let row = lossReasonRow(page);
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Aktiv", { exact: true })).toBeVisible();
    await row.getByText("Archivieren", { exact: true }).click();
    await row.getByRole("button", { name: "Archivierung bestätigen" }).click();
    feedback = page.getByRole("status").filter({
      hasText: "Der Verlustgrund wurde archiviert.",
    });
    await expect(feedback).toHaveText("Der Verlustgrund wurde archiviert.");
    await expect(feedback).toBeFocused();

    row = lossReasonRow(page);
    await expect(row.getByText("Archiviert", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Reaktivieren" }).click();
    feedback = page.getByRole("status").filter({
      hasText: "Der Verlustgrund wurde reaktiviert.",
    });
    await expect(feedback).toHaveText("Der Verlustgrund wurde reaktiviert.");
    await expect(feedback).toBeFocused();
    await expect(lossReasonRow(page).getByText("Aktiv", { exact: true })).toBeVisible();

    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "aktive Verlustgrundverwaltung");
    await expectReducedMotion(
      page,
      page.getByRole("button", { name: "Anlegen", exact: true }),
      "Verlustgrundverwaltung",
    );
    await page.setViewportSize({ width: 320, height: 900 });
    await expectNoHorizontalOverflow(page, 320);
  });

  test("M1-11a: Editor schließt Lost ab; Board, Archiv und External-Grenze greifen", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;
    const closedPath = `${boardPath}/abgeschlossen`;
    const detailPath = `${boardPath}/${data.mainProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);
    await ensureExternalAssignment(page, data);

    await page.goto(boardPath);
    const card = projectCard(page, data.mainProjectId);
    await expect(card).toHaveCount(1);
    const initialColumn = card.locator("xpath=ancestor::section[@data-column-id][1]");
    initialColumnId = await initialColumn.getAttribute("data-column-id") ?? "";
    expect(initialColumnId, "Die ursprüngliche Kanban-Spalte ist im UI bestimmbar.").not.toBe("");

    await page.goto(detailPath);
    const outcome = page.locator("#project-outcome");
    await outcome.getByText("Als verloren abschließen", { exact: true }).click();
    const reasonSelect = outcome.getByLabel("Verlustgrund");
    await reasonSelect.selectOption({ label: LOSS_REASON });
    lossReasonId = await reasonSelect.inputValue();
    expect(lossReasonId).not.toBe("");
    await outcome.getByLabel("Interner Hinweis (optional)").fill(PRIVATE_LOSS_COMMENT);
    const lostConfirmation = outcome.getByRole("button", {
      name: "Verloren verbindlich bestätigen",
    });
    const lostForm = lostConfirmation.locator("xpath=ancestor::form[1]");
    await expect(lostForm.locator('input[name="confirmation"]')).toHaveValue("mark_lost");
    await lostConfirmation.click();

    const lostFeedback = outcome.getByRole("status");
    await expect(lostFeedback).toHaveText("Die Anfrage wurde als verloren abgeschlossen.");
    await expect(lostFeedback).toBeFocused();
    await expect(outcome).toContainText("Verloren · Stand 1");
    await expect(outcome).toContainText(LOSS_REASON);
    await expect(outcome).toContainText(PRIVATE_LOSS_COMMENT);
    await expectSafeOutcomeActivity(page, ["Anfrage verloren"]);

    await page.setViewportSize({ width: 320, height: 900 });
    await expectNoHorizontalOverflow(page, 320);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "Lost-Abschluss bei 320 px");
    await expectNoWcagAaAxeViolations(page, "#project-activity", "Lost-Aktivität");
    await expectReducedMotion(
      page,
      outcome.getByText("Anfrage wieder öffnen", { exact: true }),
      "Lost-Projektakte",
    );

    await page.goto(boardPath);
    await expect(projectCard(page, data.mainProjectId)).toHaveCount(0);
    await page.getByRole("link", { name: "Abgeschlossen" }).click();
    await page.waitForURL((url) => url.pathname === closedPath);
    const filters = page.getByRole("navigation", { name: "Abschlussfilter" });
    await filters.getByRole("link", { name: "Verloren" }).click();
    await page.waitForURL((url) => (
      url.pathname === closedPath && url.searchParams.get("filter") === "lost"
    ));
    await page.setViewportSize({ width: 375, height: 900 });
    const closedRow = closedProjectRow(page, data.mainContactName);
    await expect(closedRow).toContainText("Verloren");
    await expect(closedRow).toContainText(`Verlustgrund: ${LOSS_REASON}`);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Lost-Archivfilter");
    await closedRow.getByRole("link", { name: "Projektakte öffnen" }).click();
    await page.waitForURL((url) => url.pathname === detailPath);
    await expectSafeOutcomeActivity(page, ["Anfrage verloren"]);

    const externalContext = await browser.newContext({
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 900 },
    });
    const externalPage = await externalContext.newPage();
    const externalErrors = trackBrowserErrors(externalPage);
    try {
      await externalPage.goto(boardPath);
      await loginWithRealOtp(externalPage, data.externalEmail, boardPath);
      await expect(externalPage.locator("article[data-project-id]")).toHaveCount(0);
      await expectNoPrivateOutcomeData(externalPage);

      await externalPage.goto(closedPath);
      await expect(externalPage.getByRole("heading", { name: "Kein Zugriff", level: 1 }))
        .toBeVisible();
      await expect(externalPage.getByText(data.mainContactName, { exact: true })).toHaveCount(0);
      await expectNoPrivateOutcomeData(externalPage);

      await externalPage.goto(detailPath);
      await expect(externalPage.getByRole("heading", {
        name: "Die Projektakte ist nicht verfügbar.",
        level: 1,
      })).toBeVisible();
      await expect(externalPage.locator("#project-outcome")).toHaveCount(0);
      await expect(externalPage.locator("#project-activity")).toHaveCount(0);
      await expect(externalPage.getByText(data.mainContactName, { exact: true })).toHaveCount(0);
      await expectNoPrivateOutcomeData(externalPage);
      await expectNoHorizontalOverflow(externalPage, 375);
      await expectNoWcagAaAxeViolations(externalPage, "main", "geschlossene External-Projektakte");
      expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
    } finally {
      await externalContext.close();
    }
  });

  test("M1-11a: Editor öffnet in derselben Spalte wieder und schließt Won ab", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;
    const detailPath = `${boardPath}/${data.mainProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    let outcome = page.locator("#project-outcome");
    await expect(outcome).toContainText("Verloren · Stand 1");
    await outcome.getByText("Anfrage wieder öffnen", { exact: true }).click();
    const reopenConfirmation = outcome.getByRole("button", { name: "Wieder öffnen bestätigen" });
    await expect(reopenConfirmation.locator("xpath=ancestor::form[1]")
      .locator('input[name="confirmation"]')).toHaveValue("reopen");
    await reopenConfirmation.click();
    const reopenFeedback = outcome.getByRole("status");
    await expect(reopenFeedback).toHaveText("Die Anfrage wurde wieder geöffnet.");
    await expect(reopenFeedback).toBeFocused();
    await expect(outcome).toContainText("Offen · Stand 2");
    await expect(outcome.locator("dl")).not.toContainText(LOSS_REASON);
    await expect(outcome.locator("dl")).not.toContainText(PRIVATE_LOSS_COMMENT);
    await expectSafeOutcomeActivity(page, ["Anfrage wieder geöffnet", "Anfrage verloren"]);

    await page.goto(boardPath);
    expect(initialColumnId).not.toBe("");
    const preservedColumn = page.locator(`section[data-column-id="${initialColumnId}"]`);
    await expect(preservedColumn.locator(
      `article[data-project-id="${data.mainProjectId}"]`,
    )).toHaveCount(1);

    await page.goto(detailPath);
    outcome = page.locator("#project-outcome");
    await outcome.getByText("Als gewonnen abschließen", { exact: true }).click();
    const wonConfirmation = outcome.getByRole("button", {
      name: "Gewonnen verbindlich bestätigen",
    });
    await expect(wonConfirmation.locator("xpath=ancestor::form[1]")
      .locator('input[name="confirmation"]')).toHaveValue("mark_won");
    await wonConfirmation.click();
    const wonFeedback = outcome.getByRole("status");
    await expect(wonFeedback).toHaveText("Die Anfrage wurde als gewonnen abgeschlossen.");
    await expect(wonFeedback).toBeFocused();
    await expect(outcome).toContainText("Gewonnen · Stand 3");
    await expectSafeOutcomeActivity(page, [
      "Anfrage gewonnen",
      "Anfrage wieder geöffnet",
      "Anfrage verloren",
    ]);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "Won-Abschluss");
    await expectNoWcagAaAxeViolations(page, "#project-activity", "vollständige Ergebnisaktivität");

    await page.goto(boardPath);
    await expect(projectCard(page, data.mainProjectId)).toHaveCount(0);
  });

  test("M1-11a: Viewer sieht Won-Liste und Projektakte ausschließlich lesend", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;
    const closedPath = `${boardPath}/abgeschlossen`;
    const detailPath = `${boardPath}/${data.mainProjectId}`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(boardPath);
    await loginWithRealOtp(page, data.viewerEmail, boardPath);
    await page.getByRole("link", { name: "Abgeschlossen" }).click();
    const filters = page.getByRole("navigation", { name: "Abschlussfilter" });
    await filters.getByRole("link", { name: "Gewonnen" }).click();
    await page.waitForURL((url) => (
      url.pathname === closedPath && url.searchParams.get("filter") === "won"
    ));

    const closedRow = closedProjectRow(page, data.mainContactName);
    await expect(closedRow).toContainText("Gewonnen");
    await expect(closedRow).toContainText("Stand 3");
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Viewer-Won-Archiv");
    await closedRow.getByRole("link", { name: "Projektakte öffnen" }).click();
    await page.waitForURL((url) => url.pathname === detailPath);

    const outcome = page.locator("#project-outcome");
    await expect(outcome).toContainText("Gewonnen · Stand 3");
    await expect(outcome.getByText(
      "Du kannst das Geschäftsergebnis sehen, aber nicht verändern.",
      { exact: true },
    )).toBeVisible();
    await expect(outcome.locator("form")).toHaveCount(0);
    await expect(outcome.locator("summary")).toHaveCount(0);
    await expect(outcome.getByRole("button", {
      name: /(?:Gewonnen verbindlich|Verloren verbindlich|Wieder öffnen)/u,
    })).toHaveCount(0);
    await expectSafeOutcomeActivity(page, [
      "Anfrage gewonnen",
      "Anfrage wieder geöffnet",
      "Anfrage verloren",
    ]);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "Viewer-Ergebnisansicht");
    await expectNoWcagAaAxeViolations(page, "#project-activity", "Viewer-Ergebnisaktivität");
    await expectReducedMotion(
      page,
      page.getByRole("link", { name: "Zurück zu den Anfragen" }),
      "Viewer-Projektakte",
    );

    await page.setViewportSize({ width: 320, height: 900 });
    await expectNoHorizontalOverflow(page, 320);
  });
});
