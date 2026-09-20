import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-13 Förder-Fristen-Preis — Chromium-E2E (isolierter Workspace).
 * Akte: anlegen (Preis-Snapshot 210 € + Vor-Annahme-Badge) → BzA
 * einreichen (Fälligkeit sichtbar, kein Überfällig, Transition nach
 * Korrektur offen = keine Sperre) → Typenschild anfordern →
 * Portal-Upload (Muster F13-07) → intern erledigen → BzA bewilligt →
 * Akte zeigt „Beleg erhalten", Badge weg. NICHT lokal ausführen
 * (Owner zentral); nur syntaktisch korrekt + tsc-grün.
 */

// Titel = SUBSIDY_CASE_NAMEPLATE_SLOT (Konstante, kebab; Owner-DECIDED:
// Titel-Konvention F13-07 + strukturierter Slot-Typ daneben).
const NAMEPLATE_TITLE = "typenschild-foto";
const UPLOAD_FILENAME = "typenschild.jpg";
const UPLOAD_BYTES = Buffer.from("E2E-Typenschild\n", "utf8");

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
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
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1313-E2E-State ist unvollständig (${key}).`);
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

test("F1313-E2E-01: Preis, Frist, Typenschild ohne Transitionssperre", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Foerderpreis F1313");
  await form.getByLabel("Telefon").fill("0151 34567892");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = page.url();

  // 1) Anlage: Preis-Snapshot + Vor-Annahme-Badge (rein lesend).
  await expect(page.getByTestId("subsidy-case-current")).toContainText("Noch keine Förderakte");
  await page.getByTestId("subsidy-case-create").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("Entwurf");
  await expect(page.getByTestId("subsidy-case-fee")).toContainText("210,00");
  await expect(page.getByTestId("subsidy-case-pre-approval")).toContainText("BzA noch nicht bewilligt");

  // 2) BzA einreichen: Fälligkeit sichtbar, kein Überfällig.
  await page.getByTestId("subsidy-case-to-vorbereitung").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("In Vorbereitung");
  await page.getByTestId("subsidy-case-to-bza_eingereicht").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA eingereicht");
  await expect(page.getByTestId("subsidy-case-bza-due")).toContainText("BzA fällig");
  await expect(page.getByTestId("subsidy-case-pre-approval")).toBeVisible();
  await expect(page.getByTestId("subsidy-case-overdue")).toHaveCount(0);

  // 3) Keine Transitionssperre vor Bewilligung: Korrektur offen.
  await expect(page.getByTestId("subsidy-case-to-korrektur")).toBeVisible();
  await expect(page.getByTestId("subsidy-case-to-bza_bewilligt")).toBeVisible();

  // 4) Typenschild anfordern (Slot, keine KI-Auswertung).
  await page.getByTestId("subsidy-case-nameplate-request").click();
  await expect(page.getByTestId("subsidy-case-nameplate-feedback")).toContainText(
    "Typenschild-Foto angefordert.",
  );

  // 5) Portal-Upload (Muster F13-07: Link → Dateien-Tab → Hochladen).
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByText(NAMEPLATE_TITLE, { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: UPLOAD_FILENAME,
    mimeType: "image/jpeg",
    buffer: UPLOAD_BYTES,
  });
  await page.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg");

  // 6) Intern erledigen → BzA bewilligt → „Beleg erhalten", Badge weg.
  await page.goto(detailUrl);
  const files = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  const requestItem = files.locator("li", { hasText: NAMEPLATE_TITLE });
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Hochgeladen");
  await requestItem.getByTestId("file-request-transition-erledigt").click();
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Erledigt");
  await page.getByTestId("subsidy-case-to-bza_bewilligt").click();
  await expect(page.getByTestId("subsidy-case-transition-feedback")).toContainText("Status geändert.");
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA bewilligt");
  await expect(page.getByTestId("subsidy-case-pre-approval")).toHaveCount(0);
  await expect(page.getByTestId("subsidy-beleg-block")).toContainText("Beleg erhalten");
  await expect(page.getByTestId("subsidy-case-nameplate-status")).toContainText("Beleg erhalten");

  expect(errors, "Browser-Konsole und Page-Errors der F1313-Grenze").toEqual([]);
});
