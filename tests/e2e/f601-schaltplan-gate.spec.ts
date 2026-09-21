import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import { M2_01_E2E_CONTACT, seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F6-01 Schaltplan-Gate — Chromium-E2E (isolierter Workspace).
 * - Wohnbau: Diagramm rendert + Erstöffnen-Save (idempotent, genau eine Zeile
 *   in `schematic_diagrams` je Varianten-Revision).
 * - Gewerbe (Commercial-Board): Gate-Hinweis statt Diagramm, kein Crash.
 * - Export-Refuse für Gewerbe: Fehler sichtbar, kein Download.
 *
 * Fleet-Vertrag: Die Scope-Auflösung folgt dem W-CORE-4-Felder-Modell
 * (offer.scope/price_audience, Board-Scope, Decision-Audience, fail-closed);
 * live auslösbar ist der Board-Scope, da offer-seitige commercial/b2b-Werte
 * vom `offer_status_scope_audience_ck`-CHECK blockiert werden. View-Verdrahtung
 * (Integration) und 0300-Tabelle (W-DB) kommen aus Nachbar-Lanes; diese Spec
 * ist bis zum Integrations-Merge RED (s. Report).
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
      throw new Error(`Der private F601-E2E-State ist unvollständig (${key}).`);
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
  expect(browserErrors.get(page) ?? [], "F601: keine Console-/Page-Fehler (kein Crash)").toEqual([]);
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
  if (!offerId || !variantId) throw new Error("F601: Angebots-URL ohne Offer-/Varianten-ID.");
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
    if (!target) throw new Error(`F601: Angebots-Spalte (${scope}) fehlt.`);
    await pool.query(
      `update project set kanban_board_id = $1::uuid, kanban_column_id = $2::uuid
        where workspace_id = $3::uuid and id = $4::uuid`,
      [target.board_id, target.column_id, workspaceId, projectId],
    );
  });
}

async function readFirstOpenSave(
  workspaceId: string,
  offerId: string,
): Promise<{
  count: number;
  nodeCount: number;
  variantRevision: number;
  currentRevision: number;
  revision: number;
}> {
  return poolOne(async (pool) => {
    try {
      const result = await pool.query<{
        count: number;
        node_count: number | null;
        variant_revision: number | null;
        current_revision: number | null;
        revision: number | null;
      }>(`
        select (select count(*)
                  from schematic_diagrams
                 where workspace_id = $1::uuid
                   and offer_id = $2::uuid)::int as count,
               (select node_count
                  from schematic_diagrams
                 where workspace_id = $1::uuid
                   and offer_id = $2::uuid
                 order by variant_revision desc
                 limit 1) as node_count,
               (select variant_revision
                  from schematic_diagrams
                 where workspace_id = $1::uuid
                   and offer_id = $2::uuid
                 order by variant_revision desc
                 limit 1) as variant_revision,
               (select current_revision
                  from offer_variant
                 where workspace_id = $1::uuid
                   and offer_id = $2::uuid
                   and ordinal = 1) as current_revision,
               (select revision
                  from schematic_diagrams
                 where workspace_id = $1::uuid
                   and offer_id = $2::uuid
                 order by variant_revision desc
                 limit 1) as revision
      `, [workspaceId, offerId]);
      const row = result.rows[0];
      if (!row) throw new Error("F601: Erstöffnen-Zählung ohne Ergebnis.");
      return {
        count: row.count,
        nodeCount: row.node_count ?? 0,
        variantRevision: row.variant_revision ?? 0,
        currentRevision: row.current_revision ?? 0,
        revision: row.revision ?? 0,
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === "42P01") {
        throw new Error("F601: Tabelle schematic_diagrams fehlt (0300 nicht gemergt).");
      }
      throw error;
    }
  });
}

// F6-02b/GATE-03: simuliert einen veralteten Snapshot (alter Builder-Stand)
// durch direktes Ueberschreiben der Netzliste — gueltige CHECK-Form, aber
// garantiert Drift gegen den frischen Live-Build.
async function staleFirstOpenRow(workspaceId: string, offerId: string): Promise<void> {
  await poolOne(async (pool) => {
    await pool.query(
      `update schematic_diagrams
          set netlist = '{"nodes":[],"edges":[]}'::jsonb,
              node_count = 0,
              edge_count = 0
        where workspace_id = $1::uuid
          and offer_id = $2::uuid`,
      [workspaceId, offerId],
    );
  });
}

test.describe("F6-01 Schaltplan-Gate", () => {
  test("F601-GATE-01: Wohnbau rendert das Diagramm und speichert das Erstöffnen idempotent", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f601-gate-${randomUUID().slice(0, 8)}`);
    const { offerId, variantId, offerPath } = await createOfferViaUi(page, workspaceId, projectId);

    const schematic = page.locator('[data-offer-schematic="true"]');
    await expect(schematic).toBeVisible();
    await expect(schematic.getByRole("heading", { name: "Einphasige Übersicht" })).toBeVisible();
    await expect(schematic.getByRole("img")).toBeVisible();
    await expect(schematic.getByTestId("schematic-gate-notice")).toHaveCount(0);
    await expect(schematic).toHaveAttribute("data-schematic-save-state", /^(saved|already-saved)$/u);

    // Reload: idempotenter Zweitaufruf speichert nicht erneut.
    await page.reload();
    await expect(page.locator('[data-offer-schematic="true"]')).toBeVisible();
    await expect(page.locator('[data-offer-schematic="true"]'))
      .toHaveAttribute("data-schematic-save-state", "already-saved");

    const saved = await readFirstOpenSave(workspaceId, offerId);
    expect(saved.count, "genau eine Erstöffnen-Zeile je Varianten-Revision").toBe(1);
    expect(saved.nodeCount, "gespeicherter Schaltplan enthält Knoten").toBeGreaterThan(0);
    expect(saved.variantRevision, "gespeicherte Revision folgt der Variante")
      .toBe(saved.currentRevision);
    expect(offerPath).toContain(offerId);
    expect(variantId).toMatch(/^[0-9a-f-]+$/u);
  });

  test("F601-GATE-02: Gewerbe zeigt den Gate-Hinweis, der Export verweigert ohne Download", async ({ page }) => {
    test.setTimeout(240_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f601-refuse-${randomUUID().slice(0, 8)}`);
    const { offerId, variantId } = await createOfferViaUi(page, workspaceId, projectId);
    const offerUrl = `/w/${workspaceId}/angebote/${offerId}?variante=${variantId}`;

    // Kontrolle: vorher rendert der Wohnbau-Schaltplan.
    await expect(page.locator('[data-offer-schematic="true"]')).toBeVisible();
    await expect(page.locator('[data-offer-schematic="true"]').getByRole("img")).toBeVisible();

    // Gewerbe-Board: Gate-Hinweis statt Diagramm, kein Crash, kein Save.
    await moveProjectToScopeColumn(workspaceId, projectId, "commercial");
    await page.goto(offerUrl);
    const gated = page.locator('[data-offer-schematic="true"]');
    await expect(gated).toBeVisible();
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const notice = gated.getByTestId("schematic-gate-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Wohnbau");
    await expect(gated.getByRole("img")).toHaveCount(0);
    await expect(gated).toHaveAttribute("data-schematic-save-state", "idle");

    // Export-Refuse: Fehler sichtbar, kein Download (Listener VOR dem Klick,
    // sonst würde ein fehlerhafter Download unbemerkt durchrauschen).
    await expect(gated.getByTestId("schematic-export-download")).toBeVisible();
    const noDownload = page.waitForEvent("download", { timeout: 2_500 });
    await gated.getByTestId("schematic-export-download").click();
    const refused = gated.getByTestId("schematic-export-refused");
    await expect(refused).toBeVisible();
    await expect(refused).toContainText("Gewerbe");
    await expect(noDownload).rejects.toThrow();

    // Reversibel: zurück im Wohnbau-Board rendert das Diagramm wieder,
    // ohne zweite Erstöffnen-Zeile (Reload trifft die gespeicherte Revision).
    await moveProjectToScopeColumn(workspaceId, projectId, "residential");
    await page.goto(offerUrl);
    const restored = page.locator('[data-offer-schematic="true"]');
    await expect(restored.getByRole("img")).toBeVisible();
    await expect(restored.getByTestId("schematic-gate-notice")).toHaveCount(0);
    await expect(restored).toHaveAttribute("data-schematic-save-state", "already-saved");
    const saved = await readFirstOpenSave(workspaceId, offerId);
    expect(saved.count, "weiterhin genau eine Erstöffnen-Zeile").toBe(1);
  });

  test("F601-GATE-03: Re-Open mit Drift schreibt In-Place revision+1 ohne Neuanlage", async ({ page }) => {
    test.setTimeout(180_000);
    const { workspaceId, projectId } = await seedReadyWorkspace(`f601-reopen-${randomUUID().slice(0, 8)}`);
    const { offerId } = await createOfferViaUi(page, workspaceId, projectId);

    const schematic = page.locator('[data-offer-schematic="true"]');
    await expect(schematic).toBeVisible();
    await expect(schematic).toHaveAttribute("data-schematic-save-state", /^(saved|already-saved)$/u);
    const before = await readFirstOpenSave(workspaceId, offerId);
    expect(before.count, "genau eine Erstöffnen-Zeile").toBe(1);
    expect(before.revision, "Start bei interner Revision 1").toBe(1);

    // Drift simulieren (alter Builder-Stand), dann Re-Open: Die
    // Ensure-Verdrahtung (F6-02b) schreibt In-Place revision+1.
    await staleFirstOpenRow(workspaceId, offerId);
    await page.reload();
    await expect(page.locator('[data-offer-schematic="true"]')).toBeVisible();
    await expect
      .poll(async () => (await readFirstOpenSave(workspaceId, offerId)).revision, { timeout: 30_000 })
      .toBe(2);
    const after = await readFirstOpenSave(workspaceId, offerId);
    expect(after.count, "keine Neuanlage, kein Append").toBe(1);
    expect(after.nodeCount, "frische Netzliste zurueckgeschrieben").toBeGreaterThan(0);
  });
});
