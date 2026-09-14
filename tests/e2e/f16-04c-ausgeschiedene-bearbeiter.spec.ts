import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { createDrainTrackedPool, endPoolAndWaitForClientRemoval } from "../setup/pg-pool-drain";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

// E2E-DB schreibt unter Workspace-Kontext (RLS/DML-Guard, Muster
// seedIsolatedWorkspace): eigene Client-Sitzung mit set_config.
async function withWorkspaceDb<T>(workspaceId: string, run: (query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<T>): Promise<T> {
  const pool = createDrainTrackedPool({ connectionString: state().databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
      [workspaceId],
    );
    const result = await run(
      async (text: string, params: unknown[] = []) => {
        const queried = await client.query(text, params);
        return { rows: queried.rows as Array<Record<string, unknown>> };
      },
    );
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

/**
 * F16-04c Ausgeschiedene Bearbeiter sichtbar — Chromium-E2E (isolierter
 * Workspace). Vorlage mit Bearbeiter anlegen, Mitglied per DB ausscheiden
 * lassen (Membership-Zeile weg — kein UI-Pfad nötig, der Abgang selbst ist
 * nicht Testgegenstand) → Edit-Formular zeigt den Ausgeschiedenen-Hinweis
 * statt still zu filtern; Speichern erhält die ID (kein stilles Purgen).
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
      throw new Error(`Der private F16-04C-E2E-State ist unvollständig (${key}).`);
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

test("F16-04C-E2E-01: Ausgeschiedener bleibt sichtbar und bleibt gespeichert", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const settingsPath = `/w/${workspaceId}/einstellungen/aufgaben-vorlagen`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Aufgaben-Vorlagen", level: 1 })).toBeVisible();

  // Zweites Mitglied per DB (Abgang wird später ebenfalls per DB
  // simuliert — der Abgang selbst ist nicht Testgegenstand).
  const stamp = Date.now();
  const memberEmail = `f1604c-b-${stamp}@e2e.test`;
  const membershipId = await withWorkspaceDb(workspaceId, async (query) => {
    const userId = randomUUID();
    const memberId = randomUUID();
    await query(
      "insert into public.user_identity (id, email) values ($1::uuid, $2)",
      [userId, memberEmail],
    );
    await query(
      `insert into public.membership (id, workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, $3::uuid, 'editor', '{}'::jsonb)`,
      [memberId, workspaceId, userId],
    );
    return memberId;
  });

  const templateName = `F16-04c E2E Vorlage ${stamp}`;
  const createSection = page.locator("section[aria-label=\"Neue Vorlage\"]");
  await createSection.getByLabel("Name").fill(templateName);
  await createSection.getByLabel("Aufgaben-Titel").fill(`F16-04c E2E Aufgabe ${stamp}`);
  await createSection.getByLabel("Mitglieder suchen").fill(memberEmail);
  await createSection.getByRole("button", { name: "Suchen", exact: true }).click();
  await createSection.getByRole("checkbox", { name: memberEmail }).check();
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  const article = page.locator("section[aria-label=\"Vorlagen\"] article").filter({
    has: page.getByRole("heading", { name: templateName }),
  });
  await expect(article).toHaveCount(1);

  // Abgang: Membership-Zeile weg → Hinweis statt stillem Filter.
  await withWorkspaceDb(workspaceId, async (query) => {
    await query("delete from public.membership where id = $1::uuid", [membershipId]);
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Aufgaben-Vorlagen", level: 1 })).toBeVisible();
  const reloaded = page.locator("section[aria-label=\"Vorlagen\"] article").filter({
    has: page.getByRole("heading", { name: templateName }),
  });
  await reloaded.getByText("Bearbeiten", { exact: true }).click();
  await expect(reloaded.getByTestId("template-departed-notice")).toContainText(
    "1 ausgeschiedener Bearbeiter",
  );

  // Speichern (Titel ändern) → Hinweis bleibt, ID bleibt gespeichert.
  await reloaded.getByLabel("Aufgaben-Titel").fill(`F16-04c E2E Aufgabe ${stamp} v2`);
  await reloaded.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(reloaded.getByText("Vorlage aktualisiert.", { exact: true })).toBeVisible();
  await expect(reloaded.getByTestId("template-departed-notice")).toContainText(
    "1 ausgeschiedener Bearbeiter",
  );

  // DB-Read-back: Ausgeschiedene-ID weiter gespeichert (kein Purgen).
  const stored = await withWorkspaceDb(workspaceId, async (query) => {
    const result = await query(
      `select assignee_membership_ids as "ids" from public.task_template
        where workspace_id = $1::uuid and name = $2`,
      [workspaceId, templateName],
    );
    return (result.rows[0] as unknown as { ids: string[] }).ids;
  });
  expect(stored).toEqual([membershipId]);

  expect(errors, "Browser-Konsole und Page-Errors der Ausgeschiedenen-Grenze").toEqual([]);
});
