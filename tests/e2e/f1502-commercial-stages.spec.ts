import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F15-02 Gewerbe-Stufen — Chromium-E2E (isolierter Workspace).
 * Das Gewerbe-Board zeigt die eigenen Stufen (0290-Kontraktwechsel weg von
 * der F15-01-Wohnbau-Kopie); Cross-Scope-Moves scheitern serverseitig als
 * Konflikt, die Karte bleibt auf ihrer Lane.
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
      throw new Error(`Der private F15-02-E2E-State ist unvollständig (${key}).`);
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

type SeededCommercialCard = {
  projectId: string;
  contactName: string;
  intakeColumnId: string;
  foreignColumnId: string;
};

async function seedCommercialCard(workspaceId: string): Promise<SeededCommercialCard> {
  const contactName = "F1502 Scope GmbH";
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  return poolOne(async (pool) => {
    const lane = await pool.query<{ board_id: string; column_id: string }>(`
      select board.id as board_id, intake_column.id as column_id
        from kanban_board board
        join kanban_column intake_column
          on intake_column.workspace_id = board.workspace_id
         and intake_column.board_id = board.id
         and intake_column.is_intake = true
         and intake_column.archived_at is null
       where board.workspace_id = $1::uuid
         and board.scope = 'commercial'
         and board.is_default = true
         and board.archived_at is null
    `, [workspaceId]);
    const commercial = lane.rows[0];
    if (!commercial) throw new Error("F15-02-E2E: Gewerbe-Intake fehlt.");
    // Fremdziel: Wohnbau-Lead-Spalte — der Move scheitert am Board (Scope),
    // nicht am Spaltentyp.
    const foreign = await pool.query<{ column_id: string }>(`
      select lane.id as column_id
        from kanban_board board
        join kanban_column lane
          on lane.workspace_id = board.workspace_id
         and lane.board_id = board.id
       where board.workspace_id = $1::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
         and lane.position = 2
         and lane.archived_at is null
    `, [workspaceId]);
    const foreignColumnId = foreign.rows[0]?.column_id;
    if (!foreignColumnId) throw new Error("F15-02-E2E: Wohnbau-Zielspalte fehlt.");
    await pool.query(`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values ($1::uuid, $2::uuid, $3, 'F1502', 'Scope', $4, $4)
    `, [contactId, workspaceId, contactName, `scope-${contactId}@f1502.test`]);
    await pool.query(`
      insert into site (id, workspace_id, contact_id, label)
      values ($1::uuid, $2::uuid, $3::uuid, 'F1502 Scope-Standort')
    `, [siteId, workspaceId, contactId]);
    await pool.query(`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        'F1502 Cross-Scope', 'manual'
      )
    `, [projectId, workspaceId, contactId, siteId, commercial.board_id, commercial.column_id]);
    return {
      projectId,
      contactName,
      intakeColumnId: commercial.column_id,
      foreignColumnId,
    };
  });
}

test("F1502-E2E-01: Gewerbe-Board zeigt die eigenen Stufen, Wohnbau bleibt", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  const column = (name: string) => page.getByRole("heading", { name, level: 2 });

  // Wohnbau-Kontrolle: unveränderte Referenzstufen.
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await expect(column("Eingang")).toBeVisible();
  await expect(column("In Prüfung")).toBeVisible();
  await expect(column("Qualifiziert")).toBeVisible();
  await expect(column("Angebote")).toBeVisible();

  // Gewerbe: eigene Stufen, keine Wohnbau-Qualifizierung mehr.
  await page.getByTestId("board-scope-toggle").getByRole("link", { name: "Gewerbe" }).click();
  await expect(page).toHaveURL(/bereich=gewerbe/);
  await expect(page.getByRole("heading", { name: "Anfragen Gewerbe", level: 1 })).toBeVisible();
  await expect(column("Eingang")).toBeVisible();
  await expect(column("Bedarfsanalyse")).toBeVisible();
  await expect(column("Planung")).toBeVisible();
  await expect(column("Angebote")).toBeVisible();
  await expect(column("In Prüfung")).toHaveCount(0);
  await expect(column("Qualifiziert")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Stufen-Grenze").toEqual([]);
});

test("F1502-E2E-02: Cross-Scope-Move wird verweigert, Karte bleibt auf der Lane", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const card = await seedCommercialCard(workspaceId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await page.getByTestId("board-scope-toggle").getByRole("link", { name: "Gewerbe" }).click();
  await expect(page).toHaveURL(/bereich=gewerbe/);
  await expect(page.getByRole("heading", { name: card.contactName, level: 3 })).toBeVisible();

  // UI-Pfad: Das Ziel-Select kennt nur Gewerbe-Stufen (kein Scope-Wechsel).
  const targetSelect = page.getByLabel(`Zielspalte für „${card.contactName}“`);
  await expect(targetSelect.locator("option")).toHaveText([
    "Ziel wählen",
    "Bedarfsanalyse",
    "Planung",
    "Angebote",
  ]);

  // Scope-Tamper: fremde Wohnbau-Spalte ins Formular schmuggeln.
  await page.evaluate(
    ({ projectId, foreignColumnId }: { projectId: string; foreignColumnId: string }) => {
      const select = document.getElementById(`target-${projectId}`);
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("F15-02-E2E: Zielspalten-Select fehlt.");
      }
      const tampered = document.createElement("option");
      tampered.value = foreignColumnId;
      tampered.textContent = "Wohnbau-Fremdspalte (Scope-Tamper)";
      select.appendChild(tampered);
      select.value = foreignColumnId;
    },
    { projectId: card.projectId, foreignColumnId: card.foreignColumnId },
  );
  await page.getByRole("button", { name: `„${card.contactName}“ verschieben` }).click();
  await expect(page.getByRole("status")).toContainText(
    "Die Anfrage wurde zwischenzeitlich geändert. Das Board wurde aktualisiert.",
  );

  // Karte bleibt auf der Gewerbe-Intake-Lane (DB-Read-back).
  const persisted = await poolOne(async (pool) => pool.query<{ column_id: string }>(
    "select kanban_column_id as column_id from project where id = $1::uuid",
    [card.projectId],
  ));
  expect(persisted.rows[0]?.column_id).toBe(card.intakeColumnId);

  expect(errors, "Browser-Konsole und Page-Errors des Scope-Guards").toEqual([]);
});
