import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F7.3 Checklisten-Vorlagen — Chromium-E2E.
 * - Editor legt eine Vorlage (Katalog-Position) an und wendet sie am
 *   Projekt an → Material-Checkliste entsteht (ESTIMATE-Mapping).
 * - Viewer: beide Seiten read-only.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
  mainProjectId: string;
  // W3-Isolation (f7-03-Fix): eigenes Projekt im W3-Workspace statt
  // mainProjectId — F7.2-Saves dürfen diese Spec nie beeinflussen.
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
    throw new Error("Der private F7.3-E2E-State ist unvollständig.");
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

async function seedCatalogComponent(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
       select $1::uuid, $2::uuid, 'F7-3-WR', 'inverter', u.id
         from user_identity u where u.email = $3 limit 1`,
      [randomUUID(), data.w3WorkspaceId, data.editorEmail],
    );
  } finally {
    await pool.end();
  }
}

const settingsPath = (): string => `/w/${state().w3WorkspaceId}/einstellungen/checklisten-vorlagen`;
const checklistPath = (): string => `/w/${state().w3WorkspaceId}/anfragen/${state().f703ProjectId}/checkliste`;

test("F7.3-E2E-01: Editor legt Vorlage an und wendet sie am Projekt an", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const settings = settingsPath();

  await seedCatalogComponent();
  await page.goto(settings);
  await loginWithRealOtp(page, data.editorEmail, settings);
  await expect(page.getByRole("heading", { name: "Checklisten-Vorlagen", level: 1 })).toBeVisible();

  // Vorlage mit einer Katalog-Position anlegen.
  const templateName = `Standard-Montage ${Date.now()}`;
  await page.getByLabel("Name").fill(templateName);
  await page.getByRole("button", { name: "Position hinzufügen" }).click();
  // Kimi-P2-4: explizite Komponentenwahl statt implizitem Ersttreffer.
  await page.getByLabel("Komponente 1").selectOption({ label: "F7-3-WR" });
  await page.getByLabel("Menge 1").fill("2");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Vorlage angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 Positionen/u)).toBeVisible();

  // Am Projekt anwenden → Material-Checkliste entsteht.
  const checklist = checklistPath();
  await page.goto(checklist);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aus Vorlage anlegen" })).toBeVisible();
  await page.getByLabel("Vorlage").selectOption({ label: templateName });
  await page.getByRole("button", { name: "Checkliste erstellen" }).click();

  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();
  // Die Checkliste wurde aus der Vorlage erzeugt (ESTIMATE-Mapping):
  // Block-Name = Vorlagenname, Segment „Material", Item „SKU × 2".
  await expect(page.getByLabel("Block-Name 1")).toHaveValue(templateName);
  await expect(page.getByLabel("Segment-Name 1")).toHaveValue("Material");
  await expect(page.getByLabel("Punkt-Name 1.1")).toHaveValue(/F7-3-WR × 2/u);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F7.3-E2E-02: Viewer read-only auf beiden Seiten", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await page.goto(settingsPath());
  await loginWithRealOtp(page, data.viewerEmail, settingsPath());
  await expect(page.getByRole("heading", { name: "Checklisten-Vorlagen", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(checklistPath());
  await loginWithRealOtp(page, data.viewerEmail, checklistPath());
  await expect(page.getByRole("heading", { name: "Aus Vorlage anlegen" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
