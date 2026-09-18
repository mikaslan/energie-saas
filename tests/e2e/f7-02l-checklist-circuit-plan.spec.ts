import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { buildSingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";
import {
  createInstallation,
  getInstallationWorkbook,
  setInstallationVariant,
  toSchematicInputs,
} from "@/modules/installations";
import {
  createM201RedactedViewer,
  seedM201AdditionalReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F7-02L Schaltplan-Punkt (kind=circuit-plan) — Chromium-E2E.
 * Setup nach f7-10/02k/F7-11: M2-01-Zusatzprojekt → Angebot im Browser
 * erstellen → Installation per Service anlegen + Variante binden →
 * Checkliste rendert den Einlinien-Schaltplan der gebundenen Variante
 * (F7-11-Renderer, ESTIMATE-Layout) als Anzeige-Punkt read-only. Editor
 * hat ab Version 1 KEINE Struktur-Inputs (M2-01-Harness ohne Admin) —
 * daher post-Save Text-Anker + DB-Read-back wie 02j E-02.
 *
 * Kein Vorab-Seeding noetig (anders als 02k): Das M2-01-Angebot enthaelt
 * Modul + Wechselrichter, beide verdrahtbar (F7-11-Anker unten).
 */

type SerializedM201State = {
  databaseUrl: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM201State>;
  const required: Array<keyof SerializedM201State> = [
    "databaseUrl",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M2-01-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM201State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.m201EditorEmail,
    editorIdentityId: complete.m201EditorIdentityId,
    m201BatteryId: complete.m201BatteryId,
    m201InverterId: complete.m201InverterId,
    m201ModuleId: complete.m201ModuleId,
    m201ProjectId: complete.m201ProjectId,
    m201WallboxId: complete.m201WallboxId,
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.m201WorkspaceId,
  };
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
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedPath);
  const logOffset = statSync(runtimeState().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(runtimeState().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  await expect(page).toHaveTitle(/.+/u);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function createOfferInBrowser(page: Page): Promise<void> {
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
}

async function readOwnOffer(
  m201: M201RuntimeState,
  projectId: string,
): Promise<{ offerId: string; variantId: string }> {
  return withM201Database(m201, async (tx) => {
    const found = await tx.execute<{ offerId: string; variantId: string }>(sql`
      select offer.id as "offerId", variant.id as "variantId"
        from offer
        join offer_variant as variant
          on variant.workspace_id = offer.workspace_id
         and variant.offer_id = offer.id
         and variant.ordinal = 1
       where offer.workspace_id = ${m201.workspaceId}::uuid
         and offer.project_id = ${projectId}::uuid
       order by offer.created_at desc, offer.id desc
       limit 1
    `);
    const row = found.rows[0];
    if (!row) throw new Error("F7-02L-E2E: eigenes Angebot fehlt.");
    return row;
  });
}

test("F7-02L-E2E: Schaltplan rendert als Anzeige-Punkt, ehrliche Fallbacks", async ({ page }) => {
  test.setTimeout(300_000);
  const m201 = runtimeState();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  // F7-10-Setup: eigenes Zusatzprojekt (Angebotserstellung kippt die
  // Projektphase — das geteilte M2-01-Projekt bliebe sonst nicht „ready").
  const projectId = await seedM201AdditionalReadyProject(m201);
  const projectPath = `/w/${m201.workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, m201.editorEmail, projectPath);
  await createOfferInBrowser(page);
  const offer = await readOwnOffer(m201, projectId);

  const bound = await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId });
    await setInstallationVariant(tx, ctx, { projectId, variantId: offer.variantId });
    const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
    if (!workbook) throw new Error("F7-02L-E2E: Workbook fehlt nach Bindung.");
    const inputs = toSchematicInputs(workbook.sections);
    return { inputs, schematic: buildSingleLineSchematic(inputs) };
  });
  // Ehrliche Anker aus der versiegelten M2-01-Kette (F7-11-Praezedenz):
  // Modul + Wechselrichter sind verdrahtbar, der Schaltplan ist nicht leer.
  expect(bound.inputs.map((input) => input.category)).toContain("module");
  expect(bound.inputs.map((input) => input.category)).toContain("inverter");
  expect(bound.schematic.empty).toBe(false);
  expect(bound.schematic.nodes.map((node) => node.id)).toContain("pv");
  expect(bound.schematic.nodes.map((node) => node.id)).toContain("inverter");

  const url = `/w/${m201.workspaceId}/anfragen/${projectId}/checkliste`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  const planTitle = "Schaltplan Montage";
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(planTitle);
  const item = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(item.getByLabel("Typ")).toContainText("Schaltplan");
  await item.getByLabel("Typ").selectOption("circuit-plan");

  // E-01: Typ stellen → Schaltplan-SVG sichtbar, kein Fallback.
  const schematic = item.getByTestId("checklist-schematic");
  await expect(schematic).toBeVisible();
  await expect(schematic.getByRole("img")).toBeVisible();
  await expect(item.getByText("Kein Schaltplan verfügbar.", { exact: true })).toHaveCount(0);

  // E-06: kein Abhaken, keine Pflicht angeboten (Anzeige-Art).
  await expect(item.getByRole("checkbox")).toHaveCount(0);
  await expect(item.getByText("Pflichtpunkt")).toHaveCount(0);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-04: Reload stabil (Editor ohne Strukturrecht: Text-Anker, keine
  // Struktur-Inputs ab Version 1; Tree speichert nur die Art, kein Inhalt).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const reloaded = page.locator("li", { hasText: planTitle }).first();
  await expect(reloaded.getByTestId("checklist-schematic")).toBeVisible();
  await expect(reloaded.getByTestId("checklist-schematic").getByRole("img")).toBeVisible();
  await expect(reloaded.getByText("Kein Schaltplan verfügbar.", { exact: true })).toHaveCount(0);
  await expect(reloaded.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByLabel("Punkt-Name 1.1")).toHaveCount(0);
  const stored = await withM201Database(m201, async (tx) => {
    const found = await tx.execute<{ blocks: unknown }>(sql`
      select blocks from project_checklist
       where workspace_id = ${m201.workspaceId}::uuid
         and project_id = ${projectId}::uuid
         and phase = 'site_documentation'
       limit 1
    `);
    if (!found.rows[0]) throw new Error("F7-02L-E2E: gespeicherte Checkliste fehlt.");
    return found.rows[0].blocks;
  });
  expect(JSON.stringify(stored)).toContain("circuit-plan");
  expect(JSON.stringify(stored)).not.toContain("Einphasiges Übersichtsschaltbild");
  expect(JSON.stringify(stored)).not.toContain("Kein Schaltplan verfügbar.");

  // E-05: Viewer (lesend) sieht das SVG identisch, keine Struktur-Inputs.
  const viewer = await createM201RedactedViewer(m201);
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, viewer.email, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerItem = page.locator("li", { hasText: planTitle });
  await expect(viewerItem.first().getByTestId("checklist-schematic")).toBeVisible();
  await expect(viewerItem.first().getByTestId("checklist-schematic").getByRole("img")).toBeVisible();
  await expect(viewerItem.first().getByText("Kein Schaltplan verfügbar.", { exact: true })).toHaveCount(0);
  await expect(viewerItem.first().getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByLabel("Typ")).toHaveCount(0);

  // E-07: Axe auf der Viewer-Sicht (Schaltplan-Punkt).
  await expectNoWcagAaAxeViolations(page, "F7-02L-Schaltplan");

  // E-02: Projekt ohne Bindung → ehrlicher Fallback, kein Phantom-SVG.
  const unboundProjectId = await seedM201AdditionalReadyProject(m201);
  const unboundUrl = `/w/${m201.workspaceId}/anfragen/${unboundProjectId}/checkliste`;
  await page.context().clearCookies();
  await page.goto(unboundUrl);
  await loginWithRealOtp(page, m201.editorEmail, unboundUrl);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(planTitle);
  const unboundItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await unboundItem.getByLabel("Typ").selectOption("circuit-plan");
  await expect(unboundItem.getByText("Kein Schaltplan verfügbar.", { exact: true })).toBeVisible();
  await expect(unboundItem.getByTestId("checklist-schematic")).toHaveCount(0);
  await expect(unboundItem.getByRole("img")).toHaveCount(0);

  // E-03: gebundene Variante ohne verdrahtete Knoten → ehrlicher Fallback
  // (F7-11-Muster: alle Zeilen per Angebots-Editor ausblenden — neue
  // versiegelte Revision; die Workbook-Sektionen sind dann zeilenlos,
  // der Builder bleibt leer).
  const hiddenProjectId = await seedM201AdditionalReadyProject(m201);
  const hiddenPath = `/w/${m201.workspaceId}/anfragen/${hiddenProjectId}`;
  await page.goto(hiddenPath);
  await createOfferInBrowser(page);
  const hiddenOffer = await readOwnOffer(m201, hiddenProjectId);
  await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId: hiddenProjectId });
    await setInstallationVariant(tx, ctx, { projectId: hiddenProjectId, variantId: hiddenOffer.variantId });
  });
  await page.goto(`/w/${m201.workspaceId}/angebote/${hiddenOffer.offerId}?${new URLSearchParams({ variante: hiddenOffer.variantId }).toString()}`);
  const hideBoxes = page.getByLabel("Im Kundenangebot ausblenden");
  expect(await hideBoxes.count(), "E-03 braucht sichtbare Zeilen zum Verstecken").toBeGreaterThan(0);
  for (let index = 0; index < await hideBoxes.count(); index += 1) {
    await hideBoxes.nth(index).check();
  }
  await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
  await expect(page.getByText(/Revision \d+ wurde gespeichert\./u)).toBeVisible();
  const hiddenUrl = `/w/${m201.workspaceId}/anfragen/${hiddenProjectId}/checkliste`;
  await page.goto(hiddenUrl);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(planTitle);
  const hiddenItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await hiddenItem.getByLabel("Typ").selectOption("circuit-plan");
  await expect(hiddenItem.getByText("Kein Schaltplan verfügbar.", { exact: true })).toBeVisible();
  await expect(hiddenItem.getByTestId("checklist-schematic")).toHaveCount(0);
  await expect(hiddenItem.getByRole("img")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors des Schaltplan-Punkts").toEqual([]);
});
