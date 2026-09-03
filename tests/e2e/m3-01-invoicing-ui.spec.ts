import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * M3-01 Rechnungs-Kern — UI-/E2E-Schicht (Chromium).
 *
 * Vertikaler Slice über den Bereich `/w/[workspaceId]/rechnungen`:
 *
 * - Editor: Gruppe anlegen → Rechnung als Entwurf → Ausstellen → Versenden
 *   → Stornieren (Journey durch echte Server-Actions).
 * - Liste/Filter je Typ: Statusfilter, Suche, Archiv-Achse.
 * - Berichte: KPI-Karten nach gestellten Rechnungen, CSV-Download.
 * - Viewer read-only, External fail-closed; Axe A/AA.
 *
 * Seed-Daten (Rechnungen in definierten Monaten) kommen per SQL direkt in
 * die Datenbank — der Produktweg (UI-Mutationen) wird in der Journey
 * abgedeckt.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
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
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M3-01-E2E-State ist unvollständig.");
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
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

// ── Seed-Helfer (SQL direkt, RLS-konform über app.actor_id) ─────────────

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// Deterministische Sequenz aus dem Dokumentnamen (900001–999000): robust
// gegen Modul-Reloads zwischen Tests, kollisionsfrei je Name, außerhalb des
// UI-vergebenen Bereichs (1..n).
function seedSequenceFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 900000 + (Math.abs(hash) % 99000) + 1;
}

async function seedIssuedInvoice(
  opts: {
    name: string;
    grossCents: number;
    voided?: boolean;
    issuedMonthsAgo?: number;
  },
  target?: { workspaceId: string; editorEmail: string },
): Promise<void> {
  const data = state();
  const workspaceId = target?.workspaceId ?? data.workspaceId;
  const editorEmail = target?.editorEmail ?? data.editorEmail;
  const seedSequence = seedSequenceFor(opts.name);
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [editorEmail],
    );
    // Kimi-P2-1: deterministisch in der Berlin-Monatsmitte seeden — „now()-1h"
    // wäre in der ersten Stunde des Folgemonats dem Vormonat zuzuordnen.
    const issuedAt = opts.issuedMonthsAgo !== undefined
      ? `(date_trunc('month', now() at time zone 'Europe/Berlin') - interval '${opts.issuedMonthsAgo} month' + interval '1 day 12 hours') at time zone 'Europe/Berlin'`
      : "(date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin'";
    const netCents = Math.round((opts.grossCents / 119) * 100);
    await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date,
         voided_at, void_reason
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', $2, $3,
         (select id from user_identity where email = $4 limit 1),
         ${issuedAt},
         '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
         decode($5, 'hex'),
         (select id from user_identity where email = $4 limit 1),
         '2036-12-31'::date,
         'Rechnung-E2E-' || $6,
         extract(year from now() at time zone 'Europe/Berlin')::int, $7::int, $8, $9, $10, 'unpaid', 0, (now()::date + 14),
         case when $2 = 'voided' then now() else null end,
         case when $2 = 'voided' then 'cancelled' else null end
       )`,
      [
        workspaceId,
        opts.voided ? "voided" : "issued",
        opts.name,
        editorEmail,
        ZERO_HASH,
        seedSequence,
        seedSequence,
        netCents,
        opts.grossCents - netCents,
        opts.grossCents,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const pgError = error as { detail?: unknown; message?: unknown };
    throw new Error(
      `seedIssuedInvoice fehlgeschlagen (name=${opts.name}, sequence=${seedSequence}): `
      + `${String(pgError.message)} DETAIL: ${String(pgError.detail ?? "-")}`,
    );
  } finally {
    await client.release();
    await pool.end();
  }
}

async function seedInvoicingSettings(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         id, workspace_id, company_name, company_email, company_country,
         company_address_line1, company_postal_code, company_city,
         accounting_method, revision, created_by,
         payment_account_holder, payment_iban, payment_bic
       ) select gen_random_uuid(), $1::uuid, 'Solarwerk E2E GmbH',
         'rechnung@e2e.invalid', 'DE', 'Teststraße 1', '10115', 'Berlin',
         'accrual', 1, (select id from user_identity where email = $2 limit 1),
         'Solarwerk E2E GmbH', 'DE89370400440532013000', 'MARKDEF1100'
       where not exists (
         select 1 from workspace_invoicing_settings where workspace_id = $1::uuid
       )`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await pool.end();
  }
}

// Eigenes Workspace für den Berichts-Test, damit die KPI-Assertions nicht
// von Dokumenten der anderen Tests im geteilten E2E-Workspace abhängen.
async function seedIsolatedReportsWorkspace(): Promise<{
  workspaceId: string;
  editorEmail: string;
}> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select pg_catalog.set_config('app.workspace_id', $1::text, true)`,
      [workspaceId],
    );
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    await client.query(
      `insert into workspace (id, name) values ($1::uuid, 'M3-01 Berichte E2E')`,
      [workspaceId],
    );
    // Membership-Insert darf kein Self-Mutation sein → Actor-Context leeren.
    await client.query("select pg_catalog.set_config('app.actor_id', '', true)");
    await client.query(
      `insert into membership (id, workspace_id, user_id, role, capabilities)
       select gen_random_uuid(), $1::uuid, u.id, 'editor', '{"invoicing":true}'::jsonb
         from user_identity u where u.email = $2 limit 1`,
      [workspaceId, data.editorEmail],
    );
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         id, workspace_id, company_name, company_email, company_country,
         company_address_line1, company_postal_code, company_city,
         accounting_method, revision, created_by,
         payment_account_holder, payment_iban, payment_bic
       ) select gen_random_uuid(), $1::uuid, 'Solarwerk E2E GmbH',
         'rechnung@e2e.invalid', 'DE', 'Teststraße 1', '10115', 'Berlin',
         'accrual', 1, (select id from user_identity where email = $2 limit 1),
         'Solarwerk E2E GmbH', 'DE89370400440532013000', 'MARKDEF1100'`,
      [workspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await pool.end();
  }
  return { workspaceId, editorEmail: data.editorEmail };
}

async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `update membership
          set capabilities = pg_catalog.jsonb_set(
            coalesce(capabilities, '{}'::jsonb),
            '{invoicing}',
            'true'::jsonb,
            true
          )
        where workspace_id = $1::uuid
          and user_id = (select id from user_identity where email = $2 limit 1)`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await pool.end();
  }
}

function invoicesPath(): string {
  return `/w/${state().workspaceId}/rechnungen/invoice`;
}

function currentBerlinMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

// ── Tests ────────────────────────────────────────────────────────────────

test("M3-01-E2E-01: Gruppe anlegen → Rechnung anlegen → Ausstellen → Versenden → Stornieren", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedInvoicingSettings();

  const groupsPath = `/w/${data.workspaceId}/rechnungen`;
  await page.goto(groupsPath);
  await loginWithRealOtp(page, data.editorEmail, groupsPath);

  // Gruppe anlegen
  await page.getByRole("button", { name: "Neue Gruppe" }).click();
  const dialog = page.getByRole("dialog", { name: "Neue Gruppe" });
  await dialog.getByLabel("Name").fill("Solarprojekte 2026");
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Solarprojekte 2026")).toBeVisible();

  // Rechnung als Entwurf anlegen (mit Gruppe)
  await page.goto(invoicesPath());
  await page.getByRole("button", { name: "Rechnung anlegen" }).click();
  const createDialog = page.getByRole("dialog", { name: "Rechnung anlegen" });
  await createDialog.getByLabel("Name").fill("E2E-Anlage 10 kWp");
  await createDialog.getByLabel("Fällig am").fill("2026-12-31");
  await createDialog.getByLabel("Gruppe").selectOption({ label: "Solarprojekte 2026" });
  await createDialog.getByRole("button", { name: "Als Entwurf anlegen" }).click();

  const row = page.getByRole("row").filter({ hasText: "E2E-Anlage 10 kWp" });
  await expect(row).toBeVisible();
  await expect(row.getByText("Entwurf")).toBeVisible();

  // Ausstellen → Status wechselt, Nummer erscheint
  await row.getByRole("button", { name: "Ausstellen" }).click();
  await expect(row.getByText("Ausgestellt")).toBeVisible();
  await expect(row.getByText(/RE-2026-/u)).toBeVisible();

  // Versenden (einmalig) → Button verschwindet
  await row.getByRole("button", { name: "Als versendet markieren" }).click();
  await expect(row.getByRole("button", { name: "Als versendet markieren" })).toHaveCount(0);

  // Stornieren mit Pflichtgrund → terminal
  await row.getByRole("button", { name: "Stornieren" }).click();
  const voidDialog = page.getByRole("dialog", { name: "Dokument stornieren" });
  await voidDialog.getByLabel("Grund").selectOption("created_in_error");
  await expectNoWcagAaAxeViolations(page, "M3-01-Storno-Dialog");
  await voidDialog.getByRole("button", { name: "Endgültig stornieren" }).click();
  await expect(row.getByText("Storniert")).toBeVisible();
  await expect(row.getByRole("button", { name: "Stornieren" })).toHaveCount(0);

  await expectNoWcagAaAxeViolations(page, "M3-01-Rechnungsliste");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Journey").toEqual([]);
});

test("M3-01-E2E-02: Statusfilter, Suche und Archiv-Achse", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedInvoicingSettings();
  await seedIssuedInvoice({ name: "Filtertreffer Alpha", grossCents: 11900 });
  await seedIssuedInvoice({ name: "Filtertreffer Beta", grossCents: 8000, voided: true });

  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.editorEmail, invoicesPath());

  // Beide Seed-Rechnungen sichtbar
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Alpha" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Beta" })).toBeVisible();

  // Statusfilter: nur stornierte
  await page.getByLabel("Status", { exact: true }).selectOption("voided");
  await page.getByRole("button", { name: "Filtern" }).click();
  await page.waitForURL((url) => url.searchParams.get("status") === "voided");
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Alpha" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Beta" })).toBeVisible();

  // Zurücksetzen + Suche
  await page.getByRole("link", { name: "Zurücksetzen" }).click();
  // Debug: Formular muss nach der Navigation frische Defaults tragen.
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("");
  await page.getByLabel("Suche").fill("Alpha");
  await page.getByRole("button", { name: "Filtern" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Alpha" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Beta" })).toHaveCount(0);

  // Archiv-Achse: Beta archivieren → verschwindet sofort aus der
  // Standard-Ansicht (nur aktive) und erscheint in „Nur archivierte".
  await page.getByRole("link", { name: "Zurücksetzen" }).click();
  const betaRow = page.getByRole("row").filter({ hasText: "Filtertreffer Beta" });
  await betaRow.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Beta" })).toHaveCount(0);

  await page.getByLabel("Archiv").selectOption("archived");
  await page.getByRole("button", { name: "Filtern" }).click();
  await page.waitForURL((url) => url.searchParams.get("archiv") === "archived");
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Alpha" })).toHaveCount(0);
  const archivedBeta = page.getByRole("row").filter({ hasText: "Filtertreffer Beta" });
  await expect(archivedBeta).toBeVisible();
  await expect(archivedBeta.getByText("Archiviert")).toBeVisible();
  // Reaktivieren stellt die Standard-Sichtbarkeit wieder her.
  await archivedBeta.getByRole("button", { name: "Archivierung aufheben" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Filtertreffer Beta" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Filtergrenzen").toEqual([]);
});

test("M3-01-E2E-03: Berichte zeigen KPIs und liefern CSV", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const isolated = await seedIsolatedReportsWorkspace();

  // Kimi-P2-3: Leerzustände des frischen Workspaces (Liste + Berichte).
  const emptyInvoicesUrl = `/w/${isolated.workspaceId}/rechnungen/invoice`;
  await page.goto(emptyInvoicesUrl);
  await loginWithRealOtp(page, data.editorEmail, emptyInvoicesUrl);
  await expect(page.getByText("Keine Einträge")).toBeVisible();
  const emptyReportsUrl = `/w/${isolated.workspaceId}/rechnungen/berichte`;
  await page.goto(emptyReportsUrl);
  await expect(page.getByText("Keine Einträge")).toBeVisible();

  await seedIssuedInvoice(
    { name: "KPI-Rechnung Eins", grossCents: 11900 },
    { workspaceId: isolated.workspaceId, editorEmail: isolated.editorEmail },
  );
  await seedIssuedInvoice(
    { name: "KPI-Rechnung Zwei", grossCents: 8000 },
    { workspaceId: isolated.workspaceId, editorEmail: isolated.editorEmail },
  );
  await seedIssuedInvoice(
    { name: "Vormonats-Rechnung", grossCents: 5000, issuedMonthsAgo: 1 },
    { workspaceId: isolated.workspaceId, editorEmail: isolated.editorEmail },
  );

  const reportsUrl = `/w/${isolated.workspaceId}/rechnungen/berichte`;
  await page.goto(reportsUrl);

  const month = currentBerlinMonth();
  await expect(page.getByRole("heading", { name: `Monatsübersicht ${month}`, level: 2 })).toBeVisible();

  // Einnahmen diesen Monat = 11900 + 8000 = 199,00 € (Vormonat ausgeschlossen)
  const revenueCard = page.locator("div").filter({ hasText: "Einnahmen diesen Monat" }).last();
  await expect(revenueCard.getByText("199,00 €")).toBeVisible();
  // Ausstehend (all-time) enthält zusätzlich die Vormonats-Rechnung: 249,00 €
  await expect(page.getByText("Insgesamt ausstehend")).toBeVisible();
  const outstandingCard = page.locator("div").filter({ hasText: "Ausstehend" }).last();
  await expect(outstandingCard.getByText("249,00 €")).toBeVisible();

  // CSV-Download
  const csvResponse = await page.request.get(
    `/w/${isolated.workspaceId}/rechnungen/berichte/csv?monat=${month}`,
  );
  expect(csvResponse.status()).toBe(200);
  expect(csvResponse.headers()["content-type"]).toContain("text/csv");
  const body = await csvResponse.text();
  const lines = body.split("\r\n").filter((line) => line !== "");
  expect(lines[0]).toContain("Typ;Nummer;Name;Status");
  // Scope ist der gewählte Monat: Header + die beiden aktuellen Rechnungen.
  expect(lines).toHaveLength(3);
  expect(lines.filter((line) => line.includes("KPI-Rechnung"))).toHaveLength(2);
  expect(lines.some((line) => line.includes("Vormonats-Rechnung"))).toBe(false);

  await expectNoWcagAaAxeViolations(page, "M3-01-Berichte");
  expect(errors, "Browser-Konsole und Page-Errors der Berichte").toEqual([]);
});

test("M3-01-E2E-04: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedInvoicingSettings();
  await seedIssuedInvoice({ name: "Sichtbarkeitstest", grossCents: 1000 });

  // Viewer: Liste sichtbar, keine Schreibflächen
  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.viewerEmail, invoicesPath());
  await expect(page.getByRole("row").filter({ hasText: "Sichtbarkeitstest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rechnung anlegen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ausstellen" })).toHaveCount(0);

  // External: fail-closed
  await page.context().clearCookies();
  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.externalEmail, invoicesPath());
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Sichtbarkeitstest" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});

test("M3-01-E2E-05: typ-spezifische Anlage und Spalten für die übrigen fünf Typen", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedInvoicingSettings();

  const typeCases = [
    {
      type: "credit_note",
      tab: "Gutschriften",
      button: "Gutschrift anlegen",
      fields: [
        { label: "Name", value: "E2E-Gutschrift" },
        { label: "Lieferdatum", value: "2026-12-01" },
      ],
      select: { label: "Grund", value: "minderleistung" },
      columnAssert: "1.12.2026",
    },
    {
      type: "order_confirmation",
      tab: "Auftragsbestätigungen",
      button: "Auftragsbestätigung anlegen",
      fields: [
        { label: "Name", value: "E2E-Auftrag" },
        { label: "Geplantes Lieferdatum", value: "2026-12-02" },
        { label: "Geplantes Leistungsdatum", value: "2026-12-03" },
      ],
      columnAssert: "2.12.2026",
    },
    {
      type: "purchase_order",
      tab: "Bestellungen",
      button: "Bestellung anlegen",
      fields: [
        { label: "Name", value: "E2E-Bestellung" },
        { label: "Gültig bis", value: "2026-12-04" },
      ],
      columnAssert: "4.12.2026",
    },
    {
      type: "delivery_note",
      tab: "Lieferscheine",
      button: "Lieferschein anlegen",
      fields: [
        { label: "Name", value: "E2E-Lieferschein" },
        { label: "Lieferdatum", value: "2026-12-05" },
      ],
      columnAssert: "5.12.2026",
    },
    {
      type: "letter",
      tab: "Briefe",
      button: "Brief anlegen",
      fields: [
        { label: "Name", value: "E2E-Brief" },
        { label: "Gültig bis", value: "2026-12-06" },
      ],
      columnAssert: "6.12.2026",
    },
  ] as const;

  // Login genau einmal; die Session trägt über alle folgenden gotos.
  const firstPath = `/w/${data.workspaceId}/rechnungen/${typeCases[0].type}`;
  await page.goto(firstPath);
  await loginWithRealOtp(page, data.editorEmail, firstPath);

  for (const typeCase of typeCases) {
    const path = `/w/${data.workspaceId}/rechnungen/${typeCase.type}`;
    if (typeCase.type !== typeCases[0].type) {
      await page.goto(path);
    }
    await page.getByRole("button", { name: typeCase.button }).click();
    const dialog = page.getByRole("dialog", { name: typeCase.button });
    for (const field of typeCase.fields) {
      await dialog.getByLabel(field.label).fill(field.value);
    }
    if ("select" in typeCase) {
      await dialog.getByLabel(typeCase.select.label).selectOption(typeCase.select.value);
    }
    await dialog.getByRole("button", { name: "Als Entwurf anlegen" }).click();

    const row = page.getByRole("row").filter({ hasText: typeCase.fields[0].value });
    await expect(row).toBeVisible();
    await expect(row.getByText("Entwurf")).toBeVisible();
    await expect(row.getByText(typeCase.columnAssert)).toBeVisible();
  }

  // Gutschrift-Filter (grund) greift auf den angelegten Entwurf.
  await page.goto(`/w/${data.workspaceId}/rechnungen/credit_note`);
  await page.getByLabel("Grund").selectOption("minderleistung");
  await page.getByRole("button", { name: "Filtern" }).click();
  await page.waitForURL((url) => url.searchParams.get("grund") === "minderleistung");
  await expect(page.getByRole("row").filter({ hasText: "E2E-Gutschrift" })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Typ-Abdeckung").toEqual([]);
});
