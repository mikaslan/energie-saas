import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "playwright/test";

type E2EState = {
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
  mainContactName: string;
};

const CREATE_QUICK_TASK_TITLE = "M1-10 Anlage Schnellaufgabe E2E";
const CREATE_FULL_TASK_TITLE = "M1-10 Anlage vollständige Aufgabe E2E";
const WORKFLOW_QUICK_TASK_TITLE = "M1-10 Workflow Schnellaufgabe E2E";
const WORKFLOW_FULL_TASK_TITLE = "M1-10 Workflow vollständige Aufgabe E2E";
const WORKFLOW_EDITED_TASK_TITLE = "M1-10 Workflow Aufgabe E2E – bearbeitet";
const VIEWER_TASK_TITLE = "M1-10 Viewer Aufgabe E2E";
const EXTERNAL_PRIVATE_TASK_TITLE = "M1-10 interne Aufgabe für External-Negativfall";
const FULL_TASK_BODY = "Montageunterlagen sicher und vollständig prüfen";
const EDITED_TASK_BODY = "Montageunterlagen final freigeben";
const DONE_EDITED_TASK_BODY = "Montageunterlagen nach Abschluss dokumentieren";
const CHECKLIST_ITEM = "Dachplan abgleichen";
const EDITED_CHECKLIST_ITEM = "Dachplan final abgleichen";
const TASK_LABEL = "Planung";
const EDITED_TASK_LABEL = "Montage";
const EDITED_DUE_DATE = "2026-09-20";

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
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
    "mainContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-10-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maximumCssDurationSeconds(value: string): number {
  return Math.max(...value.split(",").map((part) => {
    const normalized = part.trim();
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) throw new Error(`Ungültige CSS-Dauer: ${normalized}`);
    return normalized.endsWith("ms") ? numeric / 1_000 : numeric;
  }));
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
    message: "Der echte Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte Dev-Mail-OTP fehlt.");
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

async function openAuthenticatedProject(page: Page, email: string): Promise<string> {
  const data = state();
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
  await page.goto(detailPath);
  await loginWithRealOtp(page, email, detailPath);
  await expect(page.getByRole("heading", {
    name: data.mainContactName,
    level: 1,
  })).toBeVisible();
  return detailPath;
}

function taskCard(page: Page, title: string): Locator {
  return page.locator("#project-tasks article").filter({
    has: page.getByRole("heading", { name: title, level: 4, exact: true }),
  });
}

async function createQuickTask(page: Page, title: string): Promise<Locator> {
  const tasks = page.locator("#project-tasks");
  await tasks.getByLabel("Neue Aufgabe").fill(title);
  await tasks.getByRole("button", { name: "Aufgabe anlegen", exact: true }).click();
  await expect(tasks.getByRole("status")).toHaveText("Die Aufgabe wurde erstellt.");
  const card = taskCard(page, title);
  await expect(card).toHaveCount(1);
  return card;
}

async function createFullTask(
  page: Page,
  data: E2EState,
  title: string,
): Promise<Locator> {
  const tasks = page.locator("#project-tasks");
  await tasks.getByRole("button", { name: "Vollständige Aufgabe" }).click();
  const dialog = page.getByRole("dialog", { name: "Vollständige Aufgabe anlegen" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Titel")).toBeFocused();
  await dialog.getByLabel("Titel").fill(title);
  const richText = dialog.getByLabel("Aufgabenbeschreibung");
  await richText.fill(FULL_TASK_BODY);
  await richText.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await dialog.getByRole("button", { name: "Fett" }).click();
  await dialog.getByLabel("Fällig am").fill("2026-09-15");
  const assignees = dialog.getByRole("group", { name: "Zuständige Personen" });
  for (const email of [data.editorEmail, data.viewerEmail]) {
    await assignees.getByLabel("Interne Person suchen").fill(email);
    await assignees.getByRole("button", { name: "Person suchen" }).click();
    await assignees.getByRole("button", { name: `${email} auswählen` }).click();
  }
  const checklist = dialog.getByRole("group", { name: "Checkliste" });
  await checklist.getByRole("button", { name: "Checklistenpunkt hinzufügen" }).click();
  await checklist.getByLabel("Punkt 1").fill(CHECKLIST_ITEM);
  const labels = dialog.getByRole("group", { name: "Labels" });
  await labels.getByRole("button", { name: "Label hinzufügen" }).click();
  await labels.getByLabel("Label 1").fill(TASK_LABEL);
  await labels.getByLabel("Farbe").selectOption("blue");
  await dialog.getByRole("button", { name: "Aufgabe anlegen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tasks.getByRole("status")).toHaveText(
    "Die vollständige Aufgabe wurde erstellt.",
  );
  const card = taskCard(page, title);
  await expect(card).toHaveCount(1);
  return card;
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
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function seedQuickTaskAsEditor(
  browser: Browser,
  data: E2EState,
  title: string,
): Promise<void> {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const setupPage = await context.newPage();
  const setupErrors = trackBrowserErrors(setupPage);
  try {
    await openAuthenticatedProject(setupPage, data.editorEmail);
    if (await taskCard(setupPage, title).count() === 0) {
      await createQuickTask(setupPage, title);
    }
    await expect(taskCard(setupPage, title)).toHaveCount(1);
    expect(setupErrors, "Browser-Konsole des Task-Setups").toEqual([]);
  } finally {
    await context.close();
  }
}

async function advanceTaskRevisionAsEditor(
  browser: Browser,
  data: E2EState,
  title: string,
): Promise<void> {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const concurrentPage = await context.newPage();
  const concurrentErrors = trackBrowserErrors(concurrentPage);
  try {
    await openAuthenticatedProject(concurrentPage, data.editorEmail);
    const card = taskCard(concurrentPage, title);
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Bearbeiten" }).click();
    const dialog = concurrentPage.getByRole("dialog", { name: "Aufgabe bearbeiten" });
    await dialog.getByLabel("Fällig am").fill("2026-09-16");
    await dialog.getByRole("button", { name: "Änderungen speichern" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(concurrentPage.locator("#project-tasks").getByRole("status"))
      .toHaveText("Die Aufgabendetails wurden gespeichert.");
    expect(concurrentErrors, "Browser-Konsole des konkurrierenden Task-Edits").toEqual([]);
  } finally {
    await context.close();
  }
}

async function prepareExternalScenario(
  browser: Browser,
  data: E2EState,
  privateTaskTitle: string,
): Promise<void> {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const setupPage = await context.newPage();
  const setupErrors = trackBrowserErrors(setupPage);
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
  try {
    await setupPage.goto(detailPath);
    await loginWithRealOtp(setupPage, data.editorEmail, detailPath);
    const panel = setupPage.locator("#project-assignment");
    await expect(panel.getByRole("heading", {
      name: "Projektverantwortung",
      level: 2,
    })).toBeVisible();
    await panel.getByLabel("Personensuche").fill(data.externalEmail);
    await panel.getByRole("button", { name: "Suchen" }).click();
    await expect(panel.getByText("1 passende Person gefunden.", { exact: true })).toBeVisible();
    const addButton = panel.getByRole("button", {
      name: `${data.externalEmail} zusätzlich zuweisen`,
    });
    if (await addButton.isVisible()) {
      await addButton.click();
      await expect(panel.getByText(
        "Die Projektverantwortung wurde gespeichert.",
        { exact: true },
      )).toBeVisible();
    }
    await expect(panel.getByRole("button", {
      name: `${data.externalEmail} vom Projekt entfernen`,
    })).toBeVisible();
    if (await taskCard(setupPage, privateTaskTitle).count() === 0) {
      await createQuickTask(setupPage, privateTaskTitle);
    }
    await expect(taskCard(setupPage, privateTaskTitle)).toHaveCount(1);
    expect(setupErrors, "Browser-Konsole der External-Zuweisung").toEqual([]);
  } finally {
    await context.close();
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("M1-10: Editor erstellt Schnellaufgabe und vollständige Aufgabe mit Richtext", async ({ page }) => {
  const data = state();
  await openAuthenticatedProject(page, data.editorEmail);
  const tasks = page.locator("#project-tasks");
  await expect(tasks.getByRole("heading", { name: "Aufgaben", level: 2 })).toBeVisible();

  const quickTask = await createQuickTask(page, CREATE_QUICK_TASK_TITLE);
  await expect(quickTask).toContainText(`Zuständig: ${data.editorEmail}`);

  const fullTask = await createFullTask(page, data, CREATE_FULL_TASK_TITLE);
  await expect(fullTask.locator("strong")).toHaveText(FULL_TASK_BODY);
  await expect(fullTask.getByText(CHECKLIST_ITEM, { exact: true })).toBeVisible();
  await expect(fullTask.getByRole("list", { name: "Aufgabenlabels" }))
    .toContainText(TASK_LABEL);
  await expect(fullTask).toContainText(data.editorEmail);
  await expect(fullTask).toContainText(data.viewerEmail);
  await expectNoWcagAaAxeViolations(page, "#project-tasks", "Aufgaben nach Anlage");
});

test("M1-10: Editor bewahrt Konfliktentwurf, bearbeitet Details und durchläuft den Workflow", async ({
  page,
  browser,
}) => {
  const data = state();
  const detailPath = await openAuthenticatedProject(page, data.editorEmail);
  const tasks = page.locator("#project-tasks");
  await createQuickTask(page, WORKFLOW_QUICK_TASK_TITLE);
  let card = await createFullTask(page, data, WORKFLOW_FULL_TASK_TITLE);
  await card.getByRole("button", { name: "Bearbeiten" }).click();

  const dialog = page.getByRole("dialog", { name: "Aufgabe bearbeiten" });
  const selectedAssignees = dialog.getByRole("group", { name: "Zuständige Personen" });
  const selectedAssigneeList = selectedAssignees.getByRole("list", {
    name: "Ausgewählte Personen",
  });
  await expect(selectedAssigneeList.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(selectedAssigneeList.getByText(data.viewerEmail, { exact: true })).toBeVisible();
  await selectedAssigneeList.getByRole("button", {
    name: `${data.viewerEmail} aus Auswahl entfernen`,
  }).click();
  await expect(selectedAssigneeList.getByText(data.viewerEmail, { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Titel").fill(WORKFLOW_EDITED_TASK_TITLE);
  await dialog.getByLabel("Aufgabenbeschreibung").fill(EDITED_TASK_BODY);
  await dialog.getByLabel("Fällig am").fill(EDITED_DUE_DATE);
  await dialog.getByRole("group", { name: "Checkliste" })
    .getByLabel("Punkt 1")
    .fill(EDITED_CHECKLIST_ITEM);
  const labels = dialog.getByRole("group", { name: "Labels" });
  await labels.getByLabel("Label 1").fill(EDITED_TASK_LABEL);
  await labels.getByLabel("Farbe").selectOption("emerald");

  await advanceTaskRevisionAsEditor(browser, data, WORKFLOW_FULL_TASK_TITLE);
  await dialog.getByRole("button", { name: "Änderungen speichern" }).click();

  const conflict = dialog.getByRole("alert");
  await expect(conflict).toContainText("zwischenzeitlich geändert");
  await expect(conflict).toBeFocused();
  await expect(dialog.getByLabel("Titel")).toHaveValue(WORKFLOW_EDITED_TASK_TITLE);
  await expect(dialog.getByLabel("Aufgabenbeschreibung")).toHaveText(EDITED_TASK_BODY);
  await expect(dialog.getByLabel("Fällig am")).toHaveValue(EDITED_DUE_DATE);
  await expect(selectedAssigneeList.getByText(data.editorEmail, { exact: true })).toBeVisible();
  await expect(selectedAssigneeList.getByText(data.viewerEmail, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "Checkliste" }).getByLabel("Punkt 1"))
    .toHaveValue(EDITED_CHECKLIST_ITEM);
  await expect(labels.getByLabel("Label 1")).toHaveValue(EDITED_TASK_LABEL);
  await expect(labels.getByLabel("Farbe")).toHaveValue("emerald");

  await dialog.getByRole("button", { name: "Änderungen speichern" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#project-tasks").getByRole("status"))
    .toHaveText("Die Aufgabendetails wurden gespeichert.");
  card = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(card).toContainText(EDITED_TASK_BODY);
  await expect(card.getByText(EDITED_CHECKLIST_ITEM, { exact: true })).toBeVisible();
  await expect(card.getByText(EDITED_TASK_LABEL, { exact: true })).toBeVisible();
  await expect(card).toContainText("Stand 3");

  await card.getByRole("button", { name: "Abschließen" }).click();
  await expect(tasks.getByRole("status"))
    .toHaveText("Die Aufgabe wurde abgeschlossen.");
  await expect(tasks.getByRole("status")).toBeFocused();
  card = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(card).toContainText("Erledigt");
  await expect(card).toContainText("Stand 4");

  await card.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Aufgabenbeschreibung").fill(DONE_EDITED_TASK_BODY);
  await dialog.getByRole("button", { name: "Änderungen speichern" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#project-tasks").getByRole("status"))
    .toHaveText("Die Aufgabendetails wurden gespeichert.");
  card = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(card).toContainText(DONE_EDITED_TASK_BODY);
  await expect(card).toContainText("Stand 5");

  await card.getByRole("button", {
    name: `${EDITED_CHECKLIST_ITEM} als erledigt markieren`,
  }).click();
  await expect(page.locator("#project-tasks").getByRole("status"))
    .toHaveText("Die Checkliste wurde aktualisiert.");
  card = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(card.getByLabel("Checklistfortschritt: 1 von 1 erledigt")).toBeVisible();
  await expect(card).toContainText("Stand 6");

  await card.getByRole("button", { name: "Wieder öffnen" }).click();
  await expect(tasks.getByRole("status"))
    .toHaveText("Die Aufgabe wurde wieder geöffnet.");
  await expect(tasks.getByRole("status")).toBeFocused();
  card = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(card).toContainText("Offen");
  await expect(card).toContainText("Stand 7");

  await card.getByText("Archivieren", { exact: true }).click();
  await card.getByRole("button", { name: "Endgültig archivieren" }).click();
  await expect(taskCard(page, WORKFLOW_EDITED_TASK_TITLE)).toHaveCount(0);
  await expect(tasks.getByRole("status")).toHaveText("Die Aufgabe wurde archiviert.");
  await expect(tasks.getByRole("status")).toBeFocused();
  const archiveLink = page.getByRole("link", { name: "Archiv anzeigen (1)" });
  await expect(archiveLink).toBeVisible();
  await archiveLink.click();
  await page.waitForURL((url) => (
    url.pathname === detailPath && url.searchParams.get("tasks") === "archived"
  ));
  const archivedCard = taskCard(page, WORKFLOW_EDITED_TASK_TITLE);
  await expect(archivedCard).toContainText("Archiviert");
  await expect(archivedCard.getByRole("button", {
    name: /(?:Bearbeiten|Abschließen|Wieder öffnen|Endgültig archivieren)/u,
  })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Aktive Aufgaben" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vollständige Aufgabe" })).toHaveCount(0);
  await expect(page.getByLabel("Neue Aufgabe")).toHaveCount(0);
  await expectNoWcagAaAxeViolations(page, "#project-tasks", "Aufgabenarchiv");
  await expectNoWcagAaAxeViolations(page, "#project-activity", "Aktivität im Aufgabenarchiv");
  await expect(page.locator("#project-activity")).toContainText(WORKFLOW_EDITED_TASK_TITLE);

  await page.goto(`${detailPath}?tasks=archived&tasks=archived&activityAt=kaputt`);
  await expect(page.getByRole("heading", { name: "Aufgaben", level: 2 })).toBeVisible();
  await expect(taskCard(page, WORKFLOW_QUICK_TASK_TITLE)).toHaveCount(1);
});

test("M1-10: Dialog hält Fokus, schließt per Escape und fließt bei 320 px um", async ({ page }) => {
  const data = state();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 900 });
  await openAuthenticatedProject(page, data.editorEmail);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
    .toBe(true);
  await expectNoHorizontalOverflow(page, 320);

  const opener = page.getByRole("button", { name: "Vollständige Aufgabe" });
  const motion = await opener.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      transitionDuration: computed.transitionDuration,
      animationDuration: computed.animationDuration,
      scrollBehavior: computed.scrollBehavior,
    };
  });
  expect(maximumCssDurationSeconds(motion.transitionDuration)).toBeLessThanOrEqual(0.000_01);
  expect(maximumCssDurationSeconds(motion.animationDuration)).toBeLessThanOrEqual(0.000_01);
  expect(motion.scrollBehavior).toBe("auto");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Vollständige Aufgabe anlegen" });
  await expect(dialog.getByLabel("Titel")).toBeFocused();
  const richText = dialog.getByLabel("Aufgabenbeschreibung");
  await richText.fill("Listenausgang");
  await dialog.getByRole("button", { name: "Aufzählung" }).click();
  await expect(richText.locator("ul")).toBeVisible();
  await richText.press("Tab");
  await expect(dialog.getByLabel("Fällig am")).toBeFocused();
  await richText.focus();
  await richText.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Zeilenumbruch" })).toBeFocused();
  const closeButton = dialog.getByRole("button", { name: "Aufgabeneditor schließen" });
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Aufgabe anlegen", exact: true }))
    .toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await expectNoHorizontalOverflow(page, 320);
  await expectNoWcagAaAxeViolations(page, "[role='dialog']", "Aufgabeneditor bei 320 px");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expectNoHorizontalOverflow(page, 320);

  await page.setViewportSize({ width: 375, height: 900 });
  await opener.click();
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page, 375);
  await expectNoWcagAaAxeViolations(page, "[role='dialog']", "Aufgabeneditor bei 375 px");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("M1-10: Viewer sieht Aufgaben ausschließlich lesend", async ({ page, browser }) => {
  const data = state();
  await seedQuickTaskAsEditor(browser, data, VIEWER_TASK_TITLE);
  await openAuthenticatedProject(page, data.viewerEmail);
  const tasks = page.locator("#project-tasks");
  await expect(tasks.getByText(
    "Du kannst Aufgaben und Checklisten sehen, aber nicht verändern.",
    { exact: true },
  )).toBeVisible();
  await expect(taskCard(page, VIEWER_TASK_TITLE)).toHaveCount(1);
  await expect(tasks.getByRole("button", {
    name: /(?:Aufgabe anlegen|Vollständige Aufgabe|Bearbeiten|Abschließen|Wieder öffnen|Endgültig archivieren)/u,
  })).toHaveCount(0);
  await expect(tasks.getByLabel("Neue Aufgabe")).toHaveCount(0);
  await expectNoWcagAaAxeViolations(page, "#project-tasks", "Viewer-Aufgabenansicht");
});

test("M1-10: External erhält trotz Projektzuweisung keinerlei Aufgabendaten", async ({
  page,
  browser,
}) => {
  const data = state();
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
  await prepareExternalScenario(browser, data, EXTERNAL_PRIVATE_TASK_TITLE);
  await page.goto(detailPath);
  await loginWithRealOtp(page, data.externalEmail, detailPath);

  await expect(page.getByText("Zugewiesene Anfrage", { exact: true })).toBeVisible();
  await expect(page.locator("#project-tasks")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Aufgaben" })).toHaveCount(0);
  await expect(page.getByText(EXTERNAL_PRIVATE_TASK_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Aktivität" })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/project\.task_/u);
});
