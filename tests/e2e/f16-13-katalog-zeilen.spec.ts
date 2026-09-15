import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-13 Katalog-Zeilen in Paket-Vorlagen — Chromium-E2E.
 * Editor bindet eine Paket-Position an eine Katalogkomponente (Preise
 * kommen beim Speichern aus dem Katalog), setzt das Paket am Angebot
 * ein, ändert danach den Katalogpreis (Revision + Aktivierung) und
 * erlebt Fail-closed: Einsetzen scheitert mit Stale-Hinweis, bis die
 * Vorlage neu gebunden ist.
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1613State = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1613State = M201RuntimeState & { w3WorkspaceId: string };

function runtimeState(): F1613State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1613State>;
  const required: Array<keyof SerializedF1613State> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-13-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1613State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.editorEmail,
    editorIdentityId: complete.editorIdentityId,
    m201BatteryId: "",
    m201InverterId: "",
    m201ModuleId: "",
    m201ProjectId: "",
    m201WallboxId: "",
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.w3WorkspaceId,
    w3WorkspaceId: complete.w3WorkspaceId,
  };
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
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte F16-13-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedTarget: string): Promise<void> {
  const data = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(await otpFromPrivateDevMailLog(data.serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedTarget);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F16-13 Browser-Konsole und Page-Errors").toEqual([]);
});

const MODULE_SKU = "E2E-M201-MODULE-1-W3-F1613";
const MODULE_NAME = "Synthetische M2-01 module-Komponente";

test.describe("F16-13 Katalog-Zeilen", () => {
  // Projekt A für den Happy Path; Projekt B wird nach der Katalogdrift
  // im Test gesät (frische Resolution — sonst kippt die Angebotsseite
  // in „outdated" statt der Stale-Aussage).
  let projectAId = "";
  let moduleId = "";
  test.beforeAll(async () => {
    const data = runtimeState();
    const seed = await seedM201ReadyProject(data.databaseUrl, {
      workspaceId: data.w3WorkspaceId,
      editorIdentityId: data.editorIdentityId,
      skuSuffix: "w3-f1613",
    });
    projectAId = seed.projectId;
    moduleId = seed.products.module;
  });

  test("F16-13-E2E-01: binden, einsetzen, Drift scheitert, Rebind heilt", async ({ page }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const packageName = `F1613 Paket ${stamp}`;
    const lineName = `F1613 Modul ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();

    // Paket mit kataloggebundener Zeile anlegen.
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neues Paket", exact: true }),
    });
    await creator.getByLabel("Paketname").fill(packageName);
    await creator.getByLabel("Sektionstitel").fill(`F1613 Sektion ${stamp}`);
    await creator.getByLabel("Kategorie").selectOption("module");
    await creator.getByLabel("Positionsname 1").fill(lineName);
    await creator.getByLabel("Menge 1").fill("4");
    await creator.getByLabel("Katalogbindung 1 (optional)").selectOption({
      label: `${MODULE_SKU} — ${MODULE_NAME} (Rev. 1)`,
    });
    await expect(creator.getByText(`Gebunden: ${MODULE_SKU} (Rev. 1)`, { exact: false })).toBeVisible();
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    const article = page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName });
    await expect(article).toHaveCount(1);

    // Angebot an Projekt A + Paket einsetzen (Revision 2).
    const projectAPath = `/w/${data.w3WorkspaceId}/anfragen/${projectAId}`;
    await page.goto(projectAPath);
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntry).toBeVisible();
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const packagePanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Paket einsetzen", exact: true }),
    });
    await packagePanel.getByLabel("Paket wählen").selectOption({ label: `${packageName} (1 Position)` });
    await packagePanel.getByRole("button", { name: "Paket einsetzen", exact: true }).click();
    await expect(packagePanel.getByText("Paket eingesetzt (1 Position übernommen).", { exact: true })).toBeVisible();

    // Katalogdrift: VK 250 → 260 + Aktivierung (Rev. 2).
    const catalogPath = `/w/${data.w3WorkspaceId}/katalog/${moduleId}`;
    await page.goto(catalogPath);
    await page.getByLabel("Verkaufspreis").fill("260");
    await page.getByRole("button", { name: "Neue Preisrevision speichern", exact: true }).click();
    await expect(page.getByText("Preisrevision 2 wurde als Entwurf gespeichert.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
    await expect(page.getByRole("button", { name: "Aktivieren", exact: true })).toHaveCount(0);

    // Neues Projekt B (frische Resolution) + Einsetzen scheitert stale.
    const data2 = runtimeState();
    const seedB = await seedM201ReadyProject(data2.databaseUrl, {
      workspaceId: data2.w3WorkspaceId,
      editorIdentityId: data2.editorIdentityId,
      skuSuffix: "w3-f1613b",
    });
    const projectBPath = `/w/${data.w3WorkspaceId}/anfragen/${seedB.projectId}`;
    await page.goto(projectBPath);
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const createEntryB = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntryB).toBeVisible();
    await createEntryB.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntryB.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntryB.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntryB.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const packagePanelB = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Paket einsetzen", exact: true }),
    });
    await packagePanelB.getByLabel("Paket wählen").selectOption({ label: `${packageName} (1 Position)` });
    await packagePanelB.getByRole("button", { name: "Paket einsetzen", exact: true }).click();
    await expect(packagePanelB.getByText("Katalogbindung veraltet", { exact: false })).toBeVisible();

    // Rebind in den Einstellungen heilt die Vorlage (Rev. 2).
    await page.goto(settingsPath);
    const editArticle = page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName });
    await editArticle.getByText("Bearbeiten", { exact: true }).click();
    await editArticle.getByLabel("Katalogbindung 1 (optional)").selectOption({
      label: `${MODULE_SKU} — ${MODULE_NAME} (Rev. 2)`,
    });
    await expect(editArticle.getByText(`Gebunden: ${MODULE_SKU} (Rev. 2)`, { exact: false })).toBeVisible();
    await editArticle.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(editArticle.getByText("Paket aktualisiert.", { exact: true })).toBeVisible();
    expect(errors, "Browser-Konsole bei Katalog-Zeilen").toEqual([]);
  });
});
