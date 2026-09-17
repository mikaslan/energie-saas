import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-16 Projekt-Dateien-Kern (Katalog F7.1/F10.2-Vorstufe) — Chromium-E2E
 * (isolierter Workspace). Admin laedt PNG + PDF hoch (Liste mit Name,
 * Groesse, Datum), Reload-fest, Download-Bytes bytegleich; interner
 * Viewer liest Liste + Download ohne Upload-Form; Fehltyp (.txt)
 * scheitert sichtbar; Axe; Server-Log ohne Fehler.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_MINIMAL = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n",
  "utf8",
);
const TXT_BYTES = Buffer.from("kein erlaubter Typ\n", "utf8");

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  adminEmail: string;
  viewerEmail: string;
};

function state(): E2EState {
  const full = fixtureState() as unknown as Record<string, unknown>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "adminEmail", "viewerEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F7-16-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

async function resolveAdminId(): Promise<string> {
  return poolOne(async (pool) => {
    const result = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [state().adminEmail],
    );
    const id = (result.rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error("E2E-Adminidentitaet fehlt.");
    return id;
  });
}

async function grantViewerMembership(workspaceId: string): Promise<void> {
  await poolOne(async (pool) => {
    const found = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [state().viewerEmail],
    );
    const viewerId = (found.rows[0] as { id: string } | undefined)?.id;
    if (!viewerId) throw new Error("E2E-Vieweridentitaet fehlt.");
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
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

async function downloadBytes(page: Page, href: string): Promise<Buffer> {
  // Gleicher Browser-Kontext (Session-Cookie implizit); Content-
  // Disposition attachment + Bytes bytegleich pruefen.
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"] ?? "").toMatch(/^attachment;/u);
  return Buffer.from(await response.body());
}

test("F7-16-E2E-01: Projekt-Dateien hochladen, lesen und herunterladen", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const serverLogOffset = statSync(data.serverLogPath).size;

  const workspaceId = await seedIsolatedWorkspace(await resolveAdminId());
  await grantViewerMembership(workspaceId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.adminEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Projekt-Dateien");
  await form.getByLabel("Telefon").fill("0151 45678910");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  const detailUrl = `/w/${workspaceId}/anfragen/${projectId}`;

  const section = page.getByTestId("project-files-section");
  await expect(section).toBeVisible();

  // E-01: Admin laedt PNG + PDF hoch → Liste mit Name/Groesse/Datum.
  await section.getByTestId("project-file-input").setInputFiles([
    { name: "zaehler.png", mimeType: "image/png", buffer: PNG_1X1 },
    { name: "plan.pdf", mimeType: "application/pdf", buffer: PDF_MINIMAL },
  ]);
  await section.getByRole("button", { name: "Hochladen", exact: true }).click();
  await expect(section.getByTestId("project-file-success")).toContainText("Dateien hochgeladen");
  const rows = section.getByTestId("project-file-row");
  await expect(rows).toHaveCount(2);
  // Newest-first: plan.pdf (zuletzt hochgeladen) steht oben.
  await expect(rows.nth(0)).toContainText("plan.pdf");
  await expect(rows.nth(0)).toContainText(`${PDF_MINIMAL.byteLength} B`);
  await expect(rows.nth(1)).toContainText("zaehler.png");
  await expect(rows.nth(1)).toContainText(`${PNG_1X1.byteLength} B`);
  const today = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(new Date());
  await expect(rows.nth(0)).toContainText(today);
  const pdfHref = await rows.nth(0).getByTestId("project-file-download").getAttribute("href");
  const pngHref = await rows.nth(1).getByTestId("project-file-download").getAttribute("href");
  expect(pdfHref).toMatch(/\/api\/workspaces\/.+\/projects\/.+\/dateien\?fileId=/u);
  expect(pngHref).toMatch(/\/api\/workspaces\/.+\/projects\/.+\/dateien\?fileId=/u);
  // Kein Key-Leak: fileId-Query, nie immutable/-Key.
  expect(pdfHref).not.toContain("immutable");

  // E-02: Reload-fest.
  await page.reload();
  const reloaded = page.getByTestId("project-files-section");
  await expect(reloaded.getByTestId("project-file-row")).toHaveCount(2);
  await expect(reloaded.getByTestId("project-file-row").nth(0)).toContainText("plan.pdf");

  // E-03: Download-Bytes bytegleich.
  const pdfHrefReloaded = await reloaded
    .getByTestId("project-file-row").nth(0)
    .getByTestId("project-file-download").getAttribute("href");
  const pngHrefReloaded = await reloaded
    .getByTestId("project-file-row").nth(1)
    .getByTestId("project-file-download").getAttribute("href");
  expect(await downloadBytes(page, pdfHrefReloaded!)).toEqual(PDF_MINIMAL);
  expect(await downloadBytes(page, pngHrefReloaded!)).toEqual(PNG_1X1);

  // E-04: interner Viewer liest Liste + Download, sieht KEIN Upload-Form.
  await page.context().clearCookies();
  await page.goto(detailUrl);
  await loginWithRealOtp(page, data.viewerEmail, detailUrl);
  const viewerSection = page.getByTestId("project-files-section");
  await expect(viewerSection).toBeVisible();
  await expect(viewerSection.getByTestId("project-file-row")).toHaveCount(2);
  await expect(viewerSection.getByTestId("project-file-input")).toHaveCount(0);
  await expect(viewerSection.getByRole("button", { name: "Hochladen", exact: true })).toHaveCount(0);
  const viewerPdfHref = await viewerSection
    .getByTestId("project-file-row").nth(0)
    .getByTestId("project-file-download").getAttribute("href");
  expect(await downloadBytes(page, viewerPdfHref!)).toEqual(PDF_MINIMAL);

  // E-05: Fehltyp (.txt) scheitert sichtbar (Admin erneut anmelden).
  await page.context().clearCookies();
  await page.goto(detailUrl);
  await loginWithRealOtp(page, data.adminEmail, detailUrl);
  const adminSection = page.getByTestId("project-files-section");
  await adminSection.getByTestId("project-file-input").setInputFiles({
    name: "notizen.txt",
    mimeType: "text/plain",
    buffer: TXT_BYTES,
  });
  await adminSection.getByRole("button", { name: "Hochladen", exact: true }).click();
  await expect(adminSection.getByTestId("project-file-error"))
    .toContainText("Nur PDF-, JPEG- oder PNG-Dateien bis 25 MB sind erlaubt.");
  await expect(adminSection.getByTestId("project-file-row")).toHaveCount(2);

  // E-06: Axe (Admin-Sicht mit Formular + Liste).
  await expectNoWcagAaAxeViolations(page, "F7-16-Projektdateien");

  // E-07: Server-Log ohne Fehler aus diesem Lauf (eigener Offset).
  const serverTail = readFileSync(data.serverLogPath)
    .subarray(Math.min(serverLogOffset, statSync(data.serverLogPath).size))
    .toString("utf8");
  expect(serverTail, "kein Routen-Fehler im Server-Log").not.toMatch(/\[projekt-dateien\]/u);
  expect(serverTail, "kein Uncaught-Fehler im Server-Log").not.toMatch(/uncaughtException|unhandledRejection/u);

  // Der bewusste .txt-Fehltyp erzeugt eine Chromium-Konsolenmeldung
  // ("Failed to load resource: 400") — SPEZIFIZIERTER Negativ-Endzustand
  // (Muster f7-02g): erwartete Meldung konsumieren, Rest bleibt Fehler.
  const expected400 = "console: Failed to load resource: the server responded with a status of 400 (Bad Request)";
  const consumed = errors.filter((error) => error === expected400).length;
  expect(consumed, "Erwartete 400-Konsolenmeldung nach .txt-Fehltyp").toBeGreaterThan(0);
  const kept = errors.filter((error) => error !== expected400);
  errors.length = 0;
  errors.push(...kept);

  expect(errors, "Browser-Konsole und Page-Errors der Projekt-Dateien").toEqual([]);
});
