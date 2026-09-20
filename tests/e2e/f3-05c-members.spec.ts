import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F3-05c String-Zell-Ranges (Stufe-0) — Chromium-E2E (TDD RED, Anker).
 *
 * vertrag: docs/spec/F3-05c-members.md
 * - Editor legt per UI eine Panelgruppe (F3-04a-Testids
 *   planning-panel-groups-*), einen WR + String (F3-05a-Testids
 *   planning-strings-…/planning-inverters-…) an, legt eine Range
 *   aus der Gruppen-Hälfte an (Zeilen 1–2 x Spalten 1–6 = 12
 *   Zellen), wählt eine Zelle in der Range ab (F3-04b-Testids
 *   planning-panel-deselect-*) — der Effektiv-Count sinkt
 *   (12→11). Eine Abwahl ausserhalb der Range ändert den Count
 *   nicht. Eine Voll-Deselect-Range (nur abgewählte Zellen)
 *   scheitert hart mit Fehler (kein neuer Eintrag), eine
 *   Zell-Doppelbelegung (gleiche Zelle in 2. String desselben
 *   WR) scheitert, eine Überlapp-Range im selben String
 *   scheitert; danach wird der Member gelöscht (Liste leer).
 * - Viewer liest Member read-only (kein Formular, kein Anlegen,
 *   kein Löschen). External bleibt fail-closed (Sektion
 *   unsichtbar).
 *
 * Die UI existiert NOCH NICHT — diese Spec ist Anker-RED und
 * scheitert, bis GREEN die Anker baut.
 *
 * VERBINDLICHE Testids (GREEN baut dieselben):
 * - [data-testid="planning-string-members-section"] (einmal je
 *   String, inline im String-Bereich; Reihenfolge =
 *   String-Listenreihenfolge — der Test adressiert Sektionen
 *   per nth-Index: 0 = erster String, 1 = zweiter String)
 * - [data-testid="planning-string-members-list"] /
 *   [data-testid="planning-string-members-empty"]
 * - [data-testid="planning-string-members-form"] (nur Editor)
 * - [data-testid="planning-string-members-create"] /
 *   [data-testid="planning-string-members-delete"] (je Listeneintrag)
 * - [data-testid="planning-string-members-count"] (Text enthält
 *   den Effektiv-Count = Zellen minus Deselect-Schnittmenge,
 *   z. B. "11")
 * - Formular-Controls (innerhalb der Form):
 *   [data-testid="planning-string-members-group"] (<select>,
 *   Optionen = Gruppen-Labels),
 *   [data-testid="planning-string-members-row-from"] /
 *   [data-testid="planning-string-members-row-to"] /
 *   [data-testid="planning-string-members-col-from"] /
 *   [data-testid="planning-string-members-col-to"] (Zahlen ≥1)
 *
 * - Die Member-Liste zeigt nur Tabellen-Member (kein
 *   member_json-Legacy-Eintrag); Listeneinträge zeigen Gruppe
 *   + Zeilen-/Spalten-Fenster.
 * - Fehlschlag (Voll-Deselect, Doppelbelegung, Überlapp):
 *   [role="alert"] im Member-Formular sichtbar, kein neuer
 *   Listeneintrag, Count unverändert.
 *
 * Meldungen: "Member gespeichert." / "Member entfernt."
 *
 * Fixture-Hinweis: Wie F3-05a legt das Setup je Test eigene
 * Dächer (Meter-Rechteck 20x12 per DB-Rescale) + eigene
 * Gruppen an; Labels je Test eindeutig, serieller Modus,
 * ein Projekt. Raster 4x6 = 24 Module je Gruppe, Member-Range
 * Zeilen 1–2 x Spalten 1–6 = 12 Zellen, Effektiv-Count
 * 12→11 nach 1 Abwahl in der Range.
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
    throw new Error("Der private F3.5c-E2E-State ist unvollständig.");
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

test.describe("F3-05c String-Member — Browser-Gate", () => {
  test.describe.configure({ mode: "serial" });

  test("F305c-E2E-01: Editor legt Range aus Gruppen-Hälfte an → Deselect senkt Count → Voll-Deselect/Doppelbelegung/Überlapp scheitern → löschen", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);

    await createPanelGroup(page, "Mem-G1", "h");
    await createInverter(page, "WR Mem", 2);
    await createString(page, {
      inverterLabel: "WR Mem",
      slot: 1,
      stringLabel: "Mem-S1",
      groupLabels: ["Mem-G1"],
    });

    const section = memberSection(page, "Mem-S1");
    await expect(section).toBeVisible();
    await expect(section.getByTestId("planning-string-members-empty")).toBeVisible();

    // Range aus Gruppen-Hälfte: Zeilen 1–2 x Spalten 1–6 = 12 Zellen.
    await createMember(page, "Mem-S1", {
      groupLabel: "Mem-G1",
      rowFrom: 1,
      rowTo: 2,
      colFrom: 1,
      colTo: 6,
    });
    await expect(section.getByTestId("planning-string-members-count")).toContainText("12");
    await expect(section.getByTestId("planning-string-members-delete")).toHaveCount(1);
    await expect(
      section.getByTestId("planning-string-members-list").getByText("Mem-G1"),
    ).toBeVisible();

    // Deselect-Zelle in Range → Count sinkt 12→11.
    await deselectCell(page, { groupLabel: "Mem-G1", row: 1, col: 1 });
    await expect(section.getByTestId("planning-string-members-count")).toContainText("11");

    // Deselect-Zelle ausserhalb der Range → Count bleibt 11.
    await deselectCell(page, { groupLabel: "Mem-G1", row: 4, col: 6 });
    await expect(section.getByTestId("planning-string-members-count")).toContainText("11");

    // Persistenz über Reload.
    await page.reload();
    const reloaded = memberSection(page, "Mem-S1");
    await expect(reloaded.getByTestId("planning-string-members-delete")).toHaveCount(1);
    await expect(reloaded.getByTestId("planning-string-members-count")).toContainText("11");

    // Voll-Deselect-Range (nur Zelle 4/6, abgewählt, keine
    // Überlappung) scheitert hart mit Fehler, kein neuer Eintrag.
    await fillMemberForm(page, "Mem-S1", {
      groupLabel: "Mem-G1",
      rowFrom: 4,
      rowTo: 4,
      colFrom: 6,
      colTo: 6,
    });
    await reloaded.getByTestId("planning-string-members-create").click();
    await expect(
      reloaded.getByTestId("planning-string-members-form").getByRole("alert"),
    ).toBeVisible();
    await expect(reloaded.getByTestId("planning-string-members-delete")).toHaveCount(1);
    await expect(reloaded.getByTestId("planning-string-members-count")).toContainText("11");

    // Zweiter String am selben WR (eigene Gruppe, kein
    // F3-05a-Gruppenkonflikt) für den Doppelbelegungs-Nachweis.
    await createPanelGroup(page, "Mem-G2", "h");
    await createString(page, {
      inverterLabel: "WR Mem",
      slot: 2,
      stringLabel: "Mem-S2",
      groupLabels: ["Mem-G2"],
    });
    const second = memberSection(page, "Mem-S2");
    await expect(second.getByTestId("planning-string-members-empty")).toBeVisible();

    // Doppelbelegung: Zelle (1/2) liegt in der Range von Mem-S1
    // (selber WR), ist nicht abgewählt → scheitert hart.
    await fillMemberForm(page, "Mem-S2", {
      groupLabel: "Mem-G1",
      rowFrom: 1,
      rowTo: 1,
      colFrom: 2,
      colTo: 2,
    });
    await second.getByTestId("planning-string-members-create").click();
    await expect(
      second.getByTestId("planning-string-members-form").getByRole("alert"),
    ).toBeVisible();
    await expect(second.getByTestId("planning-string-members-empty")).toBeVisible();
    await expect(second.getByTestId("planning-string-members-delete")).toHaveCount(0);
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-count"),
    ).toContainText("11");

    // Überlapp-Range im selben String (Zeilen 2–3 x Spalten 1–6
    // schneidet die Member-Range in Zeile 2, enthält nicht
    // abgewählte Zellen) scheitert mit Fehler.
    await fillMemberForm(page, "Mem-S1", {
      groupLabel: "Mem-G1",
      rowFrom: 2,
      rowTo: 3,
      colFrom: 1,
      colTo: 6,
    });
    await memberSection(page, "Mem-S1").getByTestId("planning-string-members-create").click();
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-form").getByRole("alert"),
    ).toBeVisible();
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-delete"),
    ).toHaveCount(1);
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-count"),
    ).toContainText("11");

    // Member löschen → Liste leer.
    await memberSection(page, "Mem-S1").getByTestId("planning-string-members-delete").click();
    await expect(
      memberSection(page, "Mem-S1").getByText("Member entfernt.", { exact: true }),
    ).toBeVisible();
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-empty"),
    ).toBeVisible();
    await expect(
      memberSection(page, "Mem-S1").getByTestId("planning-string-members-delete"),
    ).toHaveCount(0);

    await expectNoWcagAaAxeViolations(page, "F3.5c Member-Sektion");
    expect(errors, "Browser-Konsole und Page-Errors des Member-Flows").toEqual([]);
  });

  test("F305c-E2E-02: Viewer liest Member read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.editorEmail, path);
    await createPanelGroup(page, "MemViewer-G1", "h");
    await createInverter(page, "WR MemViewer", 2);
    await createString(page, {
      inverterLabel: "WR MemViewer",
      slot: 1,
      stringLabel: "MemViewer-S1",
      groupLabels: ["MemViewer-G1"],
    });
    await createMember(page, "MemViewer-S1", {
      groupLabel: "MemViewer-G1",
      rowFrom: 1,
      rowTo: 2,
      colFrom: 1,
      colTo: 6,
    });

    await page.context().clearCookies();
    await page.goto(path);
    await loginWithRealOtp(page, data.viewerEmail, path);
    const viewerSection = memberSection(page, "MemViewer-S1");
    await expect(viewerSection).toBeVisible();
    await expect(
      viewerSection.getByTestId("planning-string-members-list").getByText("MemViewer-G1"),
    ).toBeVisible();
    await expect(viewerSection.getByTestId("planning-string-members-count")).toContainText("12");
    await expect(viewerSection.getByTestId("planning-string-members-form")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-members-create")).toHaveCount(0);
    await expect(viewerSection.getByTestId("planning-string-members-delete")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der Viewer-Sicht").toEqual([]);
  });

  test("F305c-E2E-03: External fail-closed (Sektion unsichtbar)", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const errors = trackBrowserErrors(page);
    const path = projectPath();

    await page.goto(path);
    await loginWithRealOtp(page, data.externalEmail, path);
    await expect(page.getByTestId("planning-string-members-section")).toHaveCount(0);

    expect(errors, "Browser-Konsole und Page-Errors der External-Sicht").toEqual([]);
  });
});
