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
 * F3-03 Dach-Minimal — Chromium-E2E (TDD RED).
 *
 * Vertrag: docs/spec/F3-BATCH-1-vertrag.md + docs/spec/F3-03-dach-minimal.md
 * - Editor zeichnet genau 1 Polygon (MapLibre), speichert, laedt persistiert
 *   erneut (Neigung/Kante ODER Flachdach-Toggle, Rand-Default-Hinweis).
 * - Selbstschnitt + tilt-Range werden clientseitig rejected.
 * - Quick-Planung blendet die Dach-Sektion aus (F3-01 Z.139-144).
 * - Viewer liest, External bleibt fail-closed.
 *
 * Erwartete UI-Anker (Projekt-Seite / Angebot-Seite):
 * - [data-testid="planning-sources-section"] (F3-02, Selbstzeichnen-Anlage)
 * - [data-testid="planning-roofs-section"] / [data-testid="roof-map"] canvas
 * - [data-testid="roof-draw-start"] / [data-testid="roof-draw-finish"]
 * - [data-testid="roof-save"] / [data-testid="roof-point-count"]
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
    throw new Error("Der private F3.3-E2E-State ist unvollständig.");
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
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

function projectPath(): string {
  const data = state();
  return `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;
}

// E2E-03 braucht ein angebotserstellungsbereites Projekt. Das geteilte
// Seed-Projekt trägt Adress-/Pin-Blocker (m1-05-Fläche, nicht anfassen) —
// daher isolierter Workspace + M2-Ready-Projekt (f302-Muster), ohne
// Interferenz mit anderen Specs.
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
  const editorEmail = `f303-offer-editor-${suffix}@example.test`;
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
        "F3.03 isolierter E2E Workspace",
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
    skuSuffix: `f303-${suffix}`,
  });
  return { workspaceId: targetWorkspaceId, projectId: seeded.projectId, editorEmail };
}

async function ensureSelfDrawnSource(page: Page): Promise<void> {
  const sources = page.getByTestId("planning-sources-section");
  await expect(sources).toBeVisible();
  await sources.getByRole("button", { name: "Selbstzeichnen-Anlage" }).click();
  await expect(sources.getByText("Selbstzeichnung angelegt.", { exact: true })).toBeVisible();
}

async function drawRectangleOnRoofMap(page: Page): Promise<void> {
  const section = page.getByTestId("planning-roofs-section");
  await expect(section).toBeVisible();
  await section.getByTestId("roof-draw-start").click();
  const canvas = section.getByTestId("roof-map").locator("canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Die Dach-Karte meldet keine Klickfläche.");
  const points = [
    { x: box.width * 0.3, y: box.height * 0.3 },
    { x: box.width * 0.7, y: box.height * 0.3 },
    { x: box.width * 0.7, y: box.height * 0.7 },
    { x: box.width * 0.3, y: box.height * 0.7 },
  ];
  for (const point of points) {
    await canvas.click({ position: { x: Math.round(point.x), y: Math.round(point.y) } });
  }
  await section.getByTestId("roof-draw-finish").click();
  await expect(section.getByTestId("roof-point-count")).toHaveText("4 Punkte");
}

test.describe("F3-03 Dach-Minimal — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    offerProject = await seedIsolatedOfferProject(state());
  });

  test("F303-E2E-01: Polygon zeichnen → speichern → laden (persistiert)", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureSelfDrawnSource(page);
    await drawRectangleOnRoofMap(page);

    const section = page.getByTestId("planning-roofs-section");
    await section.getByLabel("Neigung Kante 1 (°)").fill("30");
    await expect(section.getByText(/Randabstand: Standardwert/u)).toBeVisible();
    await section.getByTestId("roof-save").click();
    await expect(section.getByText("Dach gespeichert.", { exact: true })).toBeVisible();

    await page.reload();
    const reloaded = page.getByTestId("planning-roofs-section");
    await expect(reloaded.getByTestId("roof-point-count")).toHaveText("4 Punkte");
    await expect(reloaded.getByLabel("Neigung Kante 1 (°)")).toHaveValue("30");

    await expectNoWcagAaAxeViolations(page, "F3.3 Dach-Sektion");
    expect(errors, "Browser-Konsole und Page-Errors des Dach-Flows").toEqual([]);
  });

  test("F303-E2E-02: Selbstschnitt + tilt-Range werden rejected", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureSelfDrawnSource(page);

    const section = page.getByTestId("planning-roofs-section");
    await section.getByTestId("roof-draw-start").click();
    const canvas = section.getByTestId("roof-map").locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Die Dach-Karte meldet keine Klickfläche.");
    // Sanduhr-Reihenfolge: Kanten kreuzen sich (Selbstschnitt).
    const bowtie = [
      { x: box.width * 0.3, y: box.height * 0.3 },
      { x: box.width * 0.7, y: box.height * 0.7 },
      { x: box.width * 0.7, y: box.height * 0.3 },
      { x: box.width * 0.3, y: box.height * 0.7 },
    ];
    for (const point of bowtie) {
      await canvas.click({ position: { x: Math.round(point.x), y: Math.round(point.y) } });
    }
    await section.getByTestId("roof-draw-finish").click();
    await expect(section.getByText(/Selbstschnitt/u)).toBeVisible();
    await expect(section.getByTestId("roof-save")).toBeDisabled();

    // Gueltiges Polygon + ungueltige Neigung: Speicher-Reject.
    await section.getByTestId("roof-draw-start").click();
    const rectangle = [
      { x: box.width * 0.3, y: box.height * 0.3 },
      { x: box.width * 0.7, y: box.height * 0.3 },
      { x: box.width * 0.7, y: box.height * 0.7 },
      { x: box.width * 0.3, y: box.height * 0.7 },
    ];
    for (const point of rectangle) {
      await canvas.click({ position: { x: Math.round(point.x), y: Math.round(point.y) } });
    }
    await section.getByTestId("roof-draw-finish").click();
    await section.getByLabel("Neigung Kante 1 (°)").fill("120");
    await section.getByTestId("roof-save").click();
    await expect(section.getByText(/0–90|0-90/u)).toBeVisible();
    await expect(section.getByText("Dach gespeichert.", { exact: true })).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Dach-Validierung").toEqual([]);
  });

  test("F303-E2E-03: Quick blendet die Dach-Sektion aus", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackBrowserErrors(page);
    if (!offerProject) throw new Error("Das isolierte F3.03-Angebots-Projekt fehlt.");
    const path = `/w/${offerProject.workspaceId}/anfragen/${offerProject.projectId}`;

    await page.goto(path);
    await loginWithRealOtp(page, offerProject.editorEmail, path);
    await ensureSelfDrawnSource(page);
    await drawRectangleOnRoofMap(page);
    const section = page.getByTestId("planning-roofs-section");
    await section.getByTestId("roof-save").click();
    await expect(section.getByText("Dach gespeichert.", { exact: true })).toBeVisible();

    // Planungsmodus auf Angebotsebene auf Quick stellen (F3-01-Vertrag):
    // Dach-Sektion bleibt gespeichert, wird aber ausgeblendet.
    // Das Seed-Projekt hat noch kein Angebot — über das Projektformular
    // anlegen (M2-01-Muster), landet direkt auf der Angebotsseite.
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
    await expect(page.getByTestId("planning-roofs-section")).toHaveCount(0);
    await expect(page.getByText(
      "Quick verwaltet Komponenten und Preise; Dach-, Ertrags- und Simulationsausgaben bleiben ausgeblendet.",
      { exact: true },
    )).toBeVisible();

    // Zurueck zu 3D: gespeichertes Dach wieder sichtbar, keine Daten geloescht.
    await page.getByRole("radio", { name: "3D-Planung", exact: true }).check();
    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect(page.getByTestId("planning-roofs-section")).toBeVisible();

    expect(errors, "Browser-Konsole und Page-Errors der Quick-Ausblendung").toEqual([]);
  });

  test("F303-E2E-04: Viewer liest, External fail-closed", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    const section = page.getByTestId("planning-roofs-section");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("roof-draw-start")).toBeDisabled();
    await expect(section.getByTestId("roof-save")).toHaveCount(0);

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    // Fail-closed: External sieht die Projektseite, aber keine der beiden
    // Planungssektionen (Panels + Services + Offer-Loader verweigern).
    await expect(page.getByTestId("planning-sources-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-roofs-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
  });
});
