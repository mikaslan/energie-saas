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
  await seedProjectGraph(ids, { branch: "existing_installation" });
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

  const axe = await new AxeBuilder({ page })
    .include('[data-energy-calculation-v2-existing="true"]')
    .analyze();
  expect(
    axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
    "Axe serious/critical in der v2-Bestandsansicht",
  ).toEqual([]);
});
