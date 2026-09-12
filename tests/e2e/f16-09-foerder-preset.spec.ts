import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  readM201RevisionEvidence,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-09 Förder-Preset-Kopplung — Chromium-E2E.
 * - Editor legt eine Förder-Vorlage + Angebots-Vorlage mit Förder-Preset
 *   in den Einstellungen an, archiviert/reaktiviert sie; Viewer read-only.
 * - Editor erstellt ein Angebot am F1606-Projekt und wendet die Vorlage an →
 *   Förderung 300 bps in Revision 2 (ein Revisions-Call).
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1609State = {
  databaseUrl: string;
  editorEmail: string;
  viewerEmail: string;
  f1606ProjectId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1609State = M201RuntimeState & { f1606ProjectId: string; w3WorkspaceId: string; viewerEmail: string };

function runtimeState(): F1609State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1609State>;
  const required: Array<keyof SerializedF1609State> = [
    "databaseUrl",
    "editorEmail",
    "viewerEmail",
    "f1606ProjectId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-09-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1609State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.editorEmail,
    editorIdentityId: "",
    m201BatteryId: "",
    m201InverterId: "",
    m201ModuleId: "",
    m201ProjectId: complete.f1606ProjectId,
    f1606ProjectId: complete.f1606ProjectId,
    w3WorkspaceId: complete.w3WorkspaceId,
    m201WallboxId: "",
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.w3WorkspaceId,
    viewerEmail: complete.viewerEmail,
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
  throw new Error("Der echte F16-09-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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
  expect(browserErrors.get(page) ?? [], "F16-09 Browser-Konsole und Page-Errors").toEqual([]);
});

async function createSubsidyPreset(page: Page, workspaceId: string, name: string): Promise<void> {
  const templateUrl = `/w/${workspaceId}/einstellungen/foerder-vorlagen`;
  await page.goto(templateUrl);
  await expect(page.getByRole("heading", { name: "Förder-Vorlagen", exact: true })).toBeVisible();
  const creator = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
  });
  await creator.getByLabel("Name").fill(name);
  await creator.getByLabel("Art").selectOption("percent_bps");
  await creator.getByLabel("Prozentsatz").fill("3");
  await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}


// Suite-robust: Das Seed-Projekt trägt höchstens EIN Angebot. Läuft ein
// früherer Spec (F16-06-E2E-03) zuerst, ist das Projekt konvertiert — dann
// das bestehende Angebot über die Übersicht öffnen statt neu anzulegen.
// Revisionen immer relativ zur vorgefundenen Basis behaupten.
async function openOfferForApply(
  page: Page,
  projectPath: string,
  w3State: M201RuntimeState & { workspaceId: string; m201ProjectId: string },
): Promise<{ offerId: string; variantId: string; baseRevision: number }> {
  await page.goto(projectPath);
  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
  const readyEntry = page.locator('[data-offer-create-state="ready"]');
  if (await readyEntry.isVisible()) {
    await readyEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await readyEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await readyEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await readyEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
  } else {
    await expect(page.locator('[data-offer-create-state="converted"]')).toBeVisible();
    await page.getByRole("link", { name: "Angebotsübersicht öffnen", exact: true }).click();
    await page.waitForURL((url) => /^\/w\/[0-9a-f-]+\/angebote\/?$/u.test(url.pathname));
    await page.getByRole("link", { name: "Öffnen", exact: true }).first().click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
  }
  const current = new URL(page.url());
  const offerId = current.pathname.split("/").pop()!;
  const variantId = current.searchParams.get("variante")!;
  const evidence = await readM201RevisionEvidence(w3State, offerId, variantId);
  return { offerId, variantId, baseRevision: evidence.revision };
}

test.describe("F16-09 Förder-Preset-Kopplung", () => {
  test("F1609-E2E-01: Editor verwaltet Vorlage mit Förder-Preset (Archiv, Restore); Viewer read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const subsidyName = `F1609 E2E Drei ${stamp}`;
    const templateName = `F1609 E2E Standard ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();

    await createSubsidyPreset(page, data.w3WorkspaceId, subsidyName);

    await page.goto(settingsPath);
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
    });
    await creator.getByLabel("Name").fill(templateName);
    await creator.getByLabel("Förder-Preset").selectOption({ label: `${subsidyName} (3 %)` });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    const article = page.locator("section[aria-label=\"Vorlagen\"] article").filter({ hasText: templateName });
    await expect(article).toHaveCount(1);
    await expect(article.getByText(`Förderung: ${subsidyName} (3 %)`, { exact: false })).toBeVisible();
    expect(errors, "Browser-Konsole beim Anlegen").toEqual([]);

    await article.getByRole("button", { name: `${templateName} archivieren`, exact: true }).click();
    await expect(article.getByText("archiviert", { exact: true })).toBeVisible();
    await article.getByRole("button", { name: `${templateName} reaktivieren`, exact: true }).click();
    await expect(article.getByText("aktiv", { exact: true })).toBeVisible();
    expect(errors, "Browser-Konsole bei Archiv/Restore").toEqual([]);
  });

  test("F1609-E2E-02: Viewer sieht Vorlagen ausschließlich lesend", async ({ page }) => {
    test.setTimeout(150_000);
    const data = runtimeState();
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.viewerEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();
    await expect(page.locator("section[aria-label=\"Neue Vorlage\"]")).toHaveCount(0);
  });

  test("F1609-E2E-03: Vorlage am Angebot anwenden setzt Förderung in einer Revision", async ({ page }) => {
    test.setTimeout(240_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const subsidyName = `F1609 E2E Drei ${stamp}`;
    const templateName = `F1609 E2E Standard ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();

    await createSubsidyPreset(page, data.w3WorkspaceId, subsidyName);

    await page.goto(settingsPath);
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
    });
    await creator.getByLabel("Name").fill(templateName);
    await creator.getByLabel("Förder-Preset").selectOption({ label: `${subsidyName} (3 %)` });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(page.locator("section[aria-label=\"Vorlagen\"] article").filter({ hasText: templateName })).toHaveCount(1);

    const w3State = { ...data, workspaceId: data.w3WorkspaceId, m201ProjectId: data.f1606ProjectId };
    const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f1606ProjectId}`;
    const { offerId, variantId, baseRevision } = await openOfferForApply(page, projectPath, w3State);

    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const applyPanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: /Vorlage anwenden/, exact: false }),
    });
    await applyPanel.getByLabel("Vorlage wählen").selectOption({ label: `${templateName} (Förderung)` });
    await applyPanel.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
    await expect(applyPanel.getByText("Vorlage angewendet: Förderung gesetzt.", { exact: true })).toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(w3State, offerId, variantId)
    ).revision, {
      message: "Das Vorlagen-Apply muss genau eine Revision dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(baseRevision + 1);
    const evidence = await readM201RevisionEvidence(w3State, offerId, variantId);
    const snapshot = JSON.parse(evidence.snapshotText) as { globalDiscountBps?: unknown };
    expect(snapshot.globalDiscountBps).toBe(300);
    expect(errors, "Browser-Konsole beim Anwenden").toEqual([]);
  });
});
