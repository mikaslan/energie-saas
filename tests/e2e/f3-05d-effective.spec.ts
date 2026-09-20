import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F3-05d Effektive String-Advisories (Stufe-0) — Chromium-E2E (TDD RED, Anker).
 *
 * vertrag: docs/spec/F3-05d-effective.md
 * - Editor legt per UI eine Panelgruppe 2x3 (F3-04a-Testids
 *   planning-panel-groups-*), einen WR mit Advisory-Max-Länge 5
 *   (F3-05a-Testids planning-inverters-…; die Max-Länge setzt das
 *   Setup per DB, weil das WR-Formular kein Max-Feld hat — analog
 *   zum DB-Rescale der Dächer) + einen String (F3-05a-Testids
 *   planning-strings-…) an, legt die volle Range an (Zeilen 1–2 x
 *   Spalten 1–3 = 6 Zellen, F3-05c-Testids
 *   planning-string-members-*) — die `over-length`-Advisory ist
 *   sichtbar (6 > 5). Zwei Abwahlen in der Range (F3-04b-Testids
 *   planning-panel-deselect-*) senken den Effektiv-Count („4 von
 *   6"), die `over-length`-Advisory verschwindet (4 ≤ 5). Ein
 *   Mikro-WR auf einer abgewählten Zelle (F3-05b-Testids
 *   planning-string-equipment-*) wird gespeichert (Warnung statt
 *   Reject) und zeigt die `equipment-on-deselected`-Advisory.
 * - Viewer liest Effektiv-Counts read-only (kein Formular, kein
 *   Anlegen, kein Löschen). External bleibt fail-closed (Sektionen
 *   unsichtbar).
 *
 * Die UI existiert NOCH NICHT — diese Spec ist Anker-RED und
 * scheitert, bis GREEN die Anker baut.
 *
 * VERBINDLICHE Testids (GREEN baut dieselben):
 * - NEU: [data-testid="planning-string-members-effective"]
 *   (Count-Zeile „X von Y" = effektive Module von Roh-Modulen,
 *   z. B. "4 von 6"; je String-Member-Sektion einmal, auch Viewer)
 * - Sonst nur bestehende Slots: [data-testid="planning-strings-advisory"]
 *   für `over-length` (Text enthält „Laenge" wie bisher) und für
 *   `equipment-on-deselected` (Text enthält „abgewählt"); keine
 *   neuen Advisory-Testids.
 *
 * Fixture-Hinweis: Wie F3-05c legt das Setup je Test eigene
 * Dächer (Meter-Rechteck 20x12 per DB-Rescale) + eigene Gruppen
 * an; Labels je Test eindeutig, serieller Modus, ein Projekt.
 * Raster 2x3 = 6 Module je Gruppe, WR-Max-Länge 5, volle Range =
 * 6 Zellen, Effektiv-Count 6→4 nach 2 Abwahlen in der Range.
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

const INVERTER_MAX_MODULES = 5;

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
    throw new Error("Der private F3.5d-E2E-State ist unvollständig.");
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

// Fixture: Das WR-Formular kennt kein Max-Feld (F3-05a), daher setzt
// das Setup max_string_modules per DB — analog zum Dach-Rescale.
// Serieller Modus: Die neueste WR-Zeile gehört diesem Test.
async function setNewestInverterMaxModules(max: number): Promise<void> {
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
      `update planning_inverter set max_string_modules = $2
       where id = (
         select id from planning_inverter
         where workspace_id = $1::uuid
         order by created_at desc, id desc limit 1
       )`,
      [data.workspaceId, String(max)],
    );
    await client.query("commit");
    expect(result.rowCount, "Genau ein WR bekommt die Advisory-Max-Länge.").toBe(1);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function fillStringForm(
  page: Page,
  values: { inverterLabel: string; slot: number; stringLabel: string; groupLabels: string[] },
): Promise<void> {
  const form = page
    .getByTestId("planning-strings-section")
    .getByTestId("planning-strings-form");
  await expect(form).toBeVisible();
  await form.getByLabel("Wechselrichter").selectOption({ label: values.inverterLabel });
  await form.getByLabel("Tracker-Slot").fill(String(values.slot));
  await form.getByLabel("String-Label").fill(values.stringLabel);
  for (const groupLabel of values.groupLabels) {
    await form.getByRole("checkbox", { name: groupLabel, exact: true }).check();
  }
}

async function createString(
  page: Page,
  values: { inverterLabel: string; slot: number; stringLabel: string; groupLabels: string[] },
): Promise<void> {
  const section = page.getByTestId("planning-strings-section");
  await fillStringForm(page, values);
  await section.getByTestId("planning-strings-create").click();
  await expect(section.getByText("String gespeichert.", { exact: true })).toBeVisible();
  await expect(
    section.getByTestId("planning-strings-list").getByText(values.stringLabel),
  ).toBeVisible();
  await expect(section.getByTestId("planning-strings-empty")).toHaveCount(0);
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

// Member-Sektion je String, per String-Label adressiert (robust gegen
// Strings frueherer Spec-Dateien im Full-Suite-Lauf; nth-Index waere
// positionsabhaengig).
function memberSection(page: Page, stringLabel: string) {
  return page.getByTestId("planning-string-members-section").filter({
    has: page.getByRole("heading", { name: `String-Member: ${stringLabel}`, exact: true }),
  });
}

type MemberValues = {
  groupLabel: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
};

async function fillMemberForm(page: Page, stringLabel: string, values: MemberValues): Promise<void> {
  const form = memberSection(page, stringLabel).getByTestId("planning-string-members-form");
  await expect(form).toBeVisible();
  await form
    .getByTestId("planning-string-members-group")
    .selectOption({ label: values.groupLabel });
  await form.getByTestId("planning-string-members-row-from").fill(String(values.rowFrom));
  await form.getByTestId("planning-string-members-row-to").fill(String(values.rowTo));
  await form.getByTestId("planning-string-members-col-from").fill(String(values.colFrom));
  await form.getByTestId("planning-string-members-col-to").fill(String(values.colTo));
}

async function createMember(page: Page, stringLabel: string, values: MemberValues): Promise<void> {
  const section = memberSection(page, stringLabel);
  await fillMemberForm(page, stringLabel, values);
  await section.getByTestId("planning-string-members-create").click();
  await expect(section.getByText("Member gespeichert.", { exact: true })).toBeVisible();
  await expect(section.getByTestId("planning-string-members-empty")).toHaveCount(0);
}

type EquipmentValues = {
  stringLabel: string;
  scope: "string" | "panel";
  equipment: "optimizer" | "micro_inverter";
  groupLabel?: string;
  row?: number;
  col?: number;
};

async function attachEquipment(page: Page, values: EquipmentValues): Promise<void> {
  const section = page.getByTestId("planning-string-equipment-section");
  const form = section.getByTestId("planning-string-equipment-form");
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
  await section.getByTestId("planning-string-equipment-create").click();
  await expect(section.getByText("Equipment gespeichert.", { exact: true })).toBeVisible();
  await expect(section.getByTestId("planning-string-equipment-empty")).toHaveCount(0);
}

test.describe("F3-05d Effektive String-Advisories — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test("F305d-E2E-01: Editor volle Range → over-length sichtbar → 2 Abwahlen → Count „4 von 6\", over-length weg → Mikro auf Abwahl → Advisory", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);

    await createPanelGroup(page, "Eff-G1", "h");
    await createInverter(page, "WR Eff", 2);
    await setNewestInverterMaxModules(INVERTER_MAX_MODULES);
    await page.reload();
    await createString(page, {
      inverterLabel: "WR Eff",
      slot: 1,
      stringLabel: "Eff-S1",
      groupLabels: ["Eff-G1"],
    });

    const section = memberSection(page, "Eff-S1");
    await expect(section).toBeVisible();

    // Volle Range 2x3 = 6 Zellen > Max 5 → over-length sichtbar.
    await createMember(page, "Eff-S1", {
      groupLabel: "Eff-G1",
      rowFrom: 1,
      rowTo: 2,
      colFrom: 1,
      colTo: 3,
    });
    await expect(
      section.getByTestId("planning-string-members-effective"),
    ).toContainText("6 von 6");
    const stringsSection = page.getByTestId("planning-strings-section");
    await expect(
      stringsSection.getByTestId("planning-strings-advisory").filter({ hasText: /Laenge/i }).first(),
    ).toBeVisible();

    // 2 Abwahlen in der Range → Count sinkt 6→4, over-length weg.
    await deselectCell(page, { groupLabel: "Eff-G1", row: 1, col: 1 });
    await deselectCell(page, { groupLabel: "Eff-G1", row: 1, col: 2 });
    await expect(
      section.getByTestId("planning-string-members-effective"),
    ).toContainText("4 von 6");

    // Persistenz über Reload; over-length bleibt verschwunden.
    await page.reload();
    const reloaded = memberSection(page, "Eff-S1");
    await expect(
      reloaded.getByTestId("planning-string-members-effective"),
    ).toContainText("4 von 6");
    await expect(
      page
        .getByTestId("planning-strings-section")
        .getByTestId("planning-strings-advisory")
        .filter({ hasText: /Laenge/i }),
    ).toHaveCount(0);

    // Mikro-WR auf abgewählter Zelle (1/1): gespeichert (Warnung
    // statt Reject) + equipment-on-deselected-Advisory sichtbar.
    await attachEquipment(page, {
      stringLabel: "Eff-S1",
      scope: "panel",
      equipment: "micro_inverter",
      groupLabel: "Eff-G1",
      row: 1,
      col: 1,
    });
    await page.reload();
    await expect(
      page
        .getByTestId("planning-strings-section")
        .getByTestId("planning-strings-advisory")
        .filter({ hasText: /abgewählt/i })
        .first(),
    ).toBeVisible();

    await expectNoWcagAaAxeViolations(page, "F3.5d Effektiv-Advisories");
    expect(errors, "Browser-Konsole und Page-Errors des Effektiv-Flows").toEqual([]);
  });

  test("F305d-E2E-02: Viewer sieht Effektiv-Counts read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await createPanelGroup(page, "EffViewer-G1", "h");
    await createInverter(page, "WR EffViewer", 2);
    await setNewestInverterMaxModules(INVERTER_MAX_MODULES);
    await page.reload();
    await createString(page, {
      inverterLabel: "WR EffViewer",
      slot: 1,
      stringLabel: "EffViewer-S1",
      groupLabels: ["EffViewer-G1"],
    });
    await createMember(page, "EffViewer-S1", {
      groupLabel: "EffViewer-G1",
      rowFrom: 1,
      rowTo: 2,
      colFrom: 1,
      colTo: 3,
    });
    await deselectCell(page, { groupLabel: "EffViewer-G1", row: 2, col: 3 });

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    const viewerSection = memberSection(page, "EffViewer-S1");
    await expect(viewerSection).toBeVisible();
    await expect(
      viewerSection.getByTestId("planning-string-members-effective"),
    ).toContainText("5 von 6");
    // Effektiv 5 ≤ Max 5: keine over-length-Advisory.
    await expect(
      page
        .getByTestId("planning-strings-section")
        .getByTestId("planning-strings-advisory")
        .filter({ hasText: /Laenge/i }),
    ).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-members-form")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-members-create")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-members-delete")).toHaveCount(0);
    await expect(
      page.getByTestId("planning-strings-section").getByTestId("planning-strings-form"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("planning-string-equipment-section").getByTestId("planning-string-equipment-form"),
    ).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Viewer-Sicht").toEqual([]);
  });

  test("F305d-E2E-03: External fail-closed (Sektionen unsichtbar)", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-string-members-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-string-members-effective")).toHaveCount(0);
    await expect(page.getByTestId("planning-strings-section")).toHaveCount(0);
    await expect(page.getByTestId("planning-string-equipment-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der External-Sicht").toEqual([]);
  });
});
