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
    throw new Error("Der private F16.3D-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F16.3C-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

function selectedVariantId(page: Page): string {
  const variantId = new URL(page.url()).searchParams.get("variante");
  if (!variantId) throw new Error("F16.3D-E2E-URL enthält keine aktive Variante.");
  return variantId;
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
  expect(browserErrors.get(page) ?? [], "F16.3D Browser-Konsole und Page-Errors").toEqual([]);
});


test.describe("F16.3 Slice D Fix-Modell global", () => {
  test("F16.3-E2E-04: Fix-Vorlage übernehmen, speichern, Total minus 12,50 €", async ({ page }) => {
    test.setTimeout(180_000);
    const state = runtimeState();

    // 1) Rabatt-Vorlage per Einstellungs-UI anlegen (m201-Editor hat discounts-Cap).
    const templateUrl = `/w/${state.workspaceId}/einstellungen/rabatt-vorlagen`;
    await page.goto(templateUrl);
    await loginWithRealOtp(page, templateUrl);
    await expect(page.getByRole("heading", { name: "Rabatt-Vorlagen", exact: true })).toBeVisible();
    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
    });
    await creator.getByLabel("Name").fill("W3-E2E-Fix");
    await creator.getByLabel("Art").selectOption("fix_cents");
    await creator.getByLabel("Betrag in Euro").fill("12,50");
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(page.getByText("W3-E2E-Fix", { exact: true })).toBeVisible();

    // 2) Angebot per Projekt-UI anlegen (M2-01-Muster).
    const projectPath = `/w/${state.workspaceId}/anfragen/${state.m201ProjectId}`;
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
    const initial = await readM201Offer(state);
    const variantId = selectedVariantId(page);
    expect(variantId).toBe(initial.variantId);

    // 3) Vorlage übernehmen -> Draft zeigt 12,50 -> speichern -> Total -1250.
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const before = JSON.parse(
      (await readM201RevisionEvidence(state, initial.offerId, variantId)).snapshotText,
    ) as { totals: { basisNetCents: number } };
    await page.getByLabel("Aus Vorlage übernehmen").selectOption({ label: "W3-E2E-Fix (12,50 € · Rabatt)" });
    await expect(page.getByLabel("Globaler Fix-Rabatt €")).toHaveValue("12,50");
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect.poll(async () => (
      await readM201RevisionEvidence(state, initial.offerId, variantId)
    ).revision, {
      message: "Der Vorlagen-Save muss Revision 2 dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(2);
    const evidence = await readM201RevisionEvidence(state, initial.offerId, variantId);
    const snapshot = JSON.parse(evidence.snapshotText) as {
      globalFixDiscountCents?: unknown;
      totals: { basisNetCents: number };
    };
    expect(snapshot.globalFixDiscountCents).toBe(1250);
    expect(snapshot.totals.basisNetCents).toBe(before.totals.basisNetCents - 1250);
  });
});
