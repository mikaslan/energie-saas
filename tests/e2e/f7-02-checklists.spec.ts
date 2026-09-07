import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES,
  CHECKLIST_NODES_MAX,
  CHECKLIST_POSITION_MAX,
  type EditableChecklistBlocksV2,
} from "../../lib/integrations/checklists/contract";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7.2 Projekt-Checkliste — Chromium-E2E.
 *
 * - Editor baut Block/Segment/Punkte, toggelt, speichert (CAS v1),
 *   Reload persistiert, Fortschritt korrekt.
 * - Viewer read-only, External fail-closed.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  w3WorkspaceId: string;
  f704ProjectId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
  mainProjectId: string;
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
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "w3WorkspaceId",
    "f704ProjectId",
    "adminEmail",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
    "mainProjectId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7.2-E2E-State ist unvollständig.");
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
    if (match) return match[1];
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  // CI-Singletons (leerer <title> bei sonst stabiler Seite): Titel als
  // explizite Vorbedingung mit Retry — kommt er verspätet, wartet der Pin;
  // kommt er nie, fällt der Pin mit klarer Meldung statt Axe.
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

const path = (): string => `/w/${state().workspaceId}/anfragen/${state().mainProjectId}/checkliste`;
const f704Path = (): string =>
  `/w/${state().w3WorkspaceId}/anfragen/${state().f704ProjectId}/checkliste`;

async function activateF704Installation(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query("begin");
    await pool.query(
      "select set_config('app.workspace_id', $1, true)",
      [data.w3WorkspaceId],
    );
    await pool.query(
      `update project
          set phase = 'installation', updated_at = statement_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [data.w3WorkspaceId, data.f704ProjectId],
    );
    await pool.query(
      `insert into installation (workspace_id, project_id, source, status)
       values ($1::uuid, $2::uuid, 'direct', 'active')`,
      [data.w3WorkspaceId, data.f704ProjectId],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function seedTransportProject(blocks: EditableChecklistBlocksV2): Promise<string> {
  const data = state();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query("begin");
    await pool.query("select set_config('app.workspace_id', $1, true)", [data.w3WorkspaceId]);
    await pool.query(
      `insert into contact (
         id, workspace_id, display_name, first_name, last_name,
         email_primary, email_normalized
       ) values ($1::uuid, $2::uuid, 'F7 Transport', 'F7', 'Transport', $3, $3)`,
      [contactId, data.w3WorkspaceId, `${contactId}@f704-e2e.test`],
    );
    await pool.query(
      `insert into site (id, workspace_id, contact_id, label)
       values ($1::uuid, $2::uuid, $3::uuid, 'F7 Transport Site')`,
      [siteId, data.w3WorkspaceId, contactId],
    );
    const inserted = await pool.query(
      `insert into project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, source_key
       )
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id,
              intake_column.id, 'F7 Transport', $5
         from kanban_board board
         join kanban_column intake_column
           on intake_column.workspace_id = board.workspace_id
          and intake_column.board_id = board.id
          and intake_column.is_intake = true
          and intake_column.archived_at is null
        where board.workspace_id = $2::uuid
          and board.scope = 'residential'
          and board.is_default = true
          and board.archived_at is null`,
      [projectId, data.w3WorkspaceId, contactId, siteId, `f704-transport-${projectId}`],
    );
    expect(inserted.rowCount).toBe(1);
    const actorConfigured = await pool.query(
      `select pg_catalog.set_config('app.actor_id', identity.id::text, true)
         from user_identity identity
        where identity.email = $1
        limit 1`,
      [data.adminEmail],
    );
    expect(actorConfigured.rowCount).toBe(1);
    const checklist = await pool.query(
      `select public.save_project_checklist_v2(
         $1::uuid, $2::uuid, null::uuid, 'site_documentation'::text,
         'Baustellendokumentation'::text, 0, $3::jsonb
       ) as result`,
      [data.w3WorkspaceId, projectId, JSON.stringify(blocks)],
    );
    expect(checklist.rowCount).toBe(1);
    await pool.query("commit");
    return projectId;
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function transportBoundaryTree(): EditableChecklistBlocksV2 {
  return [{
    id: randomUUID(),
    name: "漢".repeat(200),
    position: CHECKLIST_POSITION_MAX,
    visible: false,
    segments: [{
      id: randomUUID(),
      name: "漢".repeat(200),
      position: CHECKLIST_POSITION_MAX,
      visible: false,
      items: Array.from({ length: CHECKLIST_NODES_MAX - 2 }, () => ({
        id: randomUUID(),
        title: "漢".repeat(500),
        done: false,
        required: false,
        visible: false,
      })),
    }],
  }];
}

test("F7.2-E2E-01: Editor baut Checkliste, toggelt, speichert, lädt persistiert", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByText("Noch keine sichtbaren Blöcke angelegt.")).toBeVisible();

  // Block + Segment + zwei Punkte anlegen.
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Basis");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill("Dach geprüft");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.2").fill("Zählerschrank dokumentiert");

  // Item-Fortschritt und Segmentfortschritt sind getrennt.
  await page.getByLabel("Dach geprüft").check();
  await expect(page.getByText("Punkte: 1/2")).toBeVisible();
  await expect(page.getByText("Segmentfortschritt: 0/1 (0 %)")).toBeVisible();

  // Speichern (CAS v1).
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // Kimi-P1-2: zweiter Save OHNE Reload — CAS-Version muss im Client
  // mitlaufen, sonst Konflikt.
  await page.getByLabel("Zählerschrank dokumentiert").check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();
  await expect(page.getByText("Punkte: 2/2")).toBeVisible();
  await expect(page.getByText("Segmentfortschritt: 0/1 (0 %)")).toBeVisible();

  // Reload: persistiert, Fortschritt bleibt.
  await page.reload();
  await expect(page.getByText("Punkte: 2/2")).toBeVisible();
  await expect(page.getByText("Segmentfortschritt: 0/1 (0 %)")).toBeVisible();
  await expect(page.getByLabel("Dach geprüft")).toBeChecked();
  await expect(page.getByLabel("Zählerschrank dokumentiert")).toBeChecked();

  await expectNoWcagAaAxeViolations(page, "F7.2-Checklistenseite");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F7.2-E2E-02: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Block hinzufügen" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.externalEmail, url);
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});

test("F7.4-E2E-01: Complete, Reload, Admin-Unlock und Datenerhalt", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = f704Path();
  await activateF704Installation();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("Montage");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Dachmontage");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill("Unterkonstruktion dokumentiert");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.2").fill("Optionales Abschlussfoto");
  const documentedItem = page.getByRole("checkbox", {
    name: "Unterkonstruktion dokumentiert",
    exact: true,
  });
  const optionalPhotoItem = page.getByRole("checkbox", {
    name: "Optionales Abschlussfoto",
    exact: true,
  });
  await documentedItem.check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // Ein offener optionaler Punkt blockiert den Segmentabschluss nicht.
  await expect(page.getByText("Punkte: 1/2")).toBeVisible();
  const completeButton = page.getByRole("button", { name: /Dachmontage: Segment abschließen/u });
  await completeButton.click();
  await expect(page.getByText("Segment abgeschlossen (Version 2).", { exact: true })).toBeVisible();
  await expect(page.getByText("Segmentfortschritt: 1/1 (100 %)")).toBeVisible();
  await expect(page.getByText(/^Abgeschlossen:/u)).toBeVisible();
  await expect(documentedItem).toBeDisabled();
  await expect(optionalPhotoItem).toBeDisabled();

  await page.reload();
  await expect(page.getByText("Segmentfortschritt: 1/1 (100 %)")).toBeVisible();
  await expect(documentedItem).toBeChecked();
  await expect(optionalPhotoItem).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Dachmontage: Segment entsperren/u })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.adminEmail, url);
  const unlockButton = page.getByRole("button", { name: /Dachmontage: Segment entsperren/u });
  await expect(unlockButton).toBeVisible();
  await unlockButton.click();
  await expect(page.getByText("Segment entsperrt (Version 3).", { exact: true })).toBeVisible();
  await expect(page.getByText("Segmentfortschritt: 0/1 (0 %)")).toBeVisible();
  await expect(documentedItem).toBeChecked();
  await expect(optionalPhotoItem).not.toBeChecked();

  // Admin markiert den zweiten Punkt als Pflichtpunkt. Unsaved- und
  // Required-Gate muessen getrennt sichtbar bleiben; danach darf derselbe
  // Segment-Client erneut abschliessen und muss das neue Feedback zeigen.
  const requiredToggles = page.getByLabel(/: Pflichtpunkt$/u);
  await expect(requiredToggles).toHaveCount(2);
  await page.getByLabel("Optionales Abschlussfoto: Pflichtpunkt").check();
  await expect(completeButton).toBeDisabled();
  await expect(page.getByText("Änderungen zuerst speichern, dann das Segment abschließen.")).toBeVisible();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 4).", { exact: true })).toBeVisible();
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toBeVisible();
  await expect(completeButton).toBeDisabled();

  await optionalPhotoItem.check();
  await expect(completeButton).toBeDisabled();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 5).", { exact: true })).toBeVisible();
  await completeButton.click();
  await expect(page.getByText("Segment abgeschlossen (Version 6).", { exact: true })).toBeVisible();
  await expect(page.getByText("Segment entsperrt (Version 3).", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Segmentfortschritt: 1/1 (100 %)")).toBeVisible();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ), `${width}px ohne horizontalen Overflow`).toBe(true);
    await expectNoWcagAaAxeViolations(page, `F7.4 Checkliste ${width}px`);
    await page.screenshot({
      path: testInfo.outputPath(`f704-checklist-${width}.png`),
      fullPage: true,
    });
  }
  expect(errors, "Browser-Konsole und Page-Errors von Complete/Unlock").toEqual([]);
});

test("F7.4-E2E-02: gültiger UTF-8-Maximalbaum passiert den echten Action-Transport", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const boundaryTree = transportBoundaryTree();
  const payload = JSON.stringify(boundaryTree);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  expect(payloadBytes).toBeGreaterThan(750_000);
  expect(payloadBytes).toBeLessThanOrEqual(CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES);
  const projectId = await seedTransportProject(boundaryTree);
  const url = `/w/${data.w3WorkspaceId}/anfragen/${projectId}/checkliste`;
  const errors = trackBrowserErrors(page);

  await page.goto(url);
  await loginWithRealOtp(page, data.adminEmail, url);
  expect(await page.locator('input[name="blocks"]').inputValue()).toBe(payload);

  const actionResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === new URL(url, data.baseURL).pathname,
  );
  await page.getByRole("button", { name: "Speichern" }).click();
  const actionResponse = await actionResponsePromise;
  expect(actionResponse.status()).toBe(200);
  const contentLength = Number(await actionResponse.request().headerValue("content-length"));
  expect(contentLength).toBeGreaterThan(payloadBytes);
  expect(contentLength).toBeLessThan(1_048_576);
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true }))
    .toBeVisible({ timeout: 60_000 });
  expect(errors, "Near-limit Action ohne 413/Console-Fehler").toEqual([]);
});
