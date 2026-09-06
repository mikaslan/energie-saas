import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright/test";

import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import {
  M2_01_E2E_CONTACT,
  readM201RevisionEvidence,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";
import { seedM204ReleasedOffer } from "./m2-04-fixture";

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  viewerEmail: string;
  externalEmail: string;
};

type F301OfferState = M201RuntimeState & {
  viewerEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();
let adminEmail = "";
let f301OfferState: F301OfferState | null = null;

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F3.1-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function settingsPath(): string {
  return `/w/${state().workspaceId}/einstellungen/planung`;
}

function offerState(): F301OfferState {
  if (!f301OfferState) throw new Error("Der isolierte F3.1-Angebots-State fehlt.");
  return f301OfferState;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  let otp: string | null = null;
  await expect.poll(() => {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    otp = pattern.exec(tail)?.[1] ?? null;
    return otp;
  }, {
    message: "Der echte F3.1-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte F3.1-Dev-Mail-OTP fehlt.");
  return otp;
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  const loaded = new URL(page.url());
  if (
    `${loaded.pathname}${loaded.search}` === expectedPath
    && loaded.pathname.includes("/angebote/")
  ) {
    const offerState = await page.locator("[data-offer-detail-state]")
      .getAttribute("data-offer-detail-state");
    if (offerState !== "unauthenticated") return;
    await page.goto(`/login?next=${encodeURIComponent(expectedPath)}`);
  }
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
      && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponse).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(
    state().serverLogPath,
    email,
    logOffset,
  ));
  const signInResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
      && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponse).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function seedAdminMembership(data: E2EState): Promise<string> {
  const identityId = randomUUID();
  const email = `f301-admin-${randomUUID().slice(0, 8)}@example.test`;
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
        [data.workspaceId],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [identityId, email],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`,
        [data.workspaceId, identityId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
  return email;
}

async function seedIsolatedOfferWorkspace(data: E2EState): Promise<F301OfferState> {
  const workspaceId = randomUUID();
  const editorIdentityId = randomUUID();
  const viewerIdentityId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const editorEmail = `f301-offer-editor-${suffix}@example.test`;
  const viewerEmail = `f301-offer-viewer-${suffix}@example.test`;
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [workspaceId, "F3.1 isolierter E2E Workspace"],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2), ($3::uuid, $4)",
        [editorIdentityId, editorEmail, viewerIdentityId, viewerEmail],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
              "discounts":true,"see_purchase_prices":true}'::jsonb),
                ($1::uuid, $3::uuid, 'viewer', '{}'::jsonb)`,
        [workspaceId, editorIdentityId, viewerIdentityId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }

  const seeded = await seedM201ReadyProject(data.databaseUrl, {
    workspaceId,
    editorIdentityId,
    skuSuffix: `f301-${suffix}`,
  });
  return {
    databaseUrl: data.databaseUrl,
    editorEmail,
    editorIdentityId,
    m201BatteryId: seeded.products.battery,
    m201InverterId: seeded.products.inverter,
    m201ModuleId: seeded.products.module,
    m201ProjectId: seeded.projectId,
    m201WallboxId: seeded.products.wallbox,
    serverLogPath: data.serverLogPath,
    workspaceId,
    viewerEmail,
  };
}

async function isolatedPage(
  browser: Browser,
  width: 375 | 768 | 1440,
): Promise<{
  context: BrowserContext;
  errors: string[];
  page: Page;
}> {
  const context = await browser.newContext({
    baseURL: state().baseURL,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
    viewport: { width, height: width === 1440 ? 1000 : 900 },
  });
  const page = await context.newPage();
  return { context, errors: trackBrowserErrors(page), page };
}

async function createOfferThroughBrowser(page: Page): Promise<{
  offerId: string;
  offerPath: string;
  variantId: string;
}> {
  const data = offerState();
  const projectPath = `/w/${data.workspaceId}/anfragen/${data.m201ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);
  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 }))
    .toBeVisible();
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) => (
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante")
  ));
  const current = new URL(page.url());
  const offerId = current.pathname.split("/").at(-1);
  const variantId = current.searchParams.get("variante");
  if (!offerId || !variantId) throw new Error("F3.1-Angebotsidentität fehlt.");
  return {
    offerId,
    offerPath: `${current.pathname}${current.search}`,
    variantId,
  };
}

async function expectOfferRevision(
  offerId: string,
  variantId: string,
  revision: number,
): Promise<void> {
  await expect.poll(async () => (
    await readM201RevisionEvidence(offerState(), offerId, variantId)
  ).revision, {
    message: `F3.1-Serverrevision ${revision} wurde nicht sichtbar.`,
    timeout: 15_000,
  }).toBe(revision);
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

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: width, scrollWidth: width });
}

async function captureEvidence(page: Page, name: string): Promise<void> {
  const directory = process.env.F301_E2E_SCREENSHOT_DIR;
  if (!directory) return;
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: join(directory, `${name}.png`),
  });
}

async function expectNoWcagAaAxeViolations(
  page: Page,
  stateName: string,
  include: readonly string[] = [],
): Promise<void> {
  const builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  for (const selector of include) builder.include(selector);
  const result = await builder.analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F3.1 Planungsmodi — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const data = state();
    adminEmail = await seedAdminMembership(data);
    f301OfferState = await seedIsolatedOfferWorkspace(data);
  });

  test("F301-E2E-01: Zwei isolierte Admin-Sessions belegen den Settings-CAS", async ({ browser }) => {
    test.setTimeout(120_000);
    const path = settingsPath();
    const primary = await isolatedPage(browser, 375);
    const competing = await isolatedPage(browser, 375);
    try {
      expect(primary.context).not.toBe(competing.context);
      await primary.page.goto(path);
      await loginWithRealOtp(primary.page, adminEmail, path);
      await competing.page.goto(path);
      await loginWithRealOtp(competing.page, adminEmail, path);

      await expect(primary.page.getByRole("heading", { name: "Planung", level: 1 }))
        .toBeVisible();
      await expect(primary.page.getByRole("radio", { name: /^3D\b/u })).toBeChecked();
      await expect(competing.page.getByRole("radio", { name: /^3D\b/u })).toBeChecked();

      const quick = primary.page.getByRole("radio", { name: /Quick/u });
      await quick.focus();
      await primary.page.keyboard.press("Space");
      await expect(quick).toBeChecked();
      const save = primary.page.getByRole("button", { name: "Speichern" });
      await save.focus();
      await primary.page.keyboard.press("Enter");
      await expect(primary.page.getByText(
        "Planungsstandard gespeichert.",
        { exact: true },
      )).toBeVisible();

      await competing.page.getByRole("radio", { name: /^2D\b/u }).check();
      await competing.page.getByRole("button", { name: "Speichern" }).click();
      await expect(competing.page.getByText(
        "Die Einstellung wurde zwischenzeitlich geändert. Bitte neu laden.",
        { exact: true },
      )).toBeVisible();

      await primary.page.reload();
      await expect(primary.page.getByRole("radio", { name: /Quick/u })).toBeChecked();
      await expectNoHorizontalOverflow(primary.page, 375);
      await expectNoHorizontalOverflow(competing.page, 375);
      await expectNoWcagAaAxeViolations(primary.page, "F3.1 Admin bei 375 px");
      await expectNoWcagAaAxeViolations(competing.page, "F3.1 CAS-Konflikt bei 375 px");
      await captureEvidence(primary.page, "settings-admin-375");
      expect(primary.errors, "Browser-Konsole der ersten isolierten Session").toEqual([]);
      expect(competing.errors, "Browser-Konsole der zweiten isolierten Session").toEqual([]);
    } finally {
      await Promise.all([primary.context.close(), competing.context.close()]);
    }
  });

  test("F301-E2E-02: Viewer sieht Quick read-only bei 768 px", async ({ page }) => {
    const path = settingsPath();
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(path);
    await loginWithRealOtp(page, state().viewerEmail, path);

    await expect(page.getByRole("heading", { name: "Planung", level: 1 })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Speichern" })).toHaveCount(0);
    const quickCard = page.locator("article").filter({ hasText: "Quick" });
    await expect(quickCard.getByText("Aktuell", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, 768);
    await expectNoWcagAaAxeViolations(page, "F3.1 Viewer bei 768 px");
    await captureEvidence(page, "settings-viewer-768");
  });

  test("F301-E2E-03: External bleibt bei 1440 px fail-closed", async ({ page }) => {
    const path = settingsPath();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(path);
    await loginWithRealOtp(page, state().externalEmail, path);

    await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 1440);
    await expectNoWcagAaAxeViolations(page, "F3.1 External bei 1440 px");
    await captureEvidence(page, "settings-external-1440");
  });

  test("F301-E2E-04: Offer-Modus speichert, rebasiert, sperrt und bleibt forkbar", async ({ browser, page }) => {
    test.setTimeout(240_000);
    const data = offerState();
    await page.setViewportSize({ width: 768, height: 1000 });
    const { offerId, offerPath, variantId } = await createOfferThroughBrowser(page);
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    await expect(page.getByRole("radio", { name: "3D-Planung", exact: true })).toBeChecked();
    await expectOfferRevision(offerId, variantId, 1);

    const quick = page.getByRole("radio", { name: "Quick-Planung", exact: true });
    await quick.check();
    await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Quick verwaltet Komponenten und Preise; Dach-, Ertrags- und Simulationsausgaben bleiben ausgeblendet.",
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectOfferRevision(offerId, variantId, 2);
    await expect(page.getByText("Gespeicherte Revision 2", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("radio", { name: "Quick-Planung", exact: true })).toBeChecked();

    const previewSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "PDF-Vorschau", exact: true }),
    });
    await previewSection.getByRole("button", { name: "Vorschau laden", exact: true }).click();
    const previewDialog = page.getByRole("dialog", { name: "PDF-Vorschau" });
    await expect(previewDialog.locator('iframe[title="PDF-Vorschau"]')).toBeVisible();
    const previewFrame = page.frameLocator('iframe[title="PDF-Vorschau"]');
    await expect(previewFrame.getByRole("heading", { name: "Angebotsentwurf", level: 1 }))
      .toBeVisible();
    const previewText = await previewFrame.locator("body").innerText();
    expect(previewText).toContain("PV-Module");
    expect(previewText).not.toMatch(/Dach|Ertrag|Simulation|Autarkie|Eigenverbrauch/iu);
    await previewDialog.getByRole("button", { name: "Schließen", exact: true }).click();
    await expectNoHorizontalOverflow(page, 768);
    await expectNoWcagAaAxeViolations(page, "F3.1 Quick-Angebot bei 768 px");

    const competing = await isolatedPage(browser, 768);
    try {
      await competing.page.goto(offerPath);
      await loginWithRealOtp(competing.page, data.editorEmail, offerPath);
      await expect(competing.page.getByRole(
        "radio",
        { name: "Quick-Planung", exact: true },
      )).toBeChecked();

      await page.getByRole("radio", { name: "2D-Planung", exact: true }).check();
      await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true }))
        .toBeVisible();
      await competing.page.getByRole("radio", { name: "3D-Planung", exact: true }).check();
      await competing.page.getByRole(
        "button",
        { name: "Angebotsentwurf speichern", exact: true },
      ).click();
      await expectOfferRevision(offerId, variantId, 3);

      await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
      const conflict = page.locator('[data-offer-detail-state="conflict"]');
      await expect(conflict.getByRole("alert").filter({
        hasText: "Der Serverstand wurde zwischenzeitlich geändert.",
      })).toBeVisible();
      await acceptNativeReloadFrom(
        page,
        page.getByRole("button", { name: "Serverstand bewusst neu laden" }),
      );
      await expect(page.getByText(
        "Lokaler Draft wurde auf den aktuellen Serverstand rebasiert.",
        { exact: true },
      )).toBeVisible();
      await expect(page.getByText("Planungsmodus parallel geändert", { exact: true }))
        .toBeVisible();
      await expect(page.getByRole("radio", { name: "2D-Planung", exact: true })).toBeChecked();
      await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
      await expectOfferRevision(offerId, variantId, 4);
      await expect(page.getByText("Gespeicherte Revision 4", { exact: true })).toBeVisible();
      await expect(page.getByRole("radio", { name: "2D-Planung", exact: true })).toBeChecked();
      expect(competing.errors, "Browser-Konsole der isolierten Offer-Konflikt-Session")
        .toEqual([]);
    } finally {
      await competing.context.close();
    }

    const viewer = await isolatedPage(browser, 1440);
    try {
      await viewer.page.goto(offerPath);
      await loginWithRealOtp(viewer.page, data.viewerEmail, offerPath);
      await expect(viewer.page.locator('[data-offer-detail-state="read_only"]')).toBeVisible();
      await expect(viewer.page.locator('[data-planning-mode-readonly="true"]'))
        .toContainText("2D-Planung");
      await expect(viewer.page.getByRole("radio", { name: /Planung/u })).toHaveCount(0);
      await expect(viewer.page.getByRole(
        "button",
        { name: "Angebotsentwurf speichern" },
      )).toHaveCount(0);
      await expectNoHorizontalOverflow(viewer.page, 1440);
      await expectNoWcagAaAxeViolations(viewer.page, "F3.1 Offer-Viewer bei 1440 px");
      expect(viewer.errors, "Browser-Konsole des isolierten Offer-Viewers").toEqual([]);
    } finally {
      await viewer.context.close();
    }

    const released = await seedM204ReleasedOffer(data, { validThroughOffsetDays: 17 });
    expect(released).toMatchObject({ offerId, variantId });
    await page.setViewportSize({ width: 375, height: 900 });
    const baseOfferPath = `/w/${data.workspaceId}/angebote/${offerId}`;
    const signaturePanel = page.getByRole(
      "heading",
      { name: "Signaturanforderungen", level: 2 },
    ).locator("xpath=ancestor::section[1]");
    await page.goto(baseOfferPath);
    await expect(signaturePanel.locator('input[name="variantId"]')).toHaveValue(variantId);
    await page.goto(`${baseOfferPath}?variante=${randomUUID()}`);
    await expect(signaturePanel.locator('input[name="variantId"]')).toHaveValue(variantId);
    await expect(signaturePanel).toBeVisible();

    await page.locator("#variant-name").fill("F3.1 Race Draft bleibt erhalten");
    const signer = await isolatedPage(browser, 375);
    try {
      await signer.page.goto(baseOfferPath);
      await loginWithRealOtp(signer.page, data.editorEmail, baseOfferPath);
      const signerPanel = signer.page.getByRole(
        "heading",
        { name: "Signaturanforderungen", level: 2 },
      ).locator("xpath=ancestor::section[1]");
      await signerPanel.getByLabel("Gültigkeit in Tagen (1–60)").fill("14");
      await signerPanel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();
      await expect(signerPanel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
      await expect(page.getByRole("alert").filter({
        hasText: "Für diese Variante läuft bereits eine Signaturanfrage.",
      })).toBeVisible();
      await expect(page.locator("#variant-name")).toHaveValue("F3.1 Race Draft bleibt erhalten");

      await signerPanel.getByRole("button", { name: "Link widerrufen" }).click();
      await page.getByRole("button", { name: "Sperrstatus aktualisieren" }).click();
      await expect(page.locator('[data-offer-content-lock="pending"]')).toHaveCount(0);
      await expect(page.locator("#variant-name")).toBeEnabled();
      await expect(page.locator("#variant-name")).toHaveValue("F3.1 Race Draft bleibt erhalten");
      await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Änderungen verwerfen" }).click();
    } finally {
      await signer.context.close();
    }

    const rereleased = await seedM204ReleasedOffer(data, { validThroughOffsetDays: 18 });
    expect(rereleased).toMatchObject({ offerId, variantId });
    expect(rereleased.issuanceId).not.toBe(released.issuanceId);
    await signaturePanel.getByLabel("Gültigkeit in Tagen (1–60)").fill("14");
    await signaturePanel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();
    await expect(signaturePanel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();
    await expect(page.locator('[data-offer-content-lock="pending"]')).toContainText(
      "Signaturanfrage läuft – Inhalt gesperrt",
    );
    await expect(page.locator("#offer-editor-main")).toHaveAttribute("disabled", "");
    await expect(page.locator("#variant-name")).toBeDisabled();
    await expect(page.locator('[data-planning-mode-readonly="true"]'))
      .toContainText("2D-Planung");

    const lockedViewer = await isolatedPage(browser, 1440);
    try {
      await lockedViewer.page.goto(baseOfferPath);
      await loginWithRealOtp(lockedViewer.page, data.viewerEmail, baseOfferPath);
      const viewerSignaturePanel = lockedViewer.page.getByRole(
        "heading",
        { name: "Signaturanforderungen", level: 2 },
      ).locator("xpath=ancestor::section[1]");
      await expect(viewerSignaturePanel.getByText("wartet auf Signatur", { exact: true }))
        .toBeVisible();
      await expect(viewerSignaturePanel.getByText(
        "Signaturanforderungen sind für dich nur lesbar.",
        { exact: true },
      )).toBeVisible();
      await expect(viewerSignaturePanel.getByLabel("Gültigkeit in Tagen (1–60)"))
        .toHaveCount(0);
      await expect(viewerSignaturePanel.getByRole("button", { name: "Link widerrufen" }))
        .toHaveCount(0);
      await expect(viewerSignaturePanel.getByRole("button", { name: "Analog hochladen" }))
        .toHaveCount(0);
      await expectNoWcagAaAxeViolations(
        lockedViewer.page,
        "F3.1 Signatursperre für Viewer bei 1440 px",
      );
      expect(lockedViewer.errors, "Browser-Konsole des gesperrten Offer-Viewers").toEqual([]);
    } finally {
      await lockedViewer.context.close();
    }

    const duplicate = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
    });
    await expect(duplicate.getByRole("button", { name: "Duplizieren", exact: true }))
      .toBeEnabled();
    await duplicate.getByLabel("Name der Kopie").fill("F3.1 Fork nach Signatursperre");
    await duplicate.getByRole("button", { name: "Duplizieren", exact: true }).click();
    await page.waitForURL((url) => (
      url.pathname === `/w/${data.workspaceId}/angebote/${offerId}`
      && url.searchParams.has("variante")
      && url.searchParams.get("variante") !== variantId
    ));
    await expect(page.locator('[data-offer-content-lock="pending"]')).toHaveCount(0);
    await expect(signaturePanel.getByText("wartet auf Signatur", { exact: true })).toHaveCount(0);
    await expect(signaturePanel.getByRole("button", { name: "Link widerrufen" })).toHaveCount(0);
    await expect(signaturePanel.getByRole("button", { name: "Analog hochladen" })).toHaveCount(0);
    await expect(signaturePanel.locator("a[href^='/s/']")).toHaveCount(0);
    await expect(page.locator("#variant-name")).toHaveValue("F3.1 Fork nach Signatursperre");
    await expect(page.getByRole("radio", { name: "2D-Planung", exact: true })).toBeChecked();
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(
      page,
      "F3.1 entsperrter Fork bei 375 px",
    );
    await captureEvidence(page, "offer-fork-375");
  });
});
