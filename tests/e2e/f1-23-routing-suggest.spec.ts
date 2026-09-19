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
 * F1-23-E2E-Suggest — STATUS: UNGERUNNT (Lauf macht die Zentrale).
 * Chromium-E2E (isolierter Workspace): Editor pflegt zwei Suggest-Regeln,
 * die Projektakte zeigt die Union (2 Einträge, Priority-Reihenfolge),
 * ein Klick übernimmt den ersten als Key Account (Ein-Klick bleibt).
 *
 * ANGENOMMENES UI (T8-IMPL-Vertrag, ggf. zentral nachziehen):
 * - Lead-Quellen-Seite: Formular [data-testid="routing-rule-form"] mit
 *   Labels "Lead-Quelle" (Select), "Betreuer" (Select), "Modus" (Select mit
 *   Optionen "Vorschlag"/"Automatisch"), "Priorität" (Zahl), Button
 *   "Regel speichern", Erfolgstext "Routing-Regel gespeichert.".
 * - Projektakte: Container [data-testid="routing-suggestion"] mit je Regel
 *   einem [data-testid="routing-suggestion-item"] und Button
 *   "Als Key Account festlegen" (Bestands-Strings aus F1-10).
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
      throw new Error(`Der private F1-23-E2E-State ist unvollständig (${key}).`);
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

test("F1-23-E2E-Suggest: zwei Regeln → Union → Ein-Klick-Übernahme", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const secondEmail = `zweit-${randomUUID()}@f123-e2e.test`;

  // Quelle + Projektgraph + zweites routbares Mitglied (Union braucht 2 Ziele).
  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    const contactId = randomUUID();
    const siteId = randomUUID();
    const secondUserId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F123-E2E', 'Fixture', 'Contact', 'e2e@f123.test', 'e2e@f123.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F123 Site')
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F123 Suggest', 'f123 suggest')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key, lead_source_id)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F123 Project', 'manual', ${sourceId}::uuid
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into user_identity (id, email) values (${secondUserId}::uuid, ${secondEmail})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${workspaceId}::uuid, ${secondUserId}::uuid, 'editor', '{}'::jsonb)
    `);
  }));

  // 1) Zwei Suggest-Regeln, Priority 5 (Editor) + 50 (Zweitmitglied).
  const settingsPath = `/w/${workspaceId}/einstellungen/lead-quellen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();
  const form = page.getByTestId("routing-rule-form");
  for (const [memberLabel, priority] of [[data.editorEmail, "5"], [secondEmail, "50"]] as const) {
    await form.getByLabel("Lead-Quelle").selectOption({ label: "F123 Suggest" });
    await form.getByLabel("Betreuer").selectOption({ label: memberLabel });
    await form.getByLabel("Modus").selectOption({ label: "Vorschlag" });
    await form.getByLabel("Priorität").fill(priority);
    await form.getByRole("button", { name: "Regel speichern" }).click();
    await expect(page.getByText("Routing-Regel gespeichert.", { exact: true })).toBeVisible();
  }

  // 2) Projektakte: Union mit 2 Einträgen in Priority-Reihenfolge.
  await page.goto(`/w/${workspaceId}/anfragen/${projectId}`);
  const suggestion = page.getByTestId("routing-suggestion");
  await expect(suggestion).toContainText("Routing-Vorschlag");
  const items = suggestion.getByTestId("routing-suggestion-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(data.editorEmail);
  await expect(items.nth(1)).toContainText(secondEmail);

  // 3) Ein-Klick-Übernahme des ersten → Key Account gesetzt, Rest bleibt.
  await items.nth(0).getByRole("button", { name: "Als Key Account festlegen" }).click();
  await expect(page.getByText("Die Projektverantwortung wurde gespeichert.")).toBeVisible();
  const panel = page.locator("#project-assignment");
  await expect(panel.getByText(data.editorEmail).first()).toBeVisible();
  await expect(suggestion.getByTestId("routing-suggestion-item")).toHaveCount(1);

  expect(errors, "Browser-Konsole und Page-Errors der Suggest-Grenze").toEqual([]);
});
