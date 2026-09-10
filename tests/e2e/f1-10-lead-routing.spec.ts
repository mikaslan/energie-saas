import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "playwright/test";
import { withTenantOn } from "@/lib/db/tenant";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-10 Lead-Routing — Chromium-E2E (isolierter Workspace).
 * Editor setzt die Regel in den Einstellungen (Dropdown), das
 * Zuweisungs-Panel zeigt den Vorschlag, ein Klick übernimmt ihn als
 * Key Account (bestehender set_key_account-Pfad).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
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
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1-10-E2E-State ist unvollständig (${key}).`);
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
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
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

test("F1-10-E2E-01: Regel setzen → Vorschlag → als Key Account übernehmen", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const projectId = randomUUID();
  const sourceId = randomUUID();

  // Minimaler Projektgraph + Quelle (Attribution wie der Intake sie setzt).
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    const contactId = randomUUID();
    const siteId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F110-E2E', 'Fixture', 'Contact', 'e2e@f110.test', 'e2e@f110.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F110 Site')
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F110 Routing', 'f110 routing')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key, lead_source_id)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F110 Project', 'manual', ${sourceId}::uuid
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  }));

  // 1) Regel in den Einstellungen setzen (Dropdown auf Editor-E-Mail).
  const settingsPath = `/w/${workspaceId}/einstellungen/lead-quellen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "F110 Routing" });
  await row.getByLabel("Standard-Betreuer für F110 Routing", { exact: true }).selectOption({ label: data.editorEmail });
  await row.getByRole("button", { name: "Standard-Betreuer für F110 Routing speichern" }).click();
  await expect(page.getByText("Standard-Betreuer gespeichert.", { exact: true })).toBeVisible();
  await expect(row.getByText(`Aktuell: ${data.editorEmail}`)).toBeVisible();

  // 2) Projektakte: Vorschlag sichtbar → übernehmen → Key Account gesetzt.
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  const suggestion = page.getByTestId("routing-suggestion");
  await expect(suggestion).toContainText("Routing-Vorschlag");
  await expect(suggestion).toContainText("F110 Routing");
  await expect(suggestion).toContainText(data.editorEmail);
  await suggestion.getByRole("button", { name: "Als Key Account festlegen" }).click();
  await expect(page.getByText("Die Projektverantwortung wurde gespeichert.")).toBeVisible();
  const panel = page.locator("#project-assignment");
  await expect(panel.getByText(data.editorEmail).first()).toBeVisible();

  // 3) Nach der Übernahme ist der Vorschlag verbraucht.
  await page.reload();
  await expect(page.getByTestId("routing-suggestion")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Routing-Grenze").toEqual([]);
});
