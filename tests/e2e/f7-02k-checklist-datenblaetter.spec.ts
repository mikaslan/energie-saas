import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import {
  CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
  type CatalogComponentRevisionV1,
} from "@/lib/integrations/catalog/contract";
import {
  activateCatalogComponent,
  reviseCatalogComponentDetails,
} from "@/modules/catalog";
import {
  createInstallation,
  getInstallationWorkbook,
  projectWorkbookDatasheets,
  setInstallationVariant,
} from "@/modules/installations";
import {
  createM201RedactedViewer,
  seedM201AdditionalReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F7-02K Datenblatt-Punkt (kind=datasheets) — Chromium-E2E.
 * Setup nach 02j/03e-Präzedenz: M2-01-Zusatzprojekt → Angebot im Browser
 * erstellen → Installation per Service anlegen + Variante binden →
 * Checkliste rendert die Datenblätter der gebundenen Variante als
 * Referenz-Liste (Produktname + Dateiname, verlinkt auf die
 * Katalogkomponenten-Seite, read-only). Editor hat ab Version 1 KEINE
 * Struktur-Inputs (M2-01-Harness ohne Admin) — daher post-Save
 * Text-Anker + DB-Read-back wie 02j E-02.
 *
 * E2E-Seeding: Die M2-01-Fixture seedet presentation.datasheet=null
 * (m2-01-fixture.ts). VOR der Browser-Angebotserstellung wird die
 * geteilte Batterie-Komponente per NEUER Katalog-Revision mit einem
 * synthetischen Datenblatt-Asset versehen (Details-Revise + Aktivieren,
 * idempotent); die danach erstellte Zusatzprojekt-Auflösung bindet die
 * aktuelle Revision, der versiegelte Angebots-Snapshot enthält das Asset.
 * Batterie statt Modul: advanceM201Resolution liest nur die Batterie
 * revisions-dynamisch (Modul/Wechselrichter/Wallbox sind dort auf Rev 1
 * gepinnt) — kein Eingriff in fremde Specs.
 */

const DATASHEET_FILENAME = "hersteller-datenblatt-batterie.pdf";
const DATASHEET_SHA256 = createHash("sha256")
  .update("f702k-synthetisches-batterie-datenblatt")
  .digest("hex");

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

/**
 * Stellt sicher, dass die geteilte M2-01-Batterie in ihrer AKTUELLEN
 * Revision ein Datenblatt-Asset trägt (Muster advanceM201Resolution:
 * Snapshot per SQL lesen, presentation.datasheet patchen, Revision per
 * Service bumpen, wieder aktivieren). Idempotent: trägt die aktuelle
 * Revision das Asset bereits, bleibt sie unangetastet.
 */
async function ensureM201BatteryDatasheet(m201: M201RuntimeState): Promise<void> {
  await withM201Database(m201, async (tx, ctx) => {
    const component = await tx.execute<{
      current_revision: number;
      revision_snapshot: CatalogComponentRevisionV1;
      status: string;
      [key: string]: unknown;
    }>(sql`
      select component.current_revision, component.status,
             revision.revision_snapshot
        from catalog_component component
        join catalog_component_revision revision
          on revision.workspace_id = component.workspace_id
         and revision.component_id = component.id
         and revision.revision = component.current_revision
       where component.workspace_id = ${m201.workspaceId}::uuid
         and component.id = ${m201.m201BatteryId}::uuid
       for update of component
    `);
    const battery = component.rows[0];
    if (!battery) throw new Error("F7-02K-E2E: M2-01-Batterie fehlt.");
    if (battery.revision_snapshot.presentation.datasheet?.originalFilename === DATASHEET_FILENAME) {
      if (battery.status !== "active") {
        await activateCatalogComponent(tx, ctx, {
          componentId: m201.m201BatteryId,
          expectedRevision: battery.current_revision,
          expectedStatus: battery.status,
        });
      }
      return;
    }
    const snapshot = battery.revision_snapshot;
    const revised = await reviseCatalogComponentDetails(tx, ctx, {
      schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
      componentId: m201.m201BatteryId,
      expectedRevision: battery.current_revision,
      presentation: {
        ...snapshot.presentation,
        datasheet: {
          role: "datasheet",
          objectKey: [
            "catalog",
            snapshot.identity.workspaceId,
            snapshot.identity.componentId,
            `${DATASHEET_SHA256}.pdf`,
          ].join("/"),
          sha256: DATASHEET_SHA256,
          mediaType: "application/pdf",
          originalFilename: DATASHEET_FILENAME,
        },
      },
      technicalData: snapshot.technicalData,
      technicalProvenance: snapshot.technicalProvenance,
    });
    await activateCatalogComponent(tx, ctx, {
      componentId: m201.m201BatteryId,
      expectedRevision: revised.revision,
      expectedStatus: "draft",
    });
  });
}

test("F7-02K-E2E: Datenblätter rendern als Referenz-Liste, ehrlicher Fallback", async ({ page }) => {
  test.setTimeout(240_000);
  const m201 = runtimeState();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  // Datenblatt-Asset VOR Zusatzprojekt + Angebotserstellung seeden, damit
  // der versiegelte Snapshot es enthält (siehe Kopfkommentar).
  await ensureM201BatteryDatasheet(m201);

  // F7-10-Setup: eigenes Zusatzprojekt (Angebotserstellung kippt die
  // Projektphase — das geteilte M2-01-Projekt bliebe sonst nicht „ready").
  const projectId = await seedM201AdditionalReadyProject(m201);
  const projectPath = `/w/${m201.workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, m201.editorEmail, projectPath);

  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const offer = await withM201Database(m201, async (tx) => {
    const found = await tx.execute<{ variantId: string }>(sql`
      select variant.id as "variantId"
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
    if (!row) throw new Error("F7-02K-E2E: eigenes Angebot fehlt.");
    return row;
  });

  const expectedRefs = await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId });
    await setInstallationVariant(tx, ctx, { projectId, variantId: offer.variantId });
    const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
    if (!workbook) throw new Error("F7-02K-E2E: Workbook fehlt nach Bindung.");
    return projectWorkbookDatasheets(workbook.sections);
  });
  // Ehrlicher Anker aus der versiegelten Kette: genau die Batterie trägt
  // ein Datenblatt (Modul/Wechselrichter/Wallbox bleiben asset-los).
  const batteryRef = {
    productName: "Synthetische M2-01 battery-Komponente",
    filename: DATASHEET_FILENAME,
    componentId: m201.m201BatteryId,
  };
  expect(expectedRefs).toContainEqual(batteryRef);
  expect(expectedRefs).toHaveLength(1);
  expect(JSON.stringify(expectedRefs)).not.toContain("objectKey");
  expect(JSON.stringify(expectedRefs)).not.toContain(DATASHEET_SHA256);
  const batteryLabel = `${batteryRef.productName} — ${batteryRef.filename}`;
  const batteryHref = `/w/${m201.workspaceId}/katalog/${m201.m201BatteryId}`;

  const url = `/w/${m201.workspaceId}/anfragen/${projectId}/checkliste`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  const listTitle = "Datenblätter Montage";
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(listTitle);
  const item = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(item.getByLabel("Typ")).toContainText("Datenblätter");
  await item.getByLabel("Typ").selectOption("datasheets");

  // E-01: Typ stellen → Referenz-Liste mit Link sichtbar, kein Fallback.
  const refLink = item.getByRole("link", { name: batteryLabel });
  await expect(refLink).toBeVisible();
  await expect(refLink).toHaveAttribute("href", batteryHref);
  await expect(item.getByText("Keine Datenblätter verfügbar.", { exact: true })).toHaveCount(0);

  // E-06: kein Abhaken, keine Pflicht angeboten (Anzeige-Art).
  await expect(item.getByRole("checkbox")).toHaveCount(0);
  await expect(item.getByText("Pflichtpunkt")).toHaveCount(0);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-02: Link führt auf die Katalogkomponenten-Seite.
  // .first(): Ref-<li> ist im Item-<li> verschachtelt (beide matchen
  // hasText) — E-04-Muster, Strict-Mode-sicher.
  const savedItem = page.locator("li", { hasText: batteryLabel }).first();
  await expect(savedItem.getByRole("link", { name: batteryLabel })).toHaveAttribute("href", batteryHref);
  await savedItem.getByRole("link", { name: batteryLabel }).click();
  await page.waitForURL((target) => target.pathname === batteryHref);
  await expect(page.getByRole("heading", { name: batteryRef.productName, level: 1 })).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  // E-03: Reload stabil (Editor ohne Strukturrecht: Text-Anker, keine
  // Struktur-Inputs ab Version 1; Tree speichert nur die Art, kein Inhalt).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const reloaded = page.locator("li", { hasText: batteryLabel }).first();
  await expect(reloaded.getByRole("link", { name: batteryLabel })).toBeVisible();
  await expect(reloaded.getByText("Keine Datenblätter verfügbar.", { exact: true })).toHaveCount(0);
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
    if (!found.rows[0]) throw new Error("F7-02K-E2E: gespeicherte Checkliste fehlt.");
    return found.rows[0].blocks;
  });
  expect(JSON.stringify(stored)).toContain("datasheets");
  expect(JSON.stringify(stored)).not.toContain(batteryRef.productName);
  expect(JSON.stringify(stored)).not.toContain(DATASHEET_FILENAME);

  // E-04: Viewer (lesend) sieht die Liste identisch, keine Struktur-Inputs.
  const viewer = await createM201RedactedViewer(m201);
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, viewer.email, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerItem = page.locator("li", { hasText: batteryLabel });
  await expect(viewerItem.first().getByRole("link", { name: batteryLabel })).toBeVisible();
  await expect(viewerItem.first().getByText("Keine Datenblätter verfügbar.", { exact: true })).toHaveCount(0);
  await expect(viewerItem.first().getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByLabel("Typ")).toHaveCount(0);

  // E-07: Axe auf der Viewer-Sicht (Referenz-Liste).
  await expectNoWcagAaAxeViolations(page, "F7-02K-Datenblaetter");

  // E-05: Projekt ohne Bindung → ehrlicher Fallback, kein Phantom-Text.
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
  await page.getByLabel("Punkt-Name 1.1").fill(listTitle);
  const unboundItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await unboundItem.getByLabel("Typ").selectOption("datasheets");
  await expect(unboundItem.getByText("Keine Datenblätter verfügbar.", { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Datenblätter").toEqual([]);
});
