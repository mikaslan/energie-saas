import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  readM201Offer,
  readM201RevisionEvidence,
  type M201RuntimeState,
} from "./m2-01-fixture";

const browserErrors = new WeakMap<Page, string[]>();

type SerializedM201State = {
  databaseUrl: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM201State>;
  const required: Array<keyof SerializedM201State> = [
    "databaseUrl",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F203B-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM201State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.m201EditorEmail,
    editorIdentityId: complete.m201EditorIdentityId,
    m201BatteryId: complete.m201BatteryId,
    m201InverterId: complete.m201InverterId,
    m201ModuleId: complete.m201ModuleId,
    m201ProjectId: complete.m201ProjectId,
    m201WallboxId: complete.m201WallboxId,
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.m201WorkspaceId,
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte F203B-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(state.serverLogPath, state.editorEmail, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
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

async function createOfferViaBrowser(page: Page): Promise<{
  offerId: string;
  state: M201RuntimeState;
  variantId: string;
}> {
  const state = runtimeState();
  const projectPath = `/w/${state.workspaceId}/anfragen/${state.m201ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, projectPath);

  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="current"]')).toBeVisible();
  await expect(page.getByText("Produkte sind revisionssicher zugeordnet.", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("Keine offenen Triage-Blocker.", { exact: true })).toBeVisible();

  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await expect(createEntry.getByRole("heading", {
    name: "Angebotsentwurf erstellen",
    exact: true,
  })).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));

  const offer = await readM201Offer(state);
  const createdUrl = new URL(page.url());
  expect(createdUrl.pathname).toBe(
    `/w/${state.workspaceId}/angebote/${offer.offerId}`,
  );
  expect(createdUrl.searchParams.get("variante")).toBe(offer.variantId);
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
  return { ...offer, state };
}

function trackBrowserErrors(page: Page): void {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F203B-Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F2-03b Kalkulations-Rest (D3-01 Sektionstitel-UI)", () => {
  test("zeigt für bestehende Custom-Sektionen einen Sektionsname-Input", async ({ page }) => {
    test.setTimeout(120_000);
    const { offerId, state, variantId } = await createOfferViaBrowser(page);
    const firstEvidence = await readM201RevisionEvidence(state, offerId, variantId);
    const customTitle = "F203B Titel-Edit Sektion";

    await page.getByRole("button", { name: "Freie Sektion hinzufügen" }).click();
    const newTitleInput = page.getByLabel("Sektionsname", { exact: true });
    await newTitleInput.fill(customTitle);
    const newSection = page.locator("section").filter({ has: newTitleInput });
    await newSection.getByLabel("Kategorie").selectOption("other");

    // offer-editor-model.ts Z.604-607: jede Sektion braucht ≥1 Position,
    // sonst Validierung ("Bitte prüfe den lokalen Entwurf.") und kein Save.
    await newSection.getByRole("button", { name: "Freie Position hinzufügen" }).click();
    await newSection.getByLabel("Positionsname", { exact: true }).fill("F203B Freie Position");
    await newSection.getByLabel("VK je Einheit €", { exact: true }).fill("100");
    await newSection.getByLabel("EK je Einheit €", { exact: true }).fill("60");

    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    // Diagnose vor dem Poll: Erfolg vs. Validierungs-/Fehlerfeedback.
    await expect(page.getByText(`Revision ${firstEvidence.revision + 1} wurde gespeichert.`, { exact: true }))
      .toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(state, offerId, variantId)
    ).revision, {
      message: "Der Browser-Save muss die neue Custom-Sektion dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(firstEvidence.revision + 1);
    await expect(page.getByText(`Gespeicherte Revision ${firstEvidence.revision + 1}`, { exact: true }))
      .toBeVisible();

    await page.reload();
    await expect(page.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();
    const persistedSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: customTitle, exact: true }),
    });
    await expect(persistedSection).toHaveCount(1);
    await expect(persistedSection.getByLabel("Sektionsname", { exact: true })).toBeVisible();
  });
});
