import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
} from "../../lib/integrations/catalog/contract";
import {
  activateCatalogComponent,
  createCatalogComponent,
} from "../../modules/catalog";
import {
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-13b Paket-Picker-Suche — Chromium-E2E.
 * 201 Füller-Produkte + 1 Zielprodukt mit eindeutiger SKU: Das Ziel liegt
 * hinter der 200er-Preload-Grenze und ist ohne Suche unsichtbar. Per
 * Server-Suche wird es gefunden, gebunden und das Paket gespeichert.
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1613bState = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1613bState = Pick<
  M201RuntimeState,
  "databaseUrl" | "editorEmail" | "editorIdentityId" | "serverLogPath" | "workspaceId"
>;

function runtimeState(): F1613bState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1613bState>;
  const required: Array<keyof SerializedF1613bState> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-13b-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1613bState;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.editorEmail,
    editorIdentityId: complete.editorIdentityId,
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.w3WorkspaceId,
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
  throw new Error("Der echte F16-13b-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedTarget: string): Promise<void> {
  const data = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(await otpFromPrivateDevMailLog(data.serverLogPath, email, logOffset));
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
  expect(browserErrors.get(page) ?? [], "F16-13b Browser-Konsole und Page-Errors").toEqual([]);
});

function fillerCommand(sku: string, stamp: number): CatalogComponentCreateCommandV1 {
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: sku,
    componentType: "battery",
    presentation: {
      displayName: `Füller ${sku}`,
      manufacturer: "WMEE Testwerk",
      model: "F16-13b E2E",
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: {
      schemaVersion: "battery.v1",
      nominalCapacityWh: 8_500,
      usableCapacityWh: 8_000,
      maxContinuousPowerWatts: 4_000,
      roundTripEfficiencyBasisPoints: 9_400,
      backupCapability: "known_supported",
    },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 100_000,
      salesPriceNetCents: 150_000,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `SYNTHETIC-E2E-${stamp}`,
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-E2E-${stamp}`,
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: `SYNTHETIC-E2E-${stamp}`,
      observedOn: "2026-08-29",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  };
}

test.describe("F16-13b Paket-Picker-Suche", () => {
  let targetSku = "";
  let targetName = "";

  test.beforeAll(async () => {
    const data = runtimeState();
    const stamp = Date.now();
    targetSku = `ZZZ-F1613B-TARGET-${stamp}`;
    targetName = `Zielprodukt ${stamp}`;
    await withM201Database(data, async (tx, ctx) => {
      for (let index = 0; index < 201; index += 1) {
        const created = await createCatalogComponent(tx, ctx, fillerCommand(
          `AAA-F1613B-FILL-${stamp}-${String(index).padStart(3, "0")}`,
          stamp,
        ));
        await activateCatalogComponent(tx, ctx, {
          componentId: created.componentId,
          expectedRevision: 1,
          expectedStatus: "draft",
        });
      }
      const target = await createCatalogComponent(tx, ctx, {
        ...fillerCommand(targetSku, stamp),
        presentation: {
          ...fillerCommand(targetSku, stamp).presentation,
          displayName: targetName,
        },
      });
      await activateCatalogComponent(tx, ctx, {
        componentId: target.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      });
    });
  });

  test("F16-13B-E2E-01: Produkt hinter Position 200 per Suche binden", async ({ page }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const packageName = `F1613B Paket ${stamp}`;
    const settingsPath = `/w/${data.workspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();

    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neues Paket", exact: true }),
    });
    await creator.getByLabel("Paketname").fill(packageName);
    await creator.getByLabel("Sektionstitel").fill(`F1613B Sektion ${stamp}`);
    await creator.getByLabel("Kategorie").selectOption("battery");
    await creator.getByLabel("Positionsname 1").fill(`F1613B Zeile ${stamp}`);
    await creator.getByLabel("Menge 1").fill("2");

    // Ohne Suche ist das Ziel hinter der 200er-Grenze unsichtbar.
    const binding = creator.getByLabel("Katalogbindung 1 (optional)");
    await expect(binding.locator(`option:has-text("${targetSku}")`)).toHaveCount(0);
    await creator.getByLabel("Katalog suchen 1 (optional)").fill(`ZZZ-F1613B-TARGET-${targetSku.split("-").pop()}`);
    await expect(creator.getByText("1 Treffer", { exact: false })).toBeVisible();
    await binding.selectOption({ label: `${targetSku} — ${targetName} (Rev. 1)` });
    await expect(creator.getByText(`Gebunden: ${targetSku} (Rev. 1)`, { exact: false })).toBeVisible();
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(creator.getByText("Paket angelegt.", { exact: true })).toBeVisible();
    const article = page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName });
    await expect(article).toHaveCount(1);
    await article.getByText("Bearbeiten", { exact: true }).click();
    await expect(article.getByText(`Gebunden: ${targetSku} (Rev. 1)`, { exact: false })).toBeVisible();
    expect(errors, "Browser-Konsole bei Picker-Suche").toEqual([]);
  });
});
