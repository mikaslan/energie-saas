import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { PgBoss } from "pg-boss";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  createCustomerNotificationDatabaseGateway,
  createCustomerNotificationHandler,
} from "../../worker/customer-notification";
import { NoopCustomerNotificationTransport } from "../../lib/integrations/notifications/resend-transport";
import {
  CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
  CUSTOMER_NOTIFICATION_QUEUE,
  PORTAL_LINK_TEMPLATE_ID,
} from "../../lib/integrations/notifications/contract";
import {
  parsePostgresConnectionUrl,
  postgresTestTargetConfirmation,
} from "../../lib/db/postgres-url";

/**
 * F10.08 Portal-Link-Automatik — Chromium-E2E (isolierter Workspace).
 *
 * Editor erstellt den Portal-Link (Kontakt MIT E-Mail) → UI meldet „queued" →
 * Outbox-Zeile queued (ID-only-Payload, Empfänger = Projekt-Contact) → der
 * ECHTE Worker-Handler (Gateway + Noop-Transport, wie worker/index.ts ihn
 * verdrahtet) stellt zu → delivered. Kontakt OHNE E-Mail → „kein Versand",
 * keine Outbox-Zeile (fail-closed). Viewer sieht die Sektion ohne
 * Schreibaktion.
 *
 * Der E2E-Worker läuft katalogisoliert (WORKER_E2E_CATALOG_IMPORT_ONLY) und
 * erstellt die notification.customer-Queue nicht; das beforeAll stellt den
 * Queuevertrag exakt wie worker/index.ts her (Guard scheitert sonst
 * fail-closed — dieselbe Produktionssemantik).
 */

type Seed = {
  workspaceId: string;
  withEmailProjectId: string;
  withEmailContactEmail: string;
  withoutEmailProjectId: string;
};

const WITH_EMAIL = "f1008-portal@example.test";

function fullState(): Record<string, string> {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
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
  const logOffset = statSync(fixtureState().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(
    await otpFromPrivateDevMailLog(fixtureState().serverLogPath, email, logOffset),
  );
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

function portalSection(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
}

async function seedPortalProject(
  workspaceId: string,
  actorId: string,
  contactName: string,
  email: string | null,
): Promise<{ contactId: string; projectId: string }> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId]);
      await client.query(
        `insert into contact (id, workspace_id, display_name, first_name, last_name,
                              email_primary, email_normalized, phone_raw)
         values ($1::uuid, $2::uuid, $3, 'Portal', 'Kontakt', $4, $5, $6)`,
        [
          contactId,
          workspaceId,
          contactName,
          email,
          email === null ? null : email.toLowerCase(),
          email === null ? "+49 151 0000001" : null,
        ],
      );
      await client.query(
        `insert into site (id, workspace_id, contact_id, label, formatted_address,
                           address_fingerprint, address_fingerprint_version, address_mode,
                           street, house_number, postal_code, city, country, lat, lng,
                           geocode_source, geocode_precision, address_follow_up_required,
                           address_revision, pin_confirmed, pin_confirmed_address_revision)
         values ($1::uuid, $2::uuid, $3::uuid, 'F10-08 Portal-Standort',
                 'Testweg 7, 69168 Dielheim', decode(repeat('ca', 32), 'hex'), 1,
                 'selected', 'Testweg', '7', '69168', 'Dielheim', 'DE',
                 52.52, 13.405, 'photon', 'house', false, 1, true, 1)`,
        [siteId, workspaceId, contactId],
      );
      const inserted = await client.query(
        `insert into project (id, workspace_id, contact_id, site_id, kanban_board_id,
                              kanban_column_id, name, source_key)
         select $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                board.id, intake.id, 'F10-08 Portalprojekt', 'wmee-rechner-v3'
           from kanban_board board
           join kanban_column intake
             on intake.workspace_id = board.workspace_id
            and intake.board_id = board.id
            and intake.is_intake = true
          where board.workspace_id = $2::uuid
            and board.scope = 'residential'
            and board.is_default = true
            and board.archived_at is null
            and intake.archived_at is null
         returning id`,
        [projectId, workspaceId, contactId, siteId],
      );
      if (inserted.rowCount !== 1) throw new Error("F10-08-Seed: Projektinsert ohne Intake-Spalte.");
    } finally {
      client.release();
    }
  });
  return { contactId, projectId };
}

let seed: Seed;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const data = fixtureState();
  // Sanktionierter Testmodus für servicePoolConfig (TEST_MODE aus
  // lib/db/role-env.ts, Bestätigung exakt wie dort berechnet).
  process.env.DB_ROLE_MODE = "test-legacy-single";
  const parsed = parsePostgresConnectionUrl("Postgres-Dienst-URL", data.databaseUrl);
  process.env.POSTGRES_TEST_TARGET_CONFIRM = postgresTestTargetConfirmation(parsed);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const withEmail = await seedPortalProject(workspaceId, actorId, "F1008 Mit E-Mail", WITH_EMAIL);
  const withoutEmail = await seedPortalProject(workspaceId, actorId, "F1008 Ohne E-Mail", null);
  seed = {
    workspaceId,
    withEmailProjectId: withEmail.projectId,
    withEmailContactEmail: WITH_EMAIL,
    withoutEmailProjectId: withoutEmail.projectId,
  };
  const boss = new PgBoss({ connectionString: data.databaseUrl, schema: "pgboss" });
  await boss.start();
  try {
    await boss.createQueue(CUSTOMER_NOTIFICATION_QUEUE, {
      policy: "exclusive",
      retryLimit: 10,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 180,
    });
  } finally {
    await boss.stop();
  }
});

test("F10-08-E2E-01: Portal-Link wird queued und vom Worker zugestellt", async ({ page }) => {
  test.setTimeout(150_000);
  const data = fixtureState();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${seed.workspaceId}/anfragen/${seed.withEmailProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const portal = portalSection(page);
  await expect(portal.getByText("Kein aktiver Link.", { exact: false })).toBeVisible();
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  await expect(portal.getByText(
    "Der Portal-Link wurde erstellt und die E-Mail an den Kunden queued. Kopiere ihn jetzt — er wird nicht erneut angezeigt.",
    { exact: true },
  )).toBeVisible();
  const tokenText = await portal.locator("p.font-mono").textContent();
  expect(tokenText?.trim() ?? "").toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  const outbox = await poolOne(async (pool) => {
    const result = await pool.query(
      `select n.id, n.status, n.template_id, n.idempotency_key, n.invite_id
         from customer_notification n
        where n.workspace_id = $1::uuid and n.project_id = $2::uuid`,
      [seed.workspaceId, seed.withEmailProjectId],
    );
    return result.rows as Array<{
      id: string;
      status: string;
      template_id: string;
      idempotency_key: string;
      invite_id: string;
    }>;
  });
  expect(outbox).toHaveLength(1);
  expect(outbox[0].status).toBe("queued");
  expect(outbox[0].template_id).toBe(PORTAL_LINK_TEMPLATE_ID);
  expect(outbox[0].idempotency_key).toBe(`portal-link:${outbox[0].invite_id}`);

  // ID-only-Beleg: der echte Dispatch-Payload trägt keinen Empfänger.
  const jobData = await poolOne(async (pool) => {
    const result = await pool.query(
      `select data from pgboss.job
        where name = $1 and data->>'workspaceId' = $2
        order by created_on desc limit 1`,
      [CUSTOMER_NOTIFICATION_QUEUE, seed.workspaceId],
    );
    return result.rows[0]?.data as unknown;
  });
  expect(jobData).toMatchObject({
    schemaVersion: CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
    workspaceId: seed.workspaceId,
    notificationId: outbox[0].id,
    attemptNumber: 1,
  });
  expect(JSON.stringify(jobData)).not.toContain(seed.withEmailContactEmail);

  // Empfänger löst der Worker-Definer live aus dem Contact-Graphen auf.
  const recipient = await poolOne(async (pool) => {
    const result = await pool.query(
      "select public._m111b_worker_resolve_recipient($1::uuid, $2::uuid) as email",
      [seed.workspaceId, outbox[0].id],
    );
    return (result.rows[0] as { email: string | null }).email;
  });
  expect(recipient).toBe(seed.withEmailContactEmail);

  // Echter Worker-Handler + echte Gateway-Kapseln + Produktions-Noop-Transport.
  const gateway = createCustomerNotificationDatabaseGateway(data.databaseUrl, () => undefined, 1);
  try {
    const handler = createCustomerNotificationHandler({
      database: gateway.database,
      transport: new NoopCustomerNotificationTransport(),
    });
    await handler([{ data: jobData }]);
  } finally {
    await gateway.close();
  }
  const delivered = await poolOne(async (pool) => {
    const result = await pool.query(
      "select status, delivered_at from customer_notification where id = $1::uuid",
      [outbox[0].id],
    );
    return result.rows[0] as { status: string; delivered_at: string | null };
  });
  expect(delivered.status).toBe("delivered");
  expect(delivered.delivered_at).not.toBeNull();

  await page.reload();
  await expect(portal.getByText("Aktiver Link", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("F10-08-E2E-02: Ohne Kunden-E-Mail kein Versand (fail-closed)", async ({ page }) => {
  test.setTimeout(150_000);
  const data = fixtureState();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${seed.workspaceId}/anfragen/${seed.withoutEmailProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const portal = portalSection(page);
  await expect(portal.getByText("Kein aktiver Link.", { exact: false })).toBeVisible();
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  await expect(portal.getByText(
    "Der Portal-Link wurde erstellt (keine E-Mail-Adresse beim Kunden hinterlegt — kein Versand). Kopiere ihn jetzt — er wird nicht erneut angezeigt.",
    { exact: true },
  )).toBeVisible();

  const rows = await poolOne(async (pool) => {
    const result = await pool.query(
      `select n.id from customer_notification n
        where n.workspace_id = $1::uuid and n.project_id = $2::uuid`,
      [seed.workspaceId, seed.withoutEmailProjectId],
    );
    return result.rows;
  });
  expect(rows).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("F10-08-E2E-03: Viewer sieht die Sektion ohne Schreibaktion", async ({ page }) => {
  test.setTimeout(120_000);
  const raw = fullState();
  for (const key of ["m112aWorkspaceId", "m112aProjectId", "m112aViewerEmail"] as const) {
    if (typeof raw[key] !== "string" || raw[key] === "") {
      throw new Error(`Der private F10-08-E2E-State ist unvollständig (${key}).`);
    }
  }
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${raw.m112aWorkspaceId}/anfragen/${raw.m112aProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, raw.m112aViewerEmail, projectPath);

  const portal = portalSection(page);
  await expect(portal.getByRole("heading", { name: "Kundenportal", exact: true })).toBeVisible();
  await expect(portal.getByRole("button", { name: "Link erstellen", exact: true })).toHaveCount(0);
  await expect(portal.getByRole("button", { name: "Link zurückziehen", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
