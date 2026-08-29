import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";

type E2EState = {
  baseURL: string;
  serverLogPath: string;
  workspaceId: string;
  foreignWorkspaceId: string;
  foreignProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  mainContactName: string;
  foreignContactName: string;
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

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "serverLogPath",
    "workspaceId",
    "foreignWorkspaceId",
    "foreignProjectId",
    "editorEmail",
    "viewerEmail",
    "mainContactName",
    "foreignContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-05-E2E-State ist unvollständig.");
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
  // Next 16 streamt bei einer Redirect-Entscheidung mit loading.tsx zunächst
  // eine 200er Shell und folgt anschließend dem eingebetteten Redirect.
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Code anfordern" }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status()).toBe(200);
  await expect(page.getByLabel("Sechsstelliger Code")).toBeVisible();

  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST",
  );
  let signInResponse;
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    signInResponse = await signInResponsePromise;
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  expect(signInResponse.status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoSeriousOrCriticalAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    }));
  expect(blocking).toEqual([]);
}

function boardColumn(page: Page, name: string): Locator {
  return page.locator("section[data-column-id]").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

async function pointerDragToColumn(page: Page, card: Locator, targetColumn: Locator): Promise<void> {
  const handle = card.locator('[data-testid^="drag-"]');
  await expect(handle).toBeVisible();
  await expect(targetColumn).toBeVisible();
  const handleBox = await handle.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  if (!handleBox || !targetBox) throw new Error("Pointer-DnD-Ziel ist nicht messbar.");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + Math.min(140, targetBox.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 12, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 16 });
  await expect(targetColumn.getByText("Hier ablegen", { exact: true })).toBeVisible();
  await page.mouse.up();
}

test.describe.configure({ mode: "serial" });

test("Editor: echter OTP-Golden-Flow persistiert Pin und sichtbaren Statuswechsel", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);

  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  const allCards = page.locator("article[data-project-id]");
  await expect(allCards).toHaveCount(1);
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(0);
  await expect(
    boardColumn(page, "In Prüfung").getByText("Keine Anfragen in diesem Status", { exact: true }),
  ).toBeVisible();
  await expect(
    boardColumn(page, "Qualifiziert").getByText("Keine Anfragen in diesem Status", { exact: true }),
  ).toBeVisible();
  await expect(allCards).toContainText(data.mainContactName);
  await expect(allCards).toContainText("69234 Dielheim");
  await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await allCards.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  await expect(page.getByText(/Rechner-Anfrage · Erstellt am/u)).toBeVisible();
  await expect(page.getByText("Hausgenau", { exact: true })).toBeVisible();
  await expect(page.getByText("Mühlstraße 8, 69234 Dielheim", { exact: true })).toBeVisible();
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.getByRole("button", { name: "Planungs-Pin bestätigen" }).click();
  await expect(page.getByText("Der Planungs-Pin ist bestätigt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Planungs-Pin bestätigen/u })).toHaveCount(0);

  await page.getByRole("link", { name: "Zurück zu den Anfragen" }).click();
  await page.waitForURL((url) => url.pathname === boardPath);
  const cardAfterPin = page.locator("article[data-project-id]");
  await expect(cardAfterPin).toHaveCount(1);
  await expect(cardAfterPin).not.toContainText("Pin offen");

  const keyboardSelect = cardAfterPin.getByLabel(`Zielspalte für „${data.mainContactName}“`);
  const keyboardButton = cardAfterPin.getByRole("button", {
    name: `„${data.mainContactName}“ verschieben`,
  });
  await keyboardSelect.focus();
  await page.keyboard.press("i");
  await expect(keyboardSelect.locator("option:checked")).toHaveText("In Prüfung");
  await page.keyboard.press("Tab");
  await expect(keyboardButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(0);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

  await page.reload();
  await expect(page.locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(0);
  const persistedCard = boardColumn(page, "In Prüfung").locator("article[data-project-id]");
  await expect(persistedCard).toHaveCount(1);
  await expect(persistedCard).toContainText(data.mainContactName);
  await expect(persistedCard).not.toContainText("Pin offen");

  await pointerDragToColumn(page, persistedCard, boardColumn(page, "Qualifiziert"));
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(0);
  await expect(boardColumn(page, "Qualifiziert").locator("article[data-project-id]")).toHaveCount(1);
  await page.reload();
  await expect(boardColumn(page, "Qualifiziert").locator("article[data-project-id]")).toContainText(
    data.mainContactName,
  );

  await page.goto(`/w/${data.foreignWorkspaceId}/anfragen`);
  await expect(page.getByRole("heading", { name: "Kein Zugriff", level: 1 })).toBeVisible();
  await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test.describe("mobiler Chromium-Kontext", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("Mobile: kein Drag-Grip, 44px-Fallback verschiebt persistent", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;

    await page.goto(boardPath);
    await loginWithRealOtp(page, data.editorEmail, boardPath);

    const card = page.locator("article[data-project-id]");
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-testid^="drag-"]')).toBeHidden();
    const select = card.getByLabel(`Zielspalte für „${data.mainContactName}“`);
    const button = card.getByRole("button", { name: `„${data.mainContactName}“ verschieben` });
    await expect(select).toBeVisible();
    await expect(button).toBeVisible();
    expect((await select.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await select.selectOption({ label: "In Prüfung" });
    await button.click();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);
    await page.reload();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toContainText(
      data.mainContactName,
    );
  });
});

test.describe("Tablet mit grobem Zeiger", () => {
  test.use({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
  });

  test("Tablet: Desktop-Raster bleibt ohne wirkungslosen Drag-Grip bedienbar", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;

    await page.goto(boardPath);
    await loginWithRealOtp(page, data.editorEmail, boardPath);

    const card = page.locator("article[data-project-id]");
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-testid^="drag-"]')).toBeHidden();
    await expect(page.getByLabel("Status anzeigen")).toBeHidden();

    const select = card.getByLabel(`Zielspalte für „${data.mainContactName}“`);
    const button = card.getByRole("button", { name: `„${data.mainContactName}“ verschieben` });
    await expect(select).toBeVisible();
    await expect(button).toBeVisible();
    expect((await select.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoSeriousOrCriticalAxeViolations(page);
  });
});

test("Konflikt, 404 und echter Fremdprojekt-Link bleiben fail-closed", async ({ page, context }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

  const stalePage = await context.newPage();
  const staleErrors = trackBrowserErrors(stalePage);
  try {
    await stalePage.goto(boardPath);
    const staleCard = boardColumn(stalePage, "In Prüfung").locator("article[data-project-id]");
    await expect(staleCard).toHaveCount(1);

    const currentCard = boardColumn(page, "In Prüfung").locator("article[data-project-id]");
    await currentCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "Eingang" });
    await currentCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(1);

    await staleCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "Qualifiziert" });
    await staleCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(stalePage.getByRole("status")).toContainText(
      "Die Anfrage wurde zwischenzeitlich geändert.",
    );
    await stalePage.reload();
    await expect(
      boardColumn(stalePage, "Eingang").locator("article[data-project-id]"),
    ).toContainText(data.mainContactName);

    await page.reload();
    const freshCard = boardColumn(page, "Eingang").locator("article[data-project-id]");
    await freshCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "In Prüfung" });
    await freshCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

    const missingProjectId = "11111111-1111-4111-8111-111111111111";
    await page.goto(`${boardPath}/${missingProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Die Projektakte ist nicht verfügbar.",
      level: 1,
    })).toBeVisible();

    await page.goto(`${boardPath}/${data.foreignProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Die Projektakte ist nicht verfügbar.",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(data.foreignContactName)).toHaveCount(0);

    await page.goto(`/w/${data.foreignWorkspaceId}/anfragen/${data.foreignProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Diese Projektakte ist für dich nicht freigegeben.",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
    await expectNoSeriousOrCriticalAxeViolations(page);
  } finally {
    await stalePage.close();
  }
  expect(staleErrors, "zweite Browserseite ohne Console-/Page-Errors").toEqual([]);
});

test("Viewer: darf denselben Lead lesen, aber weder Pin noch Karte verändern", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.viewerEmail, boardPath);

  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff").first()).toBeVisible();
  await expect(page.locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);
  await expect(page.locator("article[data-project-id] form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /verschieben/u })).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Planungs-Pin bestätigen/u })).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);
});
