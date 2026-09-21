import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import { M2_01_E2E_CONTACT, seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F6-02a Schematic-Overlay — Chromium-E2E (isolierter Workspace).
 * - Residential: Erdungspunkt + Konnektor anlegen, speichern, Diagramm-Text
 *   prüfen, Reload zeigt 2 persistierte Zeilen.
 * - Invalid: x=641 meldet Fehler, nichts gespeichert.
 * - Commercial: kein Formular, Gate-Hinweis sichtbar.
 * - Axe: Formular-Bereich ohne critical/serious Violations.
 *
 * Harness: F601-Muster (f601-schaltplan-gate.spec.ts: Login, Offer-Fixtures,
 * Navigation, Timeouts; f601-visual-gates.spec.ts: Axe-Muster).
 * Vertrags-Selektoren (UI parallel in Arbeit, fix): schematic-overlay-form,
 * schematic-overlay-add, schematic-overlay-save, schematic-overlay-status,
 * schematic-overlay-row, Felder name="kind|x|y|label|text|from|to",
 * schematic-gate-notice (Bestand), Diagramm role="img" mit aria-label
 * "Übersichtsschaltbild". Bis zum UI-Merge ist diese Spec RED.
 *
 * Annahmen (F601-Namen): Angebots-URL trägt die Variante als `?variante=`;
 * erste Overlay-Zeile erhält die ID "ovl-1" (daher to=ovl-1); Erfolgsstatus
 * enthält "gespeichert"; Fehlerstatus nennt "invalid" ("ungültig"/"Fehler"
 * werden ersatzweise akzeptiert); kind-Optionen heißen "Erdungspunkt"/
 * "Konnektor" oder englisch (ground/connector, per Teiltreffer gewählt).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F602A-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
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
  await page.waitForURL((url) => url.pathname === expectedPath);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  // Bewusst nur Console-/Page-Fehler (F601-Gate-Muster): Ein invalider Save
  // darf legitimerweise HTTP-4xx liefern, das ist kein Crash.
  expect(browserErrors.get(page) ?? [], "F602A: keine Console-/Page-Fehler (kein Crash)").toEqual([]);
});

async function seedReadyWorkspace(skuSuffix: string): Promise<{ workspaceId: string; projectId: string }> {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const seed = await seedM201ReadyProject(state().databaseUrl, {
    workspaceId,
    editorIdentityId: actorId,
    skuSuffix,
  });
  return { workspaceId, projectId: seed.projectId };
}

async function createOfferViaUi(
  page: Page,
  workspaceId: string,
  projectId: string,
): Promise<{ offerId: string; variantId: string; offerPath: string }> {
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);

  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));

  const createdUrl = new URL(page.url());
  const offerId = createdUrl.pathname.split("/").pop();
  const variantId = createdUrl.searchParams.get("variante");
  if (!offerId || !variantId) throw new Error("F602A: Angebots-URL ohne Offer-/Varianten-ID.");
  return { offerId, variantId, offerPath: createdUrl.pathname };
}

async function moveProjectToScopeColumn(
  workspaceId: string,
  projectId: string,
  scope: "residential" | "commercial",
): Promise<void> {
  await poolOne(async (pool) => {
    const lane = await pool.query<{ board_id: string; column_id: string }>(`
      select board.id as board_id, offer_column.id as column_id
        from kanban_board board
        join kanban_column offer_column
          on offer_column.workspace_id = board.workspace_id
         and offer_column.board_id = board.id
         and offer_column.column_type = 'offer'
         and offer_column.archived_at is null
       where board.workspace_id = $1::uuid
         and board.scope = $2
         and board.is_default = true
         and board.archived_at is null
       order by offer_column.position, offer_column.id
       limit 1
    `, [workspaceId, scope]);
    const target = lane.rows[0];
    if (!target) throw new Error(`F602A: Angebots-Spalte (${scope}) fehlt.`);
    await pool.query(
      `update project set kanban_board_id = $1::uuid, kanban_column_id = $2::uuid
        where workspace_id = $3::uuid and id = $4::uuid`,
      [target.board_id, target.column_id, workspaceId, projectId],
    );
  });
}

// Füllt ein Zeilenfeld, falls vorhanden (freiwillig, je nach kind gibt es
// nur eine Teilmenge der Felder kind/x/y/label/text/from/to).
async function setRowField(row: Locator, name: string, value: string): Promise<void> {
  const field = row.locator(`[name="${name}"]`);
  if ((await field.count()) === 0) return;
  const tagName = await field.evaluate((node) => node.tagName);
  if (tagName === "SELECT") {
    try {
      await field.selectOption(value);
    } catch {
      await field.selectOption({ label: value });
    }
    return;
  }
  await field.fill(value);
}

// Wählt die kind-Option per Teiltreffer (deutsch bevorzugt, englisch als
// Rückfall), damit beide UI-Benennungen bestehen.
async function selectKindByCandidates(row: Locator, candidates: string[]): Promise<void> {
  const field = row.locator('[name="kind"]');
  if ((await field.count()) === 0) return;
  const tagName = await field.evaluate((node) => node.tagName);
  if (tagName !== "SELECT") {
    await field.fill(candidates[0]!);
    return;
  }
  const options = await field.evaluate((node) =>
    Array.from((node as HTMLSelectElement).options).map((option) => ({
      value: option.value,
      label: option.label,
    })));
  const wanted = candidates.map((candidate) => candidate.toLowerCase());
  const hit = options.find(
    (option) =>
      option.value !== ""
      && wanted.some(
        (candidate) =>
          option.value.toLowerCase().includes(candidate)
          || option.label.toLowerCase().includes(candidate),
      ),
  );
  if (!hit) {
    throw new Error(
      `F602A: keine passende kind-Option für [${candidates.join(", ")}] (Optionen: ${JSON.stringify(options)}).`,
    );
  }
  await field.selectOption(hit.value);
}

// Legt per Add-Button eine Zeile an und wartet per Assertion auf sie.
async function addRow(page: Page, index: number): Promise<Locator> {
  await page.getByTestId("schematic-overlay-add").click();
  const row = page.getByTestId("schematic-overlay-row").nth(index);
  await expect(row).toBeVisible();
  return row;
}

test.describe("F6-02a Schematic-Overlay", () => {
  test("F602A-OVL-01: Wohnbau speichert Erdungspunkt und Konnektor, Reload zeigt 2 Zeilen", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602a-ovl-${randomUUID().slice(0, 8)}`);
    const { offerId } = await createOfferViaUi(page, workspaceId, projectId);

    const form = page.getByTestId("schematic-overlay-form");
    await expect(form).toBeVisible();

    // Zeile 1: Erdungspunkt an (410, 200).
    const groundRow = await addRow(page, 0);
    await selectKindByCandidates(groundRow, ["Erdungspunkt", "Erdung", "ground", "earth"]);
    await setRowField(groundRow, "x", "410");
    await setRowField(groundRow, "y", "200");
    await setRowField(groundRow, "label", "Erdungspunkt");
    await setRowField(groundRow, "text", "Erdungspunkt");

    // Zeile 2: Konnektor meter -> ovl-1 mit Label PE.
    const linkRow = await addRow(page, 1);
    await selectKindByCandidates(linkRow, ["Konnektor", "konnektor", "connector", "verbindung", "edge"]);
    await setRowField(linkRow, "from", "meter");
    await setRowField(linkRow, "to", "ovl-1");
    await setRowField(linkRow, "label", "PE");
    await setRowField(linkRow, "text", "PE");

    await page.getByTestId("schematic-overlay-save").click();
    const status = page.getByTestId("schematic-overlay-status");
    await expect(status).toContainText("gespeichert");

    // Diagramm rendert beide Overlay-Texte.
    const diagram = page.getByRole("img", { name: /Übersichtsschaltbild/u });
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("Erdungspunkt");
    await expect(diagram).toContainText("PE");

    // Reload: beide Zeilen sind persistiert (expect-to-pass statt Sleep).
    await page.reload();
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await expect(page.getByTestId("schematic-overlay-row")).toHaveCount(2);
    expect(offerId).toMatch(/^[0-9a-f-]+$/u);
  });

  test("F602A-OVL-02: Ungültiges x meldet Fehler und speichert keine Revision", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602a-inv-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);

    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    // Annahme: x=641 liegt außerhalb des gültigen Bereichs.
    const row = await addRow(page, 0);
    await selectKindByCandidates(row, ["Erdungspunkt", "Erdung", "ground", "earth"]);
    await setRowField(row, "x", "641");
    await setRowField(row, "y", "200");
    await setRowField(row, "label", "Erdungspunkt");
    await setRowField(row, "text", "Erdungspunkt");

    await page.getByTestId("schematic-overlay-save").click();
    const status = page.getByTestId("schematic-overlay-status");
    await expect(status).toContainText(/invalid|ungültig|fehler/iu);
    await expect(status).not.toContainText("gespeichert");
  });

  test("F602A-OVL-03: Gewerbe zeigt Gate-Hinweis statt Overlay-Formular", async ({ page }) => {
    test.setTimeout(240_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602a-com-${randomUUID().slice(0, 8)}`);
    const { offerId, variantId } = await createOfferViaUi(page, workspaceId, projectId);
    const offerUrl = `/w/${workspaceId}/angebote/${offerId}?variante=${variantId}`;

    // Kontrolle: vorher rendert das Wohnbau-Formular.
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();

    // Gewerbe-Board: Gate-Hinweis statt Formular, kein Crash.
    await moveProjectToScopeColumn(workspaceId, projectId, "commercial");
    await page.goto(offerUrl);
    const schematic = page.locator('[data-offer-schematic="true"]');
    await expect(schematic).toBeVisible();
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    await expect(schematic.getByTestId("schematic-gate-notice")).toBeVisible();
    await expect(page.getByTestId("schematic-overlay-form")).toHaveCount(0);
  });

  test("F602A-OVL-04: Overlay-Formular ohne critical/serious Axe-Violations", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602a-axe-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);

    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    // Eine befüllte Zeile, damit alle Feldtypen im Axe-Scope liegen.
    const row = await addRow(page, 0);
    await selectKindByCandidates(row, ["Erdungspunkt", "Erdung", "ground", "earth"]);
    await setRowField(row, "x", "410");
    await setRowField(row, "y", "200");
    await setRowField(row, "label", "Erdungspunkt");
    await setRowField(row, "text", "Erdungspunkt");

    await expect(page).toHaveTitle(/.+/u);
    const result = await new AxeBuilder({ page })
      .include('[data-testid="schematic-overlay-form"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const severe = result.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(severe.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    })), "overlay-form: keine critical/serious Axe-Violations").toEqual([]);
  });
});

/**
 * F6-02c-A Freier Editor — Chromium-E2E (RED bis UI-Canvas existiert).
 * Vertrags-Selektoren (SPEC docs/spec/F6-02c-freier-editor.md):
 * schematic-overlay-canvas (eigenes SVG im 640×300-Raum),
 * schematic-overlay-handle (ein Griff je ID-tragendem Element, in
 * Zeilenreihenfolge), schematic-overlay-id-chip (vergebene ovl-*-ID,
 * nur nach Save+Reload via Server-Mapping). Griffe sind native Buttons
 * (Tastatur-Nudge: Pfeil ±1, Shift+Pfeil ±10). Backbone-Knoten und
 * Konnektoren haben keine Griffe. Kein Auto-Save: Position landet erst
 * per Save in der Revision.
 */

async function saveGroundAndReload(page: Page): Promise<void> {
  const groundRow = await addRow(page, 0);
  await selectKindByCandidates(groundRow, ["Erdungspunkt", "Erdung", "ground", "earth"]);
  await setRowField(groundRow, "x", "410");
  await setRowField(groundRow, "y", "200");
  await setRowField(groundRow, "label", "Erdungspunkt");
  await setRowField(groundRow, "text", "Erdungspunkt");
  await page.getByTestId("schematic-overlay-save").click();
  await expect(page.getByTestId("schematic-overlay-status")).toContainText("gespeichert");
  await page.reload();
  await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
  await expect(page.getByTestId("schematic-overlay-row")).toHaveCount(1);
}

async function rowFieldValue(page: Page, index: number, name: string): Promise<string> {
  const field = page.getByTestId("schematic-overlay-row").nth(index).locator(`[name="${name}"]`);
  await expect(field).toBeVisible();
  return field.inputValue();
}

test.describe("F6-02c-A Freier Editor", () => {
  test("F602C-EDT-01: Drag mit Maus → Save → Reload → Position persistiert", async ({ page }) => {
    test.setTimeout(240_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602c-drag-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await saveGroundAndReload(page);

    const canvas = page.getByTestId("schematic-overlay-canvas");
    await expect(canvas).toBeVisible();
    // Adapter registriert (pragmatic-dnd setzt draggable="true" selbst).
    await expect(page.getByTestId("schematic-overlay-handle").nth(0)).toHaveAttribute(
      "draggable",
      "true",
    );
    const handle = page.getByTestId("schematic-overlay-handle").nth(0);
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    if (!box) throw new Error("F602C: Griff ohne BoundingBox.");
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("F602C: Canvas ohne BoundingBox.");
    // +40/+30 px im 640×300-Raum: (410,200) → (450,230).
    const scaleX = canvasBox.width / 640;
    const scaleY = canvasBox.height / 300;
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;
    const toX = fromX + 40 * scaleX;
    const toY = fromY + 30 * scaleY;
    // Pragmatic-dnd nutzt nativen HTML5-DnD; Playwright-Maus-Events starten
    // keinen nativen dragstart (Browser-Limit, per Diagnose belegt). Daher
    // echte DragEvent-Sequenz auf den realen Elementen — der Adapter-Pfad
    // (Registrierung, Drop-Erkennung, Koordinaten) ist identisch.
    await page.evaluate(([startX, startY, endX, endY]) => {
      const source = document.querySelector('[data-testid="schematic-overlay-handle"]');
      const target = document.querySelector('[data-testid="schematic-overlay-canvas"]');
      if (!(source instanceof HTMLElement)) throw new Error("F602C: Griff fehlt im DOM.");
      if (!(target instanceof HTMLElement)) throw new Error("F602C: Canvas fehlt im DOM.");
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY,
          dataTransfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          clientX: endX,
          clientY: endY,
          dataTransfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX: endX,
          clientY: endY,
          dataTransfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: endX,
          clientY: endY,
          dataTransfer,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          clientX: endX,
          clientY: endY,
          dataTransfer,
        }),
      );
    }, [fromX, fromY, toX, toY]);

    // Entwurf: Formularfelder folgen dem Drop (noch kein Save).
    await expect
      .poll(async () => rowFieldValue(page, 0, "x"), { timeout: 10_000 })
      .toBe("450");
    await expect
      .poll(async () => rowFieldValue(page, 0, "y"), { timeout: 10_000 })
      .toBe("230");

    await page.getByTestId("schematic-overlay-save").click();
    await expect(page.getByTestId("schematic-overlay-status")).toContainText("gespeichert");
    await page.reload();
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    expect(await rowFieldValue(page, 0, "x")).toBe("450");
    expect(await rowFieldValue(page, 0, "y")).toBe("230");
  });

  test("F602C-EDT-02: ID-Chips nach Save+Reload sichtbar (ovl-1)", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602c-chip-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await saveGroundAndReload(page);

    // Chip auf dem Canvas …
    const chip = page.getByTestId("schematic-overlay-id-chip").nth(0);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("ovl-1");
    // … und ID in der Formularzeile.
    await expect(page.getByTestId("schematic-overlay-row").nth(0)).toContainText("ovl-1");
  });

  test("F602C-EDT-03: Tastatur-Nudge ±1 und ±10", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602c-nudge-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await saveGroundAndReload(page);

    const handle = page.getByTestId("schematic-overlay-handle").nth(0);
    await expect(handle).toBeVisible();
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => rowFieldValue(page, 0, "x"), { timeout: 10_000 })
      .toBe("411");
    await page.keyboard.press("Shift+ArrowDown");
    await expect
      .poll(async () => rowFieldValue(page, 0, "y"), { timeout: 10_000 })
      .toBe("210");
  });

  test("F602C-EDT-04: Nur Overlay-Elemente haben Griffe (Backbone nie)", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602c-scope-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await saveGroundAndReload(page);

    // Backbone-Diagramm rendert …
    await expect(page.getByRole("img", { name: /Übersichtsschaltbild/u })).toBeVisible();
    // … aber genau ein Griff (Erdungspunkt; Konnektoren haetten keinen).
    await expect(page.getByTestId("schematic-overlay-canvas")).toBeVisible();
    await expect(page.getByTestId("schematic-overlay-handle")).toHaveCount(1);
  });

  test("F602C-EDT-05: Overlay-Canvas ohne critical/serious Axe-Violations", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f602c-axe-${randomUUID().slice(0, 8)}`);
    await createOfferViaUi(page, workspaceId, projectId);
    await expect(page.getByTestId("schematic-overlay-form")).toBeVisible();
    await saveGroundAndReload(page);

    await expect(page.getByTestId("schematic-overlay-canvas")).toBeVisible();
    await expect(page).toHaveTitle(/.+/u);
    const result = await new AxeBuilder({ page })
      .include('[data-testid="schematic-overlay-canvas"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const severe = result.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(severe.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    })), "overlay-canvas: keine critical/serious Axe-Violations").toEqual([]);
  });
});
