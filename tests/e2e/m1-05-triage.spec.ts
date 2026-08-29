import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { expect, test, type Locator, type Page } from "playwright/test";
import { withTenantOn } from "../../lib/db/tenant";
import type { TenantTx } from "../../lib/db/types";
import {
  type PlanningCalculationRequestV1,
} from "../../lib/integrations/calculation/contract";
import { calculatePlanningEstimate } from "../../lib/integrations/calculation/engine";
import { buildPlanningCalculationInput } from "../../lib/integrations/calculation/prepare";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentType,
} from "../../lib/integrations/catalog/contract";
import type { ServiceCtx } from "../../lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
} from "../../modules/catalog";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccess,
  persistProjectCalculationInput,
  type ProjectCalculationClaim,
} from "../../modules/energy";
import { M1_06_E2E_ADDRESS, M1_06_E2E_REGION } from "./m1-06-fixture";

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  foreignWorkspaceId: string;
  mainProjectId: string;
  foreignProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  mainContactName: string;
  foreignContactName: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/styles/liberty*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        version: 8,
        name: "M1-06 local empty map style",
        sources: {},
        layers: [],
      }),
    });
  });
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "foreignWorkspaceId",
    "mainProjectId",
    "foreignProjectId",
    "editorEmail",
    "viewerEmail",
    "mainContactName",
    "foreignContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-05-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

async function withEnergyFixtureDatabase<T>(
  callback: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    return await withTenantOn(pool, data.workspaceId, callback);
  } finally {
    await pool.end();
  }
}

const M1_08_CATALOG_FIXTURES = {
  module: "E2E PV-Modul 400 W",
  inverter: "E2E Wechselrichter 10 kW",
  battery: "E2E Speicher 8 kWh",
  wallbox: "E2E Wallbox 11 kW",
} as const;

const M1_08_UI_PRODUCT = {
  sku: "E2E-OTHER-5",
  displayName: "E2E Zusatzkomponente",
  purchaseReference: "E2E-EK-CANARY-5",
  salesReference: "E2E-VK-5",
} as const;

type M1_08_CatalogType = keyof typeof M1_08_CATALOG_FIXTURES;

function catalogFixtureCommand(
  componentType: M1_08_CatalogType,
  index: number,
): CatalogComponentCreateCommandV1 {
  const technicalData = componentType === "module"
    ? { schemaVersion: "module.v1" as const, nominalPowerWatts: 400 }
    : componentType === "inverter"
      ? {
          schemaVersion: "inverter.v1" as const,
          nominalAcPowerWatts: 10_000,
          phaseCount: 3 as const,
          mpptTrackerCount: 3,
        }
      : componentType === "battery"
        ? {
            schemaVersion: "battery.v1" as const,
            nominalCapacityWh: 8_500,
            usableCapacityWh: 8_000,
            maxContinuousPowerWatts: 4_000,
            roundTripEfficiencyBasisPoints: 9_400,
            backupCapability: "known_supported" as const,
          }
        : {
            schemaVersion: "wallbox.v1" as const,
            maxChargingPowerWatts: 11_000,
            phaseCount: 3 as const,
            connector: "type2_cable" as const,
            bidirectionalCapability: "known_supported" as const,
          };
  const technicalProvenance = {
    sourceKind: "workspace_manual" as const,
    reference: `E2E-TECH-${index}`,
    observedOn: "2026-08-29",
    rightsBasis: "workspace_owned" as const,
    sourceDocumentSha256: null,
  };

  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: `E2E-${componentType.toUpperCase()}-${index}`,
    componentType: componentType as CatalogComponentType,
    presentation: {
      displayName: M1_08_CATALOG_FIXTURES[componentType],
      manufacturer: "E2E Testwerk",
      model: `Synthetisches Fixture ${index}`,
      unit: "piece",
      keyPoints: ["Ausschließlich synthetische Testdaten"],
      image: null,
      datasheet: null,
    },
    technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 100_000 + index,
      salesPriceNetCents: 150_000 + index,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `E2E-EK-CANARY-${index}`,
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `E2E-VK-${index}`,
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance,
  };
}

async function seedActiveCatalogFixtures(): Promise<void> {
  const data = state();
  await withEnergyFixtureDatabase(async (tx) => {
    const member = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select identity.id
        from membership
        join user_identity identity on identity.id = membership.user_id
       where membership.workspace_id = ${data.workspaceId}::uuid
         and lower(identity.email) = lower(${data.editorEmail})
       limit 1
    `);
    const actor = member.rows[0]?.id;
    if (!actor) throw new Error("M1-08-E2E-Editoridentität fehlt.");
    const ctx: ServiceCtx = {
      workspaceId: data.workspaceId,
      actor,
      role: "editor",
      capabilities: {
        manage_catalog: true,
        edit_prices: true,
        see_purchase_prices: true,
      },
      featureFlags: {},
    };

    for (const [index, componentType] of (
      ["module", "inverter", "battery", "wallbox"] as const
    ).entries()) {
      const created = await createCatalogComponent(
        tx,
        ctx,
        catalogFixtureCommand(componentType, index + 1),
      );
      await activateCatalogComponent(tx, ctx, {
        componentId: created.componentId,
        expectedRevision: created.revision,
        expectedStatus: "draft",
      });
    }
  });
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function expectNoFullSha256InVisibleText(page: Page): Promise<void> {
  expect(await page.locator("body").innerText()).not.toMatch(/\b[0-9a-f]{64}\b/iu);
}

async function fillCatalogPricingForm(
  page: Page,
  input: {
    purchasePriceEuro: string;
    salesPriceEuro: string;
    purchaseReference: string;
    salesReference: string;
  },
): Promise<Locator> {
  const pricingSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Preisrevision erfassen", level: 2 }),
  });
  await pricingSection.getByLabel("Preisstand").selectOption("complete");
  await pricingSection.getByLabel("Einkaufspreis").fill(input.purchasePriceEuro);
  await pricingSection.getByLabel("Verkaufspreis").fill(input.salesPriceEuro);
  const purchaseSource = pricingSection.getByRole("group", { name: "Einkaufsquelle" });
  await purchaseSource.getByLabel("Referenz").fill(input.purchaseReference);
  await purchaseSource.getByLabel("Beobachtet am").fill("2026-08-29");
  const salesSource = pricingSection.getByRole("group", { name: "Verkaufsquelle" });
  await salesSource.getByLabel("Referenz").fill(input.salesReference);
  await salesSource.getByLabel("Beobachtet am").fill("2026-08-29");
  return pricingSection;
}

async function latestCalculationJobId(): Promise<string> {
  const data = state();
  return withEnergyFixtureDatabase(async (tx) => {
    const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id
        from project_calculation_job
       where workspace_id = ${data.workspaceId}::uuid
         and project_id = ${data.mainProjectId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const jobId = result.rows[0]?.id;
    if (!jobId) throw new Error("M1-07-E2E-Rechenauftrag fehlt.");
    return jobId;
  });
}

async function claimCalculation(jobId: string): Promise<ProjectCalculationClaim> {
  const data = state();
  const leaseToken = randomUUID();
  const claim = await withEnergyFixtureDatabase((tx) =>
    claimProjectCalculationJob(tx, {
      workspaceId: data.workspaceId,
      jobId,
      leaseToken,
    }));
  if (claim === null) throw new Error("M1-07-E2E-Rechenauftrag war nicht claimbar.");
  return claim;
}

async function setCalculationRetryWait(claim: ProjectCalculationClaim): Promise<void> {
  const data = state();
  await withEnergyFixtureDatabase((tx) => finalizeProjectCalculationFailure(tx, {
    workspaceId: data.workspaceId,
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    errorCode: "provider_unavailable",
    retryable: true,
    retryAfterMs: 0,
  }));
}

async function makeCalculationRetryDue(jobId: string): Promise<void> {
  const data = state();
  await withEnergyFixtureDatabase(async (tx) => {
    const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update project_calculation_job
         set next_attempt_at = pg_catalog.clock_timestamp()
       where workspace_id = ${data.workspaceId}::uuid
         and project_id = ${data.mainProjectId}::uuid
         and id = ${jobId}::uuid
         and state = 'retry_wait'
       returning id
    `);
    if (updated.rows.length !== 1) {
      throw new Error("M1-07-E2E-Retry konnte nicht fällig gestellt werden.");
    }
  });
}

async function setCalculationFailed(claim: ProjectCalculationClaim): Promise<void> {
  const data = state();
  await withEnergyFixtureDatabase((tx) => finalizeProjectCalculationFailure(tx, {
    workspaceId: data.workspaceId,
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    errorCode: "provider_invalid",
    retryable: false,
  }));
}

async function addCurrentRequirementRevision(): Promise<void> {
  const data = state();
  const requirementId = randomUUID();
  await withEnergyFixtureDatabase(async (tx) => {
    const inserted = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      )
      select ${requirementId}::uuid, workspace_id, project_id, revision + 1,
             schema_version, source_snapshot_id, requirements
        from project_requirement
       where workspace_id = ${data.workspaceId}::uuid
         and project_id = ${data.mainProjectId}::uuid
       order by revision desc
       limit 1
      returning id
    `);
    if (inserted.rows.length !== 1) {
      throw new Error("M1-07-E2E-Bedarfsrevision konnte nicht angelegt werden.");
    }
  });
}

function providerSnapshotsForClaim(
  claim: ProjectCalculationClaim,
): PlanningCalculationRequestV1["yieldSnapshots"] {
  const fixture = JSON.parse(readFileSync(
    "contracts/examples/planning-calculation.v1.new.request.json",
    "utf8",
  )) as PlanningCalculationRequestV1;
  const template = fixture.yieldSnapshots[0];
  const profile = claim.preparation?.profile as {
    roofs?: Array<{
      id?: unknown;
      tiltDeg?: unknown;
      azimuthDeg?: unknown;
    }>;
  } | undefined;
  const request = claim.providerRequest as {
    latitude?: unknown;
    longitude?: unknown;
  } | null;
  if (
    template === undefined
    || profile?.roofs === undefined
    || profile.roofs.length === 0
    || typeof request?.latitude !== "number"
    || typeof request.longitude !== "number"
  ) {
    throw new Error("M1-07-E2E-Providerfixture kann nicht gebunden werden.");
  }
  const latitude = Math.round(request.latitude * 1_000) / 1_000;
  const longitude = Math.round(request.longitude * 1_000) / 1_000;
  return profile.roofs.map((roof) => {
    if (
      typeof roof.id !== "string"
      || typeof roof.tiltDeg !== "number"
      || typeof roof.azimuthDeg !== "number"
    ) {
      throw new Error("M1-07-E2E-Dachfixture ist ungültig.");
    }
    return {
      ...structuredClone(template),
      roofId: roof.id,
      request: {
        ...structuredClone(template.request),
        latitude,
        longitude,
        tiltDeg: roof.tiltDeg,
        azimuthDeg: roof.azimuthDeg,
      },
    };
  });
}

async function completeCalculation(jobId: string): Promise<void> {
  const data = state();
  const claim = await claimCalculation(jobId);
  const prepared = buildPlanningCalculationInput({
    claim,
    providerSnapshot: providerSnapshotsForClaim(claim),
  });
  const stored = await withEnergyFixtureDatabase((tx) =>
    persistProjectCalculationInput(tx, {
      workspaceId: data.workspaceId,
      jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      ...prepared,
    }));
  const result = calculatePlanningEstimate(stored.inputSnapshot);
  await withEnergyFixtureDatabase((tx) => finalizeProjectCalculationSuccess(tx, {
    workspaceId: data.workspaceId,
    jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    result,
  }));
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
  // Next 16 streamt bei einer Redirect-Entscheidung mit loading.tsx zunächst
  // eine 200er Shell und folgt anschließend dem eingebetteten Redirect.
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Code anfordern" }).click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status()).toBe(200);
  await expect(page.getByLabel("Sechsstelliger Code")).toBeVisible();

  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST",
  );
  let signInResponse;
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    signInResponse = await signInResponsePromise;
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  expect(signInResponse.status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
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

function boardColumn(page: Page, name: string): Locator {
  return page.locator("section[data-column-id]").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

async function pointerDragToColumn(page: Page, card: Locator, targetColumn: Locator): Promise<void> {
  const handle = card.locator('[data-testid^="drag-"]');
  await expect(handle).toBeVisible();
  await expect(targetColumn).toBeVisible();
  const handleBox = await handle.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  if (!handleBox || !targetBox) throw new Error("Pointer-DnD-Ziel ist nicht messbar.");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + Math.min(140, targetBox.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 12, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 16 });
  await expect(targetColumn.getByText("Hier ablegen", { exact: true })).toBeVisible();
  await page.mouse.up();
}

test.describe.configure({ mode: "serial" });

test("Editor: regionaler Rechner-Lead wird hausgenau korrigiert und getrennt bestätigt", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);

  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  const allCards = page.locator("article[data-project-id]");
  await expect(allCards).toHaveCount(1);
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(0);
  await expect(
    boardColumn(page, "In Prüfung").getByText("Keine Anfragen in diesem Status", { exact: true }),
  ).toBeVisible();
  await expect(
    boardColumn(page, "Qualifiziert").getByText("Keine Anfragen in diesem Status", { exact: true }),
  ).toBeVisible();
  await expect(allCards).toContainText(data.mainContactName);
  await expect(allCards).toContainText(M1_06_E2E_REGION.formattedAddress);
  await expect(allCards).toContainText("Adresse nachfassen");
  await expect(allCards).toContainText("Pin offen");
  await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await allCards.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  await expect(page.getByText(/Rechner-Anfrage · Erstellt am/u)).toBeVisible();
  await expect(page.getByText("Regionale Schätzung", { exact: true })).toBeVisible();
  await expect(page.getByText("Regional", { exact: true })).toBeVisible();
  await expect(page.getByText(M1_06_E2E_REGION.formattedAddress, { exact: true })).toBeVisible();
  await expect(page.getByText("Adresse muss nachbearbeitet werden", { exact: true })).toBeVisible();
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Planungs-Pin bestätigen" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Hausadresse nachtragen", level: 3 })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  const searchInput = page.getByRole("combobox", { name: "Hausadresse suchen" });
  await searchInput.fill(M1_06_E2E_ADDRESS.query);
  const candidateResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/address-candidates")
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Adresse suchen" }).click();
  const candidateResponse = await candidateResponsePromise;
  if (candidateResponse.status() !== 200) {
    const failure = await candidateResponse.json().catch(() => null) as {
      error?: { code?: unknown };
    } | null;
    const safeCode = typeof failure?.error?.code === "string"
      ? failure.error.code
      : "unknown";
    throw new Error(
      `Adresskandidatensuche scheiterte mit HTTP ${candidateResponse.status()} (${safeCode}).`,
    );
  }
  await expect(page.getByRole("status")).toContainText("1 hausgenaue Adresse gefunden.");
  await expect(searchInput).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("option", { name: /Musterweg 12/u })).toBeVisible();

  await searchInput.focus();
  await page.keyboard.press("Enter");
  const selectedAddress = page.getByRole("status").filter({
    hasText: "Hausadresse ausgewählt",
  });
  await expect(selectedAddress).toBeVisible();
  await expect(selectedAddress).toBeFocused();
  await expect(selectedAddress).toContainText(M1_06_E2E_ADDRESS.formattedAddress);
  await expect(selectedAddress).toContainText("Straße und Hausnummer");
  await expect(selectedAddress).toContainText("PLZ und Ort");
  await expect(page.getByTestId("address-pin-map")).toBeVisible();

  const pinCoordinates = selectedAddress.locator("div").filter({
    has: page.getByText("Aktueller Planungs-Pin", { exact: true }),
  }).last();
  const initialPinText = await pinCoordinates.textContent();
  const eastNudge = page.getByRole("button", {
    name: "Pin einen Meter nach Osten verschieben",
  });
  const northNudge = page.getByRole("button", {
    name: "Pin einen Meter nach Norden verschieben",
  });
  expect((await eastNudge.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect((await eastNudge.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await eastNudge.click();
  await expect.poll(() => pinCoordinates.textContent()).not.toBe(initialPinText);
  const pointerAdjustedPinText = await pinCoordinates.textContent();
  await northNudge.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => pinCoordinates.textContent()).not.toBe(pointerAdjustedPinText);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.getByRole("button", { name: "Adresse übernehmen" }).click();
  await expect(page.getByText(M1_06_E2E_ADDRESS.formattedAddress, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hausadresse nachtragen", level: 3 })).toHaveCount(0);
  await expect(page.getByText("Adresse muss nachbearbeitet werden", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Planungs-Pin bestätigen" })).toBeVisible();

  await page.reload();
  await expect(page.getByText(M1_06_E2E_ADDRESS.formattedAddress, { exact: true })).toBeVisible();
  await expect(page.getByText("Hausgenau", { exact: true })).toBeVisible();
  await expect(page.getByText("Gegenüber dem Hauspunkt angepasst", { exact: true })).toBeVisible();
  await expect(page.getByText("Adresse muss nachbearbeitet werden", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Planungs-Pin bestätigen" }).click();
  await expect(page.getByText("Der Planungs-Pin ist bestätigt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Planungs-Pin bestätigen/u })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(M1_06_E2E_ADDRESS.formattedAddress, { exact: true })).toBeVisible();
  await expect(page.getByText("Planungs-Pin ist noch nicht bestätigt", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Der Planungs-Pin ist bestätigt.", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Zurück zu den Anfragen" }).click();
  await page.waitForURL((url) => url.pathname === boardPath);
  const cardAfterPin = page.locator("article[data-project-id]");
  await expect(cardAfterPin).toHaveCount(1);
  await expect(cardAfterPin).not.toContainText("Adresse nachfassen");
  await expect(cardAfterPin).not.toContainText("Pin offen");
  await expect(cardAfterPin).toContainText("Produkte offen");

  const keyboardSelect = cardAfterPin.getByLabel(`Zielspalte für „${data.mainContactName}“`);
  const keyboardButton = cardAfterPin.getByRole("button", {
    name: `„${data.mainContactName}“ verschieben`,
  });
  await keyboardSelect.focus();
  await page.keyboard.press("i");
  await expect(keyboardSelect.locator("option:checked")).toHaveText("In Prüfung");
  await page.keyboard.press("Tab");
  await expect(keyboardButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(0);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

  await page.reload();
  await expect(page.locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(0);
  const persistedCard = boardColumn(page, "In Prüfung").locator("article[data-project-id]");
  await expect(persistedCard).toHaveCount(1);
  await expect(persistedCard).toContainText(data.mainContactName);
  await expect(persistedCard).not.toContainText("Pin offen");

  await pointerDragToColumn(page, persistedCard, boardColumn(page, "Qualifiziert"));
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(0);
  await expect(boardColumn(page, "Qualifiziert").locator("article[data-project-id]")).toHaveCount(1);
  await page.reload();
  await expect(boardColumn(page, "Qualifiziert").locator("article[data-project-id]")).toContainText(
    data.mainContactName,
  );

  await page.goto(`/w/${data.foreignWorkspaceId}/anfragen`);
  await expect(page.getByRole("heading", { name: "Kein Zugriff", level: 1 })).toBeVisible();
  await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("M1-07: Editor bindet das Energieprofil und prüft alle Rechenzustände", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);
  const card = page.locator("article[data-project-id]");
  await expect(card).toHaveCount(1);
  await card.getByRole("link", { name: "Projekt öffnen" }).click();

  await expect(page.getByRole("heading", { name: "Energieprofil", level: 2 })).toBeVisible();
  await expect(page.locator('[data-energy-profile-state="no_profile"]')).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="blocked"]')).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="blocked"]'))
    .toContainText("Speichere zuerst ein aktuelles Energieprofil");
  await expect(page.getByRole("heading", {
    name: "Importierte Rechner-Schätzung (ungeprüft)",
    level: 2,
  })).toBeVisible();
  await page.getByRole("link", { name: "Energieprofil anlegen" }).click();

  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await expect(page.getByText("Importierte Rechner-Eingaben – ungeprüft", { exact: true })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
  await page.getByLabel("Haushaltsverbrauch (kWh/Jahr)").fill("4300");
  await page.getByLabel("Verschattung").selectOption("none");
  await page.getByLabel("Für den aktuellen Standort geprüft?").selectOption("true");
  const saveButton = page.getByRole("button", { name: "Profil speichern" });
  expect((await saveButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await saveButton.click();

  const savedStatus = page.getByText(/Profilrevision 1 wurde gespeichert/u);
  await expect(savedStatus).toBeVisible();
  await expect(savedStatus).toBeFocused();
  const confirmButton = page.getByRole("button", { name: "Eingaben bestätigen" });
  await expect(confirmButton).toBeVisible();
  expect((await confirmButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await confirmButton.click();
  await expect(page.getByText(/Profilrevision 1 ist für Adressrevision .* bestätigt/u))
    .toBeVisible();

  await page.getByRole("link", { name: "Zurück zur Projektakte" }).click();
  const calculation = page.locator('section:has([data-energy-calculation-state="queued"])');
  await expect(calculation).toBeVisible();
  await expect(calculation).toContainText("Eingereiht");
  const refreshButton = calculation.getByRole("button", { name: "Status aktualisieren" });
  await expect(refreshButton).toBeVisible();
  expect((await refreshButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(calculation).not.toContainText("Investitionsrahmen");
  await expect(calculation).not.toContainText("Amortisation");

  await page.reload();
  await expect(page.locator('[data-energy-calculation-state="queued"]')).toBeVisible();

  const firstJobId = await latestCalculationJobId();
  const firstClaim = await claimCalculation(firstJobId);
  await page.getByRole("button", { name: "Status aktualisieren" }).click();
  await expect(page.locator('[data-energy-calculation-state="running"]')).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="running"]'))
    .toContainText("Wird serverseitig berechnet");

  await setCalculationRetryWait(firstClaim);
  await page.getByRole("button", { name: "Status aktualisieren" }).click();
  await expect(page.locator('[data-energy-calculation-state="retry_wait"]')).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="retry_wait"]'))
    .toContainText("begrenzten technischen Wiederholungsversuch");

  await makeCalculationRetryDue(firstJobId);
  const retryClaim = await claimCalculation(firstJobId);
  await page.getByRole("button", { name: "Status aktualisieren" }).click();
  await expect(page.locator('[data-energy-calculation-state="running"]')).toBeVisible();

  await setCalculationFailed(retryClaim);
  await page.getByRole("button", { name: "Status aktualisieren" }).click();
  const failedCalculation = page.locator('[data-energy-calculation-state="failed"]');
  await expect(failedCalculation).toBeVisible();
  await expect(failedCalculation).toContainText("Planungsrechnung fehlgeschlagen");
  await expect(failedCalculation).not.toContainText("Erneut berechnen");

  await addCurrentRequirementRevision();
  await page.reload();
  const staleCalculation = page.locator('[data-energy-calculation-state="stale"]');
  await expect(staleCalculation).toBeVisible();
  await expect(staleCalculation).toContainText("Ergebnis veraltet");
  await expect(page.getByText(/aktuelle Planung ist nicht mehr daran gebunden/u)).toBeVisible();
  await page.getByRole("button", { name: "Eingaben bestätigen" }).click();
  const rateLimitFeedback = page.getByRole("alert").filter({
    hasText: "Zu viele neue Berechnungen",
  });
  await expect(rateLimitFeedback).toBeVisible();
  await expect(rateLimitFeedback).toBeFocused();
  const rateLimitText = await rateLimitFeedback.textContent();
  const retryAfter = /Bitte in (\d+) Sekunden erneut versuchen\./u.exec(
    rateLimitText ?? "",
  );
  if (!retryAfter) throw new Error("M1-07-E2E-Quota-Wartezeit fehlt.");
  await page.waitForTimeout(Number(retryAfter[1]) * 1_000 + 250);
  await page.getByRole("button", { name: "Eingaben bestätigen" }).click();
  await expect(page.locator('[data-energy-calculation-state="queued"]')).toBeVisible();

  const reboundJobId = await latestCalculationJobId();
  expect(reboundJobId).not.toBe(firstJobId);
  await completeCalculation(reboundJobId);
  await page.reload();
  const currentCalculation = page.locator('[data-energy-calculation-state="current"]');
  await expect(currentCalculation).toBeVisible();
  await expect(currentCalculation).toContainText("Ergebnis aktuell");
  await expect(currentCalculation).toContainText("Serverseitig neu berechnete Schätzung");
  await expect(currentCalculation).toContainText("Nicht F4-referenzvalidiert und nicht angebotsreif");
  await expect(currentCalculation).not.toContainText("Investitionsrahmen");
  await expect(currentCalculation).not.toContainText("Amortisation");
  await expect(currentCalculation).not.toContainText("hourlyPowerWPerKwp");
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator('[data-energy-calculation-state="current"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 320, scroll: 320 });
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addStyleTag({ content: ":root { font-size: 200% !important; }" });
  await expect(page.locator('[data-energy-calculation-state="current"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 1280, scroll: 1280 });
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("M1-08: Editor prüft Katalog und bestätigt die revisionsgebundene Produktauswahl", async ({ page }) => {
  const data = state();
  const catalogPath = `/w/${data.workspaceId}/katalog`;
  const productsPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}/produkte`;
  await seedActiveCatalogFixtures();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(catalogPath);
  await loginWithRealOtp(page, data.editorEmail, catalogPath);

  await expect(page.getByRole("heading", { name: "Produktkatalog", level: 1 })).toBeVisible();
  const catalogList = page.locator('[data-catalog-list-state="loaded"]');
  await expect(catalogList).toBeVisible();
  await expect(catalogList.locator(":scope > ul > li")).toHaveCount(4);
  for (const displayName of Object.values(M1_08_CATALOG_FIXTURES)) {
    await expect(catalogList.getByText(displayName, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Neuen Produktentwurf anlegen", { exact: true })).toBeVisible();
  await expect(page.getByText("EK netto", { exact: true })).toHaveCount(4);
  await expectNoHorizontalOverflow(page, 1440);
  await expectNoSeriousOrCriticalAxeViolations(page);

  const createDetails = page.locator("details").filter({
    has: page.getByText("Neuen Produktentwurf anlegen", { exact: true }),
  });
  await createDetails.getByText("Neuen Produktentwurf anlegen", { exact: true }).click();
  const createForm = createDetails.locator("form");
  await createForm.getByLabel("Interne SKU").fill(M1_08_UI_PRODUCT.sku);
  await createForm.getByLabel("Produkttyp").selectOption("other");
  await createForm.getByLabel("Anzeigename").fill(M1_08_UI_PRODUCT.displayName);
  await createForm.getByLabel("Hersteller", { exact: true }).fill("E2E Testwerk");
  await createForm.getByLabel("Modell").fill("UI Fixture 5");
  await createForm.getByLabel("Einheit").selectOption("set");
  await createForm.getByLabel("Kernaussagen, höchstens sechs Zeilen")
    .fill("Ausschließlich synthetische UI-Testdaten");
  await createForm.getByLabel("Attribute, je Zeile Name=Wert")
    .fill("Kategorie=E2E\nLieferumfang=Synthetisch");
  await createForm.getByLabel("Quellenart").selectOption("workspace_manual");
  await createForm.getByLabel("Quellenreferenz").fill("E2E-TECH-UI-5");
  await createForm.getByLabel("Beobachtet am").fill("2026-08-29");
  await createForm.getByLabel("Rechtebasis").selectOption("workspace_owned");
  await createForm.getByRole("button", { name: "Produktentwurf anlegen" }).click();
  await expect(createForm.getByRole("status")).toContainText(
    "Revision 1 wurde gespeichert. Der Produktstatus ist jetzt Entwurf.",
  );
  await createForm.getByRole("link", { name: "Produkt öffnen" }).click();

  await expect(page.locator('[data-catalog-component-state="draft_incomplete"]')).toBeVisible();
  await expect(page.getByRole("heading", {
    name: M1_08_UI_PRODUCT.displayName,
    level: 1,
  })).toBeVisible();
  const initialPricing = await fillCatalogPricingForm(page, {
    purchasePriceEuro: "123.45",
    salesPriceEuro: "234.56",
    purchaseReference: M1_08_UI_PRODUCT.purchaseReference,
    salesReference: M1_08_UI_PRODUCT.salesReference,
  });
  await initialPricing.getByRole("button", { name: "Neue Preisrevision speichern" }).click();
  await expect(initialPricing.getByRole("status")).toContainText(
    "Preisrevision 2 wurde als Entwurf gespeichert.",
  );

  await page.reload();
  await expect(page.locator('[data-catalog-component-state="draft_priced"]')).toBeVisible();
  const initialLifecycle = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Lifecycle", level: 2 }),
  });
  await initialLifecycle.getByRole("button", { name: "Aktivieren" }).click();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  await expect(page.getByText(M1_08_UI_PRODUCT.purchaseReference, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Zurück zum Katalog" }).click();
  await expect(catalogList.locator(":scope > ul > li")).toHaveCount(5);
  await expect(catalogList.getByText(M1_08_UI_PRODUCT.displayName, { exact: true })).toBeVisible();

  const batteryCard = catalogList.locator(":scope > ul > li").filter({
    has: page.getByText(M1_08_CATALOG_FIXTURES.battery, { exact: true }),
  });
  const batteryLink = batteryCard.getByRole("link", { name: "Produkt öffnen" });
  const batteryHref = await batteryLink.getAttribute("href");
  if (!batteryHref) throw new Error("M1-08-E2E-Batteriedetail-Link fehlt.");
  await batteryLink.click();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  await expect(page.getByRole("heading", {
    name: M1_08_CATALOG_FIXTURES.battery,
    level: 1,
  })).toBeVisible();
  const priceSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Preisstand", level: 2 }),
  });
  await expect(priceSection.getByText("EK netto", { exact: true })).toBeVisible();
  await expect(priceSection).toContainText("E2E-EK-CANARY-3");
  await expect(page.getByText("Snapshot-Hash", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Darstellung und Technik revidieren",
    level: 2,
  })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Preisrevision erfassen",
    level: 2,
  })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="pending"]')).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Produkte revisionssicher zuordnen",
    level: 1,
  })).toBeVisible();
  await expect(page.getByText("10.400 W · 10,4 kWp", { exact: true })).toBeVisible();
  const blockerList = page.getByRole("list", { name: "Auswahlblocker" });
  await expect(blockerList).toContainText("Wähle mindestens ein Produkt aus.");
  await expect(blockerList).toContainText("Für die Neuanlage fehlt mindestens ein PV-Modul.");
  await expect(page.getByRole("button", { name: "Projektauflösung bestätigen" })).toBeDisabled();

  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  await expectNoSeriousOrCriticalAxeViolations(page);

  async function selectProduct(displayName: string, quantity?: string): Promise<void> {
    const checkbox = page.getByRole("checkbox", { name: new RegExp(escapeRegExp(displayName), "u") });
    const card = checkbox.locator("..").locator("..");
    await checkbox.check();
    if (quantity !== undefined) await card.getByLabel("Menge").fill(quantity);
  }

  await selectProduct(M1_08_CATALOG_FIXTURES.module, "26");
  await selectProduct(M1_08_CATALOG_FIXTURES.inverter);
  await selectProduct(M1_08_CATALOG_FIXTURES.battery);
  await selectProduct(M1_08_CATALOG_FIXTURES.wallbox);

  await expect(page.getByRole("list", { name: "Auswahlblocker" })).toHaveCount(0);
  await expect(page.getByText(
    "Die Mindestkategorien sind vollständig ausgewählt.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText("10.400 / 10.400 W", { exact: true })).toBeVisible();
  await expect(page.getByText("8.000 / 8.000 Wh", { exact: true })).toBeVisible();
  const acknowledgements = page.getByRole("group", {
    name: "Abweichungen bewusst bestätigen",
  });
  await expect(acknowledgements).toBeVisible();
  await expect(acknowledgements.getByRole("checkbox")).toHaveCount(1);
  const compatibilityAcknowledgement = acknowledgements.getByRole("checkbox", {
    name: /Kompatibilität der gewählten Komponenten untereinander/u,
  });
  await compatibilityAcknowledgement.check();
  await expect(page.getByRole("button", { name: "Projektauflösung bestätigen" })).toBeEnabled();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectNoHorizontalOverflow(page, 1440);
  await expectNoSeriousOrCriticalAxeViolations(page);
  await page.getByRole("button", { name: "Projektauflösung bestätigen" }).click();
  await expect(page.getByText(
    "Projektauflösung Revision 1 wurde revisionssicher bestätigt.",
    { exact: true },
  )).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-catalog-resolution-state="current"]')).toBeVisible();
  await expect(page.getByText(
    "Projektauflösung Revision 1 ist aktuell.",
    { exact: true },
  )).toBeVisible();
  const savedSnapshot = page.getByRole("region", {
    name: "Gespeicherte Produktpositionen",
  });
  await expect(savedSnapshot.getByRole("row")).toHaveCount(5);
  await expect(savedSnapshot).toContainText(M1_08_CATALOG_FIXTURES.module);
  await expect(savedSnapshot).toContainText(M1_08_CATALOG_FIXTURES.wallbox);
  await expect(page.getByText("Resolution-Hash", { exact: true })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  const savedBatteryRow = savedSnapshot.getByRole("row").filter({
    hasText: M1_08_CATALOG_FIXTURES.battery,
  });
  await expect(savedBatteryRow.getByRole("cell").nth(2)).toHaveText("1");
  const originalBatterySnapshotCells = await savedBatteryRow.getByRole("cell").allInnerTexts();

  await page.goto(batteryHref);
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  const revisedPricing = await fillCatalogPricingForm(page, {
    purchasePriceEuro: "1100.03",
    salesPriceEuro: "1600.03",
    purchaseReference: "E2E-EK-CANARY-3-REV2",
    salesReference: "E2E-VK-3-REV2",
  });
  await revisedPricing.getByRole("button", { name: "Neue Preisrevision speichern" }).click();
  await expect(revisedPricing.getByRole("status")).toContainText(
    "Preisrevision 2 wurde als Entwurf gespeichert.",
  );

  await page.reload();
  await expect(page.locator('[data-catalog-component-state="draft_priced"]')).toBeVisible();
  await expect(page.getByText("E2E-EK-CANARY-3-REV2", { exact: true })).toBeVisible();
  const revisedLifecycle = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Lifecycle", level: 2 }),
  });
  await revisedLifecycle.getByRole("button", { name: "Aktivieren" }).click();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-catalog-component-state="active"]')).toBeVisible();

  await page.goto(productsPath);
  await expect(page.locator('[data-catalog-resolution-state="stale"]')).toBeVisible();
  await expect(page.getByText(
    "Die letzte Auflösung ist historisch und nicht mehr aktuell.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(
    "Mindestens ein Produkt wurde revidiert oder archiviert.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Gespeicherter Snapshot · Revision 1",
    level: 2,
  })).toBeVisible();
  const staleSavedSnapshot = page.getByRole("region", {
    name: "Gespeicherte Produktpositionen",
  });
  const staleBatteryRow = staleSavedSnapshot.getByRole("row").filter({
    hasText: M1_08_CATALOG_FIXTURES.battery,
  });
  expect(await staleBatteryRow.getByRole("cell").allInnerTexts())
    .toEqual(originalBatterySnapshotCells);
  await expect(staleBatteryRow.getByRole("cell").nth(2)).toHaveText("1");
  const currentBatteryChoice = page.getByRole("checkbox", {
    name: new RegExp(escapeRegExp(M1_08_CATALOG_FIXTURES.battery), "u"),
  });
  await expect(currentBatteryChoice.locator("..")).toContainText("Rev. 2");
  await expect(page.getByText("Resolution-Hash", { exact: true })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test.describe("mobiler Chromium-Kontext", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("Mobile: kein Drag-Grip, 44px-Fallback verschiebt persistent", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;

    await page.goto(boardPath);
    await loginWithRealOtp(page, data.editorEmail, boardPath);

    const card = page.locator("article[data-project-id]");
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-testid^="drag-"]')).toBeHidden();
    const select = card.getByLabel(`Zielspalte für „${data.mainContactName}“`);
    const button = card.getByRole("button", { name: `„${data.mainContactName}“ verschieben` });
    await expect(select).toBeVisible();
    await expect(button).toBeVisible();
    expect((await select.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await select.selectOption({ label: "In Prüfung" });
    await button.click();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);
    await page.reload();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toContainText(
      data.mainContactName,
    );
  });
});

test.describe("Tablet mit grobem Zeiger", () => {
  test.use({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
  });

  test("Tablet: Desktop-Raster bleibt ohne wirkungslosen Drag-Grip bedienbar", async ({ page }) => {
    const data = state();
    const boardPath = `/w/${data.workspaceId}/anfragen`;

    await page.goto(boardPath);
    await loginWithRealOtp(page, data.editorEmail, boardPath);

    const card = page.locator("article[data-project-id]");
    await expect(card).toHaveCount(1);
    await expect(card.locator('[data-testid^="drag-"]')).toBeHidden();
    await expect(page.getByLabel("Status anzeigen")).toBeHidden();

    const select = card.getByLabel(`Zielspalte für „${data.mainContactName}“`);
    const button = card.getByRole("button", { name: `„${data.mainContactName}“ verschieben` });
    await expect(select).toBeVisible();
    await expect(button).toBeVisible();
    expect((await select.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoSeriousOrCriticalAxeViolations(page);
  });
});

test("Konflikt, 404 und echter Fremdprojekt-Link bleiben fail-closed", async ({ page, context }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

  const stalePage = await context.newPage();
  const staleErrors = trackBrowserErrors(stalePage);
  try {
    await stalePage.goto(boardPath);
    const staleCard = boardColumn(stalePage, "In Prüfung").locator("article[data-project-id]");
    await expect(staleCard).toHaveCount(1);

    const currentCard = boardColumn(page, "In Prüfung").locator("article[data-project-id]");
    await currentCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "Eingang" });
    await currentCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(boardColumn(page, "Eingang").locator("article[data-project-id]")).toHaveCount(1);

    await staleCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "Qualifiziert" });
    await staleCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(stalePage.getByRole("status")).toContainText(
      "Die Anfrage wurde zwischenzeitlich geändert.",
    );
    await stalePage.reload();
    await expect(
      boardColumn(stalePage, "Eingang").locator("article[data-project-id]"),
    ).toContainText(data.mainContactName);

    await page.reload();
    const freshCard = boardColumn(page, "Eingang").locator("article[data-project-id]");
    await freshCard
      .getByLabel(`Zielspalte für „${data.mainContactName}“`)
      .selectOption({ label: "In Prüfung" });
    await freshCard
      .getByRole("button", { name: `„${data.mainContactName}“ verschieben` })
      .click();
    await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);

    const missingProjectId = "11111111-1111-4111-8111-111111111111";
    await page.goto(`${boardPath}/${missingProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Die Projektakte ist nicht verfügbar.",
      level: 1,
    })).toBeVisible();

    await page.goto(`${boardPath}/${data.foreignProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Die Projektakte ist nicht verfügbar.",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(data.foreignContactName)).toHaveCount(0);

    await page.goto(`/w/${data.foreignWorkspaceId}/anfragen/${data.foreignProjectId}`);
    await expect(page.getByRole("heading", {
      name: "Diese Daten sind für dich nicht freigegeben.",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(data.foreignContactName)).toHaveCount(0);

    await page.goto(
      `/w/${data.foreignWorkspaceId}/anfragen/${data.foreignProjectId}/energieprofil`,
    );
    await expect(page.getByRole("heading", {
      name: "Diese Daten sind für dich nicht freigegeben.",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(data.foreignContactName)).toHaveCount(0);
    await expectNoSeriousOrCriticalAxeViolations(page);
  } finally {
    await stalePage.close();
  }
  expect(staleErrors, "zweite Browserseite ohne Console-/Page-Errors").toEqual([]);
});

test("Viewer: Lead, Katalog und Produktsnapshot bleiben strikt lesend und EK-redigiert", async ({ page }) => {
  const data = state();
  const boardPath = `/w/${data.workspaceId}/anfragen`;

  await page.goto(boardPath);
  await loginWithRealOtp(page, data.viewerEmail, boardPath);

  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff").first()).toBeVisible();
  await expect(page.locator("article[data-project-id]")).toHaveCount(1);
  await expect(boardColumn(page, "In Prüfung").locator("article[data-project-id]")).toHaveCount(1);
  await expect(page.locator("article[data-project-id] form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /verschieben/u })).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Hausadresse suchen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adresse übernehmen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Pin einen Meter nach/u })).toHaveCount(0);
  await expect(page.getByTestId("address-pin-map")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Planungs-Pin bestätigen/u })).toHaveCount(0);
  const energyProfile = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Energieprofil", level: 2 }),
  });
  await expect(energyProfile.locator('[data-energy-profile-state="read_only"]')).toBeVisible();
  await expect(energyProfile.locator("form")).toHaveCount(0);
  await expect(energyProfile.getByRole("link", {
    name: "Energieprofil prüfen und bearbeiten",
  })).toHaveCount(0);
  await expect(page.locator('[data-energy-calculation-state="current"]')).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.goto(
    `/w/${data.workspaceId}/anfragen/${data.mainProjectId}/energieprofil`,
  );
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nur Lesezugriff", level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Profil speichern" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Eingaben bestätigen" })).toHaveCount(0);
  await expectNoSeriousOrCriticalAxeViolations(page);

  const catalogPath = `/w/${data.workspaceId}/katalog`;
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(catalogPath);
  await expect(page.getByRole("heading", { name: "Produktkatalog", level: 1 })).toBeVisible();
  await expect(page.getByText("Nur Lesezugriff", { exact: true }).first()).toBeVisible();
  const catalogList = page.locator('[data-catalog-list-state="read_only"]');
  await expect(catalogList.locator(":scope > ul > li")).toHaveCount(5);
  await expect(catalogList.getByText(M1_08_UI_PRODUCT.displayName, { exact: true })).toBeVisible();
  await expect(page.getByText("Neuen Produktentwurf anlegen", { exact: true })).toHaveCount(0);
  await expect(page.getByText("EK netto", { exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain("E2E-EK-CANARY-");
  await expectNoFullSha256InVisibleText(page);
  await expectNoHorizontalOverflow(page, 375);
  await expectNoSeriousOrCriticalAxeViolations(page);

  const batteryCard = catalogList.locator(":scope > ul > li").filter({
    has: page.getByText(M1_08_CATALOG_FIXTURES.battery, { exact: true }),
  });
  await batteryCard.getByRole("link", { name: "Produkt öffnen" }).click();
  await expect(page.locator('[data-catalog-component-state="read_only"]')).toBeVisible();
  await expect(page.getByText("Für deine Rolle ausgeblendet", { exact: true })).toBeVisible();
  await expect(page.getByText("Snapshot-Hash", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", {
    name: "Darstellung und Technik revidieren",
    level: 2,
  })).toHaveCount(0);
  await expect(page.getByRole("heading", {
    name: "Preisrevision erfassen",
    level: 2,
  })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Produkt archivieren" })).toHaveCount(0);
  const viewerPriceSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Preisstand", level: 2 }),
  });
  await expect(viewerPriceSection).not.toContainText("1.100,03");
  expect(await page.content()).not.toContain("E2E-EK-CANARY-");
  await expectNoFullSha256InVisibleText(page);
  await expectNoHorizontalOverflow(page, 375);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.goto(`/w/${data.workspaceId}/anfragen/${data.mainProjectId}/produkte`);
  await expect(page.locator('[data-catalog-resolution-state="read_only"]')).toBeVisible();
  await expect(page.getByText(
    "Die letzte Auflösung ist historisch und nicht mehr aktuell.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(
    "Mindestens ein Produkt wurde revidiert oder archiviert.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(
    "Projektauflösung Revision 1 ist aktuell.",
    { exact: true },
  )).toHaveCount(0);
  await expect(page.getByRole("region", {
    name: "Gespeicherte Produktpositionen",
  }).getByRole("row")).toHaveCount(5);
  await expect(page.getByRole("group", {
    name: "Aktive Produkte auswählen",
  })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Projektauflösung bestätigen" })).toHaveCount(0);
  await expect(page.getByText("EK-Summe netto", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Resolution-Hash", { exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain("E2E-EK-CANARY-");
  await expectNoFullSha256InVisibleText(page);
  await expectNoHorizontalOverflow(page, 375);
  await expectNoSeriousOrCriticalAxeViolations(page);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectNoHorizontalOverflow(page, 1440);
  await expectNoSeriousOrCriticalAxeViolations(page);
});
