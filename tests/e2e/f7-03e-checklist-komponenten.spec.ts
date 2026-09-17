import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import {
  createInstallation,
  formatWorkbookComponentsText,
  getInstallationWorkbook,
  setInstallationVariant,
} from "@/modules/installations";
import {
  createM201RedactedViewer,
  seedM201AdditionalReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F7-03E {{komponenten}} (Workbook-Stückliste) — Chromium-E2E.
 * Setup nach F7-10-Präzedenz: M2-01-Zusatzprojekt → Angebot im Browser
 * erstellen → Installation per Service anlegen + Variante binden →
 * Checkliste zeigt die Stückliste, Eingabe bleibt Rohtext.
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

test("F7-03E-E2E-01: {{komponenten}} zeigt die Workbook-Stückliste, roh gespeichert", async ({ page }) => {
  test.setTimeout(240_000);
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
    if (!row) throw new Error("F7-03E-E2E: eigenes Angebot fehlt.");
    return row;
  });

  const expectedComponents = await withM201Database(m201, async (tx, ctx) => {
    await createInstallation(tx, ctx, { projectId });
    await setInstallationVariant(tx, ctx, { projectId, variantId: offer.variantId });
    const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
    if (!workbook) throw new Error("F7-03E-E2E: Workbook fehlt nach Bindung.");
    return formatWorkbookComponentsText(workbook.sections);
  });
  // Ehrliche Anker aus der versiegelten M2-01-Kette (26 × 400-W-Module).
  expect(expectedComponents).toContain("26 piece Synthetische M2-01 module-Komponente");
  expect(expectedComponents).toContain("1 piece Synthetische M2-01 inverter-Komponente");

  const url = `/w/${m201.workspaceId}/anfragen/${projectId}/checkliste`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  const rawTitle = "Montage {{komponenten}}";
  const shownTitle = `Montage ${expectedComponents}`;
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(rawTitle);

  // E-01: Anzeige substituiert (Checkbox-Name = volle Stückliste).
  const item = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(item.getByRole("checkbox").first()).toHaveAccessibleName(shownTitle);
  // E-02: Eingabe zeigt Rohtext.
  await expect(page.getByLabel("Punkt-Name 1.1")).toHaveValue(rawTitle);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-03: Reload stabil (Editor ohne Strukturrecht: substituierte Anzeige
  // ueber Text-Anker, Rohtext per DB-Read-back — Eingabefelder ab Version 1
  // nur mit checklist.configure, M2-01-Harness ohne Admin).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const reloaded = page.locator("li", { hasText: "26 piece Synthetische M2-01 module-Komponente" });
  await expect(reloaded.getByRole("checkbox").first()).toHaveAccessibleName(shownTitle);
  await expect(page.getByLabel("Punkt-Name 1.1")).toHaveCount(0);
  const stored = await withM201Database(m201, async (tx) => {
    const found = await tx.execute<{ blocks: unknown }>(sql`
      select blocks from project_checklist
       where workspace_id = ${m201.workspaceId}::uuid
         and project_id = ${projectId}::uuid
         and phase = 'site_documentation'
       limit 1
    `);
    if (!found.rows[0]) throw new Error("F7-03E-E2E: gespeicherte Checkliste fehlt.");
    return found.rows[0].blocks;
  });
  expect(JSON.stringify(stored)).toContain(rawTitle);
  expect(JSON.stringify(stored)).not.toContain("Synthetische M2-01 module-Komponente");

  // E-04: Viewer (lesend) sieht substituiert, kein Eingabefeld.
  const viewer = await createM201RedactedViewer(m201);
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, viewer.email, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerItem = page.locator("li", { hasText: "26 piece Synthetische M2-01 module-Komponente" });
  await expect(viewerItem.first()).toContainText(shownTitle);
  await expect(page.getByText("{{komponenten}}")).toHaveCount(0);
  await expect(page.getByLabel("Punkt-Name 1.1")).toHaveCount(0);

  // E-06: Axe auf der Viewer-Sicht (substituierter Zustand).
  await expectNoWcagAaAxeViolations(page, "F7-03E-Komponenten");

  // E-05: Projekt ohne Bindung → Muster steht sichtbar (kein Phantom-Text).
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
  await page.getByLabel("Punkt-Name 1.1").fill(rawTitle);
  const unboundItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(unboundItem.getByRole("checkbox").first()).toHaveAccessibleName(rawTitle);

  expect(errors, "Browser-Konsole und Page-Errors der Komponenten-Platzhalter").toEqual([]);
});
