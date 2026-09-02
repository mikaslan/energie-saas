import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";

/**
 * M1-11b — Cannot Fulfil (Chromium-E2E)
 * ======================================
 *
 * Deckt die vier Chromium-Szenarien aus §11.4 der Spec
 * `docs/spec/M1-11b-cannot-fulfil.md` ab:
 *
 *   1. Editor-Abschluss mit eingefrorener Akte (terminal, kein Reopen, keine
 *      Mutationscontrols, Absage-/Sperrwarnung).
 *   2. Abgeschlossen-Liste mit „Nicht erfüllbar" als drittem Filter.
 *   3. Viewer sieht den terminalen Status ausschließlich read-only.
 *   4. External bleibt fail-closed (kein Blick auf die terminale Akte).
 *
 * Zusätzlich je Szenario: Axe WCAG A/AA, Tastatur (Szenario 1 vollständig über
 * Tastatur abgeschlossen), 375-px-/320-px-Viewport ohne horizontalen Überlauf,
 * `prefers-reduced-motion` und „keine Browser-Konsolenfehler" (nach Muster
 * `m1-11a-project-outcome.spec.ts`).
 *
 * Laufvoraussetzung / Fixture-Bedarf (WICHTIG — NICHT selbst geändert):
 * --------------------------------------------------------------------
 * Der Slice setzt voraus, dass das Hauptprojekt beim Teststart den Outcome
 * `open` besitzt. Im vollständigen Serienlauf der Suite beendet
 * `m1-11a-project-outcome.spec.ts` dasselbe Hauptprojekt jedoch im Zustand
 * `won`. Deshalb darf diese Spec im Voll-Serienlauf NICHT nach M1-11a auf
 * demselben Projekt laufen. Der Root-Integrator wählt genau eine der beiden
 * deterministischen Varianten:
 *
 *   (a) EMPFOHLEN — isolierter Einzel-Spec-Lauf auf frischer Datenbank:
 *       `M1_05_E2E_SPEC=m1-11b-cannot-fulfil.spec.ts npm run test:e2e`.
 *       Das Hauptprojekt ist dort noch `open`; kein Eingriff in `run.mts`
 *       nötig. Die External-Zuweisung stellt die Spec selbst idempotent her
 *       (siehe `ensureExternalAssignment`, identisch zu M1-11a).
 *
 *   (b) Falls die Spec in den Voll-Serienlauf eingereiht werden soll, braucht
 *       `run.mts` eine dedizierte Fixture-Erweiterung: ein ZWEITES offenes
 *       Request-Projekt (eigener Intake-Lead) plus State-Felder
 *       `m111bProjectId` und `m111bContactName` (und die External-Zuweisung
 *       darauf). Diese Spec nutzt dann statt `mainProjectId`/`mainContactName`
 *       die `m111b*`-Felder.
 *
 * Erwartete, aber in der UI noch NICHT finale Test-IDs/Labels („voraussichtlich"):
 * --------------------------------------------------------------------------------
 * Die Implementierung ist noch in Arbeit; folgende Prüfungen sind gegen die
 * Spec-Deklaration geschrieben und markiert „voraussichtlich", falls das
 * Ziel-Artefakt noch fehlt:
 *
 *   - Abgeschlossen-Liste, dritter Filter: Link „Nicht erfüllbar" →
 *     `?filter=cannot_fulfill` und Zeilen-Badge „Nicht erfüllbar".
 *     (`projectClosedRequestFilterSchema` kennt den Wert bereits; die Seite
 *     `app/w/[workspaceId]/anfragen/abgeschlossen/page.tsx` rendert ihn noch
 *     nicht.)
 *   - Aktivitätslabel: erwartet „Anfrage nicht erfüllbar" (Muster von
 *     „Anfrage gewonnen/verloren/wieder geöffnet"). Das Event
 *     `project.outcome_cannot_fulfil` existiert in Migration 0040, aber
 *     `lib/integrations/tasks/contract.ts` (`projectActivityLabels`) führt das
 *     Label noch nicht.
 *   - Header-Outcome-Badge der Projektakte (`outcomeLabel` in
 *     `[projectId]/page.tsx`) mappt `cannot_fulfill` noch nicht auf
 *     „Nicht erfüllbar".
 *   - Breadcrumb „Zurück zu den Anfragen" sollte nach `cannot_fulfill` auf die
 *     Abgeschlossen-Liste zeigen (aktuell nur für `won`/`lost`).
 *
 * Nicht im Umfang dieser 4 Szenarien (offene Punkte, siehe Abschlussmeldung):
 * Zustellstatus der Kundenmail „ohne PII" (§7/§10) und die Sperrmeldungen in
 * beiden Angebots-Panels (§10) sind noch nicht als UI-Artefakt vorhanden und
 * werden hier nicht assertiert.
 *
 * Datenhygiene: ausschließlich synthetische `@example.test`-Adressen und
 * zufällige UUIDs aus dem privaten State (`M1_05_E2E_STATE`); keine
 * Fremdkonten, keine echten Personen-/Anbieterdaten. Der Dev-Mail-OTP wird
 * ausgelesen und im `finally` wieder aus dem Eingabefeld entfernt.
 */

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

const browserErrors = new WeakMap<Page, string[]>();

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
    throw new Error("Der private M1-11b-E2E-State ist unvollständig.");
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
    message: "Der echte M1-11b-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M1-11b-Dev-Mail-OTP fehlt.");
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

// Stellt idempotent sicher, dass die External-Person dem Projekt zugewiesen ist,
// damit Szenario 4 (External abgewiesen) nicht nur „nicht zugewiesen", sondern
// „zugewiesen und trotzdem fail-closed" belegt. Identisches Muster wie M1-11a.
async function ensureExternalAssignment(page: Page, data: E2EState): Promise<void> {
  const panel = page.locator("#project-assignment");
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
    const feedback = panel.getByText(
      "Die Projektverantwortung wurde gespeichert.",
      { exact: true },
    );
    await expect(feedback).toBeVisible();
    await expect(feedback).toBeFocused();
  }
  await expect(panel.getByRole("button", {
    name: `${data.externalEmail} vom Projekt entfernen`,
  })).toBeVisible();
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
    message: `M1-11b: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
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

function closedProjectRow(page: Page, contactName: string): Locator {
  return page.locator("li").filter({
    has: page.getByRole("heading", { name: contactName, level: 2, exact: true }),
  });
}

// Prüft die Projektaktivität: festes deutsches Ereignislabel und keinerlei
// Outbox-/Benachrichtigungs-Interna oder Idempotenzschlüssel im gerenderten
// HTML („ohne PII", §7/§8). Das Label „Anfrage nicht erfüllbar" ist
// VORAUSSICHTLICH (noch nicht in `projectActivityLabels`).
async function expectSafeCannotFulfilActivity(page: Page): Promise<void> {
  const activity = page.locator("#project-activity");
  await expect(activity).toBeVisible();
  await expect(activity.getByText("Anfrage nicht erfüllbar", { exact: true }).first())
    .toBeVisible();
  const html = await activity.innerHTML();
  expect(html).not.toMatch(
    /project\.outcome_cannot_fulfil|customer_notification|delivery_attempt|cannot-fulfil\.v1|notification\.customer|idempotency/iu,
  );
}

// Fail-closed-Gegenprobe: keine Outbox-/Benachrichtigungs-Interna im
// Seiten-HTML und keine rohen Idempotenzschlüssel (64 Hex) im sichtbaren Text
// (Muster wie `expectNoFullSha256InVisibleText` aus m1-05).
async function expectNoNotificationInternals(page: Page): Promise<void> {
  expect(await page.content()).not.toMatch(
    /customer_notification|delivery_attempt|cannot-fulfil\.v1|notification\.customer|idempotency|project\.outcome_cannot_fulfil/iu,
  );
  expect(await page.locator("body").innerText()).not.toMatch(/\b[0-9a-f]{64}\b/iu);
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M1-11b: Cannot Fulfil als terminale, gesperrte Abschlusskante", () => {
  test.describe.configure({ mode: "serial" });

  test("M1-11b: Editor schließt Cannot Fulfil ab; die Akte friert terminal ein", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);
    await ensureExternalAssignment(page, data);

    const outcome = page.locator("#project-outcome");
    await expect(outcome.getByRole("heading", { name: "Anfrage-Status", level: 2 }))
      .toBeVisible();

    // Dritte Abschlussaktion samt Warnung über die Tastatur öffnen (Tastatur-Check).
    const cannotSummary = outcome.locator("summary").filter({
      hasText: "Als nicht erfüllbar abschließen",
    });
    await expect(cannotSummary).toBeVisible();
    expect((await cannotSummary.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await cannotSummary.focus();
    await expect(cannotSummary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(outcome.getByText(/Endgültig: Die Anfrage wird als nicht erfüllbar abgeschlossen/u))
      .toBeVisible();

    const confirm = outcome.getByRole("button", {
      name: "Nicht erfüllbar verbindlich bestätigen",
    });
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("xpath=ancestor::form[1]")
      .locator('input[name="confirmation"]')).toHaveValue("mark_cannot_fulfill");
    expect((await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await confirm.focus();
    await page.keyboard.press("Enter");

    const feedback = outcome.getByRole("status");
    await expect(feedback).toHaveText(
      "Die Anfrage wurde endgültig als nicht erfüllbar abgeschlossen.",
    );
    await expect(feedback).toBeFocused();

    // Terminaler Status in der Akte.
    await expect(outcome).toContainText("Nicht erfüllbar · Stand 1");

    // Eingefrorene Akte: keine Mutationscontrols, kein Reopen, kein Lost/Won.
    await expect(outcome.locator("form")).toHaveCount(0);
    await expect(outcome.locator("summary")).toHaveCount(0);
    await expect(outcome.getByText(
      "Dieser Status wird in diesem Arbeitsschritt nicht verändert.",
      { exact: true },
    )).toBeVisible();
    await expect(outcome.getByRole("button", {
      name: /(?:Nicht erfüllbar verbindlich|Wieder öffnen|Gewonnen verbindlich|Verloren verbindlich)/u,
    })).toHaveCount(0);

    await expectSafeCannotFulfilActivity(page);

    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "Cannot-Fulfil-Akte bei 375 px");
    await expectNoWcagAaAxeViolations(page, "#project-activity", "Cannot-Fulfil-Aktivität");
    await expectReducedMotion(
      page,
      page.getByRole("link", { name: "Zurück zu den Anfragen" }),
      "Cannot-Fulfil-Projektakte",
    );
  });

  test("M1-11b: Abgeschlossen-Liste führt „Nicht erfüllbar“ als dritten Filter", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;
    const closedPath = `${boardPath}/abgeschlossen`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(closedPath);
    await loginWithRealOtp(page, data.editorEmail, closedPath);

    // VORAUSSICHTLICH: dritter Filter-Link + `?filter=cannot_fulfill`.
    const filters = page.getByRole("navigation", { name: "Abschlussfilter" });
    await filters.getByRole("link", { name: "Nicht erfüllbar" }).click();
    await page.waitForURL((url) => (
      url.pathname === closedPath && url.searchParams.get("filter") === "cannot_fulfill"
    ));

    const closedRow = closedProjectRow(page, data.mainContactName);
    await expect(closedRow).toContainText("Nicht erfüllbar");
    await expect(closedRow).toContainText("Stand 1");
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Cannot-Fulfil-Archivfilter");
    await closedRow.getByRole("link", { name: "Projektakte öffnen" }).click();
    await page.waitForURL((url) => url.pathname === `${boardPath}/${data.mainProjectId}`);
    await expect(page.locator("#project-outcome")).toContainText("Nicht erfüllbar · Stand 1");
  });

  test("M1-11b: Viewer sieht den terminalen Status ausschließlich lesend", async ({ page }) => {
    const data = state();
    const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.viewerEmail, detailPath);

    const outcome = page.locator("#project-outcome");
    await expect(outcome).toContainText("Nicht erfüllbar · Stand 1");
    await expect(outcome.getByText(
      "Du kannst das Geschäftsergebnis sehen, aber nicht verändern.",
      { exact: true },
    )).toBeVisible();
    await expect(outcome.locator("form")).toHaveCount(0);
    await expect(outcome.locator("summary")).toHaveCount(0);
    await expect(outcome.getByRole("button", {
      name: /(?:Nicht erfüllbar verbindlich|Wieder öffnen|Gewonnen verbindlich|Verloren verbindlich)/u,
    })).toHaveCount(0);
    await expectSafeCannotFulfilActivity(page);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "Viewer-Cannot-Fulfil-Ansicht");
    await expectNoWcagAaAxeViolations(page, "#project-activity", "Viewer-Cannot-Fulfil-Aktivität");
    await expectReducedMotion(
      page,
      page.getByRole("link", { name: "Zurück zu den Anfragen" }),
      "Viewer-Cannot-Fulfil-Akte",
    );

    await page.setViewportSize({ width: 320, height: 900 });
    await expectNoHorizontalOverflow(page, 320);
  });

  test("M1-11b: External bleibt bei terminaler Akte fail-closed", async ({ browser }) => {
    test.setTimeout(120_000);
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;
    const closedPath = `${boardPath}/abgeschlossen`;
    const detailPath = `${boardPath}/${data.mainProjectId}`;

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
      await expectNoNotificationInternals(externalPage);

      await externalPage.goto(closedPath);
      await expect(externalPage.getByRole("heading", { name: "Kein Zugriff", level: 1 }))
        .toBeVisible();
      await expect(externalPage.getByText(data.mainContactName, { exact: true })).toHaveCount(0);
      await expectNoNotificationInternals(externalPage);

      await externalPage.goto(detailPath);
      await expect(externalPage.getByRole("heading", {
        name: "Die Projektakte ist nicht verfügbar.",
        level: 1,
      })).toBeVisible();
      await expect(externalPage.locator("#project-outcome")).toHaveCount(0);
      await expect(externalPage.locator("#project-activity")).toHaveCount(0);
      await expect(externalPage.getByText(data.mainContactName, { exact: true })).toHaveCount(0);
      await expectNoNotificationInternals(externalPage);
      await expectNoHorizontalOverflow(externalPage, 375);
      await expectNoWcagAaAxeViolations(externalPage, "main", "terminal geschlossene External-Akte");
      expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
    } finally {
      await externalContext.close();
    }
  });
});
