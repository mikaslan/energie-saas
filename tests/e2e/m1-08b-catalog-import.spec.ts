import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
} from "../../lib/integrations/catalog/contract";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
  catalogCsvTemplate,
  type CatalogCsvCanonicalField,
} from "../../lib/integrations/catalog/import-contract";
import {
  activateCatalogComponent,
  createCatalogComponent,
} from "../../modules/catalog";
import {
  M2_01_E2E_CONTACT,
  seedM201AdditionalReadyProject,
  seedM201CalculationReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

type E2EState = Readonly<{
  databaseUrl: string;
  editorEmail: string;
  externalEditorEmail: string;
  foreignWorkspaceId: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
  restrictedEditorEmail: string;
  viewerEmail: string;
  workspaceId: string;
}>;

const browserErrors = new WeakMap<Page, string[]>();
const INJECTED_UNAVAILABLE_CONSOLE_ERROR =
  "console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
const TERMINAL_STATES = new Set([
  "succeeded",
  "partial",
  "failed_final",
  "cancelled_before_start",
]);

function state(): E2EState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "editorEmail",
    "externalEditorEmail",
    "foreignWorkspaceId",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
    "restrictedEditorEmail",
    "viewerEmail",
    "workspaceId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M108B-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function catalogPreviewMode(body: Buffer | null): "inspect" | "preview" | null {
  if (!body || body.byteLength < 5) return null;
  const metadataLength = body.readUInt32BE(0);
  if (metadataLength < 1 || body.byteLength <= 4 + metadataLength) return null;
  try {
    const metadata = JSON.parse(body.subarray(4, 4 + metadataLength).toString("utf8")) as {
      mode?: unknown;
    };
    return metadata.mode === "inspect" || metadata.mode === "preview"
      ? metadata.mode
      : null;
  } catch {
    return null;
  }
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
  throw new Error("Der echte M108B-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(
  page: Page,
  email: string,
  expectedTarget: string,
): Promise<void> {
  const data = state();
  await page.waitForURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(expectedTarget);
  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otp = await otpFromPrivateDevMailLog(data.serverLogPath, email, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedTarget);
}

function catalogCsv(
  rowCount: number,
  invalidCount: number,
  skuPrefix: string,
): string {
  const [header, example] = catalogCsvTemplate()
    .replace(/^\uFEFF/u, "")
    .trimEnd()
    .split(/\r?\n/u);
  if (!header || !example) throw new Error("Die kanonische CSV-Vorlage ist leer.");
  const headers = header.split(";");
  const template = example.split(";");
  const column = (name: string): number => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`CSV-Fixturespalte fehlt: ${name}`);
    return index;
  };
  const rows = Array.from({ length: rowCount }, (_, offset) => {
    const ordinal = offset + 1;
    const padded = String(ordinal).padStart(3, "0");
    const values = [...template];
    values[column("internalSku")] = `${skuPrefix}-${padded}`;
    values[column("displayName")] = `Synthetisches CSV-Importprodukt ${padded}`;
    values[column("model")] = `M108B ${padded}`;
    values[column("technicalReference")] = `M108B-TECH-${padded}`;
    values[column("purchaseReference")] = `M108B-EK-${padded}`;
    values[column("salesReference")] = `M108B-VK-${padded}`;
    if (ordinal <= invalidCount) values[column("purchasePriceNet")] = "keine-zahl";
    return values.join(";");
  });
  return `\uFEFF${header}\r\n${rows.join("\r\n")}\r\n`;
}

type CatalogCsvProductFixture = Readonly<{
  componentType: "module" | "inverter" | "battery" | "wallbox";
  displayName: string;
  internalSku: string;
  model: string;
  purchasePriceNet: string;
  purchaseReference: string;
  salesPriceNet: string;
  salesReference: string;
  technical: Partial<Record<CatalogCsvCanonicalField, string>>;
}>;

const CATALOG_TECHNICAL_FIELDS = [
  "nominalPowerWatts",
  "nominalAcPowerWatts",
  "phaseCount",
  "mpptTrackerCount",
  "nominalCapacityWh",
  "usableCapacityWh",
  "maxContinuousPowerWatts",
  "roundTripEfficiencyPercent",
  "backupCapability",
  "maxChargingPowerWatts",
  "connector",
  "bidirectionalCapability",
  "nominalHeatingPowerWatts",
  "scop",
  "systemName",
  "roofTypes",
  "attributes",
] as const satisfies readonly CatalogCsvCanonicalField[];

const M108B_E2E02_PRODUCTS_R1 = [
  {
    internalSku: "M108B-OFFER-MODULE",
    componentType: "module",
    displayName: "M108B importiertes Angebotsmodul",
    model: "Importmodul 400",
    purchasePriceNet: "150,00",
    salesPriceNet: "250,00",
    purchaseReference: "M108B-E2E02-EK-MODULE-R1",
    salesReference: "M108B-E2E02-VK-MODULE-R1",
    technical: { nominalPowerWatts: "400" },
  },
  {
    internalSku: "M108B-OFFER-INVERTER",
    componentType: "inverter",
    displayName: "M108B importierter Angebotswechselrichter",
    model: "Importwechselrichter 10000",
    purchasePriceNet: "1000,00",
    salesPriceNet: "1500,00",
    purchaseReference: "M108B-E2E02-EK-INVERTER-R1",
    salesReference: "M108B-E2E02-VK-INVERTER-R1",
    technical: {
      nominalAcPowerWatts: "10000",
      phaseCount: "3",
      mpptTrackerCount: "3",
    },
  },
  {
    internalSku: "M108B-OFFER-BATTERY",
    componentType: "battery",
    displayName: "M108B importierter Angebotsspeicher",
    model: "Importspeicher 8000",
    purchasePriceNet: "2500,00",
    salesPriceNet: "4000,00",
    purchaseReference: "M108B-E2E02-EK-BATTERY-R1",
    salesReference: "M108B-E2E02-VK-BATTERY-R1",
    technical: {
      nominalCapacityWh: "8500",
      usableCapacityWh: "8000",
      maxContinuousPowerWatts: "4000",
      roundTripEfficiencyPercent: "94",
      backupCapability: "known_supported",
    },
  },
  {
    internalSku: "M108B-OFFER-WALLBOX",
    componentType: "wallbox",
    displayName: "M108B importierte Angebotswallbox",
    model: "Importwallbox 11000",
    purchasePriceNet: "600,00",
    salesPriceNet: "1000,00",
    purchaseReference: "M108B-E2E02-EK-WALLBOX-R1",
    salesReference: "M108B-E2E02-VK-WALLBOX-R1",
    technical: {
      maxChargingPowerWatts: "11000",
      phaseCount: "3",
      connector: "type2_cable",
      bidirectionalCapability: "known_supported",
    },
  },
] as const satisfies readonly CatalogCsvProductFixture[];

const M108B_E2E02_PRODUCTS_R2 = M108B_E2E02_PRODUCTS_R1.map((product) => (
  product.componentType === "battery"
    ? {
        ...product,
        salesPriceNet: "4500,00",
        salesReference: "M108B-E2E02-VK-BATTERY-R2",
      }
    : product
));

const M108B_E2E03_TARGET = {
  internalSku: "ZZZ-M108B-E2E03-TARGET",
  componentType: "module",
  displayName: "M108B Suchmodul hinter Position 200",
  model: "Suchmodul 400",
  purchasePriceNet: "79,00",
  salesPriceNet: "129,00",
  purchaseReference: "M108B-E2E03-EK-TARGET",
  salesReference: "M108B-E2E03-VK-TARGET",
  technical: { nominalPowerWatts: "400" },
} as const satisfies CatalogCsvProductFixture;

function catalogProductCsv(products: readonly CatalogCsvProductFixture[]): string {
  const [header, example] = catalogCsvTemplate()
    .replace(/^\uFEFF/u, "")
    .trimEnd()
    .split(/\r?\n/u);
  if (!header || !example) throw new Error("Die kanonische CSV-Vorlage ist leer.");
  const headers = header.split(";");
  const template = example.split(";");
  const column = (name: CatalogCsvCanonicalField): number => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`CSV-Fixturespalte fehlt: ${name}`);
    return index;
  };
  const rows = products.map((product) => {
    const values = [...template];
    for (const field of CATALOG_TECHNICAL_FIELDS) values[column(field)] = "";
    const common: Partial<Record<CatalogCsvCanonicalField, string>> = {
      internalSku: product.internalSku,
      componentType: product.componentType,
      displayName: product.displayName,
      manufacturer: "WMEE Import-Testwerk",
      model: product.model,
      unit: "piece",
      keyPoints: "Ausschließlich synthetische Browser-Testdaten",
      technicalSourceKind: "workspace_manual",
      technicalReference: `M108B-E2E-TECH-${product.internalSku}`,
      technicalObservedOn: "2026-08-31",
      technicalRightsBasis: "workspace_owned",
      purchasePriceNet: product.purchasePriceNet,
      purchaseSourceKind: "supplier_price_list",
      purchaseReference: product.purchaseReference,
      purchaseObservedOn: "2026-08-31",
      purchaseRightsBasis: "supplier_authorized",
      salesPriceNet: product.salesPriceNet,
      salesSourceKind: "workspace_pricing",
      salesReference: product.salesReference,
      salesObservedOn: "2026-08-31",
      salesRightsBasis: "workspace_owned",
      ...product.technical,
    };
    for (const [field, value] of Object.entries(common)) {
      if (value !== undefined) values[column(field as CatalogCsvCanonicalField)] = value;
    }
    return values.join(";");
  });
  return `\uFEFF${header}\r\n${rows.join("\r\n")}\r\n`;
}

function m201RuntimeState(data: E2EState): M201RuntimeState {
  return {
    databaseUrl: data.databaseUrl,
    editorEmail: data.m201EditorEmail,
    editorIdentityId: data.m201EditorIdentityId,
    m201BatteryId: data.m201BatteryId,
    m201InverterId: data.m201InverterId,
    m201ModuleId: data.m201ModuleId,
    m201ProjectId: data.m201ProjectId,
    m201WallboxId: data.m201WallboxId,
    serverLogPath: data.serverLogPath,
    workspaceId: data.m201WorkspaceId,
  };
}

type CatalogImportTerminalEvidence = Readonly<{
  completedDispatchCount: number;
  state: string;
}>;

async function waitForCatalogImportWorker(
  databaseUrl: string,
  workspaceId: string,
  importId: string,
): Promise<CatalogImportTerminalEvidence> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const deadline = Date.now() + 60_000;
    let lastEvidence: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const result = await pool.query<{
        completed_dispatch_count: number;
        consecutive_failure_count: number;
        error_code: string | null;
        lease_generation: string;
        lease_recovery_dispatch_count: number;
        queue_states: string[];
        state: string;
        unexpected_open_dispatch_count: number;
      }>(`
        select domain.state, domain.error_code, domain.consecutive_failure_count,
               domain.lease_generation::text as lease_generation,
               count(queue.id) filter (
                 where queue.state::text = 'completed'
               )::int as completed_dispatch_count,
               count(queue.id) filter (
                 where queue.state::text in ('created', 'retry', 'active')
                   and queue.singleton_key like domain.id::text || ':lease:%'
               )::int as lease_recovery_dispatch_count,
               count(queue.id) filter (
                 where queue.state::text in ('created', 'retry', 'active')
                   and queue.singleton_key not like domain.id::text || ':lease:%'
               )::int as unexpected_open_dispatch_count,
               coalesce(
                 array_agg(queue.state::text order by queue.created_on)
                   filter (where queue.id is not null),
                 '{}'::text[]
               ) as queue_states
          from public.catalog_import_job domain
          left join pgboss.job queue
            on queue.name = 'catalog.import.v1'
           and queue.data = jsonb_build_object(
             'schemaVersion', 'catalog-import-dispatch.v1',
             'workspaceId', domain.workspace_id::text,
             'importId', domain.id::text
           )
         where domain.workspace_id = $1::uuid
           and domain.id = $2::uuid
         group by domain.state, domain.error_code,
                  domain.consecutive_failure_count, domain.lease_generation
      `, [workspaceId, importId]);
      const current = result.rows[0];
      if (!current) throw new Error("M108B-E2E-Importjob fehlt.");
      lastEvidence = current;
      if (
        TERMINAL_STATES.has(current.state)
        && current.completed_dispatch_count > 0
        && current.unexpected_open_dispatch_count === 0
      ) {
        return {
          completedDispatchCount: current.completed_dispatch_count,
          state: current.state,
        };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(
      `M108B-E2E-Workerhost erreichte keinen belegten Terminalzustand: ${JSON.stringify(lastEvidence)}`,
    );
  } finally {
    await pool.end();
  }
}

async function expectNoSeriousOrCriticalAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    }));
  expect(blocking).toEqual([]);
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

function maximumCssDurationSeconds(value: string): number {
  return Math.max(...value.split(",").map((part) => {
    const normalized = part.trim();
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) throw new Error(`Ungültige CSS-Dauer: ${normalized}`);
    return normalized.endsWith("ms") ? numeric / 1_000 : numeric;
  }));
}

async function expectNoHorizontalDocumentOverflow(page: Page, width: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: width, scrollWidth: width });
}

async function consumeInjectedUnavailableConsoleError(page: Page): Promise<void> {
  const errors = browserErrors.get(page);
  if (!errors) throw new Error("M108B Browserfehler-Speicher fehlt.");
  await expect.poll(() => errors.filter((error) =>
    error === INJECTED_UNAVAILABLE_CONSOLE_ERROR).length).toBe(1);
  const expectedIndex = errors.indexOf(INJECTED_UNAVAILABLE_CONSOLE_ERROR);
  errors.splice(expectedIndex, 1);
}

async function uploadAndInspect(page: Page, filename: string, contents: string): Promise<void> {
  const fileInput = page.getByLabel("CSV-Datei");
  await expect(page.locator('[data-catalog-import-hydrated="true"]')).toBeVisible();
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({
    name: filename,
    mimeType: "text/csv",
    buffer: Buffer.from(contents, "utf8"),
  });
  await expect.poll(() => fileInput.evaluate((input: HTMLInputElement) => (
    input.files?.length ?? 0
  ))).toBe(1);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/katalog/import/preview"));
  await page.getByRole("button", { name: "Datei prüfen", exact: true }).click();
  const response = await responsePromise;
  const responseBody = await response.text();
  expect(response.status(), `Inspect-Antwort: ${responseBody.slice(0, 1_000)}`).toBe(200);
  expect(JSON.parse(responseBody) as unknown).toMatchObject({ status: "inspected" });
  await expect(page.locator('[data-catalog-import-page-state="inspected"]')).toBeVisible();
  await expect(page.getByText("Alle gemeinsamen Pflichtfelder sind zugeordnet.", {
    exact: true,
  })).toBeVisible();
}

type PreparedCatalogImport = Readonly<{
  detailPath: string;
  importId: string;
}>;

type ResolutionEvidence = Readonly<{
  id: string;
  resolutionSha256: string;
  revision: number;
  snapshotText: string;
  lines: readonly Readonly<{
    catalogComponentId: string;
    catalogComponentRevision: number;
    componentSnapshotSha256: string;
    internalSku: string;
    position: number;
    quantity: number;
  }>[];
}>;

type OfferEvidence = Readonly<{
  basisGrossCents: string;
  basisNetCents: string;
  basisTaxCents: string;
  id: string;
  resolutionRevision: number;
  resolutionSha256: string;
  revision: number;
  snapshotSha256: string;
  snapshotText: string;
  lines: readonly Readonly<{
    catalogComponentId: string;
    catalogComponentRevision: number;
    componentSnapshotSha256: string;
    effectivePurchaseUnitNetCents: string;
    effectiveSalesUnitNetCents: string;
    finalSalesNetCents: string;
    originalPurchaseUnitNetCents: string;
    originalSalesUnitNetCents: string;
    purchaseNetCents: string;
    quantityMilli: number;
  }>[];
}>;

async function prepareCatalogImport(
  page: Page,
  workspaceId: string,
  filename: string,
  contents: string,
): Promise<PreparedCatalogImport> {
  await page.goto(`/w/${workspaceId}/katalog/import`);
  await uploadAndInspect(page, filename, contents);
  await page.getByRole("button", { name: "Vorschau erstellen", exact: true }).click();
  await page.waitForURL((url) => /\/katalog\/importe\/[0-9a-f-]+$/u.test(url.pathname));
  const detailPath = new URL(page.url()).pathname;
  const importId = detailPath.split("/").at(-1);
  if (!importId) throw new Error("M108B-E2E-Import-ID fehlt in der URL.");
  await expect(page.locator('[data-catalog-import-detail-state="ready_for_review"]'))
    .toBeVisible();
  return { detailPath, importId };
}

async function startPreparedCatalogImport(
  page: Page,
  data: M201RuntimeState,
  prepared: PreparedCatalogImport,
  expectedState: "succeeded" | "failed_final",
): Promise<CatalogImportTerminalEvidence> {
  if (new URL(page.url()).pathname !== prepared.detailPath) {
    await page.goto(prepared.detailPath);
  }
  await page.getByLabel(CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT).check();
  await page.getByRole("button", { name: "Import starten", exact: true }).click();
  await expect(page.locator('[data-catalog-import-detail-state="queued"]')).toBeVisible();
  const evidence = await waitForCatalogImportWorker(
    data.databaseUrl,
    data.workspaceId,
    prepared.importId,
  );
  expect(evidence.state).toBe(expectedState);
  await page.reload();
  await expect(page.locator(
    `[data-catalog-import-detail-state="${expectedState}"]`,
  )).toBeVisible();
  return evidence;
}

function importRow(page: Page, displayName: string) {
  return page.locator("ol > li").filter({
    has: page.getByRole("heading", { name: displayName, exact: true, level: 3 }),
  });
}

async function expectImportMetric(
  page: Page,
  label: "Neu" | "Revidiert" | "Unverändert" | "Konflikte",
  expected: number,
): Promise<void> {
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Zeilen und Ergebnisse", level: 2 }),
  });
  const metric = section.locator("dl > div").filter({
    has: page.getByText(label, { exact: true }),
  });
  await expect(metric.locator("dd")).toHaveText(String(expected));
}

async function resultProductHref(page: Page, displayName: string): Promise<string> {
  const href = await importRow(page, displayName)
    .getByRole("link", { name: "Ergebnisprodukt öffnen" })
    .getAttribute("href");
  if (!href) throw new Error(`M108B-E2E-Ergebnislink fehlt: ${displayName}`);
  return href;
}

function componentIdFromHref(href: string): string {
  const componentId = href.split("/").at(-1);
  if (!componentId || !/^[0-9a-f-]{36}$/u.test(componentId)) {
    throw new Error(`M108B-E2E-Produkt-ID fehlt im Link: ${href}`);
  }
  return componentId;
}

async function expectComponentRevision(page: Page, revision: number): Promise<void> {
  const identity = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Identität", level: 2 }),
  });
  const revisionItem = identity.locator("dl > div").filter({
    has: page.getByText("Revision", { exact: true }),
  });
  await expect(revisionItem.locator("dd")).toHaveText(String(revision));
}

async function activateImportedProduct(
  page: Page,
  href: string,
  displayName: string,
  revision: number,
): Promise<void> {
  await page.goto(href);
  await expect(page.locator('[data-catalog-component-state="draft_priced"]')).toBeVisible();
  await expect(page.getByRole("heading", {
    name: displayName,
    exact: true,
    level: 1,
  })).toBeVisible();
  await expectComponentRevision(page, revision);
  const lifecycle = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Lifecycle", level: 2 }),
  });
  await lifecycle.getByRole("button", { name: "Aktivieren" }).click();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
}

async function archiveAndReturnImportedProductToDraft(
  page: Page,
  href: string,
): Promise<void> {
  await page.goto(href);
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  const lifecycle = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Lifecycle", level: 2 }),
  });
  await lifecycle.getByRole("button", { name: "Produkt archivieren" }).click();
  await expect(page.locator('[data-catalog-component-state="archived"]')).toBeVisible();
  await lifecycle.getByRole("button", { name: "Zurück in Entwurf" }).click();
  await expect(page.locator('[data-catalog-component-state="draft_priced"]')).toBeVisible();
}

async function resolveProjectProducts(
  page: Page,
  workspaceId: string,
  projectId: string,
  selections: readonly Readonly<{ displayName: string; quantity: string }>[],
  expectedRevision: number,
): Promise<void> {
  const productsPath = `/w/${workspaceId}/anfragen/${projectId}/produkte`;
  await page.goto(productsPath);
  for (const selection of selections) {
    const checkbox = page.getByRole("checkbox", {
      name: new RegExp(escapeRegExp(selection.displayName), "u"),
    });
    await checkbox.check();
    await page.getByLabel(`Menge für ${selection.displayName}`, { exact: true })
      .fill(selection.quantity);
  }
  await expect(page.getByRole("list", { name: "Auswahlblocker" })).toHaveCount(0);
  const acknowledgements = page.getByRole("group", {
    name: "Abweichungen bewusst bestätigen",
  });
  for (const checkbox of await acknowledgements.getByRole("checkbox").all()) {
    await checkbox.check();
  }
  await page.getByRole("button", { name: "Projektauflösung bestätigen" }).click();
  await expect(page.getByText(
    `Projektauflösung Revision ${expectedRevision} wurde revisionssicher bestätigt.`,
    { exact: true },
  )).toBeVisible();
}

async function createOfferForProject(
  page: Page,
  workspaceId: string,
  projectId: string,
): Promise<Readonly<{ offerId: string; variantId: string }>> {
  await page.goto(`/w/${workspaceId}/anfragen/${projectId}`);
  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 }))
    .toBeVisible();
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("13000");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) => (
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante")
  ));
  const url = new URL(page.url());
  const offerId = url.pathname.split("/").at(-1);
  const variantId = url.searchParams.get("variante");
  if (!offerId || !variantId) throw new Error("M108B-E2E-Angebotsidentität fehlt.");
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
  return { offerId, variantId };
}

async function createNewOfferBasis(
  page: Page,
  workspaceId: string,
  offerId: string,
  previousVariantId: string,
  name: string,
): Promise<string> {
  const detailPath = `/w/${workspaceId}/angebote/${offerId}`;
  await page.goto(`${detailPath}?variante=${previousVariantId}`);
  await expect(page.getByRole("alert").filter({
    hasText: "Die Projektgrundlage ist nicht mehr aktuell.",
  })).toBeVisible();
  await expect(page.getByText(
    "Der gespeicherte Snapshot bleibt unverändert. Eine neue Basis ist eine eigene Variante.",
    { exact: true },
  )).toBeVisible();
  const basis = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neue Basis", exact: true }),
  });
  await basis.getByLabel("Variantenname").fill(name);
  await basis.getByLabel("Steuerentwurf").selectOption("standard_19");
  await basis.getByRole("button", { name: "Neue Basis anlegen" }).click();
  await page.waitForURL((url) => (
    url.pathname === detailPath
    && url.searchParams.has("variante")
    && url.searchParams.get("variante") !== previousVariantId
  ));
  const variantId = new URL(page.url()).searchParams.get("variante");
  if (!variantId) throw new Error("M108B-E2E-neue Basis-ID fehlt.");
  return variantId;
}

async function readResolutionEvidence(
  data: M201RuntimeState,
  projectId: string,
  revision: number,
): Promise<ResolutionEvidence> {
  return withM201Database(data, async (tx) => {
    const header = await tx.execute<{
      id: string;
      resolutionSha256: string;
      revision: number;
      snapshotText: string;
      [key: string]: unknown;
    }>(sql`
      select id, revision, resolution_snapshot::text as "snapshotText",
             encode(resolution_sha256, 'hex') as "resolutionSha256"
        from project_catalog_resolution
       where workspace_id = ${data.workspaceId}::uuid
         and project_id = ${projectId}::uuid
         and revision = ${revision}
    `);
    const current = header.rows[0];
    if (!current) throw new Error(`M108B-E2E-Resolution ${revision} fehlt.`);
    const lines = await tx.execute<{
      catalogComponentId: string;
      catalogComponentRevision: number;
      componentSnapshotSha256: string;
      internalSku: string;
      position: number;
      quantity: number;
      [key: string]: unknown;
    }>(sql`
      select line.position, line.quantity,
             line.catalog_component_id as "catalogComponentId",
             line.catalog_component_revision as "catalogComponentRevision",
             encode(line.component_snapshot_sha256, 'hex')
               as "componentSnapshotSha256",
             component.internal_sku as "internalSku"
        from project_catalog_resolution_line line
        join catalog_component component
          on component.workspace_id = line.workspace_id
         and component.id = line.catalog_component_id
       where line.workspace_id = ${data.workspaceId}::uuid
         and line.resolution_id = ${current.id}::uuid
       order by line.position
    `);
    return { ...current, lines: lines.rows };
  });
}

async function readOfferEvidence(
  data: M201RuntimeState,
  offerId: string,
  variantId: string,
): Promise<OfferEvidence> {
  return withM201Database(data, async (tx) => {
    const header = await tx.execute<{
      basisGrossCents: string;
      basisNetCents: string;
      basisTaxCents: string;
      id: string;
      resolutionRevision: number;
      resolutionSha256: string;
      revision: number;
      snapshotSha256: string;
      snapshotText: string;
      [key: string]: unknown;
    }>(sql`
      select revision.id, revision.revision,
             revision.resolution_revision as "resolutionRevision",
             encode(revision.resolution_sha256, 'hex') as "resolutionSha256",
             encode(revision.snapshot_sha256, 'hex') as "snapshotSha256",
             revision.revision_snapshot::text as "snapshotText",
             revision.basis_net_cents::text as "basisNetCents",
             revision.basis_tax_cents::text as "basisTaxCents",
             revision.basis_gross_cents::text as "basisGrossCents"
        from offer_variant variant
        join offer_variant_revision revision
          on revision.workspace_id = variant.workspace_id
         and revision.offer_id = variant.offer_id
         and revision.variant_id = variant.id
         and revision.revision = variant.current_revision
       where variant.workspace_id = ${data.workspaceId}::uuid
         and variant.offer_id = ${offerId}::uuid
         and variant.id = ${variantId}::uuid
    `);
    const current = header.rows[0];
    if (!current) throw new Error("M108B-E2E-Angebotsrevision fehlt.");
    const lines = await tx.execute<{
      catalogComponentId: string;
      catalogComponentRevision: number;
      componentSnapshotSha256: string;
      effectivePurchaseUnitNetCents: string;
      effectiveSalesUnitNetCents: string;
      finalSalesNetCents: string;
      originalPurchaseUnitNetCents: string;
      originalSalesUnitNetCents: string;
      purchaseNetCents: string;
      quantityMilli: number;
      [key: string]: unknown;
    }>(sql`
      select catalog_component_id as "catalogComponentId",
             catalog_component_revision as "catalogComponentRevision",
             encode(component_snapshot_sha256, 'hex') as "componentSnapshotSha256",
             quantity_milli as "quantityMilli",
             original_purchase_unit_net_cents::text
               as "originalPurchaseUnitNetCents",
             effective_purchase_unit_net_cents::text
               as "effectivePurchaseUnitNetCents",
             original_sales_unit_net_cents::text as "originalSalesUnitNetCents",
             effective_sales_unit_net_cents::text as "effectiveSalesUnitNetCents",
             final_sales_net_cents::text as "finalSalesNetCents",
             purchase_net_cents::text as "purchaseNetCents"
        from offer_bom_line
       where workspace_id = ${data.workspaceId}::uuid
         and revision_id = ${current.id}::uuid
         and source_kind = 'catalog'
       order by catalog_component_id
    `);
    return { ...current, lines: lines.rows };
  });
}

function paddingModuleCommand(index: number): CatalogComponentCreateCommandV1 {
  const padded = String(index).padStart(3, "0");
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: `AAA-M108B-E2E03-PAD-${padded}`,
    componentType: "module",
    presentation: {
      displayName: `M108B synthetisches Suchpadding ${padded}`,
      manufacturer: "WMEE Testwerk",
      model: `Padding ${padded}`,
      unit: "piece",
      keyPoints: ["Ausschließlich synthetische Browser-Testdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 400 },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 7_900,
      salesPriceNetCents: 12_900,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `M108B-E2E03-PAD-EK-${padded}`,
        observedOn: "2026-08-31",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `M108B-E2E03-PAD-VK-${padded}`,
        observedOn: "2026-08-31",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `M108B-E2E03-PAD-TECH-${padded}`,
      observedOn: "2026-08-31",
      rightsBasis: "workspace_owned",
      sourceDocumentSha256: null,
    },
  };
}

async function seedActiveCatalogPadding(
  data: M201RuntimeState,
  count: number,
): Promise<void> {
  await withM201Database(data, async (tx, ctx) => {
    const existing = await tx.execute<{
      activeCount: number;
      totalCount: number;
      [key: string]: unknown;
    }>(sql`
      select count(*)::int as "totalCount",
             count(*) filter (where status = 'active')::int as "activeCount"
        from catalog_component
       where workspace_id = ${data.workspaceId}::uuid
         and internal_sku like 'AAA-M108B-E2E03-PAD-%'
    `);
    const counts = existing.rows[0];
    if (counts?.totalCount === count && counts.activeCount === count) return;
    if ((counts?.totalCount ?? 0) !== 0) {
      throw new Error("M108B-E2E03-Padding ist nur teilweise vorhanden.");
    }
    for (let index = 1; index <= count; index += 1) {
      const created = await createCatalogComponent(tx, ctx, paddingModuleCommand(index));
      await activateCatalogComponent(tx, ctx, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      });
    }
  });
}

async function readActiveCatalogOrdinal(
  data: M201RuntimeState,
  componentId: string,
): Promise<number> {
  return withM201Database(data, async (tx) => {
    const result = await tx.execute<{
      ordinal: number;
      [key: string]: unknown;
    }>(sql`
      select ranked.ordinal
        from (
          select id,
                 row_number() over (
                   order by status, component_type, internal_sku, id
                 )::int as ordinal
            from catalog_component
           where workspace_id = ${data.workspaceId}::uuid
             and status = 'active'
        ) ranked
       where ranked.id = ${componentId}::uuid
    `);
    const ordinal = result.rows[0]?.ordinal;
    if (ordinal === undefined) throw new Error("M108B-E2E03-Zielrang fehlt.");
    return ordinal;
  });
}

async function readImportIdentity(
  data: M201RuntimeState,
  importId: string,
): Promise<Readonly<{
  fileSha256: string;
  intentId: string;
  mappingSha256: string;
}>> {
  return withM201Database(data, async (tx) => {
    const result = await tx.execute<{
      fileSha256: string;
      intentId: string;
      mappingSha256: string;
      [key: string]: unknown;
    }>(sql`
      select intent_id as "intentId",
             encode(file_sha256, 'hex') as "fileSha256",
             encode(mapping_sha256, 'hex') as "mappingSha256"
        from catalog_import_job
       where workspace_id = ${data.workspaceId}::uuid
         and id = ${importId}::uuid
    `);
    const identity = result.rows[0];
    if (!identity) throw new Error("M108B-E2E-Importidentität fehlt.");
    return identity;
  });
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
  expect(browserErrors.get(page) ?? [], "M108B Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe.configure({ mode: "serial" });

test("M108B-E2E-01: 93/7 CSV, Intent-Replay, Worker, Report und Pagination", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.editorEmail, importPath);
  await expect(page.getByRole("heading", {
    name: "Produktkatalog aus CSV vorbereiten",
    level: 1,
  })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  let hidPreparedResponse = false;
  await page.route("**/katalog/import/preview", async (route) => {
    if (catalogPreviewMode(route.request().postDataBuffer()) !== "preview") {
      await route.continue();
      return;
    }
    // Playwright's route.fetch omits this browser-owned header. Preserve the
    // endpoint's fail-closed same-origin contract during response fault injection.
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        "sec-fetch-site": "same-origin",
      },
    });
    const body = await response.body();
    let payload: unknown = null;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      // Der echte Endpunkt bestimmt weiterhin Status und Inhalt.
    }
    if (
      !hidPreparedResponse
      && payload !== null
      && typeof payload === "object"
      && !Array.isArray(payload)
      && (payload as { status?: unknown }).status === "prepared"
    ) {
      hidPreparedResponse = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: { code: "unavailable" } }),
      });
      return;
    }
    await route.fulfill({ response, body });
  });

  await uploadAndInspect(
    page,
    "m108b-93-von-100.csv",
    catalogCsv(100, 7, "M108B-E2E-A"),
  );
  await page.getByRole("button", { name: "Vorschau erstellen", exact: true }).click();
  await expect(page.locator('[data-catalog-import-page-state="error"]')).toBeVisible();
  await expect(page.getByText("Der Importdienst ist vorübergehend nicht verfügbar.", {
    exact: true,
  })).toBeVisible();
  await consumeInjectedUnavailableConsoleError(page);

  await page.getByRole("button", { name: "Vorschau erstellen", exact: true }).click();
  await expect(page.locator('[data-catalog-import-page-state="replayed"]')).toBeVisible();
  await expect(page.getByText(/Dieser identische Importversuch existiert bereits/u)).toBeVisible();
  const existingImportLink = page.getByRole("link", { name: "Bestehenden Import öffnen" });
  const detailHref = await existingImportLink.getAttribute("href");
  expect(detailHref).toMatch(/^\/w\/[0-9a-f-]+\/katalog\/importe\/[0-9a-f-]+$/u);
  await page.unroute("**/katalog/import/preview");
  await existingImportLink.click();
  await page.waitForURL((url) => url.pathname === detailHref);
  const importId = new URL(page.url()).pathname.split("/").at(-1);
  if (!importId) throw new Error("M108B-E2E-Import-ID fehlt in der URL.");

  await expect(page.locator('[data-catalog-import-detail-state="ready_for_review"]')).toBeVisible();
  const counts = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Zeilen und Ergebnisse", level: 2 }),
  });
  const validCount = counts.locator("dl").first().locator("div").filter({
    has: page.getByText("Valide", { exact: true }),
  }).getByText("93", { exact: true });
  await expect(counts.getByText("100", { exact: true })).toBeVisible();
  await expect(validCount).toBeVisible();
  await expect(counts.getByText("7", { exact: true })).toBeVisible();
  await expect(page.getByText("invalid_money", { exact: true })).toHaveCount(7);
  await expect(page.getByText("Datenzeilen 1–100 von 100", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Nächste 100" })).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Fehlerbericht herunterladen" }).click();
  const download = await downloadPromise;
  const reportPath = await download.path();
  if (!reportPath) throw new Error("M108B-E2E-Fehlerreport wurde nicht gespeichert.");
  const report = readFileSync(reportPath, "utf8");
  expect(report).toContain("Zeile;Feld;Quellspalte;Code;Meldung");
  expect(report.match(/invalid_money/gu)).toHaveLength(7);

  await page.getByLabel(CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT).check();
  const startRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === detailHref);
  await page.getByRole("button", { name: "Import starten", exact: true }).click();
  const startRequest = await startRequestPromise;
  expect(
    startRequest.headers()["next-action"],
    `Importstart muss als Next-Action gesendet werden; Content-Type: ${startRequest.headers()["content-type"] ?? "fehlt"}.`,
  ).toBeDefined();
  await expect(page.locator('[data-catalog-import-detail-state="queued"]')).toBeVisible();
  expect(await waitForCatalogImportWorker(
    data.databaseUrl,
    data.workspaceId,
    importId,
  )).toEqual({ completedDispatchCount: 4, state: "partial" });
  await page.reload();
  await expect(page.locator('[data-catalog-import-detail-state="partial"]')).toBeVisible();
  await expect(validCount).toBeVisible();
  await expect(page.getByRole("link", { name: "Ergebnisprodukt öffnen" })).toHaveCount(93);

  await page.getByRole("link", { name: "Ergebnisprodukt öffnen" }).first().click();
  await expect(page.locator('[data-catalog-component-state="draft_priced"]')).toBeVisible();
  await expect(page.getByText("Entwurf", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Synthetisches CSV-Importprodukt 008",
    level: 1,
  })).toBeVisible();

  await page.goto(importPath);
  await uploadAndInspect(
    page,
    "m108b-pagination-101.csv",
    catalogCsv(101, 0, "M108B-E2E-B"),
  );
  await page.getByRole("button", { name: "Vorschau erstellen", exact: true }).click();
  await page.waitForURL((url) => /\/katalog\/importe\/[0-9a-f-]+$/u.test(url.pathname));
  await expect(page.getByText("Datenzeilen 1–100 von 101", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Nächste 100" }).click();
  await page.waitForURL((url) => url.searchParams.get("after") === "101");
  await expect(page.getByText("Datenzeilen 101–101 von 101", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Nächste 100" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Vorherige 100" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 390, scrollWidth: 390 });
});

test("M108B-E2E-02: Importprodukte erreichen Resolution und unveränderliche Basis-BOM", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const serialized = state();
  const data = m201RuntimeState(serialized);
  const projectId = await seedM201CalculationReadyProject(data);
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.editorEmail, importPath);

  const initial = await prepareCatalogImport(
    page,
    data.workspaceId,
    "m108b-e2e02-basis-r1.csv",
    catalogProductCsv(M108B_E2E02_PRODUCTS_R1),
  );
  for (const product of M108B_E2E02_PRODUCTS_R1) {
    await expect(importRow(page, product.displayName).getByText("Neu", { exact: true }))
      .toBeVisible();
  }
  await startPreparedCatalogImport(page, data, initial, "succeeded");
  await expectImportMetric(page, "Neu", 4);
  await expectImportMetric(page, "Revidiert", 0);

  const productHrefs = new Map<string, string>();
  const componentIds = new Map<string, string>();
  for (const product of M108B_E2E02_PRODUCTS_R1) {
    const href = await resultProductHref(page, product.displayName);
    productHrefs.set(product.internalSku, href);
    componentIds.set(product.internalSku, componentIdFromHref(href));
  }
  for (const product of M108B_E2E02_PRODUCTS_R1) {
    await activateImportedProduct(
      page,
      productHrefs.get(product.internalSku)!,
      product.displayName,
      1,
    );
  }

  const productsPath = `/w/${data.workspaceId}/anfragen/${projectId}/produkte`;
  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="pending"]')).toBeVisible();
  await resolveProjectProducts(
    page,
    data.workspaceId,
    projectId,
    M108B_E2E02_PRODUCTS_R1.map((product) => ({
      displayName: product.displayName,
      quantity: product.componentType === "module" ? "26" : "1",
    })),
    1,
  );
  await page.reload();
  await expect(page.locator('[data-catalog-resolution-state="current"]')).toBeVisible();
  await expect(page.getByText("10.400 / 10.400 W", { exact: true })).toBeVisible();
  await expect(page.getByText("8.000 / 8.000 Wh", { exact: true })).toBeVisible();

  const resolutionR1 = await readResolutionEvidence(data, projectId, 1);
  expect(resolutionR1.lines).toHaveLength(4);
  const resolutionR1BySku = new Map(resolutionR1.lines.map((line) => [
    line.internalSku,
    line,
  ]));
  for (const product of M108B_E2E02_PRODUCTS_R1) {
    const line = resolutionR1BySku.get(product.internalSku);
    expect(line).toMatchObject({
      catalogComponentId: componentIds.get(product.internalSku),
      catalogComponentRevision: 1,
      quantity: product.componentType === "module" ? 26 : 1,
    });
  }

  const initialOffer = await createOfferForProject(
    page,
    data.workspaceId,
    projectId,
  );
  const offerR1 = await readOfferEvidence(
    data,
    initialOffer.offerId,
    initialOffer.variantId,
  );
  expect(offerR1).toMatchObject({
    revision: 1,
    resolutionRevision: 1,
    resolutionSha256: resolutionR1.resolutionSha256,
    basisNetCents: "1300000",
    basisTaxCents: "247000",
    basisGrossCents: "1547000",
  });
  expect(offerR1.lines).toHaveLength(4);
  const offerR1ByComponent = new Map(offerR1.lines.map((line) => [
    line.catalogComponentId,
    line,
  ]));
  const expectedR1 = new Map([
    ["M108B-OFFER-MODULE", [26_000, "15000", "25000", "650000", "390000"]],
    ["M108B-OFFER-INVERTER", [1_000, "100000", "150000", "150000", "100000"]],
    ["M108B-OFFER-BATTERY", [1_000, "250000", "400000", "400000", "250000"]],
    ["M108B-OFFER-WALLBOX", [1_000, "60000", "100000", "100000", "60000"]],
  ] as const);
  for (const [sku, expected] of expectedR1) {
    const resolutionLine = resolutionR1BySku.get(sku);
    if (!resolutionLine) throw new Error(`M108B-E2E02-Resolutionzeile fehlt: ${sku}`);
    expect(offerR1ByComponent.get(resolutionLine.catalogComponentId)).toMatchObject({
      catalogComponentRevision: 1,
      componentSnapshotSha256: resolutionLine.componentSnapshotSha256,
      quantityMilli: expected[0],
      originalPurchaseUnitNetCents: expected[1],
      effectivePurchaseUnitNetCents: expected[1],
      originalSalesUnitNetCents: expected[2],
      effectiveSalesUnitNetCents: expected[2],
      finalSalesNetCents: expected[3],
      purchaseNetCents: expected[4],
    });
  }

  const reimport = await prepareCatalogImport(
    page,
    data.workspaceId,
    "m108b-e2e02-basis-r2.csv",
    catalogProductCsv(M108B_E2E02_PRODUCTS_R2),
  );
  for (const product of M108B_E2E02_PRODUCTS_R2) {
    await expect(importRow(page, product.displayName).getByText(
      product.componentType === "battery" ? "Revision" : "Unverändert",
      { exact: true },
    )).toBeVisible();
  }
  await startPreparedCatalogImport(page, data, reimport, "succeeded");
  await expectImportMetric(page, "Revidiert", 1);
  await expectImportMetric(page, "Unverändert", 3);
  expect(componentIdFromHref(await resultProductHref(
    page,
    M108B_E2E02_PRODUCTS_R1[2].displayName,
  ))).toBe(componentIds.get("M108B-OFFER-BATTERY"));

  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="stale"]')).toBeVisible();
  await expect(page.getByText(
    "Mindestens ein Produkt wurde revidiert oder archiviert.",
    { exact: true },
  )).toBeVisible();
  expect(await readResolutionEvidence(data, projectId, 1)).toEqual(resolutionR1);
  expect(await readOfferEvidence(
    data,
    initialOffer.offerId,
    initialOffer.variantId,
  )).toEqual(offerR1);

  await page.goto(
    `/w/${data.workspaceId}/angebote/${initialOffer.offerId}?variante=${initialOffer.variantId}`,
  );
  await expect(page.locator('[data-offer-detail-state="outdated"]')).toBeVisible();
  await expect(page.getByRole("alert").filter({
    hasText: "Die Projektgrundlage ist nicht mehr aktuell.",
  })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Neue Basis", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Neue Basis anlegen" })).toHaveCount(0);

  const batteryHref = productHrefs.get("M108B-OFFER-BATTERY");
  if (!batteryHref) throw new Error("M108B-E2E02-Batterielink fehlt.");
  await activateImportedProduct(
    page,
    batteryHref,
    M108B_E2E02_PRODUCTS_R1[2].displayName,
    2,
  );
  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="stale"]')).toBeVisible();
  await expect(page.getByRole("checkbox", {
    name: new RegExp(escapeRegExp(M108B_E2E02_PRODUCTS_R1[2].displayName), "u"),
  }).locator("..")).toContainText("Rev. 2");
  await resolveProjectProducts(
    page,
    data.workspaceId,
    projectId,
    M108B_E2E02_PRODUCTS_R2.map((product) => ({
      displayName: product.displayName,
      quantity: product.componentType === "module" ? "26" : "1",
    })),
    2,
  );

  const resolutionR2 = await readResolutionEvidence(data, projectId, 2);
  expect(resolutionR2.resolutionSha256).not.toBe(resolutionR1.resolutionSha256);
  const resolutionR2BySku = new Map(resolutionR2.lines.map((line) => [
    line.internalSku,
    line,
  ]));
  expect(resolutionR2BySku.get("M108B-OFFER-BATTERY")).toMatchObject({
    catalogComponentId: componentIds.get("M108B-OFFER-BATTERY"),
    catalogComponentRevision: 2,
    quantity: 1,
  });
  for (const sku of [
    "M108B-OFFER-MODULE",
    "M108B-OFFER-INVERTER",
    "M108B-OFFER-WALLBOX",
  ]) {
    expect(resolutionR2BySku.get(sku)?.catalogComponentRevision).toBe(1);
  }

  const currentBasisVariantId = await createNewOfferBasis(
    page,
    data.workspaceId,
    initialOffer.offerId,
    initialOffer.variantId,
    "M108B Importbasis R2",
  );
  expect(await readResolutionEvidence(data, projectId, 1)).toEqual(resolutionR1);
  expect(await readOfferEvidence(
    data,
    initialOffer.offerId,
    initialOffer.variantId,
  )).toEqual(offerR1);
  const offerR2 = await readOfferEvidence(
    data,
    initialOffer.offerId,
    currentBasisVariantId,
  );
  expect(offerR2).toMatchObject({
    revision: 1,
    resolutionRevision: 2,
    resolutionSha256: resolutionR2.resolutionSha256,
    basisNetCents: "1350000",
    basisTaxCents: "256500",
    basisGrossCents: "1606500",
  });
  expect(offerR2.snapshotSha256).not.toBe(offerR1.snapshotSha256);
  const batteryR2Line = resolutionR2BySku.get("M108B-OFFER-BATTERY");
  if (!batteryR2Line) throw new Error("M108B-E2E02-Batterie R2 fehlt.");
  expect(offerR2.lines.find((line) => (
    line.catalogComponentId === batteryR2Line.catalogComponentId
  ))).toMatchObject({
    catalogComponentRevision: 2,
    componentSnapshotSha256: batteryR2Line.componentSnapshotSha256,
    quantityMilli: 1_000,
    originalPurchaseUnitNetCents: "250000",
    effectivePurchaseUnitNetCents: "250000",
    originalSalesUnitNetCents: "450000",
    effectiveSalesUnitNetCents: "450000",
    finalSalesNetCents: "450000",
    purchaseNetCents: "250000",
  });
});

test("M108B-E2E-03: neues Intent nach Drift und importierte SKU hinter Position 200", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const serialized = state();
  const data = m201RuntimeState(serialized);
  const projectId = await seedM201AdditionalReadyProject(data);
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  const targetCsv = catalogProductCsv([M108B_E2E03_TARGET]);
  await page.goto(importPath);
  await loginWithRealOtp(page, data.editorEmail, importPath);

  const initial = await prepareCatalogImport(
    page,
    data.workspaceId,
    "m108b-e2e03-target.csv",
    targetCsv,
  );
  await expect(importRow(page, M108B_E2E03_TARGET.displayName)
    .getByText("Neu", { exact: true })).toBeVisible();
  await startPreparedCatalogImport(page, data, initial, "succeeded");
  const targetHref = await resultProductHref(page, M108B_E2E03_TARGET.displayName);
  const targetId = componentIdFromHref(targetHref);
  await activateImportedProduct(page, targetHref, M108B_E2E03_TARGET.displayName, 1);
  await seedActiveCatalogPadding(data, 205);
  expect(await readActiveCatalogOrdinal(data, targetId)).toBeGreaterThan(200);

  const drift = await prepareCatalogImport(
    page,
    data.workspaceId,
    "m108b-e2e03-target.csv",
    targetCsv,
  );
  await expect(importRow(page, M108B_E2E03_TARGET.displayName)
    .getByText("Unverändert", { exact: true })).toBeVisible();
  const driftIdentity = await readImportIdentity(data, drift.importId);
  await archiveAndReturnImportedProductToDraft(page, targetHref);
  await startPreparedCatalogImport(page, data, drift, "failed_final");
  await expectImportMetric(page, "Konflikte", 1);
  await expect(page.getByText("Verarbeitungskonflikt: status_drift", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(
    "Alle validen Zeilen kollidieren mit einem neueren Katalogstand.",
    { exact: true },
  )).toBeVisible();

  await activateImportedProduct(page, targetHref, M108B_E2E03_TARGET.displayName, 1);
  const recovered = await prepareCatalogImport(
    page,
    data.workspaceId,
    "m108b-e2e03-target.csv",
    targetCsv,
  );
  await expect(importRow(page, M108B_E2E03_TARGET.displayName)
    .getByText("Unverändert", { exact: true })).toBeVisible();
  await startPreparedCatalogImport(page, data, recovered, "succeeded");
  await expectImportMetric(page, "Unverändert", 1);
  const recoveredIdentity = await readImportIdentity(data, recovered.importId);
  expect(recovered.importId).not.toBe(drift.importId);
  expect(recoveredIdentity.intentId).not.toBe(driftIdentity.intentId);
  expect(recoveredIdentity.fileSha256).toBe(driftIdentity.fileSha256);
  expect(recoveredIdentity.mappingSha256).toBe(driftIdentity.mappingSha256);

  const productsPath = `/w/${data.workspaceId}/anfragen/${projectId}/produkte`;
  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="current"]')).toBeVisible();
  const targetCheckbox = page.getByRole("checkbox", {
    name: new RegExp(escapeRegExp(M108B_E2E03_TARGET.displayName), "u"),
  });
  await expect(targetCheckbox).toHaveCount(0);
  const search = page.getByRole("search");
  await search.getByLabel("Produkt-SKU oder Name suchen").fill(M108B_E2E03_TARGET.internalSku);
  await search.getByRole("button", { name: "Katalog durchsuchen" }).click();
  const searchResults = page.getByRole("region", { name: "Suchergebnisse" });
  await expect(searchResults).toContainText(
    `1 Treffer für „${M108B_E2E03_TARGET.internalSku}“ sind unten auswählbar.`,
  );
  await targetCheckbox.check();
  await page.getByLabel(`Menge für ${M108B_E2E03_TARGET.displayName}`, { exact: true })
    .fill("26");
  await page.getByRole("checkbox", {
    name: /Synthetische M2-01 module-Komponente/u,
  }).uncheck();

  await search.getByLabel("Produkt-SKU oder Name suchen").fill("E2E-M201-INVERTER-2");
  await search.getByRole("button", { name: "Katalog durchsuchen" }).click();
  const selectedProducts = page.getByRole("region", { name: "Ausgewählte Produkte" });
  await expect(selectedProducts).toContainText(M108B_E2E03_TARGET.displayName);
  await expect(targetCheckbox).toBeChecked();
  await expect(page.getByRole("list", { name: "Auswahlblocker" })).toHaveCount(0);
  const acknowledgements = page.getByRole("group", {
    name: "Abweichungen bewusst bestätigen",
  });
  for (const checkbox of await acknowledgements.getByRole("checkbox").all()) {
    await checkbox.check();
  }
  await page.getByRole("button", { name: "Projektauflösung bestätigen" }).click();
  await expect(page.getByText(
    "Projektauflösung Revision 2 wurde revisionssicher bestätigt.",
    { exact: true },
  )).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-catalog-resolution-state="current"]')).toBeVisible();

  const resolution = await readResolutionEvidence(data, projectId, 2);
  const targetResolutionLine = resolution.lines.find((line) => (
    line.catalogComponentId === targetId
  ));
  expect(targetResolutionLine).toMatchObject({
    internalSku: M108B_E2E03_TARGET.internalSku,
    catalogComponentRevision: 1,
    quantity: 26,
  });
  if (!targetResolutionLine) throw new Error("M108B-E2E03-Zielresolution fehlt.");

  const offer = await createOfferForProject(page, data.workspaceId, projectId);
  const evidence = await readOfferEvidence(data, offer.offerId, offer.variantId);
  expect(evidence.resolutionRevision).toBe(2);
  expect(evidence.resolutionSha256).toBe(resolution.resolutionSha256);
  expect(evidence.lines.find((line) => line.catalogComponentId === targetId)).toMatchObject({
    catalogComponentRevision: 1,
    componentSnapshotSha256: targetResolutionLine.componentSnapshotSha256,
    quantityMilli: 26_000,
    originalPurchaseUnitNetCents: "7900",
    effectivePurchaseUnitNetCents: "7900",
    originalSalesUnitNetCents: "12900",
    effectiveSalesUnitNetCents: "12900",
    finalSalesNetCents: "335400",
    purchaseNetCents: "205400",
  });
});

test("M108B-RBAC-01: Viewer und Fremdtenant bleiben am Upload-Gate", async ({ page }) => {
  const data = state();
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.viewerEmail, importPath);
  await expect(page.getByRole("heading", {
    name: "Der CSV-Katalogimport ist für dich nicht freigegeben.",
  })).toBeVisible();
  await expect(page.getByLabel("CSV-Datei")).toHaveCount(0);

  const foreignPath = `/w/${data.foreignWorkspaceId}/katalog/import`;
  await page.goto(foreignPath);
  await expect(page.getByRole("heading", {
    name: "Der CSV-Katalogimport ist für dich nicht freigegeben.",
  })).toBeVisible();
  await expect(page.getByLabel("CSV-Datei")).toHaveCount(0);
});

test("M108B-RBAC-02: Editor ohne Preisrechte bleibt am Upload-Gate", async ({ page }) => {
  const data = state();
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.restrictedEditorEmail, importPath);
  await expect(page.getByRole("heading", {
    name: "Der CSV-Katalogimport ist für dich nicht freigegeben.",
  })).toBeVisible();
  await expect(page.getByLabel("CSV-Datei")).toHaveCount(0);
});

test("M108B-RBAC-03: External-only Editor bleibt am Upload-Gate", async ({ page }) => {
  const data = state();
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.externalEditorEmail, importPath);
  await expect(page.getByRole("heading", {
    name: "Der CSV-Katalogimport ist für dich nicht freigegeben.",
  })).toBeVisible();
  await expect(page.getByLabel("CSV-Datei")).toHaveCount(0);
});

test("M108B-A11Y-01: Tastatur, Fokus, 320-px-Reflow und Reduced Motion", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const importPath = `/w/${data.workspaceId}/katalog/import`;
  await page.goto(importPath);
  await loginWithRealOtp(page, data.editorEmail, importPath);

  const fileInput = page.getByLabel("CSV-Datei");
  const inspectButton = page.getByRole("button", { name: "Datei prüfen", exact: true });
  await expect(page.locator('[data-catalog-import-hydrated="true"]')).toBeVisible();
  await expect(fileInput).toBeEnabled();
  await fileInput.focus();
  await expect(fileInput).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(inspectButton).toBeFocused();
  await page.keyboard.press("Enter");
  const missingFileAlert = page.getByRole("alert").filter({
    hasText: "Wähle zuerst eine CSV-Datei aus.",
  });
  await expect(missingFileAlert).toBeVisible();
  await expect(missingFileAlert).toBeFocused();
  await expectNoWcagAaAxeViolations(page, "Import ohne ausgewählte Datei");

  await uploadAndInspect(
    page,
    "m108b-a11y.csv",
    catalogCsv(1, 0, "M108B-A11Y"),
  );
  await expectNoWcagAaAxeViolations(page, "geprüfte Importzuordnung");

  await page.setViewportSize({ width: 320, height: 900 });
  await expectNoHorizontalDocumentOverflow(page, 320);
  await expectNoWcagAaAxeViolations(page, "400-%-Reflowäquivalent bei 320 CSS px");
  const mappingRegion = page.getByRole("region", { name: "Spaltenzuordnungstabelle" });
  await mappingRegion.evaluate((element) => { element.scrollLeft = 0; });
  await mappingRegion.focus();
  await expect(mappingRegion).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => mappingRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ))).toBe(true);
  const motion = await inspectButton.evaluate((element) => {
    const computed = window.getComputedStyle(element);
    return {
      transitionDuration: computed.transitionDuration,
      animationDuration: computed.animationDuration,
      scrollBehavior: computed.scrollBehavior,
    };
  });
  expect(maximumCssDurationSeconds(motion.transitionDuration)).toBeLessThanOrEqual(0.000_01);
  expect(maximumCssDurationSeconds(motion.animationDuration)).toBeLessThanOrEqual(0.000_01);
  expect(motion.scrollBehavior).toBe("auto");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});
