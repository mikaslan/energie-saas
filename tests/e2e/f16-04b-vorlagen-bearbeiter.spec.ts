import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F16-04b Mehrfach-Bearbeiter aus Aufgaben-Vorlage (Katalog F16.3) —
 * Chromium-E2E. Editor legt eine Vorlage an, wählt per Mitgliedersuche
 * zwei Bearbeiter und wendet sie am Projekt an → die Aufgabe trägt
 * beide Bearbeiter (statt nur den Anwendenden).
 */

type E2EState = {
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  mainContactName: string;
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
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "viewerEmail",
    "mainContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-04B-E2E-State ist unvollständig.");
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

function taskCard(page: Page, title: string) {
  return page.locator("#project-tasks article").filter({
    has: page.getByRole("heading", { name: title, level: 4, exact: true }),
  });
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F16-04B-E2E-01: Vorlage mit zwei Bearbeitern weist beide zu", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const settingsPath = `/w/${data.workspaceId}/einstellungen/aufgaben-vorlagen`;
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;

  const templateName = `F16-04b E2E Vorlage ${Date.now()}`;
  const templateTitle = `F16-04b E2E Aufgabe ${Date.now()}`;

  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Aufgaben-Vorlagen", level: 1 })).toBeVisible();

  const createSection = page.locator("section[aria-label=\"Neue Vorlage\"]");
  await createSection.getByLabel("Name").fill(templateName);
  await createSection.getByLabel("Aufgaben-Titel").fill(templateTitle);
  // Zwei Bearbeiter per Suche wählen (Editor selbst + Viewer).
  await createSection.getByLabel("Mitglieder suchen").fill(data.editorEmail);
  await createSection.getByRole("button", { name: "Suchen", exact: true }).click();
  await createSection.getByRole("checkbox", { name: data.editorEmail }).check();
  await createSection.getByLabel("Mitglieder suchen").fill(data.viewerEmail);
  await createSection.getByRole("button", { name: "Suchen", exact: true }).click();
  await createSection.getByRole("checkbox", { name: data.viewerEmail }).check();
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.locator("section[aria-label=\"Vorlagen\"]").getByRole("heading", { name: templateName })).toBeVisible();
  expect(errors, "Browser-Konsole beim Anlegen").toEqual([]);

  await page.goto(detailPath);
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();

  const tasks = page.locator("#project-tasks");
  await tasks.getByLabel("Aufgabenvorlage").selectOption({ label: `${templateName} – ${templateTitle}` });
  await tasks.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
  await expect(tasks.getByText("Die Aufgabe wurde aus der Vorlage erstellt.", { exact: true })).toBeVisible();
  const card = taskCard(page, templateTitle);
  await expect(card).toHaveCount(1);
  // Beide Bearbeiter statt nur des Anwendenden (Reihenfolge serverseitig).
  await expect(card).toContainText(`Zuständig: ${data.editorEmail}`);
  await expect(card).toContainText(data.viewerEmail);
  expect(errors, "Browser-Konsole beim Anwenden").toEqual([]);
});
