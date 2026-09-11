import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  readM201Offer,
  readM201RevisionEvidence,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-06 Angebots-Vorlagen — Chromium-E2E.
 * - Editor legt Zahlart + Rabatt + Angebots-Vorlage in den Einstellungen an,
 *   archiviert/reaktiviert sie; Viewer bleibt read-only.
 * - Editor erstellt ein Angebot am F1606-Projekt und wendet die Vorlage an →
 *   Zahlart gesetzt + Global-Rabatt 500 bps in Revision 2.
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1606State = {
  databaseUrl: string;
  editorEmail: string;
  viewerEmail: string;
  f1606ProjectId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1606State = M201RuntimeState & { f1606ProjectId: string; w3WorkspaceId: string; viewerEmail: string };

function runtimeState(): F1606State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1606State>;
  const required: Array<keyof SerializedF1606State> = [
    "databaseUrl",
    "editorEmail",
    "viewerEmail",
    "f1606ProjectId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-06-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1606State;
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
  throw new Error("Der echte F16-06-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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
  expect(browserErrors.get(page) ?? [], "F16-06 Browser-Konsole und Page-Errors").toEqual([]);
});

async function createPaymentPreset(page: Page, workspaceId: string, label: string): Promise<void> {
  const settingsPath = `/w/${workspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  await expect(page.getByRole("heading", { name: "Zahlarten", exact: true })).toBeVisible();
  const creator = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neue Zahlart", exact: true }),
  });
  await creator.getByLabel("Schlüssel").selectOption("purchase");
  await creator.getByLabel("Bezeichnung").fill(label);
  await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
}

async function archivePaymentPreset(page: Page, workspaceId: string, label: string): Promise<void> {
  // Schlüssel freigeben: f2-05 nutzt dieselben drei W3-Schlüssel später
  // (aktive Schlüssel sind je Workspace eindeutig).
  const settingsPath = `/w/${workspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  const entry = page.locator("li").filter({ hasText: label });
  await entry.getByRole("button", { name: "Archivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archivierte Zahlarten", exact: true })).toBeVisible();
}

async function createDiscountPreset(page: Page, workspaceId: string, name: string): Promise<void> {
  const templateUrl = `/w/${workspaceId}/einstellungen/rabatt-vorlagen`;
  await page.goto(templateUrl);
  await expect(page.getByRole("heading", { name: "Rabatt-Vorlagen", exact: true })).toBeVisible();
  const creator = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
  });
  await creator.getByLabel("Name").fill(name);
  await creator.getByLabel("Art").selectOption("percent_bps");
  await creator.getByLabel("Prozentsatz").fill("5");
  await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test.describe("F16-06 Angebots-Vorlagen", () => {
  test("F16-06-E2E-01: Editor verwaltet Vorlage (Presets, Archiv, Restore); Viewer read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const paymentLabel = `F1606 E2E Kauf ${stamp}`;
    const discountName = `F1606 E2E Fünf ${stamp}`;
    const templateName = `F1606 E2E Standard ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();

    await createPaymentPreset(page, data.w3WorkspaceId, paymentLabel);
    await createDiscountPreset(page, data.w3WorkspaceId, discountName);

    await page.goto(settingsPath);
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
    });
    await creator.getByLabel("Name").fill(templateName);
    await creator.getByLabel("Zahlart-Preset").selectOption({ label: paymentLabel });
    await creator.getByLabel("Rabatt-Preset").selectOption({ label: `${discountName} (5 %)` });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    const article = page.locator("section[aria-label=\"Vorlagen\"] article").filter({ hasText: templateName });
    await expect(article).toHaveCount(1);
    await expect(article.getByText(`Zahlart: ${paymentLabel}`, { exact: false })).toBeVisible();
    expect(errors, "Browser-Konsole beim Anlegen").toEqual([]);

    await article.getByRole("button", { name: `${templateName} archivieren`, exact: true }).click();
    await expect(article.getByText("archiviert", { exact: true })).toBeVisible();
    await article.getByRole("button", { name: `${templateName} reaktivieren`, exact: true }).click();
    await expect(article.getByText("aktiv", { exact: true })).toBeVisible();
    expect(errors, "Browser-Konsole bei Archiv/Restore").toEqual([]);

    await archivePaymentPreset(page, data.w3WorkspaceId, paymentLabel);
    expect(errors, "Browser-Konsole beim Schlüssel-Freigeben").toEqual([]);
  });

  test("F16-06-E2E-02: Viewer sieht Vorlagen ausschließlich lesend", async ({ page }) => {
    test.setTimeout(150_000);
    const data = runtimeState();
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.viewerEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();
    await expect(page.locator("section[aria-label=\"Neue Vorlage\"]")).toHaveCount(0);
  });

  test("F16-06-E2E-03: Vorlage am Angebot anwenden setzt Zahlart + Global-Rabatt", async ({ page }) => {
    test.setTimeout(240_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const paymentLabel = `F1606 E2E Kauf ${stamp}`;
    const discountName = `F1606 E2E Fünf ${stamp}`;
    const templateName = `F1606 E2E Standard ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/angebots-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Angebots-Vorlagen", level: 1 })).toBeVisible();

    await createPaymentPreset(page, data.w3WorkspaceId, paymentLabel);
    await createDiscountPreset(page, data.w3WorkspaceId, discountName);

    await page.goto(settingsPath);
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
    });
    await creator.getByLabel("Name").fill(templateName);
    await creator.getByLabel("Zahlart-Preset").selectOption({ label: paymentLabel });
    await creator.getByLabel("Rabatt-Preset").selectOption({ label: `${discountName} (5 %)` });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(page.locator("section[aria-label=\"Vorlagen\"] article").filter({ hasText: templateName })).toHaveCount(1);

    const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f1606ProjectId}`;
    await page.goto(projectPath);
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
    const w3State = { ...data, workspaceId: data.w3WorkspaceId, m201ProjectId: data.f1606ProjectId };
    const initial = await readM201Offer(w3State);
    const variantId = new URL(page.url()).searchParams.get("variante");
    expect(variantId).toBe(initial.variantId);

    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const applyPanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: /Vorlage anwenden/, exact: false }),
    });
    await applyPanel.getByLabel("Vorlage wählen").selectOption({ label: `${templateName} (Zahlart + Rabatt)` });
    await applyPanel.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
    await expect(applyPanel.getByText("Vorlage angewendet: Zahlart gesetzt + Global-Rabatt gesetzt.", { exact: true })).toBeVisible();
    const paymentPanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: /Zahlart ·/, exact: false }),
    });
    await expect(paymentPanel.getByText(paymentLabel, { exact: true })).toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(w3State, initial.offerId, variantId!)
    ).revision, {
      message: "Das Vorlagen-Apply muss Revision 2 dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(2);
    const evidence = await readM201RevisionEvidence(w3State, initial.offerId, variantId!);
    const snapshot = JSON.parse(evidence.snapshotText) as { globalDiscountBps?: unknown };
    expect(snapshot.globalDiscountBps).toBe(500);
    expect(errors, "Browser-Konsole beim Anwenden").toEqual([]);

    await archivePaymentPreset(page, data.w3WorkspaceId, paymentLabel);
    expect(errors, "Browser-Konsole beim Schlüssel-Freigeben").toEqual([]);
  });
});
