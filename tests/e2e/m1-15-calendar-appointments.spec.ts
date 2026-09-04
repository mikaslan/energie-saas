import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";

/**
 * M1-15 — Termine & Kalender (Chromium-E2E)
 * =========================================
 *
 * Deckt die Chromium-Szenarien aus §11 der Spec
 * `docs/spec/M1-15-termine-kalender.md` ab:
 *
 *   1. Monatsansicht rendert; Editor legt einen Termin an (Titel, Berliner
 *      Start/Ende, Kategorie-Leerzustand, Teilnehmer) → erscheint persistent.
 *   2. Ungültiges Zeitfenster (Ende vor Beginn) zeigt einen ehrlichen Fehler.
 *   3. Editor bearbeitet einen Termin revisionsgebunden (persistent).
 *   4. Editor löscht einen Termin dauerhaft (Hard-Delete) → verschwindet.
 *   5. Viewer sieht Termine ausschließlich read-only.
 *   6. External bleibt fail-closed (Permission-Denied, ohne Termin-Leak).
 *
 * Zusätzlich: Axe WCAG A/AA, Tastatur (Dialog öffnen + Speichern ohne Maus),
 * 375-px-Viewport ohne horizontalen Überlauf, `prefers-reduced-motion` und
 * „keine Browser-Konsolenfehler" (Muster `m1-11b-cannot-fulfil.spec.ts`).
 *
 * Fixture-Ansatz (Option B — wiederverwendet):
 * --------------------------------------------
 * Die Spec nutzt das dedizierte offene M1-11b-Projekt (`m111bWorkspaceId`/
 * `m111bProjectId`/`m111bContactName` „Clara E2E Absage"). `run.mts` seedet
 * dafür einen eigenen Workspace mit Editor/Viewer/External-Memberships. Das
 * Hauptprojekt („Erika E2E Muster") von m1-05/m1-11a bleibt unangetastet.
 * `appointment.write` hängt nicht am Projekt-Outcome, daher ist die Spec auch
 * nach einem M1-11b-Lauf im Voll-Serienlauf stabil.
 *
 * Hinweis zur Szenario-Interpretation: Die Spec kennt keinen echten
 * „Überlappungs-Konflikt" zwischen zwei Terminen (Service prüft nur
 * `end > start` und die `allDay`-Tagesregel). Szenario 2 prüft deshalb die
 * implementierte Zeitfenster-Validierung `end <= start` → `invalid`.
 *
 * Datenhygiene: ausschließlich synthetische `@example.test`-Adressen und
 * zufällige UUIDs; keine Fremdkonten, keine echten Personendaten. Der
 * Dev-Mail-OTP wird im `finally` aus dem Feld entfernt.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  m111bWorkspaceId: string;
  m111bProjectId: string;
  m111bContactName: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const APPOINTMENT_TITLE = "M1-15 E2E Termin";
const APPOINTMENT_TITLE_EDITED = "M1-15 E2E Termin bearbeitet";

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "m111bWorkspaceId",
    "m111bProjectId",
    "m111bContactName",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-15-E2E-State ist unvollständig.");
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
    message: "Der echte M1-15-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M1-15-Dev-Mail-OTP fehlt.");
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

// Berliner Kalendertag des Laufzeitpunkts als "YYYY-MM-DD" (Wall-Clock).
function berlinDateToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Termin-Artikel unterhalb des Kalenders (deterministische DOM-Liste).
function appointmentArticle(page: Page, title: string): Locator {
  return page.locator("#project-appointments article").filter({
    has: page.getByText(title, { exact: true }),
  });
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
    message: `M1-15: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
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

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M1-15: Termine & Kalender in der Projektakte", () => {
  test.describe.configure({ mode: "serial" });


async function seedTenancyCalendar(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select gen_random_uuid(), $1::uuid, 'M1-15 E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'M1-15 E2E Kalender'
          )
        limit 1`,
      [data.m111bWorkspaceId, data.editorEmail],
    );
  } finally {
    await pool.end();
  }
}

test("M1-15: Monatsansicht rendert; Editor legt einen Termin an (persistent)", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    // Kalender muss VOR dem ersten Rendern existieren (Range-Query beim Laden).
    await seedTenancyCalendar();
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const section = page.locator("#project-appointments");
    await expect(section.getByRole("heading", { name: "Termine", level: 2 })).toBeVisible();

    // Monatsansicht: Ansichtsgruppe mit Monat (aktiv), Woche, Liste.
    const viewGroup = page.getByRole("group", { name: "Kalenderansicht" });
    await expect(viewGroup.getByRole("button", { name: "Monat" })).toHaveAttribute(
      "aria-pressed", "true",
    );
    await expect(viewGroup.getByRole("button", { name: "Woche" })).toBeVisible();
    await expect(viewGroup.getByRole("button", { name: "Liste" })).toBeVisible();
    await expect(section.locator(".fc")).toBeVisible();
    await expect(section.getByText("Noch keine Termine vorhanden.", { exact: true })).toBeVisible();

    // Dialog öffnen (Tastaturpfad wird beim Speichern geprüft).
    const createButton = section.getByRole("button", { name: "Termin anlegen" });
    await expect(createButton).toBeVisible();
    expect((await createButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await createButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Termin anlegen", level: 2 }))
      .toBeVisible();

    // Kalenderauswahl: der geseedete Tenancy-Kalender ist vorausgewählt.
    const calendar = dialog.getByLabel("Kalender");
    await expect(calendar.locator("option")).toHaveCount(1);
    await expect(calendar.locator("option")).toHaveText("M1-15 E2E Kalender");

    // Teilnehmer: interne Mitglieder stehen als Checkboxen bereit.
    await expect(dialog.getByText("Teilnehmer", { exact: true })).toBeVisible();

    const date = berlinDateToday();
    await dialog.getByLabel("Titel").fill(APPOINTMENT_TITLE);
    await dialog.getByLabel("Typ").selectOption("on_site");
    await dialog.getByLabel("Beginn").fill(`${date}T10:00`);
    await dialog.getByLabel("Ende", { exact: true }).fill(`${date}T11:00`);
    await dialog.getByRole("checkbox", { name: data.editorEmail }).check();

    // Tastatur: Speichern (ohne Maus).
    const saveButton = dialog.getByRole("button", { name: "Speichern" });
    expect((await saveButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await saveButton.focus();
    await expect(saveButton).toBeFocused();
    await page.keyboard.press("Enter");

    // Dialog schließt; der Termin erscheint im Abschnitt.
    await expect(dialog).toHaveCount(0);
    const article = appointmentArticle(page, APPOINTMENT_TITLE);
    await expect(article).toHaveCount(1);
    await expect(article).toContainText("Vor Ort");

    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-appointments", "Termin angelegt bei 375 px");
    await expectReducedMotion(
      page,
      section.getByRole("button", { name: "Termin anlegen" }),
      "Termine-Sektion",
    );

    // Reload-Persistenz.
    await page.reload();
    await expect(appointmentArticle(page, APPOINTMENT_TITLE)).toHaveCount(1);
    await expect(page.locator("#project-appointments").getByText(
      "Noch keine Termine vorhanden.",
      { exact: true },
    )).toHaveCount(0);
  });

  test("M1-15: Ungültiges Zeitfenster zeigt einen ehrlichen Fehler", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    await page.locator("#project-appointments").getByRole("button", {
      name: "Termin anlegen",
    }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Termin anlegen", level: 2 }))
      .toBeVisible();

    const date = berlinDateToday();
    await dialog.getByLabel("Titel").fill("M1-15 E2E ungültig");
    // Ende vor Beginn verletzt `end > start`.
    await dialog.getByLabel("Beginn").fill(`${date}T14:00`);
    await dialog.getByLabel("Ende", { exact: true }).fill(`${date}T13:00`);
    await dialog.getByRole("button", { name: "Speichern" }).click();

    const feedback = dialog.getByRole("alert");
    await expect(feedback).toHaveText("Die Terminänderung ist unvollständig oder ungültig.");
    // Dialog bleibt offen; der Termin wird nicht angelegt.
    await expect(dialog).toBeVisible();
    await expect(appointmentArticle(page, "M1-15 E2E ungültig")).toHaveCount(0);
  });

  test("M1-15: Editor bearbeitet einen Termin revisionsgebunden", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const article = appointmentArticle(page, APPOINTMENT_TITLE);
    await expect(article).toHaveCount(1);
    await article.getByRole("button", { name: "Bearbeiten" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Termin bearbeiten", level: 2 }))
      .toBeVisible();
    await dialog.getByLabel("Titel").fill(APPOINTMENT_TITLE_EDITED);
    await dialog.getByLabel("Typ").selectOption("phone");
    await dialog.getByRole("button", { name: "Speichern" }).click();

    await expect(dialog).toHaveCount(0);
    const edited = appointmentArticle(page, APPOINTMENT_TITLE_EDITED);
    await expect(edited).toHaveCount(1);
    await expect(edited).toContainText("Telefonat");
    await expect(appointmentArticle(page, APPOINTMENT_TITLE)).toHaveCount(0);

    await page.reload();
    await expect(appointmentArticle(page, APPOINTMENT_TITLE_EDITED)).toHaveCount(1);
  });

  test("M1-15: Editor löscht einen Termin dauerhaft", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const article = appointmentArticle(page, APPOINTMENT_TITLE_EDITED);
    await expect(article).toHaveCount(1);
    await article.getByRole("button", { name: "Bearbeiten" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Termin bearbeiten", level: 2 }))
      .toBeVisible();
    await dialog.getByText("Löschen", { exact: true }).click();
    await expect(dialog.getByText(
      "Der Termin wird dauerhaft entfernt und ist danach nicht mehr sichtbar.",
      { exact: true },
    )).toBeVisible();
    await dialog.getByRole("button", { name: "Endgültig löschen" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(appointmentArticle(page, APPOINTMENT_TITLE_EDITED)).toHaveCount(0);
    await expect(page.locator("#project-appointments").getByText(
      "Noch keine Termine vorhanden.",
      { exact: true },
    )).toBeVisible();

    await page.reload();
    await expect(appointmentArticle(page, APPOINTMENT_TITLE_EDITED)).toHaveCount(0);
  });

  test("M1-15: Viewer sieht Termine ausschließlich lesend", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.viewerEmail, detailPath);

    await seedTenancyCalendar();
    const section = page.locator("#project-appointments");
    await expect(section.getByRole("heading", { name: "Termine", level: 2 })).toBeVisible();
    await expect(section.getByRole("button", { name: "Termin anlegen" })).toHaveCount(0);
    await expect(section.getByText(
      "Du kannst Termine sehen, aber nicht verändern.",
      { exact: true },
    )).toBeVisible();
    await expect(section.getByRole("button", { name: "Bearbeiten" })).toHaveCount(0);
    await expect(section.locator(".fc")).toBeVisible();
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-appointments", "Viewer-Termine");
  });

  test("M1-15: External bleibt beim Kalender fail-closed", async ({ browser }) => {
    test.setTimeout(120_000);
    const data = state();
    const boardPath = `/w/${data.m111bWorkspaceId}/anfragen`;
    const closedPath = `${boardPath}/abgeschlossen`;
    const detailPath = `${boardPath}/${data.m111bProjectId}`;

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

      await externalPage.goto(closedPath);
      await expect(externalPage.getByRole("heading", { name: "Kein Zugriff", level: 1 }))
        .toBeVisible();

      await externalPage.goto(detailPath);
      // Das M1-11b-Fixtureprojekt ist terminal (cannot_fulfil) — eine nicht
      // zugewiesene External-Person sieht deshalb die Projektakte nicht
      // (M1-11b-Muster), niemals die Termin-Sektion.
      await expect(externalPage.getByRole("heading", {
        name: "Die Projektakte ist nicht verfügbar.",
        level: 1,
      })).toBeVisible();
      await expect(externalPage.getByRole("heading", {
        name: "Termine",
        level: 2,
      })).toHaveCount(0);
      await expect(externalPage.locator("#project-appointments")).toHaveCount(0);
      await expectNoHorizontalOverflow(externalPage, 375);
      await expectNoWcagAaAxeViolations(externalPage, "main", "External-Denied-Termine");
      expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
    } finally {
      await externalContext.close();
    }
  });
});
