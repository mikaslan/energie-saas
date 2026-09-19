import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "playwright/test";
import { withTenantOn } from "../../lib/db/tenant";
import type { TenantTx } from "../../lib/db/types";
import type { PlanningCalculationRequestV1 } from "../../lib/integrations/calculation/contract";
import { calculatePlanningEstimate } from "../../lib/integrations/calculation/engine";
import { buildPlanningCalculationInput } from "../../lib/integrations/calculation/prepare";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationSuccess,
  persistProjectCalculationInput,
  type ProjectCalculationClaim,
} from "../../modules/energy/calculation-service";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  seedProjectGraph,
  state as fixtureState,
  writeCandidateSnapshot,
  type SeedIds,
} from "./m1-11g-fixture";

/**
 * F1-19 Planungsrechnung stale→current erhalten — Chromium-E2E (isolierter
 * Workspace, M1-05-Muster: UI treibt Save/Confirm, DB-Helfer vollenden den
 * Job deterministisch wie ein Worker).
 *
 * - Seed: unbestätigtes Profil + historische Revision -> stale sichtbar.
 * - UI-Bestätigung -> queued; Job-Vollendung -> current („Ergebnis aktuell").
 * - UI-Paket-Save -> neue Anforderungsrevision -> stale („Ergebnis veraltet").
 * - Erneute UI-Bestätigung + Vollendung -> current.
 *
 * Damit bleibt der gesamte stale→current-Lebenszyklus nach F1-19 intakt.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  return {
    baseURL: full.baseURL,
    databaseUrl: full.databaseUrl,
    serverLogPath: full.serverLogPath,
    editorEmail: full.editorEmail,
  };
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByRole("button", { name: "Code anfordern" }).click();
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  let code: string | null = null;
  while (Date.now() < deadline && code === null) {
    const log = readFileSync(state().serverLogPath);
    const tail = log.subarray(Math.min(logOffset, log.byteLength)).toString("utf8");
    code = pattern.exec(tail)?.[1] ?? null;
    if (code === null) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!code) throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
  await otpInput.fill(code);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function withProjectDatabase<T>(
  ids: SeedIds,
  callback: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return poolOne(async (pool) => withTenantOn(pool, ids.workspaceId, callback));
}

async function latestCalculationJobId(ids: SeedIds): Promise<string> {
  return withProjectDatabase(ids, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      select id
        from project_calculation_job
       where workspace_id = ${ids.workspaceId}::uuid
         and project_id = ${ids.projectId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const jobId = result.rows[0]?.id;
    if (!jobId) throw new Error("F1-19-E2E-Rechenauftrag fehlt.");
    return jobId;
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
    roofs?: Array<{ id?: unknown; tiltDeg?: unknown; azimuthDeg?: unknown }>;
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
    throw new Error("F1-19-E2E-Providerfixture kann nicht gebunden werden.");
  }
  const latitude = Math.round(request.latitude * 1_000) / 1_000;
  const longitude = Math.round(request.longitude * 1_000) / 1_000;
  return profile.roofs.map((roof) => {
    if (
      typeof roof.id !== "string"
      || typeof roof.tiltDeg !== "number"
      || typeof roof.azimuthDeg !== "number"
    ) {
      throw new Error("F1-19-E2E-Dachfixture ist ungültig.");
    }
    return {
      ...template,
      roofId: roof.id,
      request: {
        ...template.request,
        latitude,
        longitude,
        tiltDeg: roof.tiltDeg,
        azimuthDeg: roof.azimuthDeg,
      },
    };
  });
}

async function completeCalculation(ids: SeedIds, jobId: string): Promise<void> {
  const leaseToken = randomUUID();
  const claim = await withProjectDatabase(ids, (tx) =>
    claimProjectCalculationJob(tx, {
      workspaceId: ids.workspaceId,
      jobId,
      leaseToken,
    }));
  if (claim === null) throw new Error("F1-19-E2E-Rechenauftrag war nicht claimbar.");
  const prepared = buildPlanningCalculationInput({
    claim,
    providerSnapshot: providerSnapshotsForClaim(claim),
  });
  const stored = await withProjectDatabase(ids, (tx) =>
    persistProjectCalculationInput(tx, {
      workspaceId: ids.workspaceId,
      jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      ...prepared,
    }));
  const result = calculatePlanningEstimate(stored.inputSnapshot);
  await withProjectDatabase(ids, (tx) => finalizeProjectCalculationSuccess(tx, {
    workspaceId: ids.workspaceId,
    jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    result,
  }));
}

test("F1-19-E2E-03: stale→current überlebt Paket-Revisionen", async ({ page }) => {
  test.setTimeout(240_000);
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
  const errors = trackBrowserErrors(page);

  const editorPath = `/w/${workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  const projectPath = `/w/${workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);

  const staleFirst = page.locator('[data-energy-calculation-state="stale"]');
  await expect(staleFirst).toBeVisible();
  await expect(staleFirst).toContainText("Ergebnis veraltet");

  await page.goto(editorPath);
  await page.getByRole("button", { name: "Eingaben bestätigen" }).click();
  await expect(page.getByText(/Profilrevision 1 ist für Adressrevision .* bestätigt/u))
    .toBeVisible();
  await page.goto(projectPath);
  await expect(page.locator('[data-energy-calculation-state="queued"]')).toBeVisible();

  await completeCalculation(ids, await latestCalculationJobId(ids));
  await page.reload();
  const currentFirst = page.locator('[data-energy-calculation-state="current"]');
  await expect(currentFirst).toBeVisible();
  await expect(currentFirst).toContainText("Ergebnis aktuell");

  await page.goto(editorPath);
  await page.getByTestId("pkg-solar-wanted").selectOption("true");
  await page.getByTestId("pkg-solar-payment").selectOption("purchase");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ (wurde gespeichert|war bereits unverändert gespeichert)/u))
    .toBeVisible();

  await page.goto(projectPath);
  const staleSecond = page.locator('[data-energy-calculation-state="stale"]');
  await expect(staleSecond).toBeVisible();
  await expect(staleSecond).toContainText("Ergebnis veraltet");

  await page.goto(editorPath);
  await page.getByRole("button", { name: "Eingaben bestätigen" }).click();
  // Zweit-Bestaetigung kann die Neu-Reservations-Quota treffen (M1-07):
  // dann Wartezeit abwarten und erneut bestaetigen (M1-05-Muster).
  // Erfolg prueft ueber die stabile Bestaetigungs-Notiz: das Formular
  // unmountet nach Erfolg (needsConfirmation=false), die Message waere fluechtig.
  const confirmedNote = page.getByText(/ist für Adressrevision .* bestätigt/u);
  const rateLimitFeedback = page.getByRole("alert").filter({
    hasText: "Zu viele neue Berechnungen",
  });
  await expect(confirmedNote.or(rateLimitFeedback)).toBeVisible();
  if (await rateLimitFeedback.isVisible()) {
    const rateLimitText = await rateLimitFeedback.textContent();
    const retryAfter = /Bitte in (\d+) Sekunden erneut versuchen\./u.exec(
      rateLimitText ?? "",
    );
    if (!retryAfter) throw new Error("F1-19-E2E-03-Quota-Wartezeit fehlt.");
    await page.waitForTimeout(Number(retryAfter[1]) * 1_000 + 250);
    await page.getByRole("button", { name: "Eingaben bestätigen" }).click();
    await expect(confirmedNote).toBeVisible();
  }
  await page.goto(projectPath);
  await expect(page.locator('[data-energy-calculation-state="queued"]')).toBeVisible();
  await completeCalculation(ids, await latestCalculationJobId(ids));
  await page.goto(projectPath);
  const currentSecond = page.locator('[data-energy-calculation-state="current"]');
  await expect(currentSecond).toBeVisible();
  await expect(currentSecond).toContainText("Ergebnis aktuell");

  expect(errors, "Browser-Konsole und Page-Errors der Rechen-Grenze").toEqual([]);
});
