import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  seedProjectGraph,
  state as fixtureState,
  writeCandidateSnapshot,
  type SeedIds,
} from "./m1-11g-fixture";

/**
 * F1-19 Modus-Wechsel + Provenance — Chromium-E2E (isolierter Workspace).
 *
 * - Editor-Modusselektor: consumption -> property (Heizart + Bewohner
 *   Pflicht), -> roomwise (Raumliste 1..40), -> manual (Provenance
 *   operator_manual). Wechsel verlangt eine Bestätigung (Dialog).
 * - Die Akte zeigt Eingabemodus, Erfassungsquelle und Modus-Sektion.
 *
 * ABHÄNGIGKEIT (Serviceschicht-Follow-up): Der Profil-Save normalisiert
 * derzeit auf consumption (modules/energy/service.ts). Bis der Follow-up
 * inputMode/Sektionen/Provenance erhält, schlägt diese Spec nach dem
 * Save fehl; Contract-, CHECK- und Editor-Ebene darunter sind grün
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

async function seedGraph(): Promise<SeedIds> {
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
  await writeCandidateSnapshot(ids.workspaceId, ids.projectId);
  return ids;
}

test("F1-19-E2E-01: Modus-Wechsel property/roomwise/manual mit Provenance", async ({ page }) => {
  test.setTimeout(180_000);
  const ids = await seedGraph();
  const errors = trackBrowserErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  const editorPath = `/w/${ids.workspaceId}/anfragen/${ids.projectId}/energieprofil`;
  const projectPath = `/w/${ids.workspaceId}/anfragen/${ids.projectId}`;
  await page.goto(editorPath);
  await loginWithRealOtp(page, state().editorEmail, editorPath);
  await expect(page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 })).toBeVisible();

  const modeSelect = page.getByTestId("input-mode");
  await expect(modeSelect).toHaveValue("consumption");

  await modeSelect.selectOption("property");
  await expect(page.getByTestId("property-section")).toBeVisible();
  await page.getByTestId("heating-type").selectOption("heat_pump");
  await page.getByTestId("resident-count").fill("4");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/u)).toBeVisible();

  await page.goto(projectPath);
  await expect(page.getByTestId("energy-input-mode")).toHaveText("Objekt-Schätzung");
  await expect(page.getByTestId("energy-property-estimate")).toContainText("Wärmepumpe");

  await page.goto(editorPath);
  await page.getByTestId("input-mode").selectOption("roomwise");
  await expect(page.getByTestId("rooms-section")).toBeVisible();
  await page.locator("#room-0-name").fill("Wohnen");
  await page.locator("#room-0-area").fill("24");
  await page.locator("#room-0-usage").selectOption("living");
  await page.locator("#room-0-radiators").fill("2");
  await page.getByRole("button", { name: "Weiteren Raum erfassen" }).click();
  await page.locator("#room-1-name").fill("Bad");
  await page.locator("#room-1-area").fill("8");
  await page.locator("#room-1-usage").selectOption("bathroom");
  await page.locator("#room-1-radiators").fill("1");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/u)).toBeVisible();

  await page.goto(projectPath);
  await expect(page.getByTestId("energy-input-mode")).toHaveText("Raumweise Erfassung");
  await expect(page.getByTestId("energy-rooms")).toContainText("2 Räume");

  await page.goto(editorPath);
  await page.getByTestId("input-mode").selectOption("manual");
  await page.getByRole("button", { name: "Profil speichern" }).click();
  await expect(page.getByText(/Profilrevision \d+ wurde gespeichert/u)).toBeVisible();

  await page.goto(projectPath);
  await expect(page.getByTestId("energy-input-mode")).toHaveText("Manuelle Eingabe");
  await expect(page.getByTestId("energy-provenance")).toHaveText("Manuell erfasst");

  expect(errors, "Browser-Konsole und Page-Errors der Modus-Grenze").toEqual([]);
});
