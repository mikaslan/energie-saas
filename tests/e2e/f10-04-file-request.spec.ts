import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F10-04 Datei-Anfragen — Chromium-E2E (LocalStorage-Backend).
 *
 * Durchgängig: interne Anlage (Titel/Beschreibung) → Portal-Link per UI →
 * Dateien-Tab zeigt offene Anfrage → Kunden-Upload (PDF) → Portal-Bestätigung
 * → interner Eingangs-QR mit Prüfsumme → Beleg-Download (Byte-identisch) →
 * Erledigt-Übergang. Eigenes f102-Projekt, kein Cleanup nötig (frische
 * E2E-DB je Lauf; Titel eindeutig je Suite).
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const REQUEST_TITLE = "F1004-Stromrechnung (letzte 12 Monate)";
const UPLOAD_FILENAME = "stromrechnung.pdf";
const UPLOAD_BYTES = Buffer.from(
  "%PDF-1.4\nF1004-E2E-Beleg\n%%EOF\n",
  "utf8",
);

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
    throw new Error("Der private F10.4-E2E-State ist unvollständig.");
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

test("F10-04-E2E-01: Datei-Anfrage von Anlage bis Byte-identischem Beleg", async ({ page }) => {
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

  // 1) Interne Anlage (Titel + Beschreibung).
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(section).toBeVisible();
  await section.getByTestId("file-request-title").fill(REQUEST_TITLE);
  await section.getByTestId("file-request-description").fill("Bitte als PDF hochladen.");
  await section.getByTestId("file-request-create").click();
  await expect(section.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );
  const requestItem = section.locator("li", { hasText: REQUEST_TITLE });
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Offen");

  // 2) Portal-Link per UI.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) Dateien-Tab: offene Anfrage + Upload.
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByTestId("file-requests-section")).toBeVisible();
  await expect(page.getByText(REQUEST_TITLE, { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: UPLOAD_FILENAME,
    mimeType: "application/pdf",
    buffer: UPLOAD_BYTES,
  });
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toHaveText(
    "Vielen Dank — die Datei ist eingegangen.",
  );
  await expect(page.getByText(`Hochgeladen (${UPLOAD_FILENAME})`)).toBeVisible();

  // 4) Intern: Eingangs-QR mit Prüfsumme, Byte-identischer Download.
  await page.goto(projectPath);
  const receipt = section.getByTestId("file-request-receipt");
  await expect(receipt).toContainText(`Beleg: ${UPLOAD_FILENAME}`);
  const expectedSha = createHash("sha256").update(UPLOAD_BYTES).digest("hex");
  await expect(section.locator("code", { hasText: expectedSha })).toBeVisible();
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Hochgeladen");
  await requestItem.getByTestId("file-request-download").click();
  const downloadLink = requestItem.getByTestId("file-request-download-link");
  await expect(downloadLink).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect(readFileSync(downloadPath as string).equals(UPLOAD_BYTES)).toBe(true);

  // 5) Erledigt-Übergang.
  await requestItem.getByTestId("file-request-transition-erledigt").click();
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Erledigt");

  expect(errors, "Browser-Konsole und Page-Errors der Datei-Anfragen-Grenze").toEqual([]);
});
