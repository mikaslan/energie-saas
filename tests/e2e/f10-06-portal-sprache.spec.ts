import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F10-06 Portal-Sprachen — Chromium-E2E (ESTIMATE-Worte, keine Referenz).
 *
 * Durchgängig: interner Datei-Anfragen-Setup → Portal-Link per UI →
 * ?lang=en rendert EN-Chrome (Overview/Upload/Empty-States) → Tab-Link
 * behält die Sprache → ?lang=xx fällt auf Deutsch zurück → Upload-POST
 * meldet EN-Feedback und setzt das portal-lang-Cookie → Reload ohne
 * Parameter bleibt EN → Link zurückziehen → ungültiger Link mit Cookie
 * zeigt die EN-404-Seite. Eigenes Titel-Setup auf dem f101-Projekt,
 * keine Referenzdaten nötig.
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f101ProjectId: string;
  editorEmail: string;
};

const REQUEST_TITLE = "F1006-Uploadhinweis (bitte PDF)";
const UPLOAD_FILENAME = "hinweis.pdf";
const UPLOAD_BYTES = Buffer.from("%PDF-1.4\nF1006-E2E-Beleg\n%%EOF\n", "utf8");

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f101ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10.6-E2E-State ist unvollständig.");
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

test("F10-06-E2E-01: Portalsprache EN wählen, Upload-Feedback, Cookie, EN-404", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f101ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // 1) Interne Datei-Anfrage (Titel eindeutig je Suite).
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(section).toBeVisible();
  await section.getByTestId("file-request-title").fill(REQUEST_TITLE);
  await section.getByTestId("file-request-create").click();
  await expect(section.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );

  // 2) Portal-Link per UI.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) ?lang=en: EN-Chrome auf Übersicht und Dateien-Tab.
  await page.goto(`${tokenPath}?lang=en`);
  await expect(page.getByText("Customer portal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("No released documents available.", { exact: true }))
    .toBeVisible();
  await page.getByRole("link", { name: "Files" }).click();
  await page.waitForURL((url) => url.searchParams.get("lang") === "en");
  await expect(page.getByText(REQUEST_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeVisible();

  // 4) Unbekannte Sprache fällt auf Deutsch zurück.
  await page.goto(`${tokenPath}?lang=xx`);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Übersicht" })).toBeVisible();

  // 5) Upload mit Sprache: EN-Feedback + Cookie wird gesetzt.
  await page.goto(`${tokenPath}?tab=dateien&lang=en`);
  await page.locator('input[type="file"]').setInputFiles({
    name: UPLOAD_FILENAME,
    mimeType: "application/pdf",
    buffer: UPLOAD_BYTES,
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toHaveText(
    "Thank you — your file has been received.",
  );
  const langCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "portal-lang",
  );
  expect(langCookie?.value).toBe("en");

  // 6) Cookie trägt die Sprache ohne Parameter.
  await page.goto(tokenPath);
  await expect(page.getByText("Customer portal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();

  // 7) Intern aufräumen (erledigt) + Link zurückziehen → EN-404 mit Cookie.
  await page.goto(projectPath);
  const requestItem = section.locator("li", { hasText: REQUEST_TITLE });
  await requestItem.getByTestId("file-request-transition-erledigt").click();
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Erledigt");
  await page.reload();
  await expect(portal.getByText("Aktiver Link", { exact: false })).toBeVisible();
  await portal.getByRole("button", { name: "Link zurückziehen", exact: true }).click();
  await expect(portal.getByText("Der Portal-Link wurde zurückgezogen.", { exact: true }))
    .toBeVisible();
  await page.goto(tokenPath);
  await expect(page.getByRole("heading", { name: "This link is invalid.", exact: true }))
    .toBeVisible();

  // Die bewusste 404-Navigation erzeugt die spezifizierte
  // Chromium-Konsolenmeldung (Muster F10.1) — konsumieren, Rest bleibt Fehler.
  const expected404 = "console: Failed to load resource: the server responded with a status of 404 (Not Found)";
  const consumed = errors.filter((error) => error === expected404).length;
  expect(consumed, "Erwartete 404-Konsolenmeldung nach Withdraw").toBeGreaterThan(0);
  const kept = errors.filter((error) => error !== expected404);
  errors.length = 0;
  errors.push(...kept);

  expect(errors, "Browser-Konsole und Page-Errors der Sprachgrenze").toEqual([]);
});
