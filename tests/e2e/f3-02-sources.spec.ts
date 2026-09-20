import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Browser, type Page } from "playwright/test";

import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  M2_01_E2E_CONTACT,
  readM201RevisionEvidence,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F3-02 Dachquellen-Registry + Upload — Chromium-E2E (isolierter Workspace).
 *
 * TDD-RED (Batch-1): Diese Suite läuft rot, bis Migration 0270
 * (`planning_source`), der Sources-Service/-Contract und die Projekt-Sektion
 * existieren. Ablauf je F3-02-Tests: Upload → Liste → Selbstzeichnen →
 * Quick-Ausblendung (F3-01-Regel: Quick blendet Dach-/Planungs-UI aus).
 *
 * UI-Vertrag (Testids, von der Implementation zu stellen):
 * - `planning-sources-section` (section, Heading "Dachquellen")
 * - `planning-source-upload-input` (file), `planning-source-scale-meters`,
 *   `planning-source-scale-pixels`, `planning-source-upload-submit`,
 *   `planning-source-upload-feedback`
 * - `planning-source-item` (li), darin `planning-source-kind`
 *   ("Upload" | "Selbstzeichnung")
 * - `planning-source-self-drawn-create`, `planning-source-self-drawn-feedback`
 * - Angebots-Planungsblock: `planning-sources-offer-block`
 */

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_FILENAME = "dach-ortho.png";
const TXT_BYTES = Buffer.from("kein Bild\n", "utf8");
const OVERSIZE_BYTES = Buffer.alloc(10_485_760 + 1, 0x89);

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  viewerEmail: string;
};

type OfferState = M201RuntimeState & { viewerEmail: string };

let workspaceId = "";
let projectPath = "";
let viewerWorkspaceId = "";
let offerState: OfferState | null = null;

function state(): E2EState {
  const full = fixtureState() as Partial<E2EState>;
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail", "viewerEmail"] as const) {
    if (typeof parsed[key] !== "string" || parsed[key] === "") {
      throw new Error(`Der private F3-02-E2E-State ist unvollständig (${key}).`);
    }
  }
  void full;
  return parsed as E2EState;
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
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedPath);
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function addViewerToWorkspace(databaseUrl: string, targetWorkspaceId: string, viewerEmail: string): Promise<void> {
  const pool = createDrainTrackedPool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [targetWorkspaceId],
      );
      const identity = await client.query(
        "select id from user_identity where lower(email) = lower($1)",
        [viewerEmail],
      );
      const viewerId = (identity.rows[0] as { id: string } | undefined)?.id;
      if (!viewerId) throw new Error("E2E-Vieweridentitaet fehlt.");
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'viewer', '{}'::jsonb)
         on conflict do nothing`,
        [targetWorkspaceId, viewerId],
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
}

async function createProjectThroughManualLead(page: Page, targetWorkspaceId: string): Promise<string> {
  const listPath = `/w/${targetWorkspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, state().editorEmail, listPath);
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E F3-02 Dachquellen");
  await form.getByLabel("Telefon").fill("0151 45678902");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  return new URL(page.url()).pathname;
}

async function seedIsolatedOfferState(data: E2EState): Promise<OfferState> {
  const targetWorkspaceId = randomUUID();
  const editorIdentityId = randomUUID();
  const viewerIdentityId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const editorEmail = `f302-offer-editor-${suffix}@example.test`;
  const viewerEmail = `f302-offer-viewer-${suffix}@example.test`;
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query(
        "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
        [targetWorkspaceId],
      );
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        targetWorkspaceId,
        "F3.02 isolierter E2E Workspace",
      ]);
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
        [targetWorkspaceId, editorIdentityId, viewerIdentityId],
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
    workspaceId: targetWorkspaceId,
    editorIdentityId,
    skuSuffix: `f302-${suffix}`,
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
    workspaceId: targetWorkspaceId,
    viewerEmail,
  };
}

async function createOfferThroughBrowser(page: Page, data: OfferState): Promise<{
  offerId: string;
  offerPath: string;
  variantId: string;
}> {
  const targetProjectPath = `/w/${data.workspaceId}/anfragen/${data.m201ProjectId}`;
  await page.goto(targetProjectPath);
  await loginWithRealOtp(page, data.editorEmail, targetProjectPath);
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
  const current = new URL(page.url());
  const offerId = current.pathname.split("/").at(-1);
  const variantId = current.searchParams.get("variante");
  if (!offerId || !variantId) throw new Error("F3.02-Angebotsidentität fehlt.");
  return { offerId, offerPath: `${current.pathname}${current.search}`, variantId };
}

async function expectOfferRevision(offerId: string, variantId: string, revision: number): Promise<void> {
  if (!offerState) throw new Error("Der isolierte F3.02-Angebots-State fehlt.");
  const runtime = offerState;
  await expect.poll(
    async () => (await readM201RevisionEvidence(runtime, offerId, variantId)).revision,
    { message: `F3.02-Serverrevision ${revision} wurde nicht sichtbar.`, timeout: 15_000 },
  ).toBe(revision);
}

test.describe("F3-02 Dachquellen-Registry — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const data = state();
    const actorId = await resolveEditorId();
    workspaceId = await seedIsolatedWorkspace(actorId);
    viewerWorkspaceId = workspaceId;
    await addViewerToWorkspace(data.databaseUrl, viewerWorkspaceId, data.viewerEmail);
    offerState = await seedIsolatedOfferState(data);
  });

  test("F302-E2E-01: Upload mit Referenzlinie erscheint in der Liste, Duplikat ist idempotent", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = trackBrowserErrors(page);
    projectPath = await createProjectThroughManualLead(page, workspaceId);

    const section = page.getByTestId("planning-sources-section");
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { name: "Dachquellen", exact: true })).toBeVisible();

    await section.getByTestId("planning-source-upload-input").setInputFiles({
      name: PNG_FILENAME,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await section.getByTestId("planning-source-scale-meters").fill("12.5");
    await section.getByTestId("planning-source-scale-pixels").fill("640");
    await section.getByTestId("planning-source-upload-submit").click();
    await expect(section.getByTestId("planning-source-upload-feedback")).toHaveText(
      "Dachquelle gespeichert.",
    );
    const items = section.getByTestId("planning-source-item");
    await expect(items).toHaveCount(1);
    await expect(items.first().getByTestId("planning-source-kind")).toHaveText("Upload");
    await expect(items.first()).toContainText(PNG_FILENAME);

    // Gleicher Upload erneut: kein Duplikat (WORM-Idempotenz per sha256).
    // Formular wird nach Erfolg zurückgesetzt (Browser löscht File-Inputs
    // ohnehin) — Datei + Skala erneut setzen, identische Bytes + Werte.
    await section.getByTestId("planning-source-upload-input").setInputFiles({
      name: PNG_FILENAME,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await section.getByTestId("planning-source-scale-meters").fill("12.5");
    await section.getByTestId("planning-source-scale-pixels").fill("640");
    await section.getByTestId("planning-source-upload-submit").click();
    await expect(section.getByTestId("planning-source-upload-feedback")).toHaveText(
      "Dachquelle bereits vorhanden.",
    );
    await expect(section.getByTestId("planning-source-item")).toHaveCount(1);

    expect(errors, "Browser-Konsole und Page-Errors der Dachquellen-Grenze").toEqual([]);
  });

  test("F302-E2E-02: Upload-Gates weisen Dateityp, 10-MiB-Grenze und Referenzlinie ab", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = trackBrowserErrors(page);
    expect(projectPath, "F302-E2E-01 legt das Projekt an.").not.toBe("");
    await page.goto(projectPath);
    await loginWithRealOtp(page, state().editorEmail, projectPath);

    const section = page.getByTestId("planning-sources-section");
    await expect(section).toBeVisible();
    const countBefore = await section.getByTestId("planning-source-item").count();

    // Falscher Dateityp (nur JPEG/PNG).
    await section.getByTestId("planning-source-upload-input").setInputFiles({
      name: "notiz.txt",
      mimeType: "text/plain",
      buffer: TXT_BYTES,
    });
    await section.getByTestId("planning-source-scale-meters").fill("10");
    await section.getByTestId("planning-source-scale-pixels").fill("500");
    await section.getByTestId("planning-source-upload-submit").click();
    await expect(section.getByTestId("planning-source-upload-feedback")).toHaveText(
      "Nur JPEG- oder PNG-Bilder sind zulässig.",
    );

    // Über 10 MiB.
    await section.getByTestId("planning-source-upload-input").setInputFiles({
      name: "riesig.png",
      mimeType: "image/png",
      buffer: OVERSIZE_BYTES,
    });
    await section.getByTestId("planning-source-upload-submit").click();
    await expect(section.getByTestId("planning-source-upload-feedback")).toHaveText(
      "Die Datei ist zu groß (max. 10 MiB).",
    );

    // Fehlende Referenzlinie (meters/pixelLength > 0).
    await section.getByTestId("planning-source-upload-input").setInputFiles({
      name: PNG_FILENAME,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await section.getByTestId("planning-source-scale-meters").fill("0");
    await section.getByTestId("planning-source-scale-pixels").fill("");
    await section.getByTestId("planning-source-upload-submit").click();
    await expect(section.getByTestId("planning-source-upload-feedback")).toHaveText(
      "Bitte eine gültige Referenzlinie angeben (Meter und Pixel > 0).",
    );

    await expect(section.getByTestId("planning-source-item")).toHaveCount(countBefore);
    expect(errors, "Browser-Konsole und Page-Errors der Upload-Gates").toEqual([]);
  });

  test("F302-E2E-03: Selbstzeichnen-Anlage landet in der Liste, Viewer liest read-only", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    expect(projectPath, "F302-E2E-01 legt das Projekt an.").not.toBe("");
    const editorContext = await browser.newContext({
      baseURL: state().baseURL,
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });
    const viewerContext = await browser.newContext({
      baseURL: state().baseURL,
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });
    try {
      const editorPage = await editorContext.newPage();
      const editorErrors = trackBrowserErrors(editorPage);
      await editorPage.goto(projectPath);
      await loginWithRealOtp(editorPage, state().editorEmail, projectPath);
      const section = editorPage.getByTestId("planning-sources-section");
      await expect(section).toBeVisible();
      const countBefore = await section.getByTestId("planning-source-item").count();
      await section.getByTestId("planning-source-self-drawn-create").click();
      await expect(section.getByTestId("planning-source-self-drawn-feedback")).toHaveText(
        "Selbstzeichnung angelegt.",
      );
      await expect(section.getByTestId("planning-source-item")).toHaveCount(countBefore + 1);
      await expect(
        section.getByTestId("planning-source-item").last().getByTestId("planning-source-kind"),
      ).toHaveText("Selbstzeichnung");
      expect(editorErrors, "Browser-Konsole des Editors (Selbstzeichnen)").toEqual([]);

      const viewerPage = await viewerContext.newPage();
      const viewerErrors = trackBrowserErrors(viewerPage);
      await viewerPage.goto(projectPath);
      await loginWithRealOtp(viewerPage, state().viewerEmail, projectPath);
      const viewerSection = viewerPage.getByTestId("planning-sources-section");
      await expect(viewerSection).toBeVisible();
      await expect(viewerSection.getByTestId("planning-source-item").first()).toBeVisible();
      await expect(viewerSection.getByTestId("planning-source-upload-submit")).toHaveCount(0);
      await expect(viewerSection.getByTestId("planning-source-self-drawn-create")).toHaveCount(0);
      expect(viewerErrors, "Browser-Konsole des Viewers (read-only)").toEqual([]);
    } finally {
      await Promise.all([editorContext.close(), viewerContext.close()]);
    }
  });

  test("F302-E2E-04: Quick-Modus blendet den Quellen-Planungsblock aus, 2D blendet ihn ein", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = trackBrowserErrors(page);
    if (!offerState) throw new Error("Der isolierte F3.02-Angebots-State fehlt.");
    const { offerId, variantId } = await createOfferThroughBrowser(page, offerState);
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    await expect(page.getByRole("radio", { name: "3D-Planung", exact: true })).toBeChecked();
    await expectOfferRevision(offerId, variantId, 1);

    const offerBlock = page.getByTestId("planning-sources-offer-block");
    await expect(offerBlock).toBeVisible();

    await page.getByRole("radio", { name: "Quick-Planung", exact: true }).check();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectOfferRevision(offerId, variantId, 2);
    await expect(offerBlock).toHaveCount(0);
    await expect(page.getByText(
      "Quick verwaltet Komponenten und Preise; Dach-, Ertrags- und Simulationsausgaben bleiben ausgeblendet.",
      { exact: true },
    )).toBeVisible();

    await page.getByRole("radio", { name: "2D-Planung", exact: true }).check();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expectOfferRevision(offerId, variantId, 3);
    await expect(page.getByTestId("planning-sources-offer-block")).toBeVisible();

    expect(errors, "Browser-Konsole der Quick-Ausblendung").toEqual([]);
  });
});
