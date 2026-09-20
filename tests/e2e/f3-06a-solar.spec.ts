import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F3-06a Sonnenstands-Anzeige — Chromium-E2E (TDD RED).
 *
 * Vertrag: docs/spec/F3-06a-sonnenstand.md
 * - Sektion zeigt Höhe/Azimut/Auf-Unter für wählbaren Zeitpunkt.
 * - Quick blendet aus, Viewer liest, External fail-closed.
 * - Site ohne Koordinaten → Hinweistext.
 *
 * Erwartete UI-Anker (Projekt-Seite / Angebot-Seite):
 * - [data-testid="planning-solar-section"] / -datetime / -elevation /
 *   -azimuth / -state / -no-coords
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F3.6a-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
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
  expect(current.pathname).toBe("/login");
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations,
    `${stateName}: Axe-Verstöße ${JSON.stringify(result.violations.map((v) => v.id))}`,
  ).toEqual([]);
}

function projectPath(): string {
  const data = state();
  return `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
}

// Das geteilte Seed-Projekt ist regional (ohne Koordinaten). Für die
// Anzeige-Testvorbedingung Geokodierung setzen — Adressfelder und
// Follow-Up-Flags bleiben unberührt (m1-05-Fläche tabu).
async function ensureSiteCoords(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `update site as site_record set lat = 52.52, lng = 13.405
        from project as project_record
       where project_record.id = $1::uuid
         and site_record.workspace_id = project_record.workspace_id
         and site_record.id = project_record.site_id`,
      [data.mainProjectId],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

type IsolatedOfferProject = {
  workspaceId: string;
  projectId: string;
  editorEmail: string;
};

let offerProject: IsolatedOfferProject | null = null;

async function seedIsolatedOfferProject(data: E2EState): Promise<IsolatedOfferProject> {
  const targetWorkspaceId = randomUUID();
  const editorIdentityId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const editorEmail = `f306-offer-editor-${suffix}@example.test`;
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
        "F3.06a isolierter E2E Workspace",
      ]);
      await client.query("insert into user_identity (id, email) values ($1::uuid, $2)", [
        editorIdentityId,
        editorEmail,
      ]);
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
              "discounts":true,"see_purchase_prices":true}'::jsonb)`,
        [targetWorkspaceId, editorIdentityId],
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
    skuSuffix: `f306-${suffix}`,
  });
  return { workspaceId: targetWorkspaceId, projectId: seeded.projectId, editorEmail };
}

test.describe("F3-06a Sonnenstand — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    offerProject = await seedIsolatedOfferProject(state());
  });

  test("F306-E2E-01: Sonnenstand lesen, Zeitpunkt wechseln", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    await ensureSiteCoords();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    const section = page.getByTestId("planning-solar-section");
    await expect(section).toBeVisible();
    const elevation = section.getByTestId("planning-solar-elevation");
    const azimuth = section.getByTestId("planning-solar-azimuth");
    const solarState = section.getByTestId("planning-solar-state");
    await expect(elevation).toBeVisible();
    await expect(azimuth).toBeVisible();
    await expect(solarState).toBeVisible();
    const before = await elevation.textContent();

    await section.getByTestId("planning-solar-datetime").fill("2026-06-21T00:00");
    await expect(solarState).toContainText("unter");
    const after = await elevation.textContent();
    expect(after).not.toBe(before);

    await expectNoWcagAaAxeViolations(page, "F306-E2E-01");
    expect(errors, "Browser-Konsole und Page-Errors des Sonnenstands").toEqual([]);
  });

  test("F306-E2E-03: Quick blendet die Sonnenstands-Sektion aus", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackBrowserErrors(page);
    if (!offerProject) throw new Error("Das isolierte F3.06a-Angebots-Projekt fehlt.");
    const path = `/w/${offerProject.workspaceId}/anfragen/${offerProject.projectId}`;

    await page.goto(path);
    await loginWithRealOtp(page, offerProject.editorEmail, path);
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntry).toBeVisible();
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));

    const quick = page.getByRole("radio", { name: "Quick-Planung", exact: true });
    await expect(quick).toBeVisible();
    await quick.check();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect(page.getByTestId("planning-solar-section")).toHaveCount(0);

    await page.getByRole("radio", { name: "3D-Planung", exact: true }).check();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect(page.getByTestId("planning-solar-section")).toBeVisible();

    expect(errors, "Browser-Konsole und Page-Errors der Quick-Ausblendung").toEqual([]);
  });

  test("F306-E2E-02: Viewer liest, External fail-closed", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    await ensureSiteCoords();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    await expect(page.getByTestId("planning-solar-section")).toBeVisible();

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-solar-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
  });
});
