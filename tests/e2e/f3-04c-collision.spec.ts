import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F3-04c Belegung-vs-Sperrzonen-Kollision (Stufe-0) — Chromium-E2E (TDD RED, Anker).
 *
 * vertrag: docs/spec/F3-04c-collision.md
 * - Editor legt per UI eine Schornstein-Sperrzone (F3-03b-Testids
 *   planning-roof-restrictions-…) + eine Panelgruppe 2x3 darüber an
 *   (F3-04a-Testids planning-panel-groups-…): Der Kollisions-Warnbadge
 *   ist in der Gruppen-Zeile UND in der Sperrzonen-Zeile sichtbar
 *   (advisory-only, kein Reject — Anlegen gelingt beidseitig).
 *   Zwei Abwahlen in der Gruppe (F3-04b-Testids
 *   planning-panel-deselect-*) senken den Effektiv-Count, der Badge
 *   bleibt (Rechteck-Ebene) und zeigt den Deselect-Hinweis. Eine
 *   zweite, saubere Gruppe auf demselben Dach bekommt keinen Badge.
 * - Viewer sieht die Badges read-only (kein Formular, kein Anlegen,
 *   kein Löschen). External bleibt fail-closed (Sektionen unsichtbar).
 *
 * Die UI existiert NOCH NICHT — diese Spec ist Anker-RED und
 * scheitert, bis UI-GREEN die Anker baut.
 *
 * VERBINDLICHE Testids (UI-GREEN baut dieselben):
 * - [data-testid="planning-panel-collision-badge"] (je Zeile einmal:
 *   in der Gruppen-Zeile UND in der Sperrzonen-Zeile; im Zeilen-Scope
 *   adressieren — Text enthält „überlappt" + Gegenüber-Label)
 * - [data-testid="planning-panel-collision-hint"] (Deselect-Hinweis in
 *   der Gruppen-Zeile, sobald Zellen abgewählt sind — Text enthält
 *   „abgewählt"; Badge bleibt daneben sichtbar)
 * - Sonst nur bestehende Slots (F3-03b/F3-04a/F3-04b); keine neuen.
 *
 * Fixture-Hinweis: Wie F3-05d legt das Setup je Test eigene Dächer
 * (Meter-Rechteck 20x12 per DB-Rescale) an; Labels je Test eindeutig,
 * serieller Modus, ein Projekt. Die Sperrzone (0.6x0.6) liegt mittig
 * im künftigen Gruppen-Rechteck (Schnitt > 0, garantiert innen), die
 * saubere Gruppe in der Dach-Ecke (kein Schnitt). Raster 2x3.
 * Die Count-Assertion ist relativ (vorher − 2), weil sich alle
 * E2E-Dateien ein Projekt teilen.
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

const METER_ROOF_POLYGON: RoofPoint[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 12 },
  { x: 0, y: 12 },
];

const GROUP_ROWS = 2;
const GROUP_COLS = 3;
const MODULE_W_M = 1;
const MODULE_H_M = 1.7;
const GAP_M = 0.02;

const RESTRICTION_SIZE_M = 0.6;

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
    throw new Error("Der private F3.4c-E2E-State ist unvollständig.");
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

async function rescaleNewestRoofToMeters(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
      [data.workspaceId],
    );
    const result = await client.query(
      `update planning_roof_min set polygon_json = $2::jsonb
       where id = (
         select id from planning_roof_min
         where workspace_id = $1::uuid
         order by created_at desc, id desc limit 1
       )`,
      [data.workspaceId, JSON.stringify(METER_ROOF_POLYGON)],
    );
    await client.query("commit");
    expect(result.rowCount, "Genau ein Dach wird auf Meter-Skala umgestellt.").toBe(1);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function ensureMeterScaleRoof(page: Page): Promise<void> {
  await ensureSavedRoof(page);
  await rescaleNewestRoofToMeters();
  await page.reload();
  const polygon = await readRoofPolygon(page);
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6);
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 6);
}

function groupSize(): { width: number; height: number } {
  return {
    width: GROUP_COLS * MODULE_W_M + (GROUP_COLS - 1) * GAP_M,
    height: GROUP_ROWS * MODULE_H_M + (GROUP_ROWS - 1) * GAP_M,
  };
}

// Gruppen-Rechteck (Contract: cols*moduleW + Gaps, rows*moduleH +
// Gaps), zentriert im Dach-Bbox: garantiert innen bei Rechteck-Dach.
function groupGeometry(polygon: RoofPoint[]): { originX: string; originY: string } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const { width, height } = groupSize();
  return {
    originX: String((minX + maxX) / 2 - width / 2),
    originY: String((minY + maxY) / 2 - height / 2),
  };
}

// Sperrzone mittig im künftigen Gruppen-Rechteck: garantiert
// Schnitt > 0 und garantiert innen (Gruppe liegt mit Abstand im Dach).
function overlappingRestriction(polygon: RoofPoint[]): {
  x: string;
  y: string;
  width: string;
  height: string;
} {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const { width, height } = groupSize();
  const originX = (minX + maxX) / 2 - width / 2;
  const originY = (minY + maxY) / 2 - height / 2;
  return {
    x: String(originX + width / 2 - RESTRICTION_SIZE_M / 2),
    y: String(originY + height / 2 - RESTRICTION_SIZE_M / 2),
    width: String(RESTRICTION_SIZE_M),
    height: String(RESTRICTION_SIZE_M),
  };
}

// Saubere Gruppe in der Dach-Ecke: garantiert kein Schnitt mit der
// mittigen Sperrzone, garantiert innen.
function cleanGroupOrigin(polygon: RoofPoint[]): { originX: string; originY: string } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  return {
    originX: String(Math.min(...xs) + 0.5),
    originY: String(Math.min(...ys) + 0.5),
  };
}

async function fillPanelGroupForm(
  page: Page,
  values: { kind: string; label: string; originX: string; originY: string },
): Promise<void> {
  const section = page.getByTestId("planning-panel-groups-section");
  await expect(section.getByTestId("planning-panel-groups-form")).toBeVisible();
  await section.getByTestId("planning-panel-groups-kind").selectOption(values.kind);
  await section.getByTestId("planning-panel-groups-label").fill(values.label);
  await section.getByTestId("planning-panel-groups-rows").fill(String(GROUP_ROWS));
  await section.getByTestId("planning-panel-groups-cols").fill(String(GROUP_COLS));
  await section.getByLabel("Ursprung X (m)").fill(values.originX);
  await section.getByLabel("Ursprung Y (m)").fill(values.originY);
  await section.getByLabel("Modulbreite (m)").fill(String(MODULE_W_M));
  await section.getByLabel("Modulhöhe (m)").fill(String(MODULE_H_M));
  await section.getByLabel("Lücke (m)").fill(String(GAP_M));
}

// Gruppe auf dem AKTUELLEN Dach (kein neues Dach — Kollision und
// saubere Vergleichsgruppe brauchen dasselbe Dach).
async function createPanelGroupOnCurrentRoof(
  page: Page,
  label: string,
  kind: string,
  origin: { originX: string; originY: string },
): Promise<void> {
  const section = page.getByTestId("planning-panel-groups-section");
  await expect(section).toBeVisible();
  await fillPanelGroupForm(page, { kind, label, ...origin });
  await section.getByTestId("planning-panel-groups-create").click();
  await expect(section.getByText("Panel-Gruppe gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-panel-groups-list").getByText(label),
  ).toBeVisible();
}

async function fillRestrictionForm(
  page: Page,
  values: { kind: string; label: string; x: string; y: string; width: string; height: string },
): Promise<void> {
  const section = page.getByTestId("planning-roof-restrictions-section");
  await expect(section).toBeVisible();
  await section.getByLabel("Art").selectOption(values.kind);
  await section.getByLabel("Bezeichnung").fill(values.label);
  await section.getByLabel("X (m)").fill(values.x);
  await section.getByLabel("Y (m)").fill(values.y);
  await section.getByLabel("Breite (m)").fill(values.width);
  await section.getByLabel("Höhe (m)").fill(values.height);
}

async function createRestriction(
  page: Page,
  values: { kind: string; label: string; x: string; y: string; width: string; height: string },
): Promise<void> {
  const section = page.getByTestId("planning-roof-restrictions-section");
  await fillRestrictionForm(page, values);
  await section.getByTestId("planning-roof-restrictions-save").click();
  await expect(section.getByText("Sperrzone gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-roof-restrictions-item").filter({ hasText: values.label }),
  ).toBeVisible();
}

type DeselectValues = {
  groupLabel: string;
  row: number;
  col: number;
  reason?: string;
};

async function fillDeselectForm(page: Page, values: DeselectValues): Promise<void> {
  const form = page
    .getByTestId("planning-panel-deselect-section")
    .getByTestId("planning-panel-deselect-form");
  await expect(form).toBeVisible();
  await form
    .getByTestId("planning-panel-deselect-group")
    .selectOption({ label: values.groupLabel });
  await form.getByTestId("planning-panel-deselect-row").fill(String(values.row));
  await form.getByTestId("planning-panel-deselect-col").fill(String(values.col));
  if (values.reason !== undefined) {
    await form.getByTestId("planning-panel-deselect-reason").fill(values.reason);
  }
}

async function deselectCell(page: Page, values: DeselectValues): Promise<void> {
  const section = page.getByTestId("planning-panel-deselect-section");
  await fillDeselectForm(page, values);
  await section.getByTestId("planning-panel-deselect-create").click();
  await expect(section.getByText("Abwahl gespeichert.", { exact: true })).toBeVisible();
  await expect(section.getByTestId("planning-panel-deselect-empty")).toHaveCount(0);
}

async function readDeselectCount(page: Page): Promise<number> {
  const text = await page
    .getByTestId("planning-panel-deselect-section")
    .getByTestId("planning-panel-deselect-count")
    .textContent();
  const match = /(\d+)/u.exec(text ?? "");
  if (!match) throw new Error("Der Abwahl-Count enthält keine Zahl.");
  return Number(match[1]);
}

// Gruppen-Zeile im Zeilen-Scope (Tag-agnostisch: direkte
// Listenkinder mit dem Gruppen-Label).
function groupRow(page: Page, label: string) {
  return page
    .getByTestId("planning-panel-groups-list")
    .locator(":scope > *")
    .filter({ hasText: label });
}

function restrictionRow(page: Page, label: string) {
  return page
    .getByTestId("planning-roof-restrictions-section")
    .getByTestId("planning-roof-restrictions-item")
    .filter({ hasText: label });
}

test.describe("F3-04c Belegung-vs-Sperrzonen-Kollision — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test("F304c-E2E-01: Editor Sperrzone + Gruppe darüber → Badge beidseitig → 2 Abwahlen → Count sinkt, Badge + Hinweis bleiben → saubere Gruppe ohne Badge", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);

    await ensureMeterScaleRoof(page);
    const polygon = await readRoofPolygon(page);
    const collisionOrigin = groupGeometry(polygon);
    const zone = overlappingRestriction(polygon);

    // Sperrzone zuerst, Gruppe darüber — beidseitig zulässig
    // (advisory-only, kein Reject).
    await createRestriction(page, { kind: "chimney", label: "Koll-Zone", ...zone });
    await createPanelGroupOnCurrentRoof(page, "Koll-G1", "h", collisionOrigin);

    // Warnbadge in der Gruppen-Zeile UND in der Sperrzonen-Zeile.
    const collidedGroup = groupRow(page, "Koll-G1");
    await expect(collidedGroup).toHaveCount(1);
    await expect(
      collidedGroup.getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();
    await expect(
      collidedGroup.getByTestId("planning-panel-collision-badge"),
    ).toContainText(/berlappt/iu);
    await expect(
      collidedGroup.getByTestId("planning-panel-collision-badge"),
    ).toContainText("Koll-Zone");
    const collidedZone = restrictionRow(page, "Koll-Zone");
    await expect(collidedZone).toHaveCount(1);
    await expect(
      collidedZone.getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();
    await expect(
      collidedZone.getByTestId("planning-panel-collision-badge"),
    ).toContainText(/berlappt/iu);
    await expect(
      collidedZone.getByTestId("planning-panel-collision-badge"),
    ).toContainText("Koll-G1");

    // 2 Abwahlen in der Mittelspalte (unter der Zone): Count sinkt.
    const countBefore = await readDeselectCount(page);
    await deselectCell(page, { groupLabel: "Koll-G1", row: 1, col: 2 });
    await deselectCell(page, { groupLabel: "Koll-G1", row: 2, col: 2 });
    await expect(
      page
        .getByTestId("planning-panel-deselect-section")
        .getByTestId("planning-panel-deselect-count"),
    ).toContainText(String(countBefore - 2));

    // Persistenz über Reload: Badge bleibt (Rechteck-Ebene), Hinweis
    // auf die Abwahlen erscheint in der Gruppen-Zeile.
    await page.reload();
    const reloadedGroup = groupRow(page, "Koll-G1");
    await expect(
      reloadedGroup.getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();
    await expect(
      reloadedGroup.getByTestId("planning-panel-collision-hint"),
    ).toBeVisible();
    await expect(
      reloadedGroup.getByTestId("planning-panel-collision-hint"),
    ).toContainText(/abgewählt/iu);
    await expect(
      restrictionRow(page, "Koll-Zone").getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();

    // Zweite, saubere Gruppe auf demselben Dach: kein Badge dort,
    // Kollisions-Badge der ersten Gruppe unberührt.
    await createPanelGroupOnCurrentRoof(page, "Koll-G2", "h", cleanGroupOrigin(polygon));
    const cleanGroup = groupRow(page, "Koll-G2");
    await expect(cleanGroup).toHaveCount(1);
    await expect(
      cleanGroup.getByTestId("planning-panel-collision-badge"),
    ).toHaveCount(0);
    await expect(
      cleanGroup.getByTestId("planning-panel-collision-hint"),
    ).toHaveCount(0);
    await expect(
      groupRow(page, "Koll-G1").getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();

    await expectNoWcagAaAxeViolations(page, "F3.4c Kollisions-Warnung");
    expect(errors, "Browser-Konsole und Page-Errors des Kollisions-Flows").toEqual([]);
  });

  test("F304c-E2E-02: Viewer sieht Kollisions-Badges read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await ensureMeterScaleRoof(page);
    const polygon = await readRoofPolygon(page);
    await createRestriction(page, {
      kind: "chimney",
      label: "KollViewer-Zone",
      ...overlappingRestriction(polygon),
    });
    await createPanelGroupOnCurrentRoof(page, "KollViewer-G1", "h", groupGeometry(polygon));
    await expect(
      groupRow(page, "KollViewer-G1").getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    await expect(
      groupRow(page, "KollViewer-G1").getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();
    await expect(
      groupRow(page, "KollViewer-G1").getByTestId("planning-panel-collision-badge"),
    ).toContainText("KollViewer-Zone");
    await expect(
      restrictionRow(page, "KollViewer-Zone").getByTestId("planning-panel-collision-badge"),
    ).toBeVisible();
    await expect(
      page.getByTestId("planning-panel-groups-section").getByTestId("planning-panel-groups-form"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-panel-groups-section").getByTestId("planning-panel-groups-create"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-panel-groups-section").getByTestId("planning-panel-groups-delete"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-roof-restrictions-section").getByTestId("planning-roof-restrictions-save"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-roof-restrictions-section").getByTestId("planning-roof-restrictions-remove"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-panel-deselect-section").getByTestId("planning-panel-deselect-form"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-panel-deselect-section").getByTestId("planning-panel-deselect-create"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-panel-deselect-section").getByTestId("planning-panel-deselect-delete"),
    ).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Viewer-Sicht").toEqual([]);
  });

  test("F304c-E2E-03: External fail-closed (Sektionen + Badges unsichtbar)", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-panel-groups-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-roof-restrictions-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-panel-deselect-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-panel-collision-badge")).toHaveCount(0);
    await expect(page.getByTestId("planning-panel-collision-hint")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der External-Sicht").toEqual([]);
  });
});
