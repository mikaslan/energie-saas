import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F10-10 Datei-Anfragen Allow-many — Chromium-E2E (LocalStorage-Backend).
 *
 * Durchgängig: interne Anlage MIT „Mehrere Dateien erlauben" → Portal-Link
 * per UI → Erst-Upload → Zweit-Upload (andere Bytes, gleicher Name) →
 * Portal zeigt Zähler + weitere Dateinamen → internes Upload-Verzeichnis.
 * Eigenes f102-Projekt, Titel eindeutig je Suite (Muster f10-04).
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const REQUEST_TITLE = "F1010-Zaehlerfotos (mehrere Dateien)";
const FIRST_FILENAME = "zaehler-a.pdf";
const SECOND_FILENAME = "zaehler-b.pdf";
const FIRST_BYTES = Buffer.from("%PDF-1.4\nF1010-E2E-Erst\n%%EOF\n", "utf8");
const SECOND_BYTES = Buffer.from("%PDF-1.4\nF1010-E2E-Zweit\n%%EOF\n", "utf8");

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f102ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10.10-E2E-State ist unvollständig.");
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

test("F10-10-E2E-01: Allow-many-Anfrage nimmt zwei Belege an", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f102ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // 1) Interne Anlage mit Allow-many.
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(section).toBeVisible();
  await section.getByTestId("file-request-title").fill(REQUEST_TITLE);
  await section.getByTestId("file-request-allow-many").check();
  await section.getByTestId("file-request-create").click();
  await expect(section.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );
  const requestItem = section.locator("li", { hasText: REQUEST_TITLE });
  await expect(requestItem.getByTestId("file-request-status")).toHaveText(
    "Offen · Mehrere Dateien",
  );

  // 2) Portal-Link per UI.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) Erst-Upload im Portal.
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByTestId("file-requests-section")).toBeVisible();
  await expect(page.getByText(REQUEST_TITLE, { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: FIRST_FILENAME,
    mimeType: "application/pdf",
    buffer: FIRST_BYTES,
  });
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByText(`Hochgeladen (${FIRST_FILENAME})`)).toBeVisible();

  // 4) Zweit-Upload (andere Bytes) — Formular bleibt bei Allow-many sichtbar.
  await page.locator('input[type="file"]').setInputFiles({
    name: SECOND_FILENAME,
    mimeType: "application/pdf",
    buffer: SECOND_BYTES,
  });
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByText("2 Dateien erhalten")).toBeVisible();
  await expect(page.getByText(SECOND_FILENAME, { exact: true })).toBeVisible();

  // 5) Intern: Badge + Upload-Verzeichnis.
  await page.goto(projectPath);
  await expect(requestItem.getByTestId("file-request-status")).toHaveText(
    "Hochgeladen · Mehrere Dateien",
  );
  await expect(requestItem.getByTestId("file-request-uploads")).toContainText(
    `Weitere Datei: ${SECOND_FILENAME}`,
  );

  expect(errors, "Browser-Konsole und Page-Errors der Allow-many-Grenze").toEqual([]);
});
