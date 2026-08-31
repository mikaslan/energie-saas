import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

type E2EState = {
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  externalEmail: string;
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
    "externalEmail",
    "mainContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-09-E2E-State ist unvollständig.");
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
    if (match) return match[1];
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
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoSeriousOrCriticalAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    }))).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe.configure({ mode: "serial" });

test("M1-09: Editor setzt Hauptverantwortung und weist eine externe Person direkt zu", async ({ page }) => {
  const data = state();
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
  await page.goto(detailPath);
  await loginWithRealOtp(page, data.editorEmail, detailPath);

  const panel = page.locator("#project-assignment");
  await expect(panel.getByRole("heading", { name: "Projektverantwortung", level: 2 })).toBeVisible();

  const search = panel.getByLabel("Personensuche");
  await search.fill(data.editorEmail);
  await search.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByText("1 passende Person gefunden.", { exact: true })).toBeVisible();
  const setKeyAccount = panel.getByRole("button", {
    name: `${data.editorEmail} als Key Account festlegen`,
  });
  await setKeyAccount.focus();
  await page.keyboard.press("Enter");
  const mutationFeedback = panel.getByText(
    "Die Projektverantwortung wurde gespeichert.",
    { exact: true },
  );
  await expect(mutationFeedback).toBeVisible();
  await expect(mutationFeedback).toBeFocused();
  await expect(panel.getByText(data.editorEmail, { exact: true }).first()).toBeVisible();

  await search.fill(data.externalEmail);
  await panel.getByRole("button", { name: "Suchen" }).click();
  await expect(panel.getByText("1 passende Person gefunden.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: `${data.externalEmail} zusätzlich zuweisen` }).click();
  await expect(panel.getByText("Die Projektverantwortung wurde gespeichert.", { exact: true })).toBeVisible();
  await expect(panel.getByText(data.externalEmail, { exact: true }).first()).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.goto(`/w/${data.workspaceId}/anfragen`);
  const card = page.locator(`article[data-project-id="${data.mainProjectId}"]`);
  await expect(card).toContainText(`Hauptverantwortung: ${data.editorEmail}`);
});

test("M1-09: externe Person sieht nur die direkt zugewiesene offene Anfrage", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(boardPath);
  await loginWithRealOtp(page, data.externalEmail, boardPath);

  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff", { exact: true }).first()).toBeVisible();
  const cards = page.locator("article[data-project-id]");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("data-project-id", data.mainProjectId);
  await expect(cards).toContainText(data.mainContactName);
  await expect(page.getByRole("link", { name: "Produktkatalog" })).toHaveCount(0);
  await expect(page.locator('[data-testid^="drag-"]')).toHaveCount(0);
  await expect(page.getByText("Hauptverantwortung:", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 375);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await cards.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  await expect(page.getByText("Zugewiesene Anfrage", { exact: true })).toBeVisible();
  await expect(page.getByText("Du siehst ausschließlich die dir direkt zugewiesene, offene Kundenanfrage.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projektverantwortung" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Angebot" })).toHaveCount(0);
  await expect(page.getByLabel("Personensuche")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suchen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adresse übernehmen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(?:als Key Account|zusätzlich zuweisen|vom Projekt entfernen)/u })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 375);
  await page.setViewportSize({ width: 320, height: 900 });
  await expectNoHorizontalOverflow(page, 320);
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("M1-09: Entfernen der direkten Zuweisung entzieht Board und Detail", async ({ page, browser }) => {
  const data = state();
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
  const boardPath = `/w/${data.workspaceId}/anfragen`;
  await page.goto(detailPath);
  await loginWithRealOtp(page, data.editorEmail, detailPath);

  const panel = page.locator("#project-assignment");
  await panel.getByRole("button", { name: `${data.externalEmail} vom Projekt entfernen` }).click();
  await expect(panel.getByText("Die Projektverantwortung wurde gespeichert.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: `${data.externalEmail} vom Projekt entfernen` })).toHaveCount(0);

  const externalContext = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const externalPage = await externalContext.newPage();
  const externalErrors = trackBrowserErrors(externalPage);
  try {
    await externalPage.goto(boardPath);
    await loginWithRealOtp(externalPage, data.externalEmail, boardPath);
    await expect(externalPage.locator("article[data-project-id]")).toHaveCount(0);

    await externalPage.goto(detailPath);
    await expect(externalPage.getByRole("heading", {
      name: "Die Projektakte ist nicht verfügbar.",
      level: 1,
    })).toBeVisible();
    await expect(externalPage.getByText(data.mainContactName, { exact: true })).toHaveCount(0);
    await expectNoSeriousOrCriticalAxeViolations(externalPage);
    expect(externalErrors, "Browser-Konsole und Page-Errors der Entzugssession").toEqual([]);
  } finally {
    await externalContext.close();
  }
});
