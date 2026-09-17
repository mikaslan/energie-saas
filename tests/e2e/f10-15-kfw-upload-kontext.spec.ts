import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F10-15 KfW-Upload-Kontext — Chromium-E2E (isolierter Workspace, UI-Pfad
 * wie F13-07: Akte → Beleg-Phase → verknuepfte + allgemeine Anfrage).
 * Dateien-Tab kennzeichnet verknuepfte Anfragen; Foerdersektion listet
 * nur verknuepfte mit Upload-Formular (Negativfaelle: ohne Akte und ohne
 * Verknuepfte kein Block); Upload dort kehrt mit Feedback zur Uebersicht
 * zurueck; Fehltyp dort meldet `ungueltig`; allgemeiner Upload landet
 * weiter auf `tab=dateien`. Viewports 375/768/1440 + Axe als anonymer Kunde.
 */

const LINKED_TITLE = "F1015-KfW-Nachweis (verknuepft)";
const LINKED_REJECT_TITLE = "F1015-KfW-Ablehnprobe (verknuepft)";
const GENERAL_TITLE = "F1015-Allgemein (unverknuepft)";
const UPLOAD_FILENAME = "kfw-f1015.pdf";
const GENERAL_FILENAME = "allgemein-f1015.pdf";
const UPLOAD_BYTES = Buffer.from("%PDF-1.4\nF1015-E2E-PDF\n%%EOF\n", "utf8");
const UPLOAD_OK_TEXT = "Vielen Dank — die Datei ist eingegangen.";
const UPLOAD_INVALID_TEXT = "Die Datei ist ungültig (PDF, JPG oder PNG, höchstens 10 MB).";

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
      throw new Error(`Der private F10-15-E2E-State ist unvollständig (${key}).`);
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine WCAG-A/AA-Verletzung`).toEqual([]);
}

test("F10-15-E2E-01: Foerdersektion zeigt verknuepfte Anfragen mit Upload", async ({ page }) => {
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
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E KfW-Kontext");
  await leadForm.getByLabel("Telefon").fill("0151 45678915");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = page.url();

  // 1) Allgemeine Anfrage + Portal-Link (noch ohne Akte).
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await section.getByTestId("file-request-title").fill(GENERAL_TITLE);
  await section.getByTestId("file-request-create").click();
  await expect(section.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 2) Ohne Akte: keine Foerdersektion, kein Dateien-Block.
  await page.goto(tokenPath);
  await expect(page.getByTestId("portal-subsidy-section")).toHaveCount(0);
  await expect(page.getByTestId("portal-subsidy-files")).toHaveCount(0);

  // 3) Akte bis BzA bewilligt (noch ohne verknuepfte Anfrage): Sektion da,
  // Dateien-Block abwesend.
  await page.goto(detailUrl);
  await page.getByTestId("subsidy-case-create").click();
  await page.getByTestId("subsidy-case-to-bza_eingereicht").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA eingereicht");
  await page.getByTestId("subsidy-case-to-bza_bewilligt").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BzA bewilligt");
  await page.goto(tokenPath);
  await expect(page.getByTestId("portal-subsidy-section")).toBeVisible();
  await expect(page.getByTestId("portal-subsidy-files")).toHaveCount(0);

  // 4) Zwei verknuepfte Belege anfordern (Erfolg- + Ablehn-Kandidat).
  await page.goto(detailUrl);
  const beleg = page.getByTestId("subsidy-beleg-block");
  await expect(beleg).toBeVisible();
  for (const title of [LINKED_TITLE, LINKED_REJECT_TITLE]) {
    await beleg.getByTestId("subsidy-beleg-title").fill(title);
    await beleg.getByTestId("subsidy-beleg-create").click();
    await expect(beleg.getByTestId("subsidy-beleg-feedback")).toHaveText("Beleg angefordert.");
  }

  // 5) Dateien-Tab: nur Verknuepfte tragen das Foerder-Kennzeichen.
  await page.goto(`${tokenPath}?tab=dateien`);
  const filesSection = page.getByTestId("file-requests-section");
  await expect(filesSection).toBeVisible();
  const linkedItem = filesSection.locator(":scope > ul > li", { hasText: LINKED_TITLE });
  const generalItem = filesSection.locator(":scope > ul > li", { hasText: GENERAL_TITLE });
  await expect(linkedItem.getByTestId("file-request-subsidy-badge")).toHaveText("Förderung");
  await expect(generalItem.getByTestId("file-request-subsidy-badge")).toHaveCount(0);

  // 6) Foerdersektion: nur Verknuepfte, mit Upload-Formular; Axe je Viewport.
  await page.goto(tokenPath);
  const subsidyFiles = page.getByTestId("portal-subsidy-files");
  await expect(subsidyFiles).toBeVisible();
  await expect(subsidyFiles.getByText(LINKED_TITLE, { exact: true })).toBeVisible();
  await expect(subsidyFiles.getByText(GENERAL_TITLE, { exact: true })).toHaveCount(0);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(subsidyFiles).toBeVisible();
    await expectNoAxeViolations(page, `F10-15 Foerdersektion ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 7) Upload in der Foerdersektion kehrt mit Wortlaut-Feedback zurueck.
  const linkedUpload = subsidyFiles.locator(":scope > ul > li", { hasText: LINKED_TITLE });
  await linkedUpload.locator('input[type="file"]').setInputFiles({
    name: UPLOAD_FILENAME,
    mimeType: "application/pdf",
    buffer: UPLOAD_BYTES,
  });
  await linkedUpload.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath
    && url.searchParams.get("upload") === "erfolg"
    && (url.searchParams.get("tab") ?? "uebersicht") === "uebersicht"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toHaveText(UPLOAD_OK_TEXT);

  // 8) Leere Datei an zweiter verknuepfter Anfrage → `ungueltig` im Block.
  const rejectUpload = subsidyFiles.locator(":scope > ul > li", { hasText: LINKED_REJECT_TITLE });
  await rejectUpload.locator('input[type="file"]').setInputFiles({
    name: "leer-f1015.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(0),
  });
  await rejectUpload.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "ungueltig"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toHaveText(UPLOAD_INVALID_TEXT);

  // 9) Beleg im Dateien-Tab sichtbar; allgemeiner Upload landet auf dateien.
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByText(`Hochgeladen (${UPLOAD_FILENAME})`)).toBeVisible();
  await generalItem.locator('input[type="file"]').setInputFiles({
    name: GENERAL_FILENAME,
    mimeType: "application/pdf",
    buffer: UPLOAD_BYTES,
  });
  await generalItem.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath
    && url.searchParams.get("tab") === "dateien"
    && url.searchParams.get("upload") === "erfolg"
  );

  expect(errors, "Browser-Konsole und Page-Errors des KfW-Kontexts").toEqual([]);
});
