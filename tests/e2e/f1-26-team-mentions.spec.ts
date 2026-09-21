import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Browser, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-26 Team-Mentions `@team:slug` — Chromium-E2E (isolierter Workspace).
 * Editor (A) schreibt eine Notiz mit @team:slug an ein Team, dessen
 * Mitglied der Viewer (B) ist; B öffnet das Dashboard, sieht die Sektion
 * „Meine Erwähnungen" (F1-25-Pfad) mit Zeile + Link, der Link führt zur
 * Projekt-Notiz mit sichtbarem Team-Chip.
 * Muster: F1-25-Spec (Login, Widget, Zweitkontext) + F1-09-Spec
 * (Notiz-Dialog). Team-Seed per SQL wie seedViewerMembership (F1-25).
 * RED: `@team:`-Pattern + Team-Mention-Schreib-/Lesepfad fehlen noch.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  viewerEmail: string;
};

function state(): E2EState {
  const full = fixtureState() as Partial<E2EState>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail", "viewerEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1-26-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as E2EState;
}

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

async function resolveUserIdByEmail(email: string): Promise<string> {
  return poolOne(async (pool) => {
    const result = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [email],
    );
    const id = (result.rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error("F1-26-E2E: Vieweridentitaet fehlt.");
    return id;
  });
}

async function seedViewerMembership(workspaceId: string, viewerId: string): Promise<void> {
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      await client.query(
        `insert into public.membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'viewer', '{}'::jsonb)`,
        [workspaceId, viewerId],
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

async function seedTeamWithViewer(
  workspaceId: string,
  viewerId: string,
  editorId: string,
  slug: string,
): Promise<void> {
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      const membership = await client.query(
        "select id from public.membership where workspace_id = $1::uuid and user_id = $2::uuid",
        [workspaceId, viewerId],
      );
      const membershipId = (membership.rows[0] as { id: string } | undefined)?.id;
      if (!membershipId) throw new Error("F1-26-E2E: Viewer-Membership fehlt.");
      const teamId = randomUUID();
      await client.query(
        `insert into public.team (id, workspace_id, name, name_normalized, active, revision, created_by)
         values ($1::uuid, $2::uuid, $3, $3, true, 1, $4::uuid)`,
        [teamId, workspaceId, slug, editorId],
      );
      await client.query(
        `insert into public.team_member (workspace_id, team_id, membership_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [workspaceId, teamId, membershipId],
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

async function writeTeamMentionAsEditor(
  browser: Browser,
  data: E2EState,
  workspaceId: string,
  leadName: string,
  noteText: string,
): Promise<string> {
  const context = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  });
  const editorPage = await context.newPage();
  const editorErrors = trackBrowserErrors(editorPage);
  try {
    const listPath = `/w/${workspaceId}/anfragen`;
    await editorPage.goto(listPath);
    await loginWithRealOtp(editorPage, data.editorEmail, listPath);
    await expect(editorPage.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

    await editorPage.getByTestId("manual-lead-open").click();
    const form = editorPage.getByTestId("manual-lead-form");
    await form.getByLabel("Name *").fill(leadName);
    await form.getByLabel("Telefon").fill("0151 45678906");
    await form.getByRole("button", { name: "Anfrage anlegen" }).click();
    const success = editorPage.getByTestId("manual-lead-success");
    await expect(success).toContainText("Anfrage angelegt");
    await success.getByRole("link", { name: "Projektakte öffnen" }).click();
    await expect(editorPage).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
    const projectId = new URL(editorPage.url()).pathname.split("/").pop()!;

    const notes = editorPage.locator("section#project-notes");
    await notes.getByRole("button", { name: "Notiz anlegen" }).click();
    const dialog = editorPage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Notiztext" }).click();
    await dialog.getByRole("textbox", { name: "Notiztext" }).pressSequentially(noteText);
    await dialog.getByRole("button", { name: "Notiz anlegen" }).click();
    await expect(dialog).toHaveCount(0);

    expect(editorErrors, "Browser-Konsole des Team-Mention-Setups").toEqual([]);
    return projectId;
  } finally {
    await context.close();
  }
}

test("F1-26-E2E-01: @team:slug schreiben → Mitglied sieht Dashboard-Zeile → Chip an Notiz", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const data = state();
  const viewerErrors = trackBrowserErrors(page);
  const stamp = Date.now();
  const teamSlug = "e2e-montage";
  const leadName = `F126 E2E Team-Erwähnung ${stamp}`;
  const marker = `f126-e2e-${stamp}`;
  const noteText = `${marker} Team @team:${teamSlug} bitte prüfen`;

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const viewerId = await resolveUserIdByEmail(data.viewerEmail);
  await seedViewerMembership(workspaceId, viewerId);
  await seedTeamWithViewer(workspaceId, viewerId, actorId, teamSlug);

  const projectId = await writeTeamMentionAsEditor(browser, data, workspaceId, leadName, noteText);

  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, data.viewerEmail, dashboardPath);
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();

  const mentions = page.locator('section[aria-label="Meine Erwähnungen"]');
  await expect(mentions).toBeVisible();
  await expect(mentions.getByText(leadName, { exact: false })).toBeVisible();
  await expect(mentions.getByText(marker, { exact: false })).toBeVisible();
  const noteLink = mentions.locator(`a[href*="${projectId}"]`);
  await expect(noteLink.first()).toBeVisible();
  const href = await noteLink.first().getAttribute("href");
  expect(href).toContain(`/anfragen/${projectId}`);
  expect(href).toContain("#");
  await noteLink.first().click();
  await expect(page).toHaveURL(new RegExp(`/anfragen/${projectId}`, "u"));
  const notesAfterJump = page.locator("section#project-notes");
  await expect(notesAfterJump.getByText(marker, { exact: false })).toBeVisible();
  // Team-Chip analog F1-09 (`note-mention-<email>`): GREEN liefert
  // `note-team-mention-<slug>`.
  await expect(notesAfterJump.getByTestId(`note-team-mention-${teamSlug}`)).toBeVisible();

  expect(viewerErrors, "Browser-Konsole beim Team-Erwähnungen-Widget").toEqual([]);
});
