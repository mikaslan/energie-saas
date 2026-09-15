import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
} from "../../lib/integrations/catalog/contract";
import {
  createCatalogComponent,
  listCatalogComponentRevisions,
  reviseCatalogComponentPricing,
  type CatalogComponentRevisionEntry,
} from "../../modules/catalog";
import {
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * M1-08c Katalog-Revisionsverlauf — Chromium-E2E.
 * Eine Preisrevision im Produktdetail erweitert die sichtbare
 * Revisionshistorie (Revision/Zeitpunkt/Bezeichnung/VK/EK/Snapshot),
 * ohne die Seite zu verlassen.
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedM108cState = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type M108cState = Pick<
  M201RuntimeState,
  "databaseUrl" | "editorEmail" | "editorIdentityId" | "serverLogPath" | "workspaceId"
>;

function runtimeState(): M108cState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM108cState>;
  const required: Array<keyof SerializedM108cState> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M1-08c-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM108cState;
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
  throw new Error("Der echte M1-08c-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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
  expect(browserErrors.get(page) ?? [], "M1-08c Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M1-08c Katalog-Revisionsverlauf", () => {
  let componentId = "";

  test.beforeAll(async () => {
    const data = runtimeState();
    const stamp = Date.now();
    componentId = await withM201Database(data, async (tx, ctx) => {
      const created = await createCatalogComponent(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
        internalSku: `BAT-M108C-E2E-${stamp}`,
        componentType: "battery",
        presentation: {
          displayName: `Verlaufsspeicher ${stamp}`,
          manufacturer: "WMEE Testwerk",
          model: "M1-08c E2E",
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
          purchasePriceNetCents: 250_123,
          salesPriceNetCents: 390_456,
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
      });
      return created.componentId;
    });
  });

  test("M1-08C-E2E-01: Preisrevision erweitert den sichtbaren Verlauf", async ({ page }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const detailPath = `/w/${data.workspaceId}/katalog/${componentId}`;

    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);
    const history = page.getByTestId("catalog-revision-history");
    await expect(history).toBeVisible();
    await expect(history.getByRole("row")).toHaveCount(2);

    await page.getByLabel("Verkaufspreis").fill("4100");
    await page.getByRole("button", { name: "Neue Preisrevision speichern", exact: true }).click();
    await expect(page.getByText("Preisrevision 2 wurde als Entwurf gespeichert.", { exact: true }))
      .toBeVisible();
    await expect(history.getByRole("row")).toHaveCount(3);

    const secondRow = history.getByRole("row").nth(2);
    await expect(secondRow).toContainText("2");
    await expect(secondRow).toContainText("4.100,00 €");

    const entries = await withM201Database(data, async (tx, ctx) =>
      listCatalogComponentRevisions(tx, ctx, componentId)) as CatalogComponentRevisionEntry[] | null;
    expect(entries?.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(errors, "Browser-Konsole beim Revisionsverlauf").toEqual([]);
  });

  test("M1-08C-E2E-02: Verlauf bleibt nach Seitenneuladung preisgetreu", async ({ page }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const detailPath = `/w/${data.workspaceId}/katalog/${componentId}`;

    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);
    const history = page.getByTestId("catalog-revision-history");
    await expect(history).toBeVisible();

    await withM201Database(data, async (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
      schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
      componentId,
      expectedRevision: 2,
      commercial: {
        currency: "EUR",
        basis: "net",
        purchasePriceNetCents: 250_123,
        salesPriceNetCents: 420_000,
        purchaseProvenance: {
          sourceKind: "supplier_price_list",
          reference: "SYNTHETIC-E2E-RELOAD",
          observedOn: "2026-08-29",
          rightsBasis: "supplier_authorized",
          sourceDocumentSha256: null,
        },
        salesProvenance: {
          sourceKind: "workspace_pricing",
          reference: "SYNTHETIC-E2E-RELOAD",
          observedOn: "2026-08-29",
          rightsBasis: "workspace_owned",
          sourceDocumentSha256: null,
        },
      },
    }));

    await page.reload();
    await expect(history.getByRole("row")).toHaveCount(4);
    await expect(history.getByRole("row").nth(3)).toContainText("4.200,00 €");
  });
});
