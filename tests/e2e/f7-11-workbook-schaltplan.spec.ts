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
 * F7-11 Workbook-Schaltplan — Chromium-E2E.
 * Setup nach f7-10/02k: M2-01-Zusatzprojekt → Angebot im Browser
 * erstellen → Installation per Service anlegen + Variante binden →
 * Workbook zeigt unter der Stückliste den Einlinien-Schaltplan der
 * gebundenen Variante read-only (F6-01-Renderer, ESTIMATE-Layout).
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
    if (!row) throw new Error("F7-11-E2E: eigenes Angebot fehlt.");
    return row;
  });
}

test("F7-11-E2E: Workbook-Schaltplan read-only, ehrliche Fallbacks", async ({ page }) => {
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
    if (!workbook) throw new Error("F7-11-E2E: Workbook fehlt nach Bindung.");
    const inputs = toSchematicInputs(workbook.sections);
    return { inputs, schematic: buildSingleLineSchematic(inputs) };
  });
  // Ehrliche Anker aus der versiegelten M2-01-Kette: Modul + Wechselrichter
  // sind verdrahtbar, der Schaltplan ist nicht leer.
  expect(bound.inputs.map((input) => input.category)).toContain("module");
  expect(bound.inputs.map((input) => input.category)).toContain("inverter");
  expect(bound.schematic.empty).toBe(false);
  expect(bound.schematic.nodes.map((node) => node.id)).toContain("pv");
  expect(bound.schematic.nodes.map((node) => node.id)).toContain("inverter");

  // E-01: Schaltplan-SVG im Workbook sichtbar, NACH der Stückliste.
  await page.goto(projectPath);
  const panel = page.getByTestId("installation-workbook-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("workbook-bom")).toBeVisible();
  const schematic = panel.getByTestId("workbook-schematic");
  await expect(schematic).toBeVisible();
  await expect(schematic.getByRole("img")).toBeVisible();
  await expect(schematic.getByText("Kein Schaltplan verfügbar.", { exact: true })).toHaveCount(0);
  const totalBox = await panel.getByTestId("workbook-total").boundingBox();
  const schematicBox = await schematic.boundingBox();
  expect(totalBox, "Stücklistensumme hat eine Box").not.toBeNull();
  expect(schematicBox, "Schaltplan hat eine Box").not.toBeNull();
  expect(
    schematicBox!.y,
    "Schaltplan rendert nach der Stückliste",
  ).toBeGreaterThan(totalBox!.y);

  // E-04: Reload stabil (reine Projektion, kein Fetch).
  await page.reload();
  await expect(panel.getByTestId("workbook-schematic").getByRole("img")).toBeVisible();

  // E-05: Angebotsansicht zeigt das F6-SVG weiter (Move-Regression —
  // SingleLineDiagram lebt jetzt unter app/_components). Eigenes
  // Zusatzprojekt-Angebot (Shared-M2-01-Angebot existiert im
  // fokussierten Lauf nicht).
  const offerPath = `/w/${m201.workspaceId}/angebote/${offer.offerId}`;
  await page.goto(`${offerPath}?${new URLSearchParams({ variante: offer.variantId }).toString()}`);
  const offerSchematic = page.locator('[data-offer-schematic="true"]');
  await expect(offerSchematic).toBeVisible();
  await expect(offerSchematic.getByRole("heading", { name: "Einphasige Übersicht" })).toBeVisible();
  await expect(offerSchematic.getByRole("img")).toBeVisible();

  // E-06: Viewer (lesend) sieht den Block read-only identisch.
  const viewer = await createM201RedactedViewer(m201);
  await page.context().clearCookies();
  await page.goto(projectPath);
  await loginWithRealOtp(page, viewer.email, projectPath);
  await expect(panel).toBeVisible();
  const viewerSchematic = panel.getByTestId("workbook-schematic");
  await expect(viewerSchematic).toBeVisible();
  await expect(viewerSchematic.getByRole("img")).toBeVisible();
  await expect(panel.getByTestId("workbook-variant-submit")).toHaveCount(0);

  // E-07: Axe auf der Viewer-Sicht (Workbook mit Schaltplan).
  await expectNoWcagAaAxeViolations(page, "F7-11-Workbook-Schaltplan");

  // E-02: ohne Bindung → bestehender Workbook-Fallback, kein Block.
  const unboundProjectId = await seedM201AdditionalReadyProject(m201);
  await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId: unboundProjectId });
  });
  const unboundPath = `/w/${m201.workspaceId}/anfragen/${unboundProjectId}`;
  await page.context().clearCookies();
  await page.goto(unboundPath);
  await loginWithRealOtp(page, m201.editorEmail, unboundPath);
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Noch keine Variante gebunden")).toBeVisible();
  await expect(panel.getByTestId("workbook-schematic")).toHaveCount(0);

  // E-03: gebundene Variante ohne verdrahtete Knoten → ehrlicher Fallback.
  // Alle Zeilen per Angebots-Editor ausblenden (neue versiegelte Revision;
  // Service-Import im Spec unmöglich — modules/offers trägt server-only):
  // Die Workbook-Sektionen sind dann zeilenlos, der Builder bleibt leer.
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
  await page.goto(hiddenPath);
  await expect(panel.getByTestId("workbook-bom")).toBeVisible();
  const hiddenSchematic = panel.getByTestId("workbook-schematic");
  await expect(hiddenSchematic).toBeVisible();
  await expect(hiddenSchematic.getByText("Kein Schaltplan verfügbar.", { exact: true })).toBeVisible();
  await expect(hiddenSchematic.getByRole("img")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors des Workbook-Schaltplans").toEqual([]);
});
