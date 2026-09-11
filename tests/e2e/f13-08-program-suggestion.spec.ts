import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-08 Programm-Vorschlag — Chromium-E2E (isolierter Workspace).
 * Projektakte: anlegen → Rechner-Snapshot mit Wärmepumpen-Signal hinterlegen
 * → Vorschlag BAFA beobachtbar → übernehmen → Programm gespeichert.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F13-08-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function seedHeatPumpSnapshot(workspaceId: string, projectId: string): Promise<void> {
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-09-10T00:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {
      answeredFieldIds: ["waermepumpe", "wohnflaeche"],
      requestedProducts: {
        targetStorageKwh: 10,
        wallbox: true,
        bidirectionalCharging: false,
        backupPower: false,
      },
    },
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      const project = await client.query(
        `select contact_id, site_id from public.project
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, projectId],
      );
      const row = project.rows[0] as { contact_id: string; site_id: string } | undefined;
      if (!row) throw new Error("E2E-Projekt fehlt");
      const receiptId = randomUUID();
      await client.query(
        `insert into public.inbound_receipt (
           id, workspace_id, source_key, submission_id, contract_version,
           body_sha256, auth_key_id, signed_at, submitted_at, received_at,
           producer_application, producer_git_revision, producer_environment,
           calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
           privacy_notice_version, privacy_notice_url, contact_resolution,
           contact_id, site_id, project_id
         ) values (
           $1::uuid, $2::uuid, 'wmee-rechner-v3', $3::uuid, 'rechner-intake.v1',
           decode(repeat('7a', 32), 'hex'), 'f1308-e2e', now(), now(), now(),
           'wmee-rechner-v3', $4, 'development', 'wmee-solar.v1',
           '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
           'https://example.test/privacy', 'created', $5::uuid, $6::uuid, $7::uuid
         )`,
        [
          receiptId,
          workspaceId,
          randomUUID(),
          createHash("sha256").update("f1308-e2e").digest("hex").slice(0, 40),
          row.contact_id,
          row.site_id,
          projectId,
        ],
      );
      await client.query(
        `insert into public.calculator_snapshot (
           id, workspace_id, receipt_id, project_id, schema_version,
           calculator_engine, result_integrity, investment_source,
           calculated_at, snapshot
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'wmee-solar-snapshot.v1',
           'wmee-solar.v1', 'client_reported_unverified', 'market_estimate',
           now(), $5::jsonb
         )`,
        [randomUUID(), workspaceId, receiptId, projectId, JSON.stringify(snapshot)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

test("F13-08-E2E-01: Wärmepumpen-Vorschlag übernehmen speichert BAFA", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Vorschlag");
  await form.getByLabel("Telefon").fill("0151 34567891");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = page.url();
  const projectId = detailUrl.match(/\/anfragen\/([0-9a-f-]+)$/u)?.[1] ?? "";
  expect(projectId).toMatch(/^[0-9a-f-]+$/u);

  // 1) Ohne Rechner-Signale: ehrlich kein Vorschlag.
  await page.getByTestId("subsidy-case-create").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("In Vorbereitung");
  await expect(page.getByTestId("subsidy-suggestion-text")).toContainText("Kein Programm-Vorschlag");
  await expect(page.getByTestId("subsidy-suggestion-apply")).toHaveCount(0);

  // 2) Mit Wärmepumpen-Snapshot: Vorschlag BAFA mit Begründung.
  await seedHeatPumpSnapshot(workspaceId, projectId);
  await page.reload();
  await expect(page.getByTestId("subsidy-suggestion-text")).toContainText("BAFA");
  await expect(page.getByTestId("subsidy-suggestion-text")).toContainText("Wärmepumpe");
  await expect(page.getByTestId("subsidy-suggestion-text")).toContainText("f13-08-suggest.v1");

  // 3) Übernehmen speichert das Programm sichtbar.
  await page.getByTestId("subsidy-suggestion-apply").click();
  await expect(page.getByTestId("subsidy-case-details-feedback")).toContainText("Angaben gespeichert.");
  await expect(page.getByTestId("subsidy-case-current")).toContainText("BAFA");

  expect(errors, "Browser-Konsole und Page-Errors der Vorschlags-Grenze").toEqual([]);
});
