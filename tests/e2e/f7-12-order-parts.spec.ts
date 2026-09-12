import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { withTenantOn } from "../../lib/db/tenant";
import { tenantFixtures } from "../setup/tenant-fixtures";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7-12 Order Parts — Chromium-E2E (isolierter Workspace).
 * Angebots-Graph per Fixture-Kette, Installation per Seed, Editor bindet
 * die Variante per UI, legt eine Nachbestellung an, schreibt in den
 * Thread und stellt auf Bestellt.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId",
    "adminEmail", "editorEmail", "viewerEmail", "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7-12-E2E-State ist unvollständig.");
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
    if (match) return match[1]!;
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

  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function seedOrderParts(): Promise<{ workspaceId: string; projectId: string; variantName: string }> {
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
    if (!adminId) throw new Error("F7-12-E2E: Admin-Identität fehlt.");
    if (!editorId) throw new Error("F7-12-E2E: Editor-Identität fehlt.");
    let projectId = "";
    let variantName = "";
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-12 isoliert')
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
               (${workspaceId}::uuid, ${editorId}::uuid, 'editor',
                '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,"assign_projects":true}'::jsonb)
      `);
      await tenantFixtures.offer?.(tx, workspaceId);
      const project = await tx.execute<{ id: string }>(sql`
        select project.id
          from project
          join offer on offer.workspace_id = project.workspace_id
                   and offer.project_id = project.id
         where project.workspace_id = ${workspaceId}::uuid
         limit 1
      `);
      projectId = project.rows[0]?.id ?? "";
      if (!projectId) throw new Error("F7-12-E2E: Fixture-Projekt fehlt.");
      const variant = await tx.execute<{ name: string }>(sql`
        select variant.name
          from offer_variant as variant
          join offer on offer.workspace_id = variant.workspace_id
                   and offer.id = variant.offer_id
         where variant.workspace_id = ${workspaceId}::uuid
           and offer.project_id = ${projectId}::uuid
         order by variant.name, variant.id
         limit 1
      `);
      variantName = variant.rows[0]?.name ?? "";
      if (!variantName) throw new Error("F7-12-E2E: Fixture-Variante fehlt.");
      await tx.execute(sql`
        insert into installation (workspace_id, project_id, source, status)
        values (${workspaceId}::uuid, ${projectId}::uuid, 'direct', 'active')
      `);
    });
    return { workspaceId, projectId, variantName };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F7-12-E2E-01: Nachbestellung → Thread → Bestellt", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const { workspaceId, projectId, variantName } = await seedOrderParts();
  const path = `/w/${workspaceId}/anfragen/${projectId}`;

  await page.goto(`/login?${new URLSearchParams({ next: path }).toString()}`);
  await loginWithRealOtp(page, data.editorEmail, path);

  // Variante binden (F7-08-Fluss), damit Zeilenoptionen existieren.
  const panel = page.getByTestId("installation-workbook-panel");
  await expect(panel).toBeVisible();
  const variantSelect = panel.getByTestId("workbook-variant");
  const labels = await variantSelect.locator("option").allTextContents();
  const match = labels.find((label) => label.includes(variantName));
  expect(match, "Fixture-Variante ist auswählbar").toBeDefined();
  await variantSelect.selectOption({ label: match! });
  await panel.getByTestId("workbook-variant-submit").click();
  await expect(panel.getByTestId("workbook-variant-success")).toContainText(
    "Zu installierende Variante festgelegt.",
  );

  const section = page.locator('[data-order-parts="true"]');
  await expect(section).toBeVisible();
  await section.getByTestId("order-part-line").selectOption({ index: 0 });
  await section.getByTestId("order-part-quantity").fill("2");
  await section.getByRole("button", { name: "Anfordern", exact: true }).click();
  await expect(section.getByText("Nachbestellung angelegt.")).toBeVisible();
  await expect(section.getByText("Offen", { exact: true }).first()).toBeVisible();

  await section.getByPlaceholder("Nachricht zum Thread").fill("Lieferung KW 38?");
  await section.getByRole("button", { name: "Senden", exact: true }).click();
  await expect(section.getByText("Lieferung KW 38?")).toBeVisible();

  await section.getByRole("button", { name: "Bestellen", exact: true }).click();
  await expect(section.getByText("Bestellt", { exact: true }).first()).toBeVisible();

  expect(errors, "F7-12 Browser-Konsole und Page-Errors").toEqual([]);
});
