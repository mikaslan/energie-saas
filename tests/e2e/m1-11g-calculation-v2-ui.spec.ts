import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { withAuthorizedTenantOn } from "../../lib/db/tenant";
import type { ServiceCtx } from "../../lib/permissions";
import { getProjectEnergyContext } from "../../modules/energy/service";
import { withTenantOn } from "../../lib/db/tenant";
import { requeueDueProjectCalculationJobs } from "../../modules/energy/calculation-service";
import {
  addResolution,
  fixtureTransport,
  poolOne,
  reserve,
  runChain,
  resolveEditorId,
  seedIsolatedWorkspace,
  seedProjectGraph,
  state,
  type SeedIds,
} from "./m1-11g-fixture";

// M1-11g: v2-Ergebnis sichtbar (beobachtbare F4-Paritaet). Isolierter
// Workspace fuer die E2E-Loginidentitaet (Shared-Fixtures bleiben
// unberuehrt): Profil -> Reservierung -> Handler mit echten
// Fixture-Bytes (Berlin 2020, nur Transport gefakt) -> currentV2 ->
// Browser zeigt Jahres-/Monatswerte, provider_estimate-Hinweis und
// Provenienz. Alle Zahlen kommen aus der Produktionskette, nichts ist
// im Spec erfunden.

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
        name: "M1-11g local empty map style",
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
const deNumber = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

function formatKwh(value: number): string {
  return `${deNumber.format(value)} kWh`;
}

test("M1-11g: v2-Planungsergebnis ist im Browser sichtbar", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("v2-Kette erreichte kein currentV2.");
  }
  const result = expected.calculation.resultV2;

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);

  const section = page.locator('[data-energy-calculation-state="currentV2"]');
  await expect(section).toBeVisible();
  const v2result = section.locator('[data-energy-calculation-v2-result="true"]');
  await expect(v2result).toBeVisible();
  await expect(section.getByText("Ergebnis aktuell (v2)")).toBeVisible();
  await expect(v2result.getByText("Viertelstunden-Planungsrechnung (v2)")).toBeVisible();
  // Echte Kettenwerte: Jahreserzeugung E_y x kWp, formatiert wie die UI.
  await expect(v2result.getByText(formatKwh(result.value.annual.generationKwh)))
    .toBeVisible();
  await expect(v2result.getByText(formatKwh(result.value.annual.consumptionKwh)))
    .toBeVisible();
  // Monatstabelle: 12 Zeilen, Januar zuerst.
  const rows = v2result.locator("table tbody tr");
  await expect(rows).toHaveCount(12);
  await expect(rows.first().getByRole("rowheader")).toHaveText("Januar");
  await expect(rows.first().getByText(
    formatKwh(result.value.monthly[0]!.generationKwh),
  )).toBeVisible();
  // ESTIMATE-Kennzeichnung ist sichtbar, nicht versteckt.
  const warnings = v2result.locator('[data-energy-calculation-v2-warnings*="provider_estimate"]');
  await expect(warnings).toBeVisible();
  await expect(warnings.getByText(/Geschätzte Eingabedaten/)).toBeVisible();
  // Provenienz aufklappen: Zeitauflösung + Annahmen-Version.
  await v2result.getByText("Annahmen und technische Provenienz (v2)").click();
  await expect(v2result.getByText("35.040 Slots")).toBeVisible();
  await expect(v2result.getByText(result.assumptions.paramsVersion)).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-state="currentV2"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Ergebnisansicht",
  ).toEqual([]);
});

test("M1-11g: v2-Fehlversuch wird faellig gestellt und heilt per Requeue", async () => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids);

  // Erster Lauf: Provider bricht einmal ab -> retryable Fehlversuch.
  let annualCalls = 0;
  const flaky = fixtureTransport();
  const realAnnual = flaky.fetchAnnual.bind(flaky);
  flaky.fetchAnnual = async () => {
    annualCalls += 1;
    if (annualCalls === 1) throw new Error("M1-11g synthetischer Providerausfall");
    return realAnnual();
  };
  await runChain(ids, reserved.jobId, flaky);
  const afterFailure = await poolOne(async (pool) => withTenantOn(
    pool,
    workspaceId,
    async (tx) => {
      const rows = await tx.execute(
        `select state from project_calculation_job where id = '${reserved.jobId}'::uuid`,
      );
      return (rows.rows[0] as { state: string }).state;
    },
  ));
  expect(annualCalls).toBe(1);
  expect(afterFailure).toBe("retry_wait");

  // Zeitreise ueber den Backoff, Sweep stellt faellig -> queued + Dispatch.
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(
      `update project_calculation_job set next_attempt_at = now() - interval '1 minute'
        where id = '${reserved.jobId}'::uuid`,
    );
  }));
  const requeued = await poolOne(async (pool) => withTenantOn(
    pool,
    workspaceId,
    (tx) => requeueDueProjectCalculationJobs(tx, { workspaceId, limit: 10 }),
  ));
  expect(requeued).toContain(reserved.jobId);

  // Zweiter Lauf mit gesundem Provider -> currentV2.
  await runChain(ids, reserved.jobId);
  const context = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  expect(context?.calculation.status).toBe("currentV2");
});

test("M1-11g: v2-Bestandsergebnis zeigt baseline/geplant/Delta im Browser", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  // F4.5b: Investition belegt, damit die Kette economics + Delta-Bills traegt.
  await seedProjectGraph(ids, { branch: "existing_installation", investmentEuro: 20000 });
  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Bestands-Kette erreichte kein currentV2.");
  }
  const result = expected.calculation.resultV2;
  const existing = result.value.existingInstallation;
  if (!existing) throw new Error("v2-Bestandsresultat traegt kein existingInstallation.");
  // F4.5b: Delta-Bills gegen die Planungs-Bills gepinnt.
  const bills = existing.delta.bills;
  if (!bills) throw new Error("Bestand-Delta traegt keine Bills.");
  const economics = result.value.economics;
  if (!economics) throw new Error("Bestand-Kette traegt kein economics.");
  expect(bills.savingsEuro).toBeCloseTo(bills.baselineEuro - bills.plannedEuro, 2);
  expect(bills.plannedEuro).toBeCloseTo(economics.annualBillsEuro.currentEuro, 2);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);

  const section = page.locator('[data-energy-calculation-state="currentV2"]');
  await expect(section).toBeVisible();
  const v2result = section.locator('[data-energy-calculation-v2-result="true"]');
  await expect(v2result).toBeVisible();
  // Bestandsblock: echte Kettenwerte (8 kWp Anlage, Baseline, Delta).
  const v2existing = v2result.locator('[data-energy-calculation-v2-existing="true"]');
  await expect(v2existing).toBeVisible();
  await expect(v2existing.getByText(`${deNumber.format(8)} kWp`)).toBeVisible();
  await expect(v2existing.getByText(formatKwh(existing.baseline.annual.selfConsumptionKwh)))
    .toBeVisible();
  await expect(v2existing.getByText(
    formatKwh(existing.delta.additionalSelfConsumptionKwh),
  )).toBeVisible();
  // Baseline-Monatstabelle: 12 Zeilen, Januar zuerst, echte Kettenwerte.
  const rows = v2existing.locator("table tbody tr");
  await expect(rows).toHaveCount(12);
  await expect(rows.first().getByRole("rowheader")).toHaveText("Januar");
  await expect(rows.first().getByText(
    formatKwh(existing.baseline.monthly[0]!.selfConsumptionKwh),
  )).toBeVisible();
  // F4.5b: Geldvergleich und Sankey sind beobachtbar.
  await expect(v2existing.getByText("Stromrechnung Bestand (Jahr 1)")).toBeVisible();
  await expect(v2existing.getByText("Ersparnis Planung vs. Bestand")).toBeVisible();
  await expect(page.locator('[data-energy-sankey-chart="true"]')).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-v2-existing="true"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Bestandsansicht",
  ).toEqual([]);
});

test("M1-11g: v2-Ergebnis wird nach Bedarfsrevision als historisch gezeigt", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("v2-Kette erreichte kein currentV2.");
  }
  const generationKwh = expected.calculation.resultV2.value.annual.generationKwh;

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);
  await expect(page.locator('[data-energy-calculation-state="currentV2"]')).toBeVisible();

  // Neue Bedarfsrevision entkoppelt den Job -> stale mit v2-Historie.
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    const inserted = await tx.execute(
      `insert into project_requirement (
         id, workspace_id, project_id, revision, schema_version,
         source_snapshot_id, requirements
       )
       select gen_random_uuid(), workspace_id, project_id, revision + 1,
              schema_version, source_snapshot_id, requirements
       from project_requirement
       where workspace_id = '${workspaceId}'::uuid
         and project_id = '${ids.projectId}'::uuid
       order by revision desc
       limit 1
       returning id`,
    );
    if (inserted.rows.length !== 1) throw new Error("Bedarfsrevision fehlt.");
  }));
  await page.reload();
  const stale = page.locator('[data-energy-calculation-state="stale"]');
  await expect(stale).toBeVisible();
  await expect(stale.getByText("Ergebnis veraltet")).toBeVisible();
  // Historische v2-Werte bleiben sichtbar, als historisch markiert.
  await expect(stale.getByText("Historische Viertelstunden-Planungsrechnung")).toBeVisible();
  await expect(stale.getByText(formatKwh(generationKwh))).toBeVisible();
});

test("M1-11g: F4.2-Monatsprofil formt die v2-Last nach Monatswerten", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  // Monatssumme 4200 == Haushalts-kWh (konsistent), Januar-Spitze 450,
  // Juli-Senke 230, ohne Tagesgänge (H0-Fallback).
  const monthlyKwh = [450, 400, 350, 300, 250, 230, 230, 280, 330, 380, 450, 550];
  await seedProjectGraph(ids, {
    customLoadProfile: {
      monthlyKwh,
      weekdayHourlyKwh: null,
      weekendHourlyKwh: null,
    },
  });
  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Monatsprofil-Kette erreichte kein currentV2.");
  }
  const result = expected.calculation.resultV2;
  const january = result.value.monthly[0]!;
  const july = result.value.monthly[6]!;

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);

  const section = page.locator('[data-energy-calculation-state="currentV2"]');
  await expect(section).toBeVisible();
  // Monatsform sichtbar: Januar-Netzbezug deutlich über Juli (wenig PV,
  // viel Last im Januar; viel PV, wenig Last im Juli).
  await expect(section.getByText(formatKwh(january.gridImportKwh))).toBeVisible();
  expect(january.gridImportKwh).toBeGreaterThan(july.gridImportKwh * 1.5);

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-v2-result="true"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Monatsprofilansicht",
  ).toEqual([]);
});

// Kandidaturfähiger Snapshot (Projektion braucht echte Rechner-Inputs;
// Minimal-Snapshot des Ketten-Fixtures projiziert nicht).
async function writeCandidateSnapshot(
  workspaceId: string,
  projectId: string,
  provenancePatch: Record<string, string> = {},
): Promise<void> {
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    const snapshot = {
      schemaVersion: "wmee-solar-snapshot.v1",
      calculatedAt: new Date().toISOString(),
      branch: "new_installation",
      questionnaireVariant: "short",
      resultIntegrity: "client_reported_unverified",
      inputs: {
        roofs: [{
          id: "dach-sued",
          areaM2: 52,
          azimuthDeg: 5,
          tiltDeg: 35,
          type: "pitched",
          shading: "light",
        }],
        consumption: {
          householdKwhPerYear: 4200,
          electricityPriceCentsPerKwh: 36,
          annualPriceIncreasePercent: 3,
          evKmPerYear: 12000,
          evChargingPattern: "evening",
          heatPumpKwhPerYear: 0,
          coolingKwhPerYear: 0,
          heatingAcKwhPerYear: 0,
          hotWaterKwhPerYear: null,
          buildingType: null,
          buildingYear: null,
          heatedAreaM2: null,
        },
        existingInstallation: null,
        answeredFieldIds: ["stromverbrauch", "eauto", "ladeort", "waermepumpe", "klimaKuehlen", "klimaHeizen", "warmwasser", "verschattung"],
      },
      provenance: {
        roof: "user_drawn",
        consumption: "metered_kwh",
        electricityPrice: "customer",
        annualPriceIncrease: "customer",
        investment: "market_estimate",
        ...provenancePatch,
      },
      result: { mode: "new_installation" },
    };
    await tx.execute(
      `update calculator_snapshot set snapshot = '${JSON.stringify(snapshot)}'::jsonb
       where workspace_id = '${workspaceId}'::uuid and project_id = '${projectId}'::uuid`,
    );
  }));
}

test("M1-11g: F4.2-Monatsformular speichert Monatswerte als known-Profil", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();

  const customBlock = page.locator('[data-energy-custom-profile="true"]');
  await expect(customBlock).toHaveCount(0);
  await page.getByLabel("Lastprofil").selectOption("customer_monthly_hourly.v1");
  await expect(customBlock).toBeVisible();
  // 12 Monate + 24 Werktag + 24 Wochenende.
  await expect(customBlock.locator('input[type="number"]')).toHaveCount(60);
  // Monatssumme 4200 == Haushalts-kWh (konsistent).
  const monthlyKwh = [450, 400, 350, 300, 250, 230, 230, 280, 330, 380, 450, 550];
  for (const [index, kwh] of monthlyKwh.entries()) {
    await customBlock.locator(`input[name="customMonthly.${index}"]`).fill(String(kwh));
  }
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/)).toBeVisible();

  // Gespeichert: Monatswerte stehen als known-Profil im Kontext.
  const saved = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  const custom = (saved?.profile as unknown as {
    value?: { consumption?: { customLoadProfile?: { status?: unknown; value?: unknown } } };
  } | null)?.value?.consumption?.customLoadProfile;
  expect(custom?.status).toBe("known");
  expect((custom?.value as { monthlyKwh?: unknown })?.monthlyKwh).toEqual(monthlyKwh);
});

test("M1-11g: F4.2-Monatsprofil treibt currentV2-Monatsform", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  // Winterlastig, Summe 4200 == Haushalts-kWh: Dezember 6x Juli.
  const monthlyKwh = [700, 600, 400, 250, 150, 100, 100, 150, 250, 400, 500, 600];
  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Lastprofil").selectOption("customer_monthly_hourly.v1");
  const customBlock = page.locator('[data-energy-custom-profile="true"]');
  await expect(customBlock).toBeVisible();
  for (const [index, kwh] of monthlyKwh.entries()) {
    await customBlock.locator(`input[name="customMonthly.${index}"]`).fill(String(kwh));
  }
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Monatsprofil-Kette erreichte kein currentV2.");
  }
  const result = expected.calculation.resultV2.value;
  // Jahressumme = Monats-Basis (4200) + EV (12000 km x 0,2 kWh/km);
  // kein stilles H0-Default, keine erfundene Zusatzlast.
  expect(Math.abs(result.annual.consumptionKwh - (4200 + 12000 * 0.2))).toBeLessThan(5);
  // Monatsform folgt den Monatswerten: Dezember-Import klar über Juli.
  const december = result.monthly[11]!;
  const july = result.monthly[6]!;
  expect(december.month).toBe(12);
  expect(july.month).toBe(7);
  expect(december.gridImportKwh).toBeGreaterThan(july.gridImportKwh);

  // Session aus dem Editor-Login besteht weiter: direkter Goto ohne Re-Login.
  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await expect(page.locator('[data-energy-calculation-state="currentV2"]')).toBeVisible();
  const v2result = page.locator('[data-energy-calculation-v2-result="true"]');
  await expect(v2result).toBeVisible();
  // Monatstabelle spiegelt die Monatsform: 12 Zeilen, Dezember-Netzbezug
  // als formatierter Kettenwert in der Dezember-Zeile.
  const rows = v2result.locator("table tbody tr");
  await expect(rows).toHaveCount(12);
  await expect(rows.first().getByRole("rowheader")).toHaveText("Januar");
  const decemberRow = rows.nth(11);
  await expect(decemberRow.getByRole("rowheader")).toHaveText("Dezember");
  await expect(decemberRow.getByText(formatKwh(december.gridImportKwh))).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-v2-result="true"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Monatsprofilansicht",
  ).toEqual([]);
});

test("M1-11g: F4.3-WP-Thermie treibt currentV2-WP-Strom", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  // Thermischer WP-Bedarf 12.000 kWh + Kennlinienparameter (legacy
  // WP-Strom bleibt 0 aus dem Kandidaten-Snapshot: kein Widerspruch).
  await page.getByLabel(/Wärmebedarf/).fill("12000");
  await page.getByLabel(/COP Nennwert/).fill("4");
  await page.getByLabel(/Bivalenzpunkt/).fill("-6");
  await page.getByLabel(/Warmwasseranteil/).fill("0.2");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  // Gespeichert: Thermalwerte stehen als known-Profil im Kontext.
  const saved = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  const consumption = (saved?.profile as unknown as {
    value?: { consumption?: Record<string, { status?: unknown; value?: unknown }> };
  } | null)?.value?.consumption;
  expect(consumption?.heatPumpThermalKwhPerYear?.status).toBe("known");
  expect(consumption?.heatPumpThermalKwhPerYear?.value).toBe(12000);

  // F5-01 WP-Schätzung: gespeicherte 12.000 kWh -> Bestand 6 kW,
  // Neubau 7,06 kW, Norm-Hinweis direkt an der Zahl.
  await page.reload();
  const sizingBox = page.getByTestId("hp-sizing-estimate");
  await expect(sizingBox).toContainText("Bestand: 6 kW");
  await expect(sizingBox).toContainText("Neubau: 7,06 kW");
  await expect(sizingBox).toContainText("DIN EN 12831");

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("WP-COP-Kette erreichte kein currentV2.");
  }
  // COP-Effekt: WP-Strom (annual minus Haushalt 4200 minus EV 2400) liegt
  // echt zwischen 0 und der Thermie 12.000 (keine Pauschal-1:1-Form).
  const annual = expected.calculation.resultV2.value.annual.consumptionKwh;
  const wpElectrical = annual - (4200 + 12000 * 0.2);
  expect(wpElectrical).toBeGreaterThan(0);
  expect(wpElectrical).toBeLessThan(12000);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await expect(page.locator('[data-energy-calculation-state="currentV2"]')).toBeVisible();
  await expect(page.locator('[data-energy-calculation-v2-result="true"]')).toBeVisible();
});

test("M1-11g: F4.5-Investition/Verguetung treibt currentV2-economics", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  // Kandidat liefert Preis 36 Ct + 3 % Eskalation; hier Investition und
  // Verguetungs-Override dazu (EEG-Tabelle bleibt unbenutzt).
  await page.getByLabel("Investition netto (€)").fill("20000");
  await page.getByLabel("Einspeisevergütung Override (Ct/kWh, leer = EEG-Default)").fill("8");
  await page.getByLabel("EEG-Inbetriebnahmejahr (Vergütungssatz, 1990–2100)").fill("2024");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Wirtschaftlichkeits-Kette erreichte kein currentV2.");
  }
  const economics = expected.calculation.resultV2.value.economics;
  if (!economics) throw new Error("currentV2 traegt kein economics.");
  // Override-Quelle, 20 Zeilen, Amortisation im Horizont.
  expect(economics.feedInTariffSource).toBe("override");
  expect(economics.feedInTariffCtPerKwh).toBe(8);
  expect(economics.investmentEuro).toBe(20000);
  expect(economics.cumulativeCashflowEuro).toHaveLength(20);
  expect(economics.annualSavingsEuro).toBeGreaterThan(0);
  expect(economics.amortizationYears).not.toBeNull();
  const amortized = economics.amortizationYears!;
  expect(economics.cumulativeCashflowEuro[amortized - 1]).toBeGreaterThanOrEqual(0);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  const block = page.locator('[data-energy-calculation-v2-economics="true"]');
  await expect(block).toBeVisible();
  // KPI-Zeilen als formatierte Kettenwerte (Jahresersparnis, Amortisationsjahr).
  await expect(block.getByText(`Jahr ${amortized}`)).toBeVisible();
  const rows = block.locator("table tbody tr");
  await expect(rows).toHaveCount(20);

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-v2-economics="true"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Wirtschaftlichkeitsansicht",
  ).toEqual([]);
});

test("M1-11g: F4.5b-Workspace-Default traegt currentV2-economics", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  // Preis/Eskalation unbelegt (Provenienz default); Investition/Verguetung
  // kommen aus dem Editor, Preis/Horizont aus Workspace-Defaults.
  await writeCandidateSnapshot(workspaceId, ids.projectId, {
    electricityPrice: "default",
    annualPriceIncrease: "default",
  });
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(
      `insert into workspace_economics_settings
         (id, workspace_id, revision, electricity_price_net_cents_per_kwh,
          escalation_rate_bps, cashflow_horizon_years, created_by)
       values ('${randomUUID()}', '${workspaceId}'::uuid, 1, 30, 200, 15, '${actorId}'::uuid)`,
    );
  }));

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Investition netto (€)").fill("20000");
  await page.getByLabel("Einspeisevergütung Override (Ct/kWh, leer = EEG-Default)").fill("8");
  await page.getByLabel("EEG-Inbetriebnahmejahr (Vergütungssatz, 1990–2100)").fill("2024");
  // Preis/Eskalation leeren: Profil-Luecke faellt auf Workspace-Defaults.
  await page.getByLabel("Kundentarif (ct/kWh)").fill("");
  await page.getByLabel("Angegebene Preisänderung (%/Jahr)").fill("");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Workspace-Default-Kette erreichte kein currentV2.");
  }
  const economics = expected.calculation.resultV2.value.economics;
  if (!economics) throw new Error("currentV2 traegt kein economics.");
  expect(economics.priceSource).toBe("workspace_default");
  expect(economics.importPriceCtPerKwh).toBe(30);
  expect(economics.priceEscalationRate).toBeCloseTo(0.02, 12);
  expect(economics.settingsRevision).toBe(1);
  expect(economics.horizonYears).toBe(15);
  expect(economics.cumulativeCashflowEuro).toHaveLength(15);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  const block = page.locator('[data-energy-calculation-v2-economics="true"]');
  await expect(block).toBeVisible();
  await expect(block.getByText(/Workspace-Default/)).toBeVisible();
  await expect(block.locator("table tbody tr")).toHaveCount(15);
});

test("M1-11g: F4.4a-Neutarif traegt currentV2-Bills", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Investition netto (€)").fill("20000");
  await page.getByLabel("Einspeisevergütung Override (Ct/kWh, leer = EEG-Default)").fill("8");
  await page.getByLabel("EEG-Inbetriebnahmejahr (Vergütungssatz, 1990–2100)").fill("2024");
  await page.getByLabel("Neutarif Vergleich (Ct/kWh, leer = kein Vergleich)").fill("28");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("Tarifvergleich-Kette erreichte kein currentV2.");
  }
  const economics = expected.calculation.resultV2.value.economics;
  if (!economics) throw new Error("currentV2 traegt kein economics.");
  // Konsistenz: noPv − current = self × 0,36; Neutarif 28 Ct belegt.
  const annual = expected.calculation.resultV2.value.annual;
  expect(economics.annualBillsEuro.newTariffEuro).not.toBeNull();
  expect(economics.annualBillsEuro.newTariffEuro).toBeCloseTo(annual.gridImportKwh * 0.28, 2);
  expect(
    economics.annualBillsEuro.noPvEuro - economics.annualBillsEuro.currentEuro,
  ).toBeCloseTo(annual.selfConsumptionKwh * 0.36, 2);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  const block = page.locator('[data-energy-calculation-v2-economics="true"]');
  await expect(block).toBeVisible();
  await expect(block.getByText("Stromrechnung (Jahr 1)")).toBeVisible();
  await expect(block.getByText("Mit PV (Neutarif)")).toBeVisible();
});

test("M1-11g: F4.4b-TOU traegt currentV2-Bill und Ladefahrplan", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Investition netto (€)").fill("20000");
  await page.getByLabel("Einspeisevergütung Override (Ct/kWh, leer = EEG-Default)").fill("8");
  await page.getByLabel("EEG-Inbetriebnahmejahr (Vergütungssatz, 1990–2100)").fill("2024");
  const touPrices = [...new Array(6).fill("20"), ...new Array(18).fill("38")].join(", ");
  await page.getByLabel("TOU-Stundenpreise (24 Werte Komma-getrennt, leer = kein TOU)").fill(touPrices);
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("TOU-Kette erreichte kein currentV2.");
  }
  const economics = expected.calculation.resultV2.value.economics;
  if (!economics) throw new Error("currentV2 traegt kein economics.");
  const tou = economics.tou;
  if (!tou) throw new Error("currentV2 traegt keinen TOU-Block.");
  // Konsistenz: Ersparnis = Flattarif-Rechnung mit PV minus TOU-Rechnung.
  expect(tou.billEuro).toBeGreaterThan(0);
  expect(tou.savingsVsFlatEuro).toBeCloseTo(
    economics.annualBillsEuro.currentEuro - tou.billEuro,
    2,
  );
  expect(tou.gridChargeKwh).toBeGreaterThanOrEqual(0);
  expect(tou.schedule24h).toHaveLength(24);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  const block = page.locator('[data-energy-calculation-v2-tou="true"]');
  await expect(block).toBeVisible();
  await expect(block.getByText("Zeitvariabler Tarif")).toBeVisible();
  await expect(block.getByText("Mit PV (Zeittarif)")).toBeVisible();
  await expect(page.locator('[data-energy-tou-schedule-chart="true"]')).toBeVisible();
  await expect(page.locator('[data-energy-sankey-chart="true"]')).toBeVisible();
});

test("M1-11g: F4.2c-Lastgang-CSV treibt currentV2-Jahreslast", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  // Konstante Stundenlast mit Summe 4200 = Haushalts-kWh (Band ±0,06).
  const csvValue = 4200 / 8_760;
  const csvText = new Array(8_760).fill(String(csvValue)).join("\n");
  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Lastprofil").selectOption("customer_csv.v1");
  const csvBlock = page.locator('[data-energy-csv-profile="true"]');
  await expect(csvBlock).toBeVisible();
  // 8.760 Zeilen per fill() haengen (Aktions-Budget); die Textarea ist
  // unkontrolliert — FormData liest .value beim Submit.
  await csvBlock.getByLabel("Lastgang-Reihe (kWh je Zeile)").evaluate((element, text) => {
    const area = element as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(area, text);
    else area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, csvText);
  await expect(csvBlock.getByLabel("Lastgang-Reihe (kWh je Zeile)")).toHaveValue(/0\.479/);
  await page.getByRole("button", { name: "Profil speichern" }).click();
  const savedMessage = page.getByText(/Profilrevision \d+ wurde gespeichert/);
  await expect(savedMessage).toBeVisible();
  const revision = Number((await savedMessage.textContent() ?? "").match(/Profilrevision (\d+)/)?.[1]);
  expect(Number.isInteger(revision)).toBe(true);

  await addResolution(
    ids,
    createHash("sha256").update("m111g-v1-input").digest("hex"),
    createHash("sha256").update("m111g-v1-revision").digest("hex"),
  );
  const reserved = await reserve(ids, revision);
  await runChain(ids, reserved.jobId);

  const expected = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  if (expected?.calculation.status !== "currentV2") {
    throw new Error("CSV-Kette erreichte kein currentV2.");
  }
  const result = expected.calculation.resultV2.value;
  // Jahressumme = CSV-Basis (4200) + EV (12000 km x 0,2 kWh/km).
  expect(Math.abs(result.annual.consumptionKwh - (4_200 + 12000 * 0.2))).toBeLessThan(5);

  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await expect(page.locator('[data-energy-calculation-state="currentV2"]')).toBeVisible();
  const v2result = page.locator('[data-energy-calculation-v2-result="true"]');
  await expect(v2result).toBeVisible();
  await expect(page.locator('[data-energy-sankey-chart="true"]')).toBeVisible();
});

test("M1-11g: Boden-Albedo speichert als known-Profil", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const ids: SeedIds = {
    workspaceId,
    actorId,
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  await seedProjectGraph(ids);
  await writeCandidateSnapshot(workspaceId, ids.projectId);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();
  await page.getByLabel("Boden-Albedo (0–1, leer = 0,2)").fill("0.5");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/)).toBeVisible();

  const saved = await poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    actorId,
    workspaceId,
    (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
  ));
  const albedo = (saved?.profile as unknown as {
    value?: { consumption?: { groundAlbedo?: { status?: unknown; value?: unknown } } };
  } | null)?.value?.consumption?.groundAlbedo;
  expect(albedo?.status).toBe("known");
  expect(albedo?.value).toBe(0.5);
});
