import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "playwright/test";
import { withTenantOn } from "../../lib/db/tenant";
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
 * F1-19 Zielpakete in der Akte — Chromium-E2E (isolierter Workspace).
 *
 * - Paket-Matrix im Editor: Solar Ja+Kauf, Heizung Ja+Finanzierung,
 *   Speicher Nein. Save schreibt eine neue Anforderungsrevision mit
 *   requestedPackages (DB-Assertion, läuft schon heute).
 * - Die Akte zeigt die Kaufabsicht je Paket mit Zahlart.
 *
 * ABHÄNGIGKEIT (Lesepfad-Follow-up): Die Akten-Anzeige
 * (data-testid energy-packages) braucht die Lese-Erweiterung in der
 * Projekt-Service-Schicht. Bis dahin schlägt der letzte Block fehl;
 * Editor, Action-Merge und DB-CHECK sind grün
 * (tests/db/f1019-energy-deepening.test.ts).
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

async function latestRequirementPackages(ids: SeedIds): Promise<{
  revision: number;
  packages: unknown;
}> {
  return poolOne(async (pool) => withTenantOn(pool, ids.workspaceId, async (tx) => {
    const result = await tx.execute<{ revision: number; packages: unknown }>(sql`
      select revision, requirements->'requestedPackages' as packages
        from project_requirement
       where project_id = ${ids.projectId}::uuid
       order by revision desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1-19-E2E-Anforderung fehlt.");
    return { revision: row.revision, packages: row.packages };
  }));
}

test("F1-19-E2E-02: Zielpakete werden Revision und erscheinen in der Akte", async ({ page }) => {
  test.setTimeout(180_000);
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
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();

  await expect(page.getByTestId("packages-section")).toBeVisible();
  await page.getByTestId("pkg-solar-wanted").selectOption("true");
  await page.getByTestId("pkg-solar-payment").selectOption("purchase");
  await page.getByTestId("pkg-heating-wanted").selectOption("true");
  await page.getByTestId("pkg-heating-payment").selectOption("financing");
  await page.getByTestId("pkg-storage-wanted").selectOption("false");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/u)).toBeVisible();

  const latest = await latestRequirementPackages(ids);
  expect(latest.revision).toBe(2);
  expect(latest.packages).toMatchObject({
    solar: { wanted: true, paymentKind: "purchase" },
    storage: { wanted: false, paymentKind: null },
    heating: { wanted: true, paymentKind: "financing" },
  });

  await page.goto(projectPath);
  const packages = page.getByTestId("energy-packages");
  await expect(packages).toBeVisible();
  await expect(packages).toContainText("Solar (Kauf)");
  await expect(packages).toContainText("Heizung (Finanzierung)");

  expect(errors, "Browser-Konsole und Page-Errors der Paket-Grenze").toEqual([]);
});
