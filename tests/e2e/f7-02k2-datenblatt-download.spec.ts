import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { resolveObjectStorage } from "@/lib/storage";
import {
  createM201RedactedViewer,
  seedM201AdditionalReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F7-02K2 Datenblatt Byte-Download (Katalog F7.2) — Chromium-E2E.
 * Setup nach 02k-Praezedenz: M2-01-Zusatzprojekt → Angebot im Browser
 * erstellen → Installation per Service anlegen + Variante binden →
 * Checkliste rendert je Referenz Katalog-Link (Bestand) + eigenen
 * Download-Link „PDF herunterladen" auf die Session-Route.
 *
 * E2E-Seeding: 02k-Muster (Batterie-Revision mit Datenblatt-Asset VOR der
 * Angebotserstellung, EIGENER Dateiname — 02k/02k2 sind reihenfolgefrei,
 * jede Spec bindet die bei IHRER Angebotserstellung aktuelle Revision) +
 * zusaetzlich Storage-Seed via `put` (NICHT putImmutable — Katalog-Keys
 * sind nicht immutable-praefiziert) ins Server-Verzeichnis
 * (<privateDirectory>/storage, neben serverLogPath).
 */

const DATASHEET_FILENAME = "f702k2-datenblatt-batterie.pdf";
const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n",
  "utf8",
);
const DATASHEET_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

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
 * Revision das 02k2-Datenblatt-Asset (sha der echten PDF-Bytes) trägt
 * (02k-Muster; eigener Dateiname → reihenfolgefrei zu 02k).
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
    if (!battery) throw new Error("F7-02K2-E2E: M2-01-Batterie fehlt.");
    const current = battery.revision_snapshot.presentation.datasheet;
    if (
      current?.originalFilename === DATASHEET_FILENAME
      && current?.sha256 === DATASHEET_SHA256
    ) {
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

test("F7-02K2-E2E: Datenblatt-Download je Referenz, ehrlicher Fallback ohne Bindung", async ({ page }) => {
  test.setTimeout(240_000);
  const m201 = runtimeState();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const serverLogOffset = statSync(m201.serverLogPath).size;

  // Datenblatt-Asset VOR Zusatzprojekt + Angebotserstellung seeden, damit
  // der versiegelte Snapshot es enthält (02k-Muster) …
  await ensureM201BatteryDatasheet(m201);
  // … und die Bytes ins Server-Storage legen (`put`, NICHT putImmutable).
  process.env.STORAGE_BACKEND = "local";
  process.env.STORAGE_LOCAL_DIR = join(dirname(m201.serverLogPath), "storage");
  const objectKey = [
    "catalog",
    m201.workspaceId,
    m201.m201BatteryId,
    `${DATASHEET_SHA256}.pdf`,
  ].join("/");
  await resolveObjectStorage().put(objectKey, PDF_BYTES, "application/pdf");

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
    if (!row) throw new Error("F7-02K2-E2E: eigenes Angebot fehlt.");
    return row;
  });

  const expectedRefs = await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId });
    await setInstallationVariant(tx, ctx, { projectId, variantId: offer.variantId });
    const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
    if (!workbook) throw new Error("F7-02K2-E2E: Workbook fehlt nach Bindung.");
    return projectWorkbookDatasheets(workbook.sections);
  });
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
  const downloadHref =
    `/api/workspaces/${m201.workspaceId}/projects/${projectId}/checkliste/datenblatt`
    + `?componentId=${m201.m201BatteryId}`;
  const downloadLabel = `PDF herunterladen: ${batteryLabel}`;

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
  await item.getByLabel("Typ").selectOption("datasheets");

  // E-01: Download-Link je Referenz sichtbar neben dem Katalog-Link
  // (Bestand unveraendert).
  const catalogLink = item.getByRole("link", { name: batteryLabel, exact: true });
  await expect(catalogLink).toBeVisible();
  await expect(catalogLink).toHaveAttribute("href", batteryHref);
  const downloadLink = item.getByRole("link", { name: downloadLabel, exact: true });
  await expect(downloadLink).toBeVisible();
  await expect(downloadLink).toHaveAttribute("href", downloadHref);
  await expect(downloadLink).toHaveText("PDF herunterladen");
  await expect(item.getByText("Keine Datenblätter verfügbar.", { exact: true })).toHaveCount(0);

  // E-02: Klick → Download-Event, Bytes bytegleich, Dateiname + attachment.
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(DATASHEET_FILENAME);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const downloaded = readFileSync(downloadPath as string);
  expect(downloaded.equals(PDF_BYTES)).toBe(true);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(DATASHEET_SHA256);
  const headerProbe = await page.request.get(downloadHref);
  expect(headerProbe.status()).toBe(200);
  expect(headerProbe.headers()["content-type"]).toBe("application/pdf");
  expect(headerProbe.headers()["content-disposition"] ?? "").toMatch(/^attachment;/u);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-06: Reload stabil (Download-Link + Katalog-Link bleiben).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const reloaded = page.locator("li", { hasText: batteryLabel }).first();
  await expect(reloaded.getByRole("link", { name: downloadLabel, exact: true }))
    .toHaveAttribute("href", downloadHref);
  await expect(reloaded.getByRole("link", { name: batteryLabel, exact: true }))
    .toHaveAttribute("href", batteryHref);

  // E-03: Viewer (beide Leserechte) laedt die Bytes identisch.
  const viewer = await createM201RedactedViewer(m201);
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, viewer.email, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerItem = page.locator("li", { hasText: batteryLabel }).first();
  await expect(viewerItem.getByRole("link", { name: downloadLabel, exact: true })).toBeVisible();
  const viewerProbe = await page.request.get(downloadHref);
  expect(viewerProbe.status()).toBe(200);
  expect(Buffer.from(await viewerProbe.body()).equals(PDF_BYTES)).toBe(true);

  // E-07: Axe auf der Viewer-Sicht (Referenz-Liste + Download-Link).
  await expectNoWcagAaAxeViolations(page, "F7-02K2-Datenblatt-Download");

  // E-04: fremde componentId → 404 (uniform, kein Orakel).
  const foreignProbe = await page.request.get(
    `/api/workspaces/${m201.workspaceId}/projects/${projectId}/checkliste/datenblatt`
    + `?componentId=${randomUUID()}`,
  );
  expect(foreignProbe.status()).toBe(404);

  // E-05: Projekt ohne Bindung → ehrlicher Fallback, kein Link.
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
  await expect(unboundItem.getByRole("link", { name: /PDF herunterladen/u })).toHaveCount(0);

  // E-08: Server-Log ohne Fehler aus diesem Lauf (eigener Offset, F7-16-Muster).
  const serverTail = readFileSync(m201.serverLogPath)
    .subarray(Math.min(serverLogOffset, statSync(m201.serverLogPath).size))
    .toString("utf8");
  expect(serverTail, "kein Routen-Fehler im Server-Log").not.toMatch(/\[checkliste\] datenblatt/u);
  expect(serverTail, "kein Uncaught-Fehler im Server-Log").not.toMatch(/uncaughtException|unhandledRejection/u);

  expect(errors, "Browser-Konsole und Page-Errors des Datenblatt-Downloads").toEqual([]);
});
