import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";

/**
 * M1-14 — Kontakt-Datensatz (Chromium-E2E)
 * ========================================
 *
 * Deckt die Chromium-Szenarien aus §10.6 der Spec
 * `docs/spec/M1-14-kontaktdatensatz.md` ab:
 *
 *   1. Editor lädt den vollständigen Kontakt-Datensatz (Name/Anrede/Adresse/
 *      Erreichbarkeit/Marketing-Consent) und speichert revisionsgebunden.
 *   2. Namens-Split-Validierungsfehler (leerer Vorname) bleibt ehrlich `invalid`.
 *   3. Viewer sieht den Kontakt ausschließlich read-only (keine Mutations-UI).
 *   4. External bleibt fail-closed (Permission-Denied, ohne Contact-Leak).
 *
 * Zusätzlich: Axe WCAG A/AA, Tastatur (Edit öffnen + Speichern ohne Maus),
 * 375-/320-px-Viewport ohne horizontalen Überlauf, `prefers-reduced-motion`
 * und „keine Browser-Konsolenfehler" (Muster `m1-11b-cannot-fulfil.spec.ts`).
 *
 * Fixture-Ansatz (Option B — wiederverwendet):
 * --------------------------------------------
 * Die Spec nutzt das dedizierte offene M1-11b-Projekt (`m111bWorkspaceId`/
 * `m111bProjectId`/`m111bContactName` „Clara E2E Absage"), das `run.mts` in
 * einem eigenen Workspace seedet. Dessen Kontakt („Clara"/„E2E Absage" aus dem
 * Backfill) darf hier gefahrlos bearbeitet werden, ohne das gemeinsame
 * Hauptprojekt („Erika E2E Muster") von m1-05/m1-09/m1-10/m1-11a anzutasten.
 * Editor/Viewer/External sind Memberships der bestehenden Identitäten; die
 * Kontakt-Adresse ist getrennt von der (unveränderten) Projekt-`site`-Adresse.
 *
 * Datenhygiene: ausschließlich synthetische `@example.test`-Adressen und
 * zufällige UUIDs aus dem privaten State; keine Fremdkonten, keine echten
 * Personendaten. Der Dev-Mail-OTP wird im `finally` aus dem Feld entfernt.
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
    throw new Error("Der private M1-14-E2E-State ist unvollständig.");
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
    message: "Der echte M1-14-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M1-14-Dev-Mail-OTP fehlt.");
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

// Sektion „Identität und Kontakt" der Projektakte (Section aus app/w/[workspaceId]/_ui.tsx).
function contactSection(page: Page): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Identität und Kontakt", level: 2 }),
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
    message: `M1-14: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
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

test.describe("M1-14: Kontakt-Datensatz in der Projektakte", () => {
  test.describe.configure({ mode: "serial" });

  test("M1-14: Editor lädt den Datensatz und speichert revisionsgebunden", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const section = contactSection(page);
    await expect(section).toBeVisible();

    // Lesezustand: Name, Vorname/Nachname, Anrede, Kontaktwege, Consent, Stand.
    await expect(section.getByText("Clara E2E Absage", { exact: true })).toBeVisible();
    await expect(section.getByText("Clara", { exact: true })).toBeVisible();
    await expect(section.getByText("E2E Absage", { exact: true })).toBeVisible();
    await expect(section.getByText("Vorname", { exact: true })).toBeVisible();
    await expect(section.getByText("Nachname", { exact: true })).toBeVisible();
    await expect(section.getByText("Anrede", { exact: true })).toBeVisible();
    await expect(section.getByText("Kontaktwege", { exact: true })).toBeVisible();
    await expect(section.getByText("Kontaktadresse", { exact: true })).toBeVisible();
    await expect(section.getByText("Marketing-Consent", { exact: true })).toBeVisible();
    await expect(section.getByText("Einwilligung: Nicht erteilt", { exact: true })).toBeVisible();
    await expect(section.locator("dd").last()).toHaveText("1");
    await expectNoWcagAaAxeViolations(page, "main", "Kontakt-Lesezustand");

    // Tastatur: Edit öffnen.
    const editButton = section.getByRole("button", { name: "Kontakt bearbeiten" });
    await expect(editButton).toBeVisible();
    expect((await editButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await editButton.focus();
    await expect(editButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(section.getByLabel("Vorname")).toBeVisible();

    // Stammdaten ändern (Name, Anrede, Kontaktwege, Adresse, Consent-Version).
    await section.getByLabel("Vorname").fill("Clara B");
    await section.getByLabel("Nachname").fill("Absage");
    await section.getByLabel("Anrede").selectOption("female");
    await section.getByLabel("Sekundäre E-Mail").fill("clara.zwei@example.test");
    await section.getByLabel("Mobil (E.164, z. B. +49170…)").fill("+491701234567");
    await section.getByLabel("Erreichbarkeit").selectOption("morning");
    await section.getByLabel("Straße").fill("Musterweg");
    await section.getByLabel("Hausnummer").fill("12");
    await section.getByLabel("Postleitzahl").fill("69115");
    await section.getByLabel("Ort").fill("Heidelberg");
    await section.getByLabel("Land").fill("DE");
    await section.getByLabel("Policy-Version").fill("v1");

    // Tastatur: Speichern (ohne Maus).
    const saveButton = section.getByRole("button", { name: "Speichern" });
    expect((await saveButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await saveButton.focus();
    await page.keyboard.press("Enter");

    // Nach dem Erfolg wechselt die Sektion in den Lesezustand mit aktualisierten Werten.
    await expect(section.getByText("Clara B", { exact: true })).toBeVisible();
    await expect(section.getByText("Absage", { exact: true })).toBeVisible();
    await expect(section.getByText("Frau", { exact: true })).toBeVisible();
    await expect(section.getByText("Sekundäre E-Mail: clara.zwei@example.test", { exact: true })).toBeVisible();
    await expect(section.getByText("Mobil: +491701234567", { exact: true })).toBeVisible();
    await expect(section.getByText("Erreichbarkeit: Vormittag", { exact: true })).toBeVisible();
    await expect(section.getByText(
      "Musterweg 12, 69115 Heidelberg, DE",
      { exact: true },
    )).toBeVisible();
    await expect(section.getByText("Policy-Version: v1", { exact: true })).toBeVisible();
    await expect(section.locator("dd").last()).toHaveText("2");

    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Kontakt nach Edit bei 375 px");
    await expectReducedMotion(
      page,
      section.getByRole("button", { name: "Kontakt bearbeiten" }),
      "Kontakt-Lesezustand",
    );

    // Reload-Persistenz.
    await page.reload();
    const reloaded = contactSection(page);
    await expect(reloaded.getByText("Clara B", { exact: true })).toBeVisible();
    await expect(reloaded.getByText("Absage", { exact: true })).toBeVisible();
    await expect(reloaded.getByText("Sekundäre E-Mail: clara.zwei@example.test", { exact: true })).toBeVisible();
    await expect(reloaded.locator("dd").last()).toHaveText("2");
  });

  test("M1-14: Namens-Split-Validierungsfehler bleibt ehrlich", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const section = contactSection(page);
    await section.getByRole("button", { name: "Kontakt bearbeiten" }).click();
    await expect(section.getByLabel("Vorname")).toBeVisible();

    // Leerer Vorname verletzt die Namens-Split-/Nicht-leer-Invariante.
    await section.getByLabel("Vorname").fill("");
    await section.getByRole("button", { name: "Speichern" }).click();

    const feedback = section.getByRole("alert");
    await expect(feedback).toHaveText("Die Eingabe ist unvollständig oder ungültig.");
    await expect(feedback).toBeFocused();
    // Das Formular bleibt geöffnet, der Entwurf bleibt erhalten.
    await expect(section.getByLabel("Vorname")).toBeVisible();
  });

  test("M1-14: Viewer sieht den Kontakt ausschließlich lesend", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.m111bWorkspaceId}/anfragen/${data.m111bProjectId}`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.viewerEmail, detailPath);

    const section = contactSection(page);
    await expect(section).toBeVisible();
    await expect(section.getByText("Clara B", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "Kontakt bearbeiten" })).toHaveCount(0);
    await expect(section.getByText(
      "Du kannst die Kontaktdaten sehen, aber nicht verändern.",
      { exact: true },
    )).toBeVisible();
    await expect(section.locator("form")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Viewer-Kontaktansicht");
  });

  test("M1-14: External bleibt beim Kontakt-Datensatz fail-closed", async ({ browser }) => {
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
      // Fail-closed: die Projektakte existiert für External nicht (404, kein Leak).
      await expect(externalPage.getByRole("heading", {
        name: "Die Projektakte ist nicht verfügbar.",
        level: 1,
      })).toBeVisible();
      await expect(externalPage.getByText(data.m111bContactName, { exact: true })).toHaveCount(0);
      await expect(externalPage.getByRole("heading", {
        name: "Identität und Kontakt",
        level: 2,
      })).toHaveCount(0);
      await expectNoHorizontalOverflow(externalPage, 375);
      await expectNoWcagAaAxeViolations(externalPage, "main", "External-Denied-Kontakt");
      expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
    } finally {
      await externalContext.close();
    }
  });
});
