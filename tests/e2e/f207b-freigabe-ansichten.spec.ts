// F2-07b Freigabe-Ansichten — RED: Panels/Sektionen + F207B-A11Y-01.
// Spec: docs/spec/F2-07b-freigabe-ansichten.md (Anzeigeorte, Panels, §Tests).
// Anzeigeort: Offer-Detailseite, neue Sektionen UNTERHALB bestehender Panels.
// Setup-Muster: tests/e2e/m2-01-offer.spec.ts (M1_05_E2E_STATE, OTP-Login,
// Offer-Erstellung via Browser) + F202B-Muster (eigenes Ready-Projekt per
// seedM201ReadyProject mit skuSuffix in test.beforeAll). EIN Offer wird
// einmalig erzeugt und von allen 6 lesenden Tests geteilt (nur Navigation +
// Sichtbarkeits-Asserts, keine Mutationen). Nur existierende E2EState-Keys
// (run.mts kennt keine f207b-Keys).
// RED: Sektionen #offer-release-chronik / #offer-approval-ledger /
// #offer-candidate-history / #offer-withdraw-history existieren noch nicht.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

const browserErrors = new WeakMap<Page, string[]>();

const CHRONIK_SELECTOR = "#offer-release-chronik";
const LEDGER_SELECTOR = "#offer-approval-ledger";
const CANDIDATE_HISTORY_SELECTOR = "#offer-candidate-history";
const WITHDRAW_HISTORY_SELECTOR = "#offer-withdraw-history";

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
    throw new Error("Der private F207B-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F207B-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(
    state.serverLogPath,
    state.editorEmail,
    logOffset,
  );
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

async function createOfferViaBrowser(page: Page, projectId: string): Promise<void> {
  const state = runtimeState();
  const projectPath = `/w/${state.workspaceId}/anfragen/${projectId}`;
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
}

let f207bOfferPath = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const state = runtimeState();
  const seed = await seedM201ReadyProject(state.databaseUrl, {
    workspaceId: state.workspaceId,
    editorIdentityId: state.editorIdentityId,
    skuSuffix: `w3-f207b-${randomUUID().slice(0, 8)}`,
  });
  const context = await browser.newContext();
  const setupPage = await context.newPage();
  const setupErrors: string[] = [];
  setupPage.on("console", (message) => {
    if (message.type() === "error") setupErrors.push(`console: ${message.text()}`);
  });
  setupPage.on("pageerror", (error) => setupErrors.push(`pageerror: ${error.message}`));
  try {
    await createOfferViaBrowser(setupPage, seed.projectId);
    const createdUrl = new URL(setupPage.url());
    f207bOfferPath = `${createdUrl.pathname}${createdUrl.search}`;
    expect(setupErrors, "F207B-Setup Browser-Konsole und Page-Errors").toEqual([]);
  } finally {
    await context.close();
  }
});

async function gotoSharedOffer(page: Page): Promise<void> {
  if (!f207bOfferPath) throw new Error("F207B-Seed fehlt (beforeAll nicht gelaufen?).");
  // R9-Harness-Fix (FINAL-REPORT-5E §5): Angebotsrouten leiten nicht zu
  // /login um — explizit mit next-Parameter einsteigen.
  await page.goto(`/login?next=${encodeURIComponent(f207bOfferPath)}`);
  await loginWithRealOtp(page, f207bOfferPath);
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
  expect(browserErrors.get(page) ?? [], "F207B Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F207B Freigabe-Ansichten (Offer-Detailseite)", () => {
  test("D4-07 Chronik-Sektion ist sichtbar (unterhalb bestehender Panels)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    await expect(page.locator(CHRONIK_SELECTOR)).toBeVisible();
    await expect(
      page.locator("#offer-release-candidate"),
      "Bestands-Panel bleibt oberhalb bestehen",
    ).toBeVisible();
  });

  test("D4-02 Ledger- + D4-01 Candidate-Historie-Sektionen sind sichtbar", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    await expect(page.locator(LEDGER_SELECTOR)).toBeVisible();
    await expect(page.locator(CANDIDATE_HISTORY_SELECTOR)).toBeVisible();
  });

  test("D4-03 Withdraw-Historie ist sichtbar", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    await expect(page.locator(WITHDRAW_HISTORY_SELECTOR)).toBeVisible();
  });

  test("F207B-A11Y-01: echte Listen (ul/ol), Zeitpunkte in time", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    for (const selector of [
      CHRONIK_SELECTOR,
      LEDGER_SELECTOR,
      CANDIDATE_HISTORY_SELECTOR,
      WITHDRAW_HISTORY_SELECTOR,
    ]) {
      const section = page.locator(selector);
      await expect(section).toBeVisible();
      const list = section.locator("ul, ol").first();
      await expect(list).toBeVisible();
      const times = section.locator("time[datetime]");
      expect(await times.count()).toBeGreaterThan(0);
    }
  });

  test("F207B-A11Y-01: keine interaktiven Schein-Elemente, keine Inputs/Forms (D4-04 readonly)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    for (const selector of [LEDGER_SELECTOR, CANDIDATE_HISTORY_SELECTOR]) {
      const section = page.locator(selector);
      await expect(section.locator("input, form, button")).toHaveCount(0);
      await expect(section.locator("[onclick], [role='button']")).toHaveCount(0);
    }
  });

  test("Leere Zustände zeigen deutsche Hinweistexte (Seed-Offer ohne Freigaben)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await gotoSharedOffer(page);
    await expect(
      page.locator(CHRONIK_SELECTOR).getByText("Noch keine Freigaben protokolliert."),
    ).toBeVisible();
    await expect(
      page.locator(WITHDRAW_HISTORY_SELECTOR).getByText("Noch keine Rücknahmen."),
    ).toBeVisible();
  });
});
