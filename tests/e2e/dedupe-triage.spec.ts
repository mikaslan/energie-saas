import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F1-22 Duplikat-Triage — Chromium-E2E (isolierter Workspace, SQL-Seed).
 *
 * - Editor: Queue listet Kontakt- und Projekt-Flag → Detail mit
 *   Gegenüberstellung → „Als geprüft markieren" → Queue schrumpft und
 *   der Board-Blocker („Kontakt prüfen") löst sich.
 * - Viewer: Detail lesbar („Du kannst die Dubletten sehen, aber nicht
 *   verändern."), keine Markieren-/Verknüpfen-Formulare.
 * - Extern: Queue und Detail antworten mit „Kein Zugriff".
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
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
    "databaseUrl",
    "serverLogPath",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F1-22-E2E-State ist unvollständig.");
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

type DedupeSeed = {
  workspaceId: string;
  contactId: string;
  projectId: string;
};

async function resolveIdentityId(pool: { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ id?: string }> }> }, email: string): Promise<string> {
  const result = await pool.query("select id from user_identity where lower(email) = lower($1)", [email]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`E2E-Identität fehlt (${email}).`);
  return id;
}

async function seedDedupeWorkspace(): Promise<DedupeSeed> {
  const pool = createDrainTrackedPool({ connectionString: state().databaseUrl, max: 1 });
  try {
    const editorId = await resolveIdentityId(pool, state().editorEmail);
    const viewerId = await resolveIdentityId(pool, state().viewerEmail);
    const externalId = await resolveIdentityId(pool, state().externalEmail);
    const workspaceId = randomUUID();
    const contactId = randomUUID();
    const twinId = randomUUID();
    const siteId = randomUUID();
    const projectId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      await client.query("insert into public.workspace (id, name) values ($1::uuid, 'F1-22 E2E-Dubletten')", [
        workspaceId,
      ]);
      await client.query(
        `insert into public.membership (workspace_id, user_id, role, capabilities) values
           ($1::uuid, $2::uuid, 'editor', '{}'::jsonb),
           ($1::uuid, $3::uuid, 'viewer', '{}'::jsonb),
           ($1::uuid, $4::uuid, 'editor', '{"external_only":true}'::jsonb)`,
        [workspaceId, editorId, viewerId, externalId],
      );
      await client.query(
        `insert into public.contact (
           id, workspace_id, display_name, first_name, last_name,
           email_primary, email_normalized, dedupe_review_required
         ) values
           ($1::uuid, $2::uuid, 'Greta Gemeldet', 'Greta', 'Gemeldet',
            'greta@f122-e2e.test', 'greta@f122-e2e.test', true),
           ($3::uuid, $2::uuid, 'Greta Zwilling', 'Greta', 'Zwilling',
            'greta@f122-e2e.test', 'greta@f122-e2e.test', false)`,
        [contactId, workspaceId, twinId],
      );
      await client.query(
        "insert into public.site (id, workspace_id, contact_id, label) values ($1::uuid, $2::uuid, $3::uuid, 'F122 E2E-Standort')",
        [siteId, workspaceId, contactId],
      );
      await client.query(
        `insert into public.project (
           id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
           name, source_key, dedupe_review_required
         )
         select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id, intake.id,
                'F122 E2E-Prüfprojekt', 'manual', true
           from public.kanban_board board
           join public.kanban_column intake
             on intake.workspace_id = board.workspace_id
            and intake.board_id = board.id
            and intake.is_intake = true
            and intake.archived_at is null
          where board.workspace_id = $2::uuid
            and board.scope = 'residential'
            and board.is_default = true
            and board.archived_at is null`,
        [projectId, workspaceId, contactId, siteId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { workspaceId, contactId, projectId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F122-E2E-01: Editor triagiert — Queue schrumpft, Board-Blocker löst sich", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const seed = await seedDedupeWorkspace();

  const queuePath = `/w/${seed.workspaceId}/dubletten`;
  await page.goto(queuePath);
  await loginWithRealOtp(page, data.editorEmail, queuePath);
  await expect(page.getByRole("heading", { name: "Dubletten", level: 1 })).toBeVisible();

  const queue = page.getByTestId("dubletten-queue");
  await expect(queue).toContainText("Greta Gemeldet");
  await expect(queue).toContainText("F122 E2E-Prüfprojekt");

  // Projekt-Detail: Gegenüberstellung + Markieren (zeilenweise, reihenfolgenfest).
  await queue.getByRole("listitem").filter({ hasText: "F122 E2E-Prüfprojekt" }).getByRole("link", { name: "Prüfen" }).click();
  await expect(page).toHaveURL(new RegExp(`/dubletten/projekt/${seed.projectId}$`, "u"));
  await expect(page.getByTestId("dedupe-detail")).toContainText("F122 E2E-Prüfprojekt");
  await expect(page.getByTestId("dedupe-candidates")).toContainText("Greta Zwilling");
  await page.getByTestId("dedupe-mark-form").getByRole("button", { name: "Als geprüft markieren" }).click();
  await expect(page.getByTestId("dedupe-mark-success")).toContainText("aufgelöst");

  // Kontakt-Detail: Markieren leert die Queue vollständig.
  await page.goto(`${queuePath}/kontakt/${seed.contactId}`);
  await expect(page.getByTestId("dedupe-detail")).toContainText("Greta Gemeldet");
  await page.getByTestId("dedupe-mark-form").getByRole("button", { name: "Als geprüft markieren" }).click();
  await expect(page.getByTestId("dedupe-mark-success")).toContainText("aufgelöst");

  await page.goto(queuePath);
  await expect(page.getByTestId("dubletten-empty")).toContainText("Keine Dubletten");

  // Der Board-Blocker ist mit dem Flag verschwunden.
  await page.goto(`/w/${seed.workspaceId}/anfragen`);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(page.getByText("Kontakt prüfen")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Triage-Grenze").toEqual([]);
});

test("F122-E2E-02: Viewer liest, Extern erhält Kein Zugriff", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const seed = await seedDedupeWorkspace();

  const detailPath = `/w/${seed.workspaceId}/dubletten/projekt/${seed.projectId}`;
  await page.goto(detailPath);
  await loginWithRealOtp(page, data.viewerEmail, detailPath);
  await expect(page.getByTestId("dedupe-detail")).toContainText("F122 E2E-Prüfprojekt");
  await expect(page.getByTestId("dedupe-readonly")).toContainText("sehen, aber nicht verändern");
  await expect(page.getByTestId("dedupe-mark-form")).toHaveCount(0);
  await expect(page.locator("[data-testid^='dedupe-link-form-']")).toHaveCount(0);

  // Frische Session für Extern: neuer Kontext ohne Cookies.
  await page.context().clearCookies();
  await page.goto(`/w/${seed.workspaceId}/dubletten`);
  await loginWithRealOtp(page, data.externalEmail, `/w/${seed.workspaceId}/dubletten`);
  await expect(page.getByTestId("dubletten-denied")).toContainText("internen Mitgliedern");

  expect(errors, "Browser-Konsole und Page-Errors der RBAC-Grenze").toEqual([]);
});
