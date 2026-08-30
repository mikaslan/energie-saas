import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_ADDRESS,
  M2_01_E2E_CONTACT,
  advanceM201Resolution,
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
  throw new Error("Der echte M2-01-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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
  if (!variantId) throw new Error("M2-01-E2E-URL enthält keine aktive Variante.");
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
  expect(browserErrors.get(page) ?? [], "M2-01 Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M2-01 Angebotsvarianten und Snapshot-BOM", () => {
  test("führt Request → Offer → Duplikat/Edit/Reload → Outdated/neue Basis vollständig aus", async ({ page }) => {
    test.setTimeout(120_000);
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

    const initial = await readM201Offer(state);
    const createdUrl = new URL(page.url());
    expect(createdUrl.pathname).toBe(
      `/w/${state.workspaceId}/angebote/${initial.offerId}`,
    );
    expect(createdUrl.searchParams.get("variante")).toBe(initial.variantId);
    const basisEvidence = await readM201RevisionEvidence(
      state,
      initial.offerId,
      initial.variantId,
    );
    expect(basisEvidence.revision).toBe(1);
    expect(basisEvidence.resolutionRevision).toBe(1);

    const detailPath = `/w/${state.workspaceId}/angebote/${initial.offerId}`;
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 }))
      .toBeVisible();
    await expect(page.getByText(M2_01_E2E_ADDRESS, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Variantenname").first()).toHaveValue("Basis");

    const duplicateSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
    });
    await duplicateSection.getByLabel("Name der Kopie").fill("Browser-Kopie");
    await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
    await page.waitForURL((url) =>
      url.pathname === detailPath
      && url.searchParams.get("variante") !== initial.variantId);
    const duplicateVariantId = selectedVariantId(page);
    await expect(page.locator("#variant-name")).toHaveValue("Browser-Kopie");

    await page.locator("#variant-description").fill("Synthetischer gespeicherter Browserstand");
    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    const dirtyDialog = page.getByRole("dialog", {
      name: "Möchtest du den lokalen Entwurf verlassen?",
    });
    await expect(dirtyDialog).toBeVisible();
    await expect(dirtyDialog.getByRole("button", { name: "Bleiben" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dirtyDialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${duplicateVariantId}$`, "u"));

    await page.getByLabel("Menge", { exact: true }).first().fill("27");
    await page.getByLabel("VK je Einheit €", { exact: true }).first().fill("260");
    await page.getByLabel("Grund für VK-Änderung", { exact: true }).first()
      .selectOption("negotiated");
    await page.getByLabel("Zeilenrabatt %", { exact: true }).first().fill("1,25");
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect.poll(async () => (
      await readM201RevisionEvidence(state, initial.offerId, duplicateVariantId)
    ).revision, {
      message: "Der Browser-Save muss Revision 2 dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(2);

    await page.reload();
    await expect(page.locator("#variant-name")).toHaveValue("Browser-Kopie");
    await expect(page.locator("#variant-description"))
      .toHaveValue("Synthetischer gespeicherter Browserstand");
    await expect(page.getByLabel("Menge", { exact: true }).first()).toHaveValue("27");
    await expect(page.getByLabel("VK je Einheit €", { exact: true }).first()).toHaveValue("260");
    await expect(page.getByLabel("Zeilenrabatt %", { exact: true }).first()).toHaveValue("1,25");
    await expect(page.getByText("Revision 2", { exact: true }).first()).toBeVisible();

    await page.setViewportSize({ width: 375, height: 900 });
    const mobileVariantSelect = page.getByLabel("Angebotsvariante", { exact: true });
    await expect(mobileVariantSelect).toBeVisible();
    await expect(mobileVariantSelect.locator("option")).toHaveCount(2);
    await mobileVariantSelect.selectOption(initial.variantId);
    await page.getByRole("button", { name: "Variante öffnen" }).click();
    await page.waitForURL((url) =>
      url.pathname === detailPath
      && url.searchParams.get("variante") === initial.variantId);
    await expect(page.locator("#variant-name")).toHaveValue("Basis");

    await advanceM201Resolution(state);
    await page.reload();
    await expect(page.getByRole("alert").filter({
      hasText: "Die Projektgrundlage ist nicht mehr aktuell.",
    })).toBeVisible();
    await expect(page.getByText(
      "Der gespeicherte Snapshot bleibt unverändert. Eine neue Basis ist eine eigene Variante.",
      { exact: true },
    )).toBeVisible();

    const basisSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neue Basis", exact: true }),
    });
    await basisSection.getByLabel("Variantenname").fill("Aktuelle Browser-Basis");
    await basisSection.getByLabel("Steuerentwurf").selectOption("standard_19");
    await basisSection.getByRole("button", { name: "Neue Basis anlegen" }).click();
    await page.waitForURL((url) =>
      url.pathname === detailPath
      && ![initial.variantId, duplicateVariantId].includes(
        url.searchParams.get("variante") ?? "",
      ));
    const currentBasisVariantId = selectedVariantId(page);
    await expect(page.locator("#variant-name")).toHaveValue("Aktuelle Browser-Basis");
    await expect(page.getByLabel("Angebotsvariante", { exact: true }).locator("option"))
      .toHaveCount(3);
    await expect(page.getByText("Die Projektgrundlage ist nicht mehr aktuell.", { exact: true }))
      .toHaveCount(0);

    const unchangedBasis = await readM201RevisionEvidence(
      state,
      initial.offerId,
      initial.variantId,
    );
    expect(unchangedBasis).toEqual(basisEvidence);
    const currentBasis = await readM201RevisionEvidence(
      state,
      initial.offerId,
      currentBasisVariantId,
    );
    expect(currentBasis.revision).toBe(1);
    expect(currentBasis.resolutionRevision).toBe(2);
    expect(currentBasis.snapshotSha256).not.toBe(basisEvidence.snapshotSha256);
  });
});
