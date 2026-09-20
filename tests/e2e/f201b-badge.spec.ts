import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { seedM201AdditionalReadyProject, type M201RuntimeState } from "./m2-01-fixture";

/**
 * F2-01b Converted-Badge — Chromium-E2E (RED).
 *
 * F201B-UI-01: Akte ohne Offer zeigt kein Badge; nach Browser-Konvertierung
 * steht das Badge „Angebot angelegt" im Akte-Kopf (neben Phasenanzeige) und
 * in der Converted-Section (data-offer-create-state="converted").
 * Spec: docs/spec/F2-01b-angebots-ansichten.md (§Anzeigeorte, §Wortlaut).
 *
 * Muster: tests/e2e/m2-01-offer.spec.ts (Login, Guards, Ready-Konvertierung)
 * + tests/e2e/f7-09-kapazitaeten.spec.ts (eigenes Zusatzprojekt per
 * seedM201AdditionalReadyProject — keine Kopplung ans geteilte M2-01-Projekt,
 * keine neuen State-Keys, nur databaseUrl/serverLogPath + m201*-Keys).
 *
 * RED-Grund: Das Badge existiert nicht (0 Treffer im Code, D2-1b) — weder im
 * Akte-Kopf noch in der Converted-Section steht „Angebot angelegt".
 */

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

const browserErrors = new WeakMap<Page, string[]>();

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
    throw new Error("Der private M2-01-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F201B-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F201B Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F2-01b Converted-Badge", () => {
  test("F201B-UI-01: kein Badge ohne Offer, nach Konvertierung Badge in Kopf + Section", async ({ page }) => {
    test.setTimeout(120_000);
    const state = runtimeState();
    // Eigenes Zusatzprojekt: Die Browser-Konvertierung kippt die Projektphase
    // auf "offer" — das geteilte M2-01-Projekt bliebe sonst für M2-01/02/03a
    // im Zustand "converted" statt "ready" zurück (F7-09-Präzedenz).
    const projectId = await seedM201AdditionalReadyProject(state);
    const projectPath = `/w/${state.workspaceId}/anfragen/${projectId}`;
    await page.goto(projectPath);
    await loginWithRealOtp(page, projectPath);

    // Akte ohne Offer: kein Badge. Exaktwortlaut — die Converted-Überschrift
    // („Angebot ist bereits angelegt") und der Button („Angebot erstellen")
    // dürfen nicht mitzählen.
    await expect(page.locator('[data-offer-create-state="ready"]')).toBeVisible();
    await expect(page.getByText("Angebot angelegt", { exact: true })).toHaveCount(0);

    // Browser-Konvertierung (M2-01-Flow).
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));

    // Zurück zur Akte: Konvertierung ist persistiert (Converted-Guard).
    await page.goto(projectPath);
    const converted = page.locator('[data-offer-create-state="converted"]');
    await expect(converted).toBeVisible();

    // RED: Badge „Angebot angelegt" in der Section …
    await expect(converted.getByText("Angebot angelegt", { exact: true })).toBeVisible();
    // … und im Akte-Kopf — genau zwei Anzeigeorte (Spec §Anzeigeorte).
    await expect(page.getByText("Angebot angelegt", { exact: true })).toHaveCount(2);
  });
});
