import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7-03B Punkt-Arten in Vorlagen (Katalog F7.3) — Chromium-E2E
 * (W3-Isolation wie F7.3-E2E-01). Editor legt eine Vorlage mit
 * Einfachauswahl- und Textantwort-Position an und wendet sie am Projekt
 * an → die Arten landen 1:1 auf den Projekt-Punkten (Radio-Input +
 * Antwort-Textarea), Speichern + Reload belegt die Persistenz.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
  mainProjectId: string;
  w3WorkspaceId: string;
  f703ProjectId: string;
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
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId", "editorEmail", "viewerEmail", "mainProjectId",
    "w3WorkspaceId", "f703ProjectId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7-03B-E2E-State ist unvollständig.");
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
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  await page.getByLabel("Sechsstelliger Code").fill(
    await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset),
  );
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function seedCatalogComponents(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    for (const sku of ["F7-3B-WR1", "F7-3B-WR2"]) {
      await pool.query(
        `insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
         select $1::uuid, $2::uuid, $3, 'inverter', u.id
           from user_identity u where u.email = $4 limit 1`,
        [randomUUID(), data.w3WorkspaceId, sku, data.editorEmail],
      );
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  await expect(page).toHaveTitle(/.+/u);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

const settingsPath = (): string => `/w/${state().w3WorkspaceId}/einstellungen/checklisten-vorlagen`;
const checklistPath = (): string => `/w/${state().w3WorkspaceId}/anfragen/${state().f703ProjectId}/checkliste`;

test("F7-03B-E2E-01: Vorlagen-Arten landen per Apply auf den Projekt-Punkten und persistieren", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const settings = settingsPath();

  await seedCatalogComponents();
  await page.goto(settings);
  await loginWithRealOtp(page, data.editorEmail, settings);
  await expect(page.getByRole("heading", { name: "Checklisten-Vorlagen", level: 1 })).toBeVisible();

  // Vorlage mit Einfachauswahl- und Textantwort-Position anlegen.
  const templateName = `Arten-Vorlage ${Date.now()}`;
  await page.getByLabel("Name").fill(templateName);
  await page.getByRole("button", { name: "Position hinzufügen" }).click();
  await page.getByLabel("Komponente 1").selectOption({ label: "F7-3B-WR1" });
  await page.getByLabel("Art 1").selectOption("radio");
  await page.getByRole("button", { name: "Position hinzufügen" }).click();
  await page.getByLabel("Komponente 2").selectOption({ label: "F7-3B-WR2" });
  await page.getByLabel("Art 2").selectOption("text");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Vorlage angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 Positionen/u)).toBeVisible();

  // Am Projekt anwenden → Arten entstehen 1:1 (Radio + Textarea).
  const checklist = checklistPath();
  await page.goto(checklist);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await page.getByLabel("Vorlage").selectOption({ label: templateName });
  await page.getByRole("button", { name: "Checkliste erstellen" }).click();
  await expect(page.getByText("Vorlage angewendet (Version 1).", { exact: true })).toBeVisible();

  const radioTitle = "F7-3B-WR1 × 1";
  const textTitle = "F7-3B-WR2 × 1";
  const radio = page.getByRole("radio", { name: radioTitle });
  const answer = page.getByLabel(`${textTitle}: Antworttext`);
  await expect(radio).toBeVisible();
  await expect(answer).toBeVisible();

  // Auswahl + Antwort → Speichern → Reload persistent.
  await radio.check();
  await answer.fill("Dachhaken gesetzt");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByRole("radio", { name: radioTitle })).toBeChecked();
  await expect(page.getByLabel(`${textTitle}: Antworttext`)).toHaveValue("Dachhaken gesetzt");

  await expectNoWcagAaAxeViolations(page, "F7-03B-Arten");

  expect(errors, "Browser-Konsole und Page-Errors der Vorlagen-Arten").toEqual([]);
});
