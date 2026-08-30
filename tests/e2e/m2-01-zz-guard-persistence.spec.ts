import { readFileSync, statSync } from "node:fs";
import { expect, test, type Locator, type Page } from "playwright/test";
import {
  clearM201ActorMutationWindow,
  createM201RedactedEditor,
  exhaustM201ActorMutationWindow,
  expireM201IdentitySessions,
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

type PersistedSnapshot = {
  customDealNetCents: number | null;
  globalDiscountBps: number;
  sections: Array<{
    category: string;
    discountBps: number;
    sectionDomainId: string;
    title: string;
    lines: Array<{
      componentCategory: string;
      isHidden: boolean;
      lineDiscountBps: number;
      lineDomainId: string;
      positionType: string;
      product: {
        description: string | null;
        displayName: string;
        kind: string;
        unit: string;
      };
      purchasePricing: {
        effectiveUnitNetCents: number;
        provenance: { kind: string; reasonCode?: string };
      };
      quantityMilli: number;
      salesPricing: { effectiveUnitNetCents: number };
      source: { kind: string };
      taxTreatment: string;
    }>;
  }>;
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
    throw new Error("Der private M2-01-Guard-E2E-State ist unvollständig.");
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
  throw new Error("Der echte M2-01-Guard-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(
  page: Page,
  expectedTarget: string,
  email = runtimeState().editorEmail,
): Promise<void> {
  const state = runtimeState();
  const currentUrl = new URL(page.url());
  if (`${currentUrl.pathname}${currentUrl.search}` === expectedTarget) {
    const offerState = await page.locator("[data-offer-detail-state]")
      .getAttribute("data-offer-detail-state");
    if (offerState !== "unauthenticated") return;
    await page.goto(`/login?next=${encodeURIComponent(expectedTarget)}`);
  }
  await page.waitForURL((url) => url.pathname === "/login");
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(state.serverLogPath, email, logOffset);
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

async function openEditor(page: Page): Promise<{
  offerId: string;
  offerPath: string;
  state: M201RuntimeState;
  variantId: string;
}> {
  const state = runtimeState();
  const offer = await readM201Offer(state);
  const offerPath = `/w/${state.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;
  await page.goto(offerPath);
  await loginWithRealOtp(page, offerPath);
  await expect(page.locator(
    '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
  )).toBeVisible();
  return { ...offer, offerPath, state };
}

function dirtyDialog(page: Page): Locator {
  return page.getByRole("dialog", {
    name: "Möchtest du den lokalen Entwurf verlassen?",
  });
}

function domainId(id: string | null, expression: RegExp, label: string): string {
  const match = id ? expression.exec(id) : null;
  if (!match) throw new Error(`${label} enthält keine stabile Domain-ID.`);
  return match[1];
}

async function cancelNativeDirtyReload(page: Page): Promise<void> {
  let observedType = "";
  const dialogPromise = new Promise<void>((resolveDialog, rejectDialog) => {
    page.once("dialog", async (dialog) => {
      try {
        observedType = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      } catch (error) {
        rejectDialog(error);
      }
    });
  });
  const reloadAttempt = page.evaluate(() => window.location.reload()).catch((error: unknown) => {
    if (!(error instanceof Error) || !/context was destroyed|Navigation interrupted/iu.test(error.message)) {
      throw error;
    }
    return undefined;
  });
  await Promise.all([dialogPromise, reloadAttempt]);
  expect(observedType).toBe("beforeunload");
}

async function acceptNativeReloadFrom(page: Page, trigger: Locator): Promise<void> {
  let observedType = "";
  const dialogPromise = new Promise<void>((resolveDialog, rejectDialog) => {
    page.once("dialog", async (dialog) => {
      try {
        observedType = dialog.type();
        await dialog.accept();
        resolveDialog();
      } catch (error) {
        rejectDialog(error);
      }
    });
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    dialogPromise,
    trigger.click(),
  ]);
  expect(observedType).toBe("beforeunload");
}

async function dismissNativeReloadFrom(page: Page, trigger: Locator): Promise<void> {
  let observedType = "";
  const dialogPromise = new Promise<void>((resolveDialog, rejectDialog) => {
    page.once("dialog", async (dialog) => {
      try {
        observedType = dialog.type();
        await dialog.dismiss();
        resolveDialog();
      } catch (error) {
        rejectDialog(error);
      }
    });
  });
  await Promise.all([
    dialogPromise,
    trigger.evaluate((element) => (element as HTMLButtonElement).click()),
  ]);
  expect(observedType).toBe("beforeunload");
}

async function expectRevision(
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
  revision: number,
): Promise<void> {
  await expect.poll(async () => (
    await readM201RevisionEvidence(state, offerId, variantId)
  ).revision, {
    message: `Serverrevision ${revision} wurde nicht sichtbar.`,
  }).toBe(revision);
}

async function expectSavedEditorSettled(page: Page, revision: number): Promise<void> {
  await expect(page.getByText(`Gespeicherte Revision ${revision}`, { exact: true }))
    .toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const historyState = window.history.state as { offerDirtyGuard?: unknown } | null;
    return historyState?.offerDirtyGuard === true;
  }), {
    message: "Der Dirty-History-Sentinel wurde nach dem bestätigten Save nicht abgebaut.",
  }).toBe(false);
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function saveConcurrentDescription(
  page: Page,
  offerPath: string,
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
  currentRevision: number,
  description: string,
): Promise<number> {
  const parallelPage = await page.context().newPage();
  const errors = trackBrowserErrors(parallelPage);
  try {
    await parallelPage.goto(offerPath);
    await expect(parallelPage.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();
    await parallelPage.locator("#variant-description").fill(description);
    await parallelPage.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectRevision(state, offerId, variantId, currentRevision + 1);
    expect(errors, "paralleler M2-01-Conflict-Tab ohne Browserfehler").toEqual([]);
    return currentRevision + 1;
  } finally {
    await parallelPage.close();
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "M2-01 Guard-Browser-Konsole und Page-Errors")
    .toEqual([]);
});

test.describe("M2-01 Dirty-Guard, Konflikt und F2.3-Persistenz", () => {
  test("blockiert History/Back, Reload und Logout ohne stillen Draftverlust", async ({ page }) => {
    test.setTimeout(90_000);
    const { offerPath } = await openEditor(page);
    const description = page.locator("#variant-description");
    const localValue = "SYNTHETIC DIRTY GUARD DRAFT";
    await description.fill(localValue);
    await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true })).toBeVisible();

    await page.evaluate(() => window.history.back());
    await expect(dirtyDialog(page)).toBeVisible();
    await expect(dirtyDialog(page)).toContainText("vorherige Seite");
    await dirtyDialog(page).getByRole("button", { name: "Bleiben" }).click();
    await expect(page).toHaveURL(offerPath);
    await expect(description).toHaveValue(localValue);

    await cancelNativeDirtyReload(page);
    await expect(page).toHaveURL(offerPath);
    await expect(description).toHaveValue(localValue);

    const logout = page.getByRole("button", { name: "Abmelden", exact: true });
    await logout.click();
    await expect(dirtyDialog(page)).toBeVisible();
    await dirtyDialog(page).getByRole("button", { name: "Bleiben" }).click();
    await expect(logout).toBeFocused();
    await expect(description).toHaveValue(localValue);

    await logout.click();
    await dirtyDialog(page).getByRole("button", { name: "Verwerfen" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
  });

  test("bricht Save-and-continue bei Validation und Unavailable fail-closed ab", async ({ page }) => {
    test.setTimeout(100_000);
    const { offerPath, state } = await openEditor(page);
    const variantName = page.locator("#variant-name");
    const savedName = await variantName.inputValue();
    await variantName.fill("");
    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();

    await expect(page).toHaveURL(offerPath);
    await expect(page.locator('[data-offer-detail-state="validation"]')).toBeVisible();
    await expect(variantName).toBeFocused();
    await expect(variantName).toHaveValue("");
    await expect(page.locator('#offer-editor-error-summary a[href="#variant-name"]'))
      .toBeVisible();

    await variantName.fill(savedName);
    await expect(page.getByRole("button", { name: "Änderungen verwerfen" })).toBeDisabled();
    const unavailableDraft = "SYNTHETIC UNAVAILABLE DRAFT";
    const description = page.locator("#variant-description");
    await description.fill(unavailableDraft);
    await exhaustM201ActorMutationWindow(state);
    try {
      await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
      await dirtyDialog(page).getByRole("button", {
        name: "Speichern und fortfahren",
      }).click();

      await expect(page).toHaveURL(offerPath);
      const unavailableState = page.locator('[data-offer-detail-state="unavailable"]');
      await expect(unavailableState).toBeVisible();
      await expect(unavailableState.getByRole("alert").filter({
        hasText: "Speichern ist vorübergehend nicht verfügbar.",
      })).toBeFocused();
      await expect(unavailableState).toContainText(
        "Der lokale Draft bleibt erhalten. Keine Aktion wird automatisch wiederholt.",
      );
      const retryTime = unavailableState.locator("time[datetime]");
      await expect(retryTime).toBeVisible();
      expect(Date.parse(await retryTime.getAttribute("datetime") ?? "")).toBeGreaterThan(Date.now());
      await expect(description).toHaveValue(unavailableDraft);
      await expect(page.getByRole("button", { name: "Angebotsentwurf speichern" }))
        .toBeDisabled();
    } finally {
      await clearM201ActorMutationWindow(state);
    }
  });

  test("rebasiert einen echten Revision-Conflict und speichert erst danach", async ({ page }) => {
    test.setTimeout(110_000);
    const { offerId, offerPath, state, variantId } = await openEditor(page);
    const before = await readM201RevisionEvidence(state, offerId, variantId);
    const localDescription = `SYNTHETIC LOCAL REBASE ${before.revision}`;
    await page.locator("#variant-description").fill(localDescription);
    const serverRevision = await saveConcurrentDescription(
      page,
      offerPath,
      state,
      offerId,
      variantId,
      before.revision,
      `SYNTHETIC SERVER REVISION ${before.revision + 1}`,
    );
    expect(serverRevision).toBe(before.revision + 1);

    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();
    const conflictState = page.locator('[data-offer-detail-state="conflict"]');
    await expect(conflictState).toBeVisible();
    await expect(conflictState.getByRole("alert").filter({
      hasText: "Der Serverstand wurde zwischenzeitlich geändert.",
    })).toBeFocused();
    await expect(page).toHaveURL(offerPath);
    await expect(page.locator("#variant-description")).toHaveValue(localDescription);

    await acceptNativeReloadFrom(
      page,
      page.getByRole("button", { name: "Serverstand bewusst neu laden" }),
    );
    await expect(page.getByText(
      "Lokaler Draft wurde auf den aktuellen Serverstand rebasiert.",
      { exact: true },
    )).toBeVisible();
    await expect(page.locator("#variant-description")).toHaveValue(localDescription);

    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectRevision(state, offerId, variantId, serverRevision + 1);
    await expectSavedEditorSettled(page, serverRevision + 1);
    await page.reload();
    await expect(page.locator("#variant-description")).toHaveValue(localDescription);
  });

  test("hält unauthenticated Save lokal und schützt den bewussten Login-Redirect", async ({ page }) => {
    test.setTimeout(100_000);
    const { offerPath, state } = await openEditor(page);
    const localDescription = "SYNTHETIC EXPIRED SESSION DRAFT";
    const description = page.locator("#variant-description");
    await description.fill(localDescription);
    await expireM201IdentitySessions(state);

    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();
    const unauthenticated = page.locator('[data-offer-detail-state="unauthenticated"]');
    await expect(unauthenticated).toBeVisible();
    await expect(unauthenticated.getByRole("alert").filter({
      hasText: "Deine Sitzung ist abgelaufen.",
    })).toBeFocused();
    await expect(page).toHaveURL(offerPath);
    await expect(description).toHaveValue(localDescription);

    const loginButton = page.getByRole("button", { name: "Zur Anmeldung", exact: true });
    await loginButton.click();
    await expect(dirtyDialog(page)).toBeVisible();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();
    await expect(unauthenticated).toBeVisible();
    await expect(page).toHaveURL(offerPath);
    await expect(description).toHaveValue(localDescription);

    await loginButton.click();
    await dirtyDialog(page).getByRole("button", { name: "Verwerfen" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
  });

  test("persistiert Konditionen, freie Struktur, Metadaten und Cross-Section-Moves", async ({ page }) => {
    test.setTimeout(150_000);
    const { offerId, state, variantId } = await openEditor(page);
    const firstEvidence = await readM201RevisionEvidence(state, offerId, variantId);
    await page.getByLabel("Globaler Rabatt %").fill("3,5");
    await page.getByLabel("Custom Deal netto €").fill("10000");

    const sourceSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "PV-Module", exact: true }),
    });
    await expect(sourceSection).toHaveCount(1);
    const sourceDiscount = sourceSection.getByLabel("Sektionsrabatt %");
    const sourceSectionId = domainId(
      await sourceDiscount.getAttribute("id"),
      /^section-([0-9a-f-]+)-discount$/u,
      "Sektionsrabatt",
    );
    await sourceDiscount.fill("2,25");

    await page.getByRole("button", { name: "Freie Sektion hinzufügen" }).click();
    const customSectionTitle = page.getByLabel("Sektionsname", { exact: true });
    const customSectionId = domainId(
      await customSectionTitle.getAttribute("id"),
      /^section-([0-9a-f-]+)-title$/u,
      "Sektionsname",
    );
    const customSection = page.locator("section").filter({ has: customSectionTitle });
    await customSectionTitle.fill("Synthetische Montageleistungen");
    await customSection.getByLabel("Kategorie").selectOption("mounting");

    const lastCatalogMove = sourceSection.getByLabel("In Sektion verschieben").first();
    await expect(lastCatalogMove).toBeDisabled();
    await expect(sourceSection).toContainText(
      "Mindestens eine Position muss in dieser Sektion verbleiben.",
    );
    await sourceSection.getByRole("button", { name: "Freie Position hinzufügen" }).click();
    await expect(lastCatalogMove).toBeEnabled();

    const customName = page.getByLabel("Positionsname", { exact: true });
    const customLineId = domainId(
      await customName.getAttribute("id"),
      /^line-([0-9a-f-]+)-name$/u,
      "Positionsname",
    );
    const customLine = page.locator(`#line-${customLineId}-editor`);
    await customLine.getByLabel("Positionsname").fill("Synthetische Montagepauschale");
    await customLine.getByLabel("Positionsbeschreibung")
      .fill("Browserpersistente freie Leistung");
    await customLine.getByLabel("Einheit", { exact: true }).selectOption("set");
    await customLine.getByLabel("Menge", { exact: true }).fill("2");
    await customLine.getByLabel("VK je Einheit €", { exact: true }).fill("875,50");
    await customLine.getByLabel("EK je Einheit €", { exact: true }).fill("420,25");
    await customLine.getByLabel("Zeilenrabatt %", { exact: true }).fill("4,75");
    await customLine.getByLabel("Positionsart").selectOption("additional");
    await customLine.getByLabel("Steuer je Position").selectOption("zero_operator_confirmed");
    await customLine.getByLabel(
      "0-%-Steuerentwurf für diese Position frisch bestätigen",
    ).check();
    await customLine.getByLabel("Im Kundenangebot ausblenden").check();

    await customLine.getByLabel("In Sektion verschieben").selectOption(customSectionId);
    await expect(page.locator(`#line-${customLineId}-editor`)).toBeFocused();
    await expect(page.locator(`#line-${customLineId}-target-section`)).toBeDisabled();
    await expect(page.getByRole("status").filter({
      hasText: "Synthetische Montagepauschale wurde in Synthetische Montageleistungen verschoben.",
    })).toBeAttached();
    await customSection.getByLabel("Sektionsrabatt %").fill("1,5");

    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectRevision(state, offerId, variantId, firstEvidence.revision + 1);
    await expectSavedEditorSettled(page, firstEvidence.revision + 1);
    await page.reload();
    await expect(page.locator(`#line-${customLineId}-editor`)).toBeVisible();

    const persistedTarget = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Synthetische Montageleistungen",
        exact: true,
      }),
    });
    await expect(persistedTarget.locator(`#line-${customLineId}-editor`)).toBeVisible();
    await persistedTarget.getByRole("button", { name: "Freie Position hinzufügen" }).click();
    const nameInputIds = await persistedTarget.getByLabel("Positionsname", { exact: true })
      .evaluateAll((inputs) => inputs.map((input) => input.id));
    const additionalNameId = nameInputIds.find((id) => id !== `line-${customLineId}-name`);
    const additionalLineId = domainId(
      additionalNameId ?? null,
      /^line-([0-9a-f-]+)-name$/u,
      "zweite freie Position",
    );
    const additionalLine = page.locator(`#line-${additionalLineId}-editor`);
    await additionalLine.getByLabel("Positionsname").fill("Synthetische Restposition");
    await additionalLine.getByLabel("Positionsbeschreibung").fill("Bleibt in der freien Sektion");
    await additionalLine.getByLabel("VK je Einheit €", { exact: true }).fill("25");
    await additionalLine.getByLabel("EK je Einheit €", { exact: true }).fill("15");

    const persistedCustomLine = page.locator(`#line-${customLineId}-editor`);
    const persistedMove = persistedCustomLine.getByLabel("In Sektion verschieben");
    await expect(persistedMove).toBeEnabled();
    await persistedMove.selectOption(sourceSectionId);
    await expect(page.locator(`#line-${customLineId}-target-section`)).toBeFocused();
    await expect(page.locator(`#line-${customLineId}-target-section`)).toHaveValue(sourceSectionId);

    await persistedCustomLine.getByLabel("Positionsname").fill("Synthetische Montage final");
    await persistedCustomLine.getByLabel("Positionsbeschreibung")
      .fill("Finale persistierte Browsermetadaten");
    await persistedCustomLine.getByLabel("Einheit", { exact: true }).selectOption("meter");
    await persistedCustomLine.getByLabel("Menge", { exact: true }).fill("2,5");
    await persistedCustomLine.getByLabel("EK je Einheit €", { exact: true }).fill("430,75");
    const purchaseReason = persistedCustomLine.getByLabel("Grund für EK-Änderung");
    await expect(purchaseReason).toBeEnabled();
    await purchaseReason.selectOption("negotiated");

    const secondRevision = (await readM201RevisionEvidence(state, offerId, variantId)).revision;
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectRevision(state, offerId, variantId, secondRevision + 1);
    await expectSavedEditorSettled(page, secondRevision + 1);
    await page.reload();

    await expect(page.getByLabel("Globaler Rabatt %")).toHaveValue("3,5");
    await expect(page.getByLabel("Custom Deal netto €")).toHaveValue("10000");
    const reloadedSource = page.locator("section").filter({
      has: page.getByRole("heading", { name: "PV-Module", exact: true }),
    });
    await expect(reloadedSource.getByLabel("Sektionsrabatt %")).toHaveValue("2,25");
    const reloadedTarget = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Synthetische Montageleistungen",
        exact: true,
      }),
    });
    await expect(reloadedTarget.getByLabel("Sektionsrabatt %")).toHaveValue("1,5");
    await expect(reloadedTarget.getByLabel("Positionsname", { exact: true }))
      .toHaveValue("Synthetische Restposition");
    const reloadedLine = page.locator(`#line-${customLineId}-editor`);
    await expect(reloadedSource.locator(`#line-${customLineId}-editor`)).toBeVisible();
    await expect(reloadedLine.getByLabel("Positionsname"))
      .toHaveValue("Synthetische Montage final");
    await expect(reloadedLine.getByLabel("Positionsbeschreibung"))
      .toHaveValue("Finale persistierte Browsermetadaten");
    await expect(reloadedLine.getByLabel("Einheit", { exact: true })).toHaveValue("meter");
    await expect(reloadedLine.getByLabel("Menge", { exact: true })).toHaveValue("2,5");
    await expect(reloadedLine.getByLabel("VK je Einheit €", { exact: true }))
      .toHaveValue("875,5");
    await expect(reloadedLine.getByLabel("EK je Einheit €", { exact: true }))
      .toHaveValue("430,75");
    await expect(reloadedLine.getByLabel("Zeilenrabatt %", { exact: true }))
      .toHaveValue("4,75");
    await expect(reloadedLine.getByLabel("Positionsart")).toHaveValue("additional");
    await expect(reloadedLine.getByLabel("Steuer je Position"))
      .toHaveValue("zero_operator_confirmed");
    await expect(reloadedLine.getByLabel("Im Kundenangebot ausblenden")).toBeChecked();
    await expect(reloadedLine.getByLabel("In Sektion verschieben")).toHaveValue(sourceSectionId);

    const finalEvidence = await readM201RevisionEvidence(state, offerId, variantId);
    const snapshot = JSON.parse(finalEvidence.snapshotText) as PersistedSnapshot;
    expect(snapshot.globalDiscountBps).toBe(350);
    expect(snapshot.customDealNetCents).toBe(1_000_000);
    const snapshotSource = snapshot.sections.find((section) =>
      section.sectionDomainId === sourceSectionId);
    const snapshotTarget = snapshot.sections.find((section) =>
      section.sectionDomainId === customSectionId);
    expect(snapshotSource?.discountBps).toBe(225);
    expect(snapshotTarget).toMatchObject({
      category: "mounting",
      discountBps: 150,
      title: "Synthetische Montageleistungen",
    });
    expect(snapshotTarget?.lines.some((line) =>
      line.product.displayName === "Synthetische Restposition")).toBe(true);
    const persisted = snapshotSource?.lines.find((line) => line.lineDomainId === customLineId);
    expect(persisted).toMatchObject({
      componentCategory: "module",
      isHidden: true,
      lineDiscountBps: 475,
      positionType: "additional",
      product: {
        description: "Finale persistierte Browsermetadaten",
        displayName: "Synthetische Montage final",
        kind: "custom",
        unit: "meter",
      },
      purchasePricing: {
        effectiveUnitNetCents: 43_075,
        provenance: { kind: "manual_override", reasonCode: "negotiated" },
      },
      quantityMilli: 2_500,
      salesPricing: { effectiveUnitNetCents: 87_550 },
      source: { kind: "custom" },
      taxTreatment: "zero_operator_confirmed",
    });
  });

  test("bindet den Recovery-Draft an den Actor und redigiert EK beim Sessionwechsel", async ({ page }) => {
    test.setTimeout(150_000);
    const redactedEditor = await createM201RedactedEditor(runtimeState());
    const { offerId, offerPath, state, variantId } = await openEditor(page);
    const evidence = await readM201RevisionEvidence(state, offerId, variantId);
    const snapshot = JSON.parse(evidence.snapshotText) as PersistedSnapshot;
    const customLine = snapshot.sections.flatMap((section) => section.lines)
      .find((line) => line.product.displayName === "Synthetische Montage final");
    if (!customLine) throw new Error("Persistierte synthetische EK-Testposition fehlt.");

    const lineEditor = page.locator(`#line-${customLine.lineDomainId}-editor`);
    await lineEditor.getByLabel("EK je Einheit €", { exact: true }).fill("777,77");
    await lineEditor.getByLabel("Grund für EK-Änderung").selectOption("negotiated");
    await saveConcurrentDescription(
      page,
      offerPath,
      state,
      offerId,
      variantId,
      evidence.revision,
      `SYNTHETIC SECURITY SERVER REVISION ${evidence.revision + 1}`,
    );
    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();
    await expect(page.locator('[data-offer-detail-state="conflict"]')).toBeVisible();

    const reloadServer = page.getByRole("button", { name: "Serverstand bewusst neu laden" });
    const recoveryKey = `wmee:offer-draft:${offerId}:${variantId}`;
    await dismissNativeReloadFrom(page, reloadServer);
    expect(await page.evaluate((key) => {
      const raw = window.sessionStorage.getItem(key);
      return {
        containsSensitivePurchaseDraft: raw?.includes("777,77") ?? false,
        recoveryEnvelopeExists: raw !== null,
      };
    }, recoveryKey)).toEqual({
      containsSensitivePurchaseDraft: false,
      recoveryEnvelopeExists: true,
    });

    await acceptNativeReloadFrom(
      page,
      reloadServer,
    );
    await expect(page.locator('[data-offer-recovery-purchase-omitted="true"]'))
      .toHaveText(
        "Ein lokaler EK-Entwurf wurde aus Sicherheitsgründen nicht im Browser gespeichert und konnte nicht wiederhergestellt werden. Prüfe den aktuellen Server-EK und trage deine Änderung bei Bedarf erneut ein.",
      );
    await expect(page.locator(`#line-${customLine.lineDomainId}-editor`)
      .getByLabel("EK je Einheit €", { exact: true })).toHaveValue("430,75");
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), recoveryKey))
      .toBeNull();

    const switchEvidence = await readM201RevisionEvidence(state, offerId, variantId);
    const switchLine = page.locator(`#line-${customLine.lineDomainId}-editor`);
    await switchLine.getByLabel("EK je Einheit €", { exact: true }).fill("888,88");
    await switchLine.getByLabel("Grund für EK-Änderung").selectOption("negotiated");
    await page.locator("#variant-description").fill("SYNTHETIC ACTOR SWITCH LOCAL");
    await saveConcurrentDescription(
      page,
      offerPath,
      state,
      offerId,
      variantId,
      switchEvidence.revision,
      `SYNTHETIC ACTOR SWITCH SERVER ${switchEvidence.revision + 1}`,
    );
    await page.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await dirtyDialog(page).getByRole("button", { name: "Speichern und fortfahren" }).click();
    await expect(page.locator('[data-offer-detail-state="conflict"]')).toBeVisible();

    await expireM201IdentitySessions(state);
    await acceptNativeReloadFrom(
      page,
      page.getByRole("button", { name: "Serverstand bewusst neu laden" }),
    );
    await expect(page.locator('[data-offer-detail-state="unauthenticated"]')).toBeVisible();
    expect(await page.evaluate((key) => {
      const raw = window.sessionStorage.getItem(key);
      return {
        containsSensitivePurchaseDraft: raw?.includes("888,88") ?? false,
        recoveryEnvelopeExists: raw !== null,
      };
    }, recoveryKey)).toEqual({
      containsSensitivePurchaseDraft: false,
      recoveryEnvelopeExists: true,
    });

    await page.goto(`/login?next=${encodeURIComponent(offerPath)}`);
    await loginWithRealOtp(page, offerPath, redactedEditor.email);
    await expect(page.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();
    await expect(page.getByLabel("EK je Einheit €", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Einkaufspreis", { exact: true })).toHaveCount(0);
    await expect(page.getByText(
      "Lokaler Draft wurde auf den aktuellen Serverstand rebasiert.",
      { exact: true },
    )).toHaveCount(0);
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), recoveryKey))
      .toBeNull();
    expect(await page.locator("input").evaluateAll((inputs) =>
      inputs.some((input) => (input as HTMLInputElement).value === "777,77")))
      .toBe(false);
  });
});
