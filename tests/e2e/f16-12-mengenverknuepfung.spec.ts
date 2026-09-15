import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-12 Mengenverknüpfung („Linked amounts", Katalog F16.2) — Chromium-E2E.
 * Editor legt eine freie Sektion mit zwei freien Positionen an, verknüpft
 * die Kabelsatz-Menge mit den Quellmodulen (× 2,5) und ändert danach die
 * Quellmenge — die abgeleitete Menge folgt serverberechnet (Kaskade).
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1612State = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  viewerEmail: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1612State = M201RuntimeState & { w3WorkspaceId: string; viewerEmail: string };

function runtimeState(): F1612State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1612State>;
  const required: Array<keyof SerializedF1612State> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "viewerEmail",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-12-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1612State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.editorEmail,
    viewerEmail: complete.viewerEmail,
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
  throw new Error("Der echte F16-12-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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
  expect(browserErrors.get(page) ?? [], "F16-12 Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F16-12 Mengenverknüpfung", () => {
  // Eigenes angebotsfähiges Projekt: ein Angebot je Projekt versteckt das
  // Create-Widget (Präzedenz F16-11 E2E-03).
  let isolatedProjectId = "";
  test.beforeAll(async () => {
    const data = runtimeState();
    const isolated = await seedM201ReadyProject(data.databaseUrl, {
      workspaceId: data.w3WorkspaceId,
      editorIdentityId: data.editorIdentityId,
      skuSuffix: `w3-f1612-${randomUUID().slice(0, 8)}`,
    });
    isolatedProjectId = isolated.projectId;
  });

  test("F16-12-E2E-01: freie Menge verknüpfen, Kaskade folgt Quelländerung", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const sectionTitle = `F1612 Sektion ${stamp}`;
    const sourceName = `F1612 Quelle ${stamp}`;
    const dependentName = `F1612 Kabelsatz ${stamp}`;

    const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${isolatedProjectId}`;
    await page.goto(projectPath);
    await loginWithRealOtp(page, data.editorEmail, projectPath);
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

    // Freie Sektion + zwei freie Positionen anlegen (Button je Sektion —
    // auf die neue freie Sektion mit dem Sektionsname-Feld scopen).
    await page.getByRole("button", { name: "Freie Sektion hinzufügen", exact: true }).click();
    await page.getByLabel("Sektionsname").fill(sectionTitle);
    const freeSection = page.locator("section", { has: page.getByLabel("Sektionsname") });
    await freeSection.getByRole("button", { name: "Freie Position hinzufügen", exact: true }).click();
    // Neue Zeilen hängen am Sektionsende — last() ist deterministisch.
    const freshSourceItem = freeSection.locator("li").last();
    await freshSourceItem.getByLabel("Positionsname").fill(sourceName);
    await freshSourceItem.getByLabel("Menge", { exact: true }).fill("10");
    await freshSourceItem.getByLabel("VK je Einheit €").fill("250,00");
    await freshSourceItem.getByLabel("EK je Einheit €").fill("150,00");
    await freeSection.getByRole("button", { name: "Freie Position hinzufügen", exact: true }).click();
    const dependentItem = freeSection.locator("li").last();
    await dependentItem.getByLabel("Positionsname").fill(dependentName);
    await dependentItem.getByLabel("Menge", { exact: true }).fill("1");
    await dependentItem.getByLabel("VK je Einheit €").fill("2,50");
    await dependentItem.getByLabel("EK je Einheit €").fill("1,00");
    await page.getByRole("button", { name: "Angebotsentwurf speichern", exact: true }).click();
    await expect(page.getByText("Revision 2 wurde gespeichert.", { exact: true })).toBeVisible();

    // Kabelsatz mit den Quellmodulen verknüpfen (× 2,5 → 25 Stück).
    // Nach dem Speichern neu lokalisieren (Draft wird aus Revision 2 neu aufgebaut).
    const savedDependentItem = page.locator("li").filter({ has: page.getByText(dependentName, { exact: true }) });
    const sourceOptionLabel = `${sectionTitle} – ${sourceName} (Menge 10)`;
    await savedDependentItem.getByLabel("Menge verknüpft mit").selectOption({ label: sourceOptionLabel });
    await savedDependentItem.getByLabel("Faktor ×").fill("2,5");
    await expect(savedDependentItem.getByText("Abgeleitet: 25", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Angebotsentwurf speichern", exact: true }).click();
    await expect(page.getByText("Revision 3 wurde gespeichert.", { exact: true })).toBeVisible();
    // Editor-Belege: Kopfzeile, deaktivierte abgeleitete Menge, Serverwert 25.
    await expect(savedDependentItem.getByText(`Menge verknüpft mit ${sourceName}`, { exact: true })).toBeVisible();
    const linkedQuantity = savedDependentItem.getByLabel("Menge (verknüpft, abgeleitet)");
    await expect(linkedQuantity).toBeDisabled();
    await expect(linkedQuantity).toHaveValue("25");

    // Quellmenge ändern → Kaskade (12 × 2,5 = 30).
    const sourceItem = page.locator("li").filter({ has: page.getByText(sourceName, { exact: true }) });
    await sourceItem.getByLabel("Menge", { exact: true }).fill("12");
    await expect(savedDependentItem.getByText("Abgeleitet: 30", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Angebotsentwurf speichern", exact: true }).click();
    await expect(page.getByText("Revision 4 wurde gespeichert.", { exact: true })).toBeVisible();
    await expect(savedDependentItem.getByText(`Menge verknüpft mit ${sourceName}`, { exact: true })).toBeVisible();
    await expect(savedDependentItem.getByLabel("Menge (verknüpft, abgeleitet)")).toHaveValue("30");

    // Viewer-Leg: Read-only-Karte zeigt die Verknüpfung (public View-Projektion).
    const offerTarget = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    try {
      viewerPage.on("console", (message) => {
        if (message.type() === "error") errors.push(`viewer console: ${message.text()}`);
      });
      viewerPage.on("pageerror", (error) => errors.push(`viewer pageerror: ${error.message}`));
      // Die Angebotsseite leitet nicht selbst auf /login um — direkt mit next-Ziel anmelden.
      await viewerPage.goto(`/login?next=${encodeURIComponent(offerTarget)}`);
      await loginWithRealOtp(viewerPage, data.viewerEmail, offerTarget);
      await expect(viewerPage.locator('[data-offer-detail-state="read_only"]')).toBeVisible();
      await expect(viewerPage.getByText(`Verknüpft mit ${sourceName} × 2,5`, { exact: false })).toBeVisible();
      await expect(viewerPage.getByText("30 Stk.", { exact: true }).first()).toBeVisible();
    } finally {
      await viewerContext.close();
    }
    expect(errors, "Browser-Konsole bei Mengenverknüpfung").toEqual([]);
  });
});
