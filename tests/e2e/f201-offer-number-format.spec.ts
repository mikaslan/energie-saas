import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F2.1 Angebotsnummernformat — Chromium-E2E (isolierte Workspaces).
 * Format per Settings-UI setzen → Angebot per UI erzeugen → Nummer folgt
 * dem Format (PV-Jahr-0001). Zweit-Workspace ohne Format belegt Legacy-
 * Default (ANG-Jahr-000001). Keine Shared-Fixture-Berührung.
 */

type SerializedF201State = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  serverLogPath: string;
};

function runtimeState(): SerializedF201State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF201State>;
  const required: Array<keyof SerializedF201State> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F201-E2E-State ist unvollständig.");
  }
  return parsed as SerializedF201State;
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
  throw new Error("Der echte F201-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
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

async function seedIsolatedReadyProject(
  tag: string,
  skuSuffix: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const data = runtimeState();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [workspaceId, tag]);
    await client.query(
      "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
      [workspaceId],
    );
    await client.query(
      `insert into membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'editor',
         '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
            "assign_projects":true,"convert_phase":true,"discounts":true}'::jsonb)`,
      [workspaceId, data.editorIdentityId],
    );
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
  const seed = await seedM201ReadyProject(data.databaseUrl, {
    editorIdentityId: data.editorIdentityId,
    workspaceId,
    skuSuffix,
  });
  return { workspaceId, projectId: seed.projectId };
}

async function readLatestOfferNumber(
  databaseUrl: string,
  workspaceId: string,
  projectId: string,
): Promise<{ offerNumber: string; numberYear: number; numberSequence: number }> {
  const pool = createDrainTrackedPool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select offer_number, number_year, number_sequence from offer
        where workspace_id = $1::uuid and project_id = $2::uuid
        order by created_at desc, id desc limit 1`,
      [workspaceId, projectId],
    );
    const row = result.rows[0] as
      | { offer_number: string; number_year: number; number_sequence: number }
      | undefined;
    if (!row) throw new Error("F201-E2E-Angebot wurde nicht über die Browser-Action erzeugt.");
    return { offerNumber: row.offer_number, numberYear: row.number_year, numberSequence: row.number_sequence };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function createOfferViaUi(page: Page, workspaceId: string, projectId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/anfragen/${projectId}`);
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    new RegExp(`^/w/${workspaceId}/angebote/[0-9a-f-]+$`, "u").test(url.pathname)
    && url.searchParams.has("variante"));
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test("F201-E2E-01: gesetztes Format steuert die erzeugte Angebotsnummer", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackBrowserErrors(page);
  const data = runtimeState();
  const world = await seedIsolatedReadyProject("F2.1 isolierter Format-Workspace", "f201a");

  const settingsPath = `/w/${world.workspaceId}/einstellungen/angebotsnummern`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Angebotsnummern", exact: true })).toBeVisible();
  await expect(page.getByTestId("number-format-preview")).toHaveText(/^ANG-[0-9]{4}-[0-9]{6}$/u);

  await page.getByTestId("number-format-prefix").fill("pv");
  await page.getByTestId("number-format-padding").fill("4");
  await page.getByTestId("number-format-submit").click();
  await expect(page.getByTestId("number-format-feedback")).toContainText("gespeichert");
  await expect(page.getByTestId("number-format-preview")).toHaveText(/^PV-[0-9]{4}-[0-9]{4}$/u);

  await createOfferViaUi(page, world.workspaceId, world.projectId);
  const created = await readLatestOfferNumber(data.databaseUrl, world.workspaceId, world.projectId);
  expect(created.offerNumber).toBe(`PV-${created.numberYear}-0001`);
  expect(created.numberSequence).toBe(1);

  expect(errors, "Browser-Konsole und Page-Errors des Format-Flusses").toEqual([]);
});

test("F201-E2E-02: ohne Format gilt Legacy-Default ANG/6", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackBrowserErrors(page);
  const data = runtimeState();
  const world = await seedIsolatedReadyProject("F2.1 isolierter Legacy-Workspace", "f201b");

  const projectPath = `/w/${world.workspaceId}/anfragen/${world.projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);
  await createOfferViaUi(page, world.workspaceId, world.projectId);
  const created = await readLatestOfferNumber(data.databaseUrl, world.workspaceId, world.projectId);
  expect(created.offerNumber).toBe(`ANG-${created.numberYear}-000001`);
  expect(created.numberSequence).toBe(1);

  expect(errors, "Browser-Konsole und Page-Errors des Legacy-Flusses").toEqual([]);
});
