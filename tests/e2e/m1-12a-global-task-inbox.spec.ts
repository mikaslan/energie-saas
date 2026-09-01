import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
} from "playwright/test";
import {
  M1_12A_BODY_NEEDLE,
  M1_12A_BODY_NEEDLE_TITLE,
  M1_12A_CONTACT_NAME,
  M1_12A_DONE_TITLE,
  M1_12A_NO_DUE_TITLE,
  M1_12A_OVERDUE_TITLE,
  M1_12A_PAGE_TASK_COUNT,
  M1_12A_PAGE_TITLE_PREFIX,
  M1_12A_PROJECT_NAME,
  M1_12A_TODAY_TITLE,
  m112aPageTaskTitle,
} from "./m1-12a-fixture";

type E2EState = {
  serverLogPath: string;
  m112aWorkspaceId: string;
  foreignWorkspaceId: string;
  m112aProjectId: string;
  m112aEditorEmail: string;
  m112aViewerEmail: string;
  m112aExternalEmail: string;
  foreignContactName: string;
};

const PAGE_LIMIT = 50;
const INBOX_LIST = "ul[aria-label='Gefilterte Aufgaben']";
const DENIED_TITLE = "Die Aufgaben-Inbox ist für dich nicht freigegeben.";

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "m112aWorkspaceId",
    "foreignWorkspaceId",
    "m112aProjectId",
    "m112aEditorEmail",
    "m112aViewerEmail",
    "m112aExternalEmail",
    "foreignContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-12a-E2E-State ist unvollständig.");
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
    message: "Der echte M1-12a-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M1-12a-Dev-Mail-OTP fehlt.");
  return otp;
}

/**
 * Die Inbox baut ihr Rücksprungziel aus den geschlossenen Filtern, der `next`
 * ist dort also kein nackter Pfad. Erwartet wird deshalb das vollständige
 * Ziel; der Zielpfad wird daraus abgeleitet.
 */
function inboxLoginNext(workspaceId: string): string {
  return `/w/${workspaceId}/aufgaben?filter=mine&state=open&dueBucket=any`;
}

async function loginWithRealOtp(page: Page, email: string, expectedNext: string): Promise<void> {
  const expectedPath = new URL(expectedNext, "https://wmee.invalid").pathname;
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedNext);

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
    message: `M1-12a: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
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

function inboxCard(page: Page, title: string): Locator {
  return page.locator(`${INBOX_LIST} article`).filter({
    has: page.getByRole("heading", { name: title, level: 2, exact: true }),
  });
}

function inboxTitles(page: Page): Promise<string[]> {
  return page.locator(`${INBOX_LIST} article h2`).allInnerTexts();
}

async function applyInboxFilter(
  page: Page,
  values: { filter?: string; state?: string; dueBucket?: string; query?: string },
): Promise<void> {
  if (values.filter !== undefined) await page.getByLabel("Ansicht").selectOption(values.filter);
  if (values.state !== undefined) await page.getByLabel("Status").selectOption(values.state);
  if (values.dueBucket !== undefined) {
    await page.getByLabel("Fälligkeit").selectOption(values.dueBucket);
  }
  if (values.query !== undefined) await page.getByLabel("Suche").fill(values.query);
  // Nach dem Login trägt die URL bereits `filter`. Auf dessen blosse Existenz
  // zu warten wäre sofort erfüllt und läse die alte Seite. Gewartet wird
  // deshalb auf genau die Werte, die dieser Aufruf gesetzt hat.
  await Promise.all([
    page.waitForURL((url) => Object.entries(values).every(([key, value]) => (
      value === undefined || (url.searchParams.get(key) ?? "") === value
    ))),
    page.getByRole("button", { name: "Anzeigen" }).click(),
  ]);
}

/** Kein Aufgabentitel, kein Beschreibungstext, keine Fremddaten im HTML. */
async function expectNoInboxLeak(page: Page, data: E2EState): Promise<void> {
  const content = await page.content();
  for (const forbidden of [
    m112aPageTaskTitle(1),
    M1_12A_BODY_NEEDLE_TITLE,
    M1_12A_BODY_NEEDLE,
    M1_12A_OVERDUE_TITLE,
    M1_12A_DONE_TITLE,
    M1_12A_PROJECT_NAME,
    M1_12A_CONTACT_NAME,
    data.foreignContactName,
  ]) {
    expect(content, `darf nicht im HTML stehen: ${forbidden}`).not.toContain(forbidden);
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M1-12a: Projektübergreifende Aufgaben-Inbox", () => {
  test.describe.configure({ mode: "serial" });

  test("M1-12a: Editor erreicht die Inbox und sieht offene eigene Aufgaben", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.m112aWorkspaceId}/anfragen`;
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.goto(boardPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, boardPath);

    await page.getByRole("link", { name: "Aufgaben", exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === inboxPath);

    await expect(page.getByRole("heading", { name: "Aufgaben", level: 1 })).toBeVisible();
    await expect(page.getByText("Read-only Übersicht", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Ansicht")).toHaveValue("mine");
    await expect(page.getByLabel("Status")).toHaveValue("open");
    await expect(page.getByLabel("Fälligkeit")).toHaveValue("any");
    await expect(page.getByLabel("Suche")).toHaveValue("");
    await expect(page.getByRole("link", { name: "Filter zurücksetzen" })).toHaveCount(0);

    // Ordnung due_at asc: überfällig, heute, dann die datierten Seitenaufgaben.
    const overdue = inboxCard(page, M1_12A_OVERDUE_TITLE);
    await expect(overdue).toHaveCount(1);
    await expect(overdue).toContainText("Offen");
    await expect(overdue).toContainText("Überfällig ·");
    await expect(overdue).toContainText(`Projekt: ${M1_12A_PROJECT_NAME}`);
    await expect(overdue).toContainText("Dir zugewiesen · Von dir erstellt");
    await expect(overdue).toContainText("1 zuständige Person");
    await expect(inboxCard(page, M1_12A_TODAY_TITLE)).toContainText("Heute fällig ·");
    await expect(inboxCard(page, M1_12A_DONE_TITLE)).toHaveCount(0);
    await expect(page.getByText(`${PAGE_LIMIT} auf dieser Seite`, { exact: true }))
      .toBeVisible();

    const deepLink = overdue.getByRole("link", { name: "Projektakte öffnen" });
    await expect(deepLink).toHaveAttribute(
      "href",
      `/w/${data.m112aWorkspaceId}/anfragen/${data.m112aProjectId}#project-tasks`,
    );
    await deepLink.click();
    await page.waitForURL((url) => (
      url.pathname === `/w/${data.m112aWorkspaceId}/anfragen/${data.m112aProjectId}`
    ));
    await expect(page.locator("#project-tasks")).toBeVisible();
  });

  test("M1-12a: Filter und Suche greifen bis in den Beschreibungstext", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, inboxLoginNext(data.m112aWorkspaceId));

    await applyInboxFilter(page, { dueBucket: "overdue" });
    expect(await inboxTitles(page)).toEqual([M1_12A_OVERDUE_TITLE]);
    await expect(page.getByRole("link", { name: "Filter zurücksetzen" })).toBeVisible();

    await applyInboxFilter(page, { dueBucket: "today" });
    expect(await inboxTitles(page)).toEqual([M1_12A_TODAY_TITLE]);

    await applyInboxFilter(page, { dueBucket: "no_due" });
    expect(await inboxTitles(page)).toEqual([M1_12A_NO_DUE_TITLE]);

    await applyInboxFilter(page, { dueBucket: "any", state: "done" });
    const done = inboxCard(page, M1_12A_DONE_TITLE);
    await expect(done).toContainText("Erledigt");
    await expect(done).toContainText("2 zuständige Personen");
    await expect(inboxCard(page, M1_12A_OVERDUE_TITLE)).toHaveCount(0);

    // Treffer ausschließlich über den sicheren Beschreibungstext; der Text
    // selbst wird dabei nie projiziert.
    await applyInboxFilter(page, { state: "open", query: M1_12A_BODY_NEEDLE });
    expect(await inboxTitles(page)).toEqual([M1_12A_BODY_NEEDLE_TITLE]);
    await expect(page.getByText("1 auf dieser Seite", { exact: true })).toBeVisible();
    expect(await page.content(), "der Beschreibungssatz wird nie projiziert")
      .not.toContain(`${M1_12A_BODY_NEEDLE} freigeben`);

    // Der Projektname ist ausdrücklich nicht durchsuchbar.
    await applyInboxFilter(page, { query: M1_12A_PROJECT_NAME });
    await expect(page.getByRole("heading", { name: "Keine passenden Aufgaben", level: 3 }))
      .toBeVisible();
    await expect(page.locator(INBOX_LIST)).toHaveCount(0);

    await page.getByRole("link", { name: "Filter zurücksetzen" }).click();
    await page.waitForURL((url) => url.pathname === inboxPath && url.search === "");
    // Regression: nach einer reinen Parameternavigation muss auch das
    // Formular zurückgesetzt sein, nicht nur die Ergebnisliste.
    await expect(page.getByLabel("Ansicht")).toHaveValue("mine");
    await expect(page.getByLabel("Status")).toHaveValue("open");
    await expect(page.getByLabel("Fälligkeit")).toHaveValue("any");
    await expect(page.getByLabel("Suche")).toHaveValue("");

    await applyInboxFilter(page, { filter: "assigned_by_me" });
    await expect(inboxCard(page, M1_12A_OVERDUE_TITLE)).toHaveCount(1);
    await applyInboxFilter(page, { filter: "all" });
    await expect(inboxCard(page, M1_12A_OVERDUE_TITLE)).toHaveCount(1);
  });

  test("M1-12a: Seitenwechsel liefert die Restmenge ohne Doppelung", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, inboxLoginNext(data.m112aWorkspaceId));

    await applyInboxFilter(page, { query: M1_12A_PAGE_TITLE_PREFIX });
    const firstPage = await inboxTitles(page);
    expect(firstPage).toEqual(
      Array.from({ length: PAGE_LIMIT }, (_unused, index) => m112aPageTaskTitle(index + 1)),
    );
    const pagination = page.getByRole("navigation", { name: "Aufgabenseiten" });
    await expect(pagination.getByRole("link", { name: "Erste Seite" })).toHaveCount(0);

    await pagination.getByRole("link", { name: "Weitere Aufgaben" }).click();
    await page.waitForURL((url) => url.searchParams.get("cursor") !== null);
    const continuation = new URL(page.url());
    expect(continuation.searchParams.get("asOf")).not.toBeNull();
    expect(continuation.searchParams.get("query")).toBe(M1_12A_PAGE_TITLE_PREFIX);

    const secondPage = await inboxTitles(page);
    expect(secondPage).toEqual(
      Array.from({ length: M1_12A_PAGE_TASK_COUNT - PAGE_LIMIT }, (_unused, index) =>
        m112aPageTaskTitle(index + PAGE_LIMIT + 1)),
    );
    expect(new Set([...firstPage, ...secondPage]).size).toBe(M1_12A_PAGE_TASK_COUNT);
    await expect(page.getByRole("navigation", { name: "Aufgabenseiten" })
      .getByRole("link", { name: "Weitere Aufgaben" })).toHaveCount(0);

    await page.getByRole("navigation", { name: "Aufgabenseiten" })
      .getByRole("link", { name: "Erste Seite" }).click();
    await page.waitForURL((url) => url.searchParams.get("cursor") === null);
    expect(await inboxTitles(page)).toEqual(firstPage);
  });

  test("M1-12a: Viewer liest die Inbox ohne jede Änderungsmöglichkeit", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aViewerEmail, inboxLoginNext(data.m112aWorkspaceId));

    await expect(page.getByRole("heading", { name: "Aufgaben", level: 1 })).toBeVisible();
    await expect(page.getByText("Read-only Übersicht", { exact: true })).toBeVisible();
    await applyInboxFilter(page, { filter: "all", query: M1_12A_OVERDUE_TITLE });
    await expect(inboxCard(page, M1_12A_OVERDUE_TITLE)).toHaveCount(1);

    // Genau ein Formular: die GET-Suche. Keine Server Action, kein POST.
    await expect(page.locator("form")).toHaveCount(1);
    await expect(page.locator("form")).toHaveAttribute("method", "get");
    await expect(page.locator("form[method='post'], form[action]")).toHaveCount(0);
    await expect(page.getByRole("button", {
      name: /Aufgabe anlegen|Bearbeiten|Abschließen|Wieder öffnen|Archivieren|Speichern/u,
    })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 375);
  });

  test("M1-12a: External erhält auf der direkten URL keine Aufgabendaten", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aExternalEmail, inboxLoginNext(data.m112aWorkspaceId));

    await expect(page.getByRole("heading", { name: DENIED_TITLE, level: 1 })).toBeVisible();
    await expect(page.locator(INBOX_LIST)).toHaveCount(0);
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Projektakte öffnen" })).toHaveCount(0);
    await expectNoInboxLeak(page, data);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "body", "External-Denied-Inbox");
  });

  test("M1-12a: Fremdmandant und manipulierter Cursor bleiben fail-closed", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, inboxLoginNext(data.m112aWorkspaceId));

    await page.goto(`/w/${data.foreignWorkspaceId}/aufgaben`);
    await expect(page.getByRole("heading", { name: DENIED_TITLE, level: 1 })).toBeVisible();
    await expectNoInboxLeak(page, data);

    await page.goto(inboxPath);
    await applyInboxFilter(page, { query: M1_12A_PAGE_TITLE_PREFIX });
    await page.getByRole("link", { name: "Weitere Aufgaben" }).click();
    await page.waitForURL((url) => url.searchParams.get("cursor") !== null);
    const valid = new URL(page.url());
    const cursor = valid.searchParams.get("cursor") ?? "";
    const asOf = valid.searchParams.get("asOf") ?? "";
    expect(cursor).not.toBe("");
    const encodedAsOf = encodeURIComponent(asOf);
    const encodedQuery = encodeURIComponent(M1_12A_PAGE_TITLE_PREFIX);

    for (const [label, search] of [
      ["Cursor ohne asOf", `?cursor=${cursor}`],
      [
        "Cursorbindung an einen anderen Filter",
        `?filter=all&state=open&dueBucket=any&query=${encodedQuery}`
          + `&asOf=${encodedAsOf}&cursor=${cursor}`,
      ],
      ["gefälschter Cursor", `?asOf=${encodedAsOf}&cursor=AAAAAAAA`],
      ["unbekannter Query-Schlüssel", "?tasks=archived"],
    ] as const) {
      await page.goto(`${inboxPath}${search}`);
      // Diese Route streamt, weil sie ein loading.tsx besitzt. Next
      // dokumentiert dafür ausdrücklich: bei gestreamten Antworten steht der
      // Statuscode bereits fest, wenn notFound() greift, und bleibt 200; ein
      // echtes 404 gilt nur für ungestreamte Antworten (siehe
      // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
      // not-found.md und .../04-functions/not-found.md). Der Statuscode ist
      // hier deshalb keine belastbare Zusicherung — die Zusicherung ist, dass
      // keinerlei Inbox gerendert wird.
      await expect(
        page.getByRole("heading", { name: "Aufgaben", level: 1 }),
        `${label} rendert die Inbox nicht`,
      ).toHaveCount(0);
      await expect(page.locator(INBOX_LIST)).toHaveCount(0);
      await expect(page.getByRole("search")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Projektakte öffnen" }))
        .toHaveCount(0);
      await expectNoInboxLeak(page, data);
    }
  });

  test("M1-12a: Inbox erfüllt WCAG A/AA und ist per Tastatur bedienbar", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, inboxLoginNext(data.m112aWorkspaceId));
    await expect(page.getByRole("heading", { name: "Aufgaben", level: 1 })).toBeVisible();

    const skipLink = page.getByRole("link", { name: "Zur Aufgabenliste springen" });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).hash).toBe("#global-task-inbox-main");
    // Das Sprungziel muss den Fokus wirklich übernehmen, sonst liefe die
    // nächste Tabulatortaste zurück in die Kopfnavigation.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("global-task-inbox-main");

    await page.getByLabel("Suche").focus();
    await page.keyboard.type(M1_12A_OVERDUE_TITLE);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Anzeigen" })).toBeFocused();
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("query") === M1_12A_OVERDUE_TITLE),
      page.keyboard.press("Enter"),
    ]);
    await expect(inboxCard(page, M1_12A_OVERDUE_TITLE)).toHaveCount(1);

    await expect(page.getByRole("navigation", { name: "Bereichsnavigation" })
      .getByRole("link", { name: "Aufgaben" })).toHaveAttribute("aria-current", "page");
    await expectNoWcagAaAxeViolations(page, "body", "gefilterte Aufgaben-Inbox");
    await expectReducedMotion(
      page,
      page.getByRole("button", { name: "Anzeigen" }),
      "Aufgaben-Inbox",
    );
  });

  test("M1-12a: Inbox fließt bei 320 und 375 px ohne Querlauf um", async ({ page }) => {
    const data = state();
    const inboxPath = `/w/${data.m112aWorkspaceId}/aufgaben`;
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(inboxPath);
    await loginWithRealOtp(page, data.m112aEditorEmail, inboxLoginNext(data.m112aWorkspaceId));
    await applyInboxFilter(page, { filter: "all", query: M1_12A_PAGE_TITLE_PREFIX });
    await expect(page.locator(`${INBOX_LIST} article`)).toHaveCount(PAGE_LIMIT);

    await expectNoHorizontalOverflow(page, 320);
    await expectNoWcagAaAxeViolations(page, "body", "Aufgaben-Inbox bei 320 px");
    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
  });
});
