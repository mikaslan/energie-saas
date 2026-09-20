import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

/**
 * F3-03b Dach-Sperrzonen — Chromium-E2E (TDD RED).
 *
 * vertrag: docs/spec/F3-03b-sperrzonen.md
 * - Editor legt ein Rechteck an (Art + Bezeichnung + x/y/w/h + optionale
 *   Hoehe), sieht es in der Liste, laedt persistiert erneut, loescht es.
 * - Ungueltige Rechtecke (Breite 0) werden clientseitig rejected,
 *   Rechtecke ausserhalb des Dachpolygons serverseitig.
 * - Viewer liest, External bleibt fail-closed.
 *
 * Erwartete UI-Anker (Projekt-Seite, Dach-Sektion):
 * - [data-testid="planning-roof-restrictions-section"]
 * - [data-testid="planning-roof-restrictions-save"] /
 *   [data-testid="planning-roof-restrictions-item"] /
 *   [data-testid="planning-roof-restrictions-remove"]
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

type RoofPoint = { x: number; y: number };

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
    throw new Error("Der private F3.3b-E2E-State ist unvollständig.");
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

async function ensureSavedRoof(page: Page): Promise<void> {
  await ensureSelfDrawnSource(page);
  await drawRectangleOnRoofMap(page);
  const section = page.getByTestId("planning-roofs-section");
  await section.getByLabel("Neigung Kante 1 (°)").fill("30");
  await section.getByTestId("roof-save").click();
  await expect(section.getByText("Dach gespeichert.", { exact: true })).toBeVisible();
}

async function readRoofPolygon(page: Page): Promise<RoofPoint[]> {
  const raw = await page
    .getByTestId("planning-roofs-section")
    .locator('input[name="polygon"]')
    .inputValue();
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("Das gespeicherte Dachpolygon ist leer.");
  }
  return parsed as RoofPoint[];
}

// Konvexes Viereck (Karten-Rechteck): kleines Rechteck um den
// Bbox-Mittelpunkt liegt garantiert innen (Ecken-Test, Kante = drin).
function insideRect(polygon: RoofPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = (maxX - minX) / 8;
  const height = (maxY - minY) / 8;
  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height,
  };
}

function outsideRect(polygon: RoofPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return { x: Math.max(...xs) + width, y: Math.max(...ys) + height, width, height };
}

async function fillRestrictionForm(
  page: Page,
  values: { kind: string; label: string; x: string; y: string; width: string; height: string; heightM?: string },
): Promise<void> {
  const section = page.getByTestId("planning-roof-restrictions-section");
  await section.getByLabel("Art").selectOption(values.kind);
  await section.getByLabel("Bezeichnung").fill(values.label);
  await section.getByLabel("X (m)").fill(values.x);
  await section.getByLabel("Y (m)").fill(values.y);
  await section.getByLabel("Breite (m)").fill(values.width);
  await section.getByLabel("Höhe (m)").fill(values.height);
  if (values.heightM !== undefined) {
    await section.getByLabel("Höhe über Dach (m, optional)").fill(values.heightM);
  }
}

test.describe("F3-03b Dach-Sperrzonen — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test("F303b-E2E-01: Rechteck anlegen → Liste → laden → löschen", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureSavedRoof(page);
    await page.reload();

    const polygon = await readRoofPolygon(page);
    const rect = insideRect(polygon);
    const section = page.getByTestId("planning-roof-restrictions-section");
    await expect(section).toBeVisible();
    await fillRestrictionForm(page, {
      kind: "chimney",
      label: "Kamin Nord",
      x: String(rect.x),
      y: String(rect.y),
      width: String(rect.width),
      height: String(rect.height),
      heightM: "1.5",
    });
    await section.getByTestId("planning-roof-restrictions-save").click();
    await expect(section.getByText("Sperrzone gespeichert.", { exact: true })).toBeVisible();
    await expect(section.getByTestId("planning-roof-restrictions-item")).toHaveCount(1);
    await expect(
      section.getByTestId("planning-roof-restrictions-item").getByText("Kamin Nord"),
    ).toBeVisible();

    await page.reload();
    const reloaded = page.getByTestId("planning-roof-restrictions-section");
    await expect(reloaded.getByTestId("planning-roof-restrictions-item")).toHaveCount(1);

    await reloaded.getByTestId("planning-roof-restrictions-remove").click();
    await expect(reloaded.getByText("Sperrzone gelöscht.", { exact: true })).toBeVisible();
    await expect(reloaded.getByTestId("planning-roof-restrictions-item")).toHaveCount(0);

    await expectNoWcagAaAxeViolations(page, "F3.3b Sperrzonen-Sektion");
    expect(errors, "Browser-Konsole und Page-Errors des Sperrzonen-Flows").toEqual([]);
  });

  test("F303b-E2E-02: Rechteck-Rejects (Breite 0, ausserhalb)", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureSavedRoof(page);
    await page.reload();

    const polygon = await readRoofPolygon(page);
    const rect = insideRect(polygon);
    const section = page.getByTestId("planning-roof-restrictions-section");
    await expect(section).toBeVisible();

    await fillRestrictionForm(page, {
      kind: "window",
      label: "Nullbreite",
      x: String(rect.x),
      y: String(rect.y),
      width: "0",
      height: String(rect.height),
    });
    await section.getByTestId("planning-roof-restrictions-save").click();
    await expect(section.getByText(/Breite\/Höhe > 0/u)).toBeVisible();
    await expect(section.getByText("Sperrzone gespeichert.", { exact: true })).toHaveCount(0);

    const outside = outsideRect(polygon);
    await fillRestrictionForm(page, {
      kind: "other",
      label: "Draußen",
      x: String(outside.x),
      y: String(outside.y),
      width: String(outside.width),
      height: String(outside.height),
    });
    await section.getByTestId("planning-roof-restrictions-save").click();
    await expect(
      section.getByText("Das Rechteck liegt außerhalb des Dachpolygons.", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Sperrzone gespeichert.", { exact: true })).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Sperrzonen-Validierung").toEqual([]);
  });

  test("F303b-E2E-03: Viewer liest, External fail-closed", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureSavedRoof(page);
    await page.reload();
    const polygon = await readRoofPolygon(page);
    const rect = insideRect(polygon);
    await fillRestrictionForm(page, {
      kind: "chimney",
      label: "Viewer-Sicht",
      x: String(rect.x),
      y: String(rect.y),
      width: String(rect.width),
      height: String(rect.height),
    });
    const editorSection = page.getByTestId("planning-roof-restrictions-section");
    await editorSection.getByTestId("planning-roof-restrictions-save").click();
    await expect(editorSection.getByText("Sperrzone gespeichert.", { exact: true })).toBeVisible();

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    const viewerSection = page.getByTestId("planning-roof-restrictions-section");
    await expect(viewerSection).toBeVisible();
    await expect(
      viewerSection.getByTestId("planning-roof-restrictions-item").getByText("Viewer-Sicht"),
    ).toBeVisible();
    await expect(viewerSection.getByTestId("planning-roof-restrictions-save")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-roof-restrictions-remove")).toHaveCount(0);

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-roof-restrictions-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
  });
});
