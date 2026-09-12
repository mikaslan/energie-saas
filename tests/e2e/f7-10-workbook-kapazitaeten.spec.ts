import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { createInstallation, setInstallationVariant } from "@/modules/installations";
import {
  seedM201AdditionalReadyProject,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F7-10 Workbook-Kapazitaeten — Chromium-E2E.
 * M2-01-Fixture (26 × 400-W-Module, 8.000-Wh-Speicher) → Angebot im
 * Browser erstellen → Installation per Service anlegen + Variante
 * binden → Projektseite zeigt 10,4 kWp / 8 kWh im Workbook.
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

const browserErrors = new WeakMap<Page, string[]>();

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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte F7-10-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

  const otp = await otpFromPrivateDevMailLog(
    state.serverLogPath,
    state.editorEmail,
    logOffset,
  );
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

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F7-10 Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F7-10 Workbook-Kapazitaeten", () => {
  test("F7-10-E2E-01: Workbook zeigt versiegelte kWp/kWh der gebundenen Variante", async ({ page }) => {
    test.setTimeout(120_000);
    const state = runtimeState();
    // Eigenes Zusatzprojekt: Die Angebotserstellung kippt die Projektphase
    // auf "offer" — das geteilte M2-01-Projekt bliebe sonst für M2-01/02/03a
    // im Zustand "converted" statt "ready" zurück.
    const projectId = await seedM201AdditionalReadyProject(state);
    const projectPath = `/w/${state.workspaceId}/anfragen/${projectId}`;
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
    // Jüngstes Angebot des EIGENEN Projekts (readM201Offer ist an das
    // geteilte M2-01-Projekt gebunden).
    const offer = await withM201Database(state, async (tx) => {
      const found = await tx.execute<{ variantId: string }>(sql`
        select variant.id as "variantId"
          from offer
          join offer_variant as variant
            on variant.workspace_id = offer.workspace_id
           and variant.offer_id = offer.id
           and variant.ordinal = 1
         where offer.workspace_id = ${state.workspaceId}::uuid
           and offer.project_id = ${projectId}::uuid
         order by offer.created_at desc, offer.id desc
         limit 1
      `);
      const row = found.rows[0];
      if (!row) throw new Error("F7-10-E2E: eigenes Angebot fehlt.");
      return row;
    });

    await withM201Database(state, async (tx, ctx) => {
      await createInstallation(tx, ctx, { projectId });
      await setInstallationVariant(tx, ctx, {
        projectId,
        variantId: offer.variantId,
      });
    });

    await page.goto(projectPath);
    const panel = page.getByTestId("installation-workbook-panel");
    await expect(panel).toBeVisible();
    const capacities = panel.getByTestId("workbook-capacities");
    await expect(capacities).toBeVisible();
    // 26 Module × 400 W, 8.000 Wh nutzbar.
    await expect(capacities.getByText("10,4 kWp", { exact: true })).toBeVisible();
    await expect(capacities.getByText("8 kWh", { exact: true })).toBeVisible();
  });
});
