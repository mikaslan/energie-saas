import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { withTenantOn } from "../../lib/db/tenant";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F2-05b Zahlart-Hinweise — Chromium-E2E (isolierter Workspace, Lane 7 Welle 2).
 *
 * F205B-E2E-01 (RED): Zahlart der aktiven Variante erscheint als reiner
 * Lese-Hinweis im OfferSignaturePanel (D5-05, exakte §4-Texte); ohne
 * Zahlart der Null-Text. Scheitert, bis das Panel den Hinweis rendert.
 * F205B-NEG-01 (PIN, erwartet GRÜN): öffentliche Token-Route zeigt kein
 * Zahlart-Label — D5-04 ist verworfen (§5), Gate unverändert.
 *
 * Isolation (f12-01-Muster): eigener Workspace + eigenes M2-01-Ready-Projekt.
 * Der geteilte w3Workspace scheiterte in der Vollsuite an UNIQUE
 * payment_option_ws_active_key_uq, weil die f2-05-Spec `purchase` zuerst
 * belegt (CI rot/lokal grün).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  adminEmail: string;
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
    "adminEmail",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F2-05b-E2E-State ist unvollständig.");
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

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function seedIsolatedWorkspace(): Promise<{ workspaceId: string; editorIdentityId: string }> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email in ($1, $2)",
      [data.adminEmail, data.editorEmail],
    );
    const adminId = identities.rows.find((row) => row.email === data.adminEmail)?.id;
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!adminId) throw new Error("F205B-E2E: Admin-Identität fehlt.");
    if (!editorId) throw new Error("F205B-E2E: Editor-Identität fehlt.");
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${workspaceId}::uuid, 'F205B isoliert')
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
               (${workspaceId}::uuid, ${editorId}::uuid, 'editor',
                 '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,"assign_projects":true,"convert_phase":true,"discounts":true}'::jsonb)
      `);
    });
    return { workspaceId, editorIdentityId: editorId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function signaturePanel(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Signaturanforderungen", exact: true }),
  });
}

test("F205B-E2E-01: Zahlart-Hinweis im Signatur-Panel (gesetzt + Null-Text)", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const { workspaceId, editorIdentityId } = await seedIsolatedWorkspace();
  const seed = await seedM201ReadyProject(data.databaseUrl, {
    workspaceId,
    editorIdentityId,
    skuSuffix: "w3-f205b",
  });

  // Stammdaten-Voraussetzung per UI (eigene Bezeichnung für stabile Selektoren).
  const settingsPath = `/w/${workspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await page.getByLabel("Schlüssel").selectOption("purchase");
  await page.getByLabel("Bezeichnung").fill("Kauf Hinweis E2E");
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Zahlart angelegt.")).toBeVisible();

  // Angebot per UI erzeugen (Ready-Status aus dem eigenen M2-01-Seed).
  const projectPath = `/w/${workspaceId}/anfragen/${seed.projectId}`;
  await page.goto(projectPath);
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("9800");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));

  // Ohne Zahlart: Null-Text (§4 DE null, exakt).
  const panel = signaturePanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Zahlart der Variante: keine Angabe (reine Anzeige).", { exact: true }))
    .toBeVisible();

  // Zahlart an der Variante setzen.
  const controls = page.locator("section").filter({
    has: page.getByRole("heading", { name: /Zahlart/, exact: false }),
  });
  await controls.getByLabel("Zahlart wählen").selectOption({ label: "Kauf Hinweis E2E (Kauf)" });
  await controls.getByRole("button", { name: "Zahlart speichern", exact: true }).click();
  await expect(controls.getByText("Die Zahlart wurde gespeichert.")).toBeVisible();

  // Mit Zahlart: Hinweis mit Label (§4 DE gesetzt, exakt), reine Anzeige.
  await page.reload();
  const reloadedPanel = signaturePanel(page);
  await expect(reloadedPanel.getByText(
    "Zahlart der Variante: Kauf Hinweis E2E (reine Anzeige).",
    { exact: true },
  )).toBeVisible();
  await expect(reloadedPanel.getByText("vorbereitet · nicht versendet")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Signatur-Grenze").toEqual([]);
});

test("F205B-NEG-01 [PIN, erwartet GRÜN]: öffentliche Token-Route ohne Zahlart-Label", async ({ page }) => {
  // PIN: D5-04 verworfen (F2-05b §5) — kein Label auf /s/[token], Gate unverändert.
  // Erwartet GRÜN schon vor der Implementierung; pinnt den Verwurf.
  test.setTimeout(60_000);
  const errors = trackErrors(page);

  await page.goto("/s/00000000-0000-0000-0000-000000000000");
  await expect(page.getByText(/Zahlart der Variante|Variant payment option/)).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Token-Route").toEqual([]);
});
