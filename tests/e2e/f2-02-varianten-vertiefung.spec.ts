import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F2.2 Varianten-Vertiefung — Chromium-E2E (Nachholblock Welle 03).
 *
 * Abdeckung (klickbarer Pfad + DB-Read-back): Angebot per UI erzeugen
 * (Erstvariante ist per F2.2-Semantik primary), Variante per UI
 * duplizieren (Kopie nie primary), Variantennavigation zeigt beide,
 * DB-Read-back belegt is_primary/Override/Bundles.
 *
 * F2.2-E2E-02 deckt die Editor-Steuerung ab (Promote per UI, Override mit
 * Euro-Kommaschreibweise, Bundle-Liste speichern) inkl. DB-Read-back.
 * Service-Semantik (Switch/Override/Bundles inkl. No-ops) decken zusätzlich
 * die Vitest-DB-Tests tests/db/f202-variant-deepening.test.ts ab.
 * Eigenes W3-Projekt: keine Kopplung an andere Specs (f7-03-Lehre).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  f22ProjectId: string;
  editorEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "f22ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F2.2-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
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
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => url.pathname === expectedPath);
}

type VariantRow = {
  id: string;
  ordinal: number;
  isPrimary: boolean;
  bundles: unknown;
  override: number | null;
};

async function readVariantState(): Promise<VariantRow[]> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select v.id::text as id, v.ordinal as ordinal,
              v.is_primary as "isPrimary", v.optional_bundles as bundles,
              o.total_price_override_net_cents as override
         from offer o
         join offer_variant v
           on v.workspace_id = o.workspace_id
          and v.offer_id = o.id
        where o.workspace_id = $1::uuid
          and o.project_id = $2::uuid
        order by v.ordinal asc`,
      [data.w3WorkspaceId, data.f22ProjectId],
    );
    return result.rows as VariantRow[];
  } finally {
    await pool.end();
  }
}

test("F2.2-E2E-01: Varianten-Lifecycle — Create, Duplikat, Primary-Semantik", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f22ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // Angebot per UI erzeugen (Ready-Status aus dem M2-01-Seed).
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("9800");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const detailPath = new URL(page.url()).pathname;
  const initialVariantId = new URL(page.url()).searchParams.get("variante");
  expect(initialVariantId).toBeTruthy();

  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
  await expect(page.getByLabel("Variantenname").first()).toHaveValue("Basis");

  // Variante per UI duplizieren.
  const duplicateSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
  });
  await duplicateSection.getByLabel("Name der Kopie").fill("W3-Zweitvariante");
  await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === detailPath
    && url.searchParams.get("variante") !== initialVariantId);
  await expect(page.locator("#variant-name")).toHaveValue("W3-Zweitvariante");

  // Navigation zeigt beide Varianten.
  await expect(page.getByLabel("Angebotsvariante", { exact: true }).locator("option"))
    .toHaveCount(2);

  // F2.2-Semantik als DB-Read-back: Erstvariante primary, Kopie nicht,
  // kein Override, keine Bundles.
  await expect.poll(async () => (await readVariantState()).length, {
    message: "Beide Varianten müssen persistiert sein.",
    timeout: 15_000,
  }).toBe(2);
  const variants = await readVariantState();
  expect(variants[0]?.isPrimary).toBe(true);
  expect(variants[1]?.isPrimary).toBe(false);
  expect(variants[0]?.override).toBeNull();
  expect(variants[1]?.override).toBeNull();
  expect(variants[0]?.bundles).toEqual([]);
  expect(variants[1]?.bundles).toEqual([]);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F2.2-E2E-02: Editor-Steuerung — Promote, Deal-Override, Bundles", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f22ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // Angebot per UI erzeugen, Zweitvariante duplizieren (Muster aus E2E-01).
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("9800");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const detailPath = new URL(page.url()).pathname;
  const initialVariantId = new URL(page.url()).searchParams.get("variante");
  const duplicateSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
  });
  await duplicateSection.getByLabel("Name der Kopie").fill("W3-Steuerung");
  await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === detailPath
    && url.searchParams.get("variante") !== initialVariantId);
  await expect(page.locator("#variant-name")).toHaveValue("W3-Steuerung");

  const controls = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Primärvariante und Deal-Wert", exact: true }),
  });
  await expect(controls).toBeVisible();

  // Zweitvariante per UI zur primären Variante machen.
  await controls.getByRole("button", { name: /als primär festlegen/ }).click();
  await expect(controls.getByText("Die primäre Variante wurde umgeschaltet.")).toBeVisible();
  await expect(controls.getByText(/Primärvariante:/)).toContainText("W3-Steuerung");

  // Deal-Override mit Euro-Kommaschreibweise setzen.
  await controls.getByLabel("Deal-Override netto in Euro (optional)").fill("12,50");
  await controls.getByRole("button", { name: "Override speichern", exact: true }).click();
  await expect(controls.getByText("Der Deal-Override wurde gespeichert.")).toBeVisible();
  await expect(controls.getByText(/Deal-Override aktiv/)).toBeVisible();

  // Optionale Bundles der aktiven Variante pflegen.
  await controls.getByRole("button", { name: "Bundle hinzufügen", exact: true }).click();
  await controls.getByLabel("Bundle-Name 1", { exact: true }).fill("Wallbox-Paket");
  await controls.getByRole("button", { name: "Bundles speichern", exact: true }).click();
  await expect(controls.getByText("Die optionalen Bundles wurden gespeichert.")).toBeVisible();

  // DB-Read-back: Zweitvariante primär, Override 1250 Cent (Offer-Ebene),
  // Bundle an der Zweitvariante.
  await expect.poll(async () => {
    const rows = await readVariantState();
    return rows.some((row) => row.ordinal === 1 && row.isPrimary);
  }, { message: "Der Promote muss in der DB sichtbar sein.", timeout: 15_000 }).toBe(true);
  const variants = await readVariantState();
  expect(variants).toHaveLength(2);
  const promoted = variants.find((row) => row.id !== variants[0]?.id);
  expect(promoted?.isPrimary).toBe(true);
  expect(variants[0]?.override).toBe("1250");
  expect(variants[1]?.override).toBe("1250");
  expect(promoted?.bundles).toEqual([{ name: "Wallbox-Paket", position: 0 }]);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
