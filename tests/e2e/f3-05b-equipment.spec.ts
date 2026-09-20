import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F3-05b String-Equipment (Stufe-0) — Chromium-E2E (TDD RED, Anker).
 *
 * vertrag: docs/spec/F3-05b-equipment.md
 * - Editor legt einen WR + einen String per UI an (F3-05a-Testids),
 *   hängt einen Optimierer (scope string) an, scheitert mit dem
 *   2. Optimierer (ValidationError, kein zweiter Eintrag), hängt
 *   Mikro-WR an 2 Panels an, scheitert mit Doppelbelegung
 *   desselben Panels (hart, kein neuer Eintrag), sieht die
 *   Advisory-Warnung (Teilabdeckung), löscht das Equipment
 *   (Liste danach leer).
 * - Viewer liest Equipment read-only (kein Formular, kein
 *   Anlegen, kein Löschen). External bleibt fail-closed (Sektion
 *   unsichtbar).
 *
 * Die UI existiert NOCH NICHT — diese Spec ist Anker-RED und
 * scheitert, bis GREEN die Anker baut.
 *
 * VERBINDLICHE Testids (GREEN baut dieselben):
 * - [data-testid="planning-string-equipment-section"]
 * - [data-testid="planning-string-equipment-list"] /
 *   [data-testid="planning-string-equipment-empty"]
 * - [data-testid="planning-string-equipment-form"] (nur Editor)
 * - [data-testid="planning-string-equipment-create"] /
 *   [data-testid="planning-string-equipment-delete"] (je Listeneintrag)
 * - [data-testid="planning-string-equipment-advisory"] (Text enthält
 *   "Teil" bei Mikro-Teilabdeckung; Warnung, nie Reject)
 * - Formular-Controls (innerhalb der Form):
 *   [data-testid="planning-string-equipment-scope"] (<select>,
 *   Werte "string"|"panel"),
 *   [data-testid="planning-string-equipment-equipment"] (<select>,
 *   Werte "optimizer"|"micro_inverter"),
 *   [data-testid="planning-string-equipment-group"] (<select>,
 *   Optionen = Gruppen-Labels des Strings, nur scope=panel),
 *   [data-testid="planning-string-equipment-row"] (Zahl ≥1,
 *   nur scope=panel),
 *   [data-testid="planning-string-equipment-col"] (Zahl ≥1,
 *   nur scope=panel)
 *
 * Equipment-Formular (Labels, von GREEN als <label> verdrahtet):
 * - "String" (<select>, Optionen = String-Labels)
 * - Listeneinträge zeigen Typ ("Optimierer"/"Mikro-WR") + String-Label;
 *   Panel-Einträge zusätzlich Gruppe + Zeile/Spalte.
 * - Fehlschlag: [role="alert"] im Equipment-Formular sichtbar,
 *   kein neuer Listeneintrag.
 *
 * Meldungen: "Equipment gespeichert." / "Equipment gelöscht."
 *
 * Fixture-Hinweis: Wie F3-05a legt das Setup je Test eigene Dächer
 * (Meter-Rechteck 20x12 per DB-Rescale) + eigene Gruppen an; Labels
 * je Test eindeutig, serieller Modus, ein Projekt. Beide Gruppen
 * je Test sind "h" (kein H/V-Mix), damit die String-Advisory die
 * Equipment-Advisory nicht überlagert.
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

const GROUP_ROWS = 4;
const GROUP_COLS = 6;
const MODULE_W_M = 1;
const MODULE_H_M = 1.7;
const GAP_M = 0.02;

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
    throw new Error("Der private F3.5b-E2E-State ist unvollständig.");
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

// Gruppen-Rechteck (Contract: cols*moduleW + Gaps, rows*moduleH +
// Gaps), zentriert im Dach-Bbox: garantiert innen bei Rechteck-Dach.
function groupGeometry(polygon: RoofPoint[]): { originX: string; originY: string } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = GROUP_COLS * MODULE_W_M + (GROUP_COLS - 1) * GAP_M;
  const height = GROUP_ROWS * MODULE_H_M + (GROUP_ROWS - 1) * GAP_M;
  return {
    originX: String((minX + maxX) / 2 - width / 2),
    originY: String((minY + maxY) / 2 - height / 2),
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

// Setzt eingeloggten Editor auf der Projekt-Seite voraus; legt ein
// eigenes Dach + eine Gruppe an (Label je Test eindeutig wählen).
async function createPanelGroup(page: Page, label: string, kind: string): Promise<void> {
  await ensureMeterScaleRoof(page);
  const section = page.getByTestId("planning-panel-groups-section");
  await expect(section).toBeVisible();
  await fillPanelGroupForm(page, { kind, label, ...groupGeometry(await readRoofPolygon(page)) });
  await section.getByTestId("planning-panel-groups-create").click();
  await expect(section.getByText("Panel-Gruppe gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-panel-groups-list").getByText(label),
  ).toBeVisible();
}

async function createInverter(page: Page, label: string, trackers: number): Promise<void> {
  const section = page.getByTestId("planning-strings-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("planning-inverters-form")).toBeVisible();
  await section.getByTestId("planning-inverters-label").fill(label);
  await section.getByTestId("planning-inverters-trackers").fill(String(trackers));
  await section.getByTestId("planning-inverters-create").click();
  await expect(section.getByText("Wechselrichter gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-inverters-list").getByText(label),
  ).toBeVisible();
}

async function createString(
  page: Page,
  values: { inverterLabel: string; slot: number; stringLabel: string; groupLabels: string[] },
): Promise<void> {
  const section = page.getByTestId("planning-strings-section");
  const form = section.getByTestId("planning-strings-form");
  await expect(form).toBeVisible();
  await form.getByLabel("Wechselrichter").selectOption({ label: values.inverterLabel });
  await form.getByLabel("Tracker-Slot").fill(String(values.slot));
  await form.getByLabel("String-Label").fill(values.stringLabel);
  for (const groupLabel of values.groupLabels) {
    await form.getByRole("checkbox", { name: groupLabel, exact: true }).check();
  }
  await section.getByTestId("planning-strings-create").click();
  await expect(section.getByText("String gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-strings-list").getByText(values.stringLabel),
  ).toBeVisible();
}

type EquipmentValues = {
  stringLabel: string;
  scope: "string" | "panel";
  equipment: "optimizer" | "micro_inverter";
  groupLabel?: string;
  row?: number;
  col?: number;
};

async function fillEquipmentForm(page: Page, values: EquipmentValues): Promise<void> {
  const form = page
    .getByTestId("planning-string-equipment-section")
    .getByTestId("planning-string-equipment-form");
  await expect(form).toBeVisible();
  await form.getByTestId("planning-string-equipment-string").selectOption({ label: values.stringLabel });
  await form.getByTestId("planning-string-equipment-scope").selectOption(values.scope);
  await form.getByTestId("planning-string-equipment-equipment").selectOption(values.equipment);
  if (values.scope === "panel") {
    if (values.groupLabel === undefined || values.row === undefined || values.col === undefined) {
      throw new Error("Panel-Equipment braucht Gruppe + Zeile + Spalte.");
    }
    await form
      .getByTestId("planning-string-equipment-group")
      .selectOption({ label: values.groupLabel });
    await form.getByTestId("planning-string-equipment-row").fill(String(values.row));
    await form.getByTestId("planning-string-equipment-col").fill(String(values.col));
  }
}

async function attachEquipment(page: Page, values: EquipmentValues): Promise<void> {
  const section = page.getByTestId("planning-string-equipment-section");
  await fillEquipmentForm(page, values);
  await section.getByTestId("planning-string-equipment-create").click();
  await expect(section.getByText("Equipment gespeichert.", { exact: true })).toBeVisible();
  await expect(section.getByTestId("planning-string-equipment-empty")).toHaveCount(0);
}

test.describe("F3-05b String-Equipment — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test("F305b-E2E-01: Optimierer → 2. scheitert → Mikro an 2 Panels → Doppelbelegung scheitert → Advisory → löschen", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);

    await createPanelGroup(page, "Equip-G1", "h");
    await createPanelGroup(page, "Equip-G2", "h");
    await createInverter(page, "WR Equip", 2);
    await createString(page, {
      inverterLabel: "WR Equip",
      slot: 1,
      stringLabel: "Equip-String",
      groupLabels: ["Equip-G1", "Equip-G2"],
    });

    const section = page.getByTestId("planning-string-equipment-section");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("planning-string-equipment-empty")).toBeVisible();

    await attachEquipment(page, {
      stringLabel: "Equip-String",
      scope: "string",
      equipment: "optimizer",
    });
    await expect(
      section.getByTestId("planning-string-equipment-list").getByText("Optimierer"),
    ).toBeVisible();

    await fillEquipmentForm(page, {
      stringLabel: "Equip-String",
      scope: "string",
      equipment: "optimizer",
    });
    await section.getByTestId("planning-string-equipment-create").click();
    await expect(
      section.getByTestId("planning-string-equipment-form").getByRole("alert"),
    ).toBeVisible();
    await expect(section.getByTestId("planning-string-equipment-delete")).toHaveCount(1);

    await attachEquipment(page, {
      stringLabel: "Equip-String",
      scope: "panel",
      equipment: "micro_inverter",
      groupLabel: "Equip-G1",
      row: 1,
      col: 1,
    });
    await attachEquipment(page, {
      stringLabel: "Equip-String",
      scope: "panel",
      equipment: "micro_inverter",
      groupLabel: "Equip-G1",
      row: 1,
      col: 2,
    });
    await expect(section.getByTestId("planning-string-equipment-delete")).toHaveCount(3);

    await fillEquipmentForm(page, {
      stringLabel: "Equip-String",
      scope: "panel",
      equipment: "micro_inverter",
      groupLabel: "Equip-G1",
      row: 1,
      col: 1,
    });
    await section.getByTestId("planning-string-equipment-create").click();
    await expect(
      section.getByTestId("planning-string-equipment-form").getByRole("alert"),
    ).toBeVisible();
    await expect(section.getByTestId("planning-string-equipment-delete")).toHaveCount(3);

    await expect(section.getByTestId("planning-string-equipment-advisory")).toBeVisible();
    await expect(section.getByTestId("planning-string-equipment-advisory")).toContainText(/Teil/i);

    await page.reload();
    const reloaded = page.getByTestId("planning-string-equipment-section");
    await expect(reloaded.getByTestId("planning-string-equipment-delete")).toHaveCount(3);
    await expect(reloaded.getByTestId("planning-string-equipment-advisory")).toBeVisible();

    while (await reloaded.getByTestId("planning-string-equipment-delete").count() > 0) {
      await reloaded.getByTestId("planning-string-equipment-delete").first().click();
      await expect(reloaded.getByText("Equipment gelöscht.", { exact: true })).toBeVisible();
    }
    await expect(reloaded.getByTestId("planning-string-equipment-empty")).toBeVisible();

    await expectNoWcagAaAxeViolations(page, "F3.5b Equipment-Sektion");
    expect(errors, "Browser-Konsole und Page-Errors des Equipment-Flows").toEqual([]);
  });

  test("F305b-E2E-02: Viewer liest Equipment read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await createPanelGroup(page, "EquipViewer-G1", "h");
    await createPanelGroup(page, "EquipViewer-G2", "h");
    await createInverter(page, "WR EquipViewer", 2);
    await createString(page, {
      inverterLabel: "WR EquipViewer",
      slot: 1,
      stringLabel: "EquipViewer-String",
      groupLabels: ["EquipViewer-G1", "EquipViewer-G2"],
    });
    await attachEquipment(page, {
      stringLabel: "EquipViewer-String",
      scope: "string",
      equipment: "optimizer",
    });

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    const viewerSection = page.getByTestId("planning-string-equipment-section");
    await expect(viewerSection).toBeVisible();
    await expect(
      viewerSection.getByTestId("planning-string-equipment-list").getByText("Optimierer"),
    ).toBeVisible();
    await expect(viewerSection.getByTestId("planning-string-equipment-form")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-equipment-create")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-equipment-delete")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Viewer-Sicht").toEqual([]);
  });

  test("F305b-E2E-03: External fail-closed (Sektion unsichtbar)", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-string-equipment-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der External-Sicht").toEqual([]);
  });
});
