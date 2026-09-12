import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  readM201RevisionEvidence,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F2-06 Upsell-Auswahl Slice A — Chromium-E2E (m201-Seed).
 * Editor legt eine optionale freie Position an (Positionsart Optional),
 * die Detailseite zeigt den Upsell-Block mit Checkbox; Toggle aktualisiert
 * die angezeigte Summe nachweisbar und reversibel. Axe sauber.
 */

const browserErrors = new WeakMap<Page, string[]>();

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
    throw new Error("Der private F2-06-E2E-State ist unvollständig.");
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

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);
  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state.serverLogPath, state.editorEmail, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedTarget);
}

function domainId(id: string | null, expression: RegExp, label: string): string {
  const match = id ? expression.exec(id) : null;
  if (!match) throw new Error(`${label} enthält keine stabile Domain-ID.`);
  return match[1]!;
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

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F2-06 Browser-Konsole und Page-Errors").toEqual([]);
});

test("F206-E2E-01: Optionale Position wird Upsell-Checkbox mit Live-Summe", async ({ page }) => {
  test.setTimeout(240_000);
  const state = runtimeState();
  const projectPath = `/w/${state.workspaceId}/anfragen/${state.m201ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, projectPath);

  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const offerUrl = new URL(page.url());
  const offerId = offerUrl.pathname.split("/").at(-1)!;
  const variantId = offerUrl.searchParams.get("variante")!;
  const firstEvidence = await readM201RevisionEvidence(state, offerId, variantId);

  const sourceSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "PV-Module", exact: true }),
  });
  await expect(sourceSection).toHaveCount(1);
  await sourceSection.getByRole("button", { name: "Freie Position hinzufügen" }).click();
  const customName = page.getByLabel("Positionsname", { exact: true });
  const customLineId = domainId(
    await customName.getAttribute("id"),
    /^line-([0-9a-f-]+)-name$/u,
    "Positionsname",
  );
  const customLine = page.locator(`#line-${customLineId}-editor`);
  await customLine.getByLabel("Positionsname").fill("Synthetische Wallbox");
  await customLine.getByLabel("Einheit", { exact: true }).selectOption("set");
  await customLine.getByLabel("Menge", { exact: true }).fill("1");
  await customLine.getByLabel("VK je Einheit €", { exact: true }).fill("952,00");
  await customLine.getByLabel("EK je Einheit €", { exact: true }).fill("400");
  await customLine.getByLabel("Positionsart").selectOption("optional");
  await customLine.getByLabel("Steuer je Position").selectOption("zero_operator_confirmed");
  await customLine.getByLabel(
    "0-%-Steuerentwurf für diese Position frisch bestätigen",
  ).check();

  await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
  await expect.poll(async () =>
    (await readM201RevisionEvidence(state, offerId, variantId)).revision,
  { timeout: 30_000 }).toBe(firstEvidence.revision + 1);
  await page.reload();
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();

  const panel = page.getByTestId("offer-upsell-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Synthetische Wallbox")).toBeVisible();
  const total = panel.getByTestId("offer-upsell-total");
  const basisText = (await total.textContent()) ?? "";
  expect(basisText).toContain("keine Auswahl");
  const checkbox = panel.getByLabel("Synthetische Wallbox als Upsell wählen");
  await checkbox.check();
  await expect.poll(async () => total.textContent(), { timeout: 12_000 })
    .not.toBe(basisText);
  const withUpsell = (await total.textContent()) ?? "";
  expect(withUpsell).not.toContain("keine Auswahl");
  await checkbox.uncheck();
  await expect.poll(async () => total.textContent(), { timeout: 12_000 }).toBe(basisText);

  await expectNoWcagAaAxeViolations(page, "F2-06-Upsell");
});
