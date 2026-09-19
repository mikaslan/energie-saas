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
 * F1-23-E2E-Auto — STATUS: UNGERUNNT (Lauf macht die Zentrale).
 * Chromium-E2E (isolierter Workspace): Editor pflegt eine Auto-Regel
 * (Modus Automatisch, Defaults auto_on_manual=true / auto_on_intake=false
 * sichtbar), erfasst danach eine manuelle Anfrage mit dieser Quelle; die
 * Projektakte zeigt das Regelziel als Key Account (Stand 1). Regelvollzug,
 * kein Zuweisungsrecht des Erfassers nötig.
 *
 * ANGENOMMENES UI (T8-IMPL-Vertrag, ggf. zentral nachziehen):
 * - Lead-Quellen-Seite: Formular [data-testid="routing-rule-form"] wie in
 *   f1-23-routing-suggest.spec.ts, zusätzlich Checkboxen
 *   "Auto bei manueller Erfassung" (Default an) und "Auto bei Intake"
 *   (Default aus); Modus-Option "Automatisch".
 * - Manuelle Erfassung: Bestands-IDs aus F12-02 (manual-lead-open,
 *   manual-lead-form, manual-lead-success, "Projektakte öffnen"); die
 *   Quellenauswahl trägt das Label "Lead-Quelle" (Annahme).
 * - Projektakte: Region "Projektverantwortung" mit "Stand 1" (F12-02-Muster).
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

test("F1-23-E2E-Auto: Auto-Regel weist manuelle Erfassung zu", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const sourceId = randomUUID();

  await poolOne(async (pool) => withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F123 Auto', 'f123 auto')
    `);
  }));

  // 1) Auto-Regel auf den Editor; Trigger-Defaults prüfen.
  const settingsPath = `/w/${workspaceId}/einstellungen/lead-quellen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Lead-Quellen", level: 1 })).toBeVisible();
  const form = page.getByTestId("routing-rule-form");
  await form.getByLabel("Lead-Quelle").selectOption({ label: "F123 Auto" });
  await form.getByLabel("Betreuer").selectOption({ label: data.editorEmail });
  await form.getByLabel("Modus").selectOption({ label: "Automatisch" });
  await form.getByLabel("Priorität").fill("10");
  await expect(form.getByLabel("Auto bei manueller Erfassung")).toBeChecked();
  await expect(form.getByLabel("Auto bei Intake")).not.toBeChecked();
  await form.getByRole("button", { name: "Regel speichern" }).click();
  await expect(page.getByText("Routing-Regel gespeichert.", { exact: true })).toBeVisible();

  // 2) Manuelle Erfassung mit dieser Quelle.
  await page.goto(`/w/${workspaceId}/anfragen`);
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("Auto Kontakt");
  await leadForm.getByLabel("E-Mail").fill("auto@f123-e2e.test");
  await leadForm.getByLabel(/Lead-Quelle/).selectOption({ label: "F123 Auto" });
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();

  const success = page.getByTestId("manual-lead-success");
  await expect(success).toBeVisible();
  const projectHref = await success.getByRole("link", { name: "Projektakte öffnen" }).getAttribute("href");
  expect(projectHref, "Erfolgsmeldung verlinkt die Projektakte").toMatch(/^\/w\/.+\/anfragen\/.+$/u);

  // 3) Akte: Regelziel ist Key Account (Stand 1).
  await page.goto(projectHref!);
  const responsibility = page.getByRole("region", { name: "Projektverantwortung" });
  await expect(responsibility.getByText("Stand 1", { exact: false })).toBeVisible();
  await expect(responsibility.getByText(data.editorEmail, { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Auto-Grenze").toEqual([]);
});
