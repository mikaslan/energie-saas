import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { withTenantOn } from "../../lib/db/tenant";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F12-01 Funnel-Kampagnen — Chromium-E2E (isolierter Workspace).
 * Editor legt per UI eine Kampagne an eigener Quelle an, erfasst danach
 * eine manuelle Anfrage mit dieser Kampagne; die Projektakte zeigt
 * Kampagne + Quelle. Kein öffentliches Frontend, keine Provider.
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
    throw new Error("Der private F12-01-E2E-State ist unvollständig.");
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
  await page.goto(`/login?${new URLSearchParams({ next: expectedPath }).toString()}`);
  await page.waitForURL((url) => url.pathname === "/login");

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

async function seedIsolatedWorkspace(): Promise<{ workspaceId: string }> {
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
    if (!adminId) throw new Error("F12-01-E2E: Admin-Identität fehlt.");
    if (!editorId) throw new Error("F12-01-E2E: Editor-Identität fehlt.");
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${workspaceId}::uuid, 'F12-01 isoliert')
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
               (${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
      `);
      // Eigene Quelle für die Kampagne (Verwaltungs-UI der Quelle selbst
      // bleibt F1.8-Sache; hier zählt die Kampagnen-Kette).
      await tx.execute(sql`
        insert into lead_source (workspace_id, name, name_normalized)
        values (${workspaceId}::uuid, 'F1201 E2E Messe', 'f1201 e2e messe')
      `);
    });
    return { workspaceId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F12-01-E2E-01: Kampagne anlegen → manuelle Anfrage mit Kampagne → Projektakte", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const { workspaceId } = await seedIsolatedWorkspace();

  const settingsPath = `/w/${workspaceId}/einstellungen/lead-quellen`;
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();

  const campaignForm = page.getByTestId("funnel-campaign-create-form");
  await campaignForm.getByLabel("Name").fill("Fruehjahrs-Messe");
  await campaignForm.getByLabel("Slug").fill("fruehjahr-2026");
  await campaignForm.getByLabel("Lead-Quelle").selectOption({ label: "F1201 E2E Messe" });
  await campaignForm.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Funnel-Kampagne angelegt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Fruehjahrs-Messe", { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F12-01-Einstellungsseite");

  // Manuelle Erfassung mit Kampagne (Anfragen-Board, Standardbereich).
  const boardPath = `/w/${workspaceId}/anfragen`;
  await page.goto(boardPath);
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("Kampagnen Kontakt");
  await form.getByLabel("E-Mail").fill("kampagne@f1201-e2e.test");
  await form.getByLabel(/Funnel-Kampagne/).selectOption({ label: "Fruehjahrs-Messe · F1201 E2E Messe" });
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();

  const success = page.getByTestId("manual-lead-success");
  await expect(success).toBeVisible();
  const projectHref = await success.getByRole("link", { name: "Projektakte öffnen" }).getAttribute("href");
  expect(projectHref, "Erfolgsmeldung verlinkt die Projektakte").toMatch(/^\/w\/.+\/anfragen\/.+$/u);

  await page.goto(projectHref!);
  await expect(page.getByText("Fruehjahrs-Messe · F1201 E2E Messe", { exact: true })).toBeVisible();

  expect(errors, "F12-01 Browser-Konsole und Page-Errors").toEqual([]);
});
