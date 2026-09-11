import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-07 BnD-Beleg-Upload — Chromium-E2E (isolierter Workspace).
 * Akte: anlegen → BzA einreichen → bewilligt → Beleg anfordern →
 * Dateianfragen-Sektion zeigt ihn → Portal-Upload → intern erledigen →
 * Akte zeigt „Beleg erhalten".
 */

const BELEG_TITLE = "BnD-Beleg: Schlussrechnung";
const UPLOAD_FILENAME = "schlussrechnung.pdf";
const UPLOAD_BYTES = Buffer.from("%PDF-1.4 E2E-Beleg\n", "utf8");

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F13-07-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

test("F13-07-E2E-01: BnD-Beleg von Anforderung bis Erhalt in der Akte", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E BnD-Beleg");
  await form.getByLabel("Telefon").fill("0151 45678904");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = page.url();

  // 1) Akte bis BzA bewilligt (Beleg-Phase).
  await page.getByTestId("subsidy-case-create").click();
  await page.getByTestId("subsidy-case-to-bza_eingereicht").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA eingereicht");
  await page.getByTestId("subsidy-case-to-bza_bewilligt").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA bewilligt");

  // 2) Beleg anfordern — Block erscheint erst in der Beleg-Phase.
  const beleg = page.getByTestId("subsidy-beleg-block");
  await expect(beleg).toBeVisible();
  await beleg.getByTestId("subsidy-beleg-title").fill(BELEG_TITLE);
  await beleg.getByTestId("subsidy-beleg-create").click();
  await expect(beleg.getByTestId("subsidy-beleg-feedback")).toHaveText("Beleg angefordert.");
  await expect(beleg).toContainText(BELEG_TITLE);
  await expect(beleg).toContainText("Offen");

  // 3) Dateianfragen-Sektion zeigt dieselbe Anfrage.
  const files = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(files.getByText(BELEG_TITLE, { exact: true })).toBeVisible();

  // 4) Portal-Link per UI, Upload im Dateien-Tab.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByText(BELEG_TITLE, { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: UPLOAD_FILENAME,
    mimeType: "application/pdf",
    buffer: UPLOAD_BYTES,
  });
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg");

  // 5) Intern erledigen → Akte zeigt „Beleg erhalten".
  await page.goto(detailUrl);
  const requestItem = files.locator("li", { hasText: BELEG_TITLE });
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Hochgeladen");
  await requestItem.getByTestId("file-request-transition-erledigt").click();
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Erledigt");
  await expect(page.getByTestId("subsidy-beleg-block")).toContainText("Beleg erhalten");

  expect(errors, "Browser-Konsole und Page-Errors der Beleg-Grenze").toEqual([]);
});
