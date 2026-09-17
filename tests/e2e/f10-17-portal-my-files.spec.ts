import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F10-17 Portal My-Files (Katalog F10.2) — Chromium-E2E (isolierter
 * Workspace). Admin lädt PDF hoch (Portal: default unsichtbar) → toggelt
 * „Für Kunden sichtbar" → Portal-Dateien-Tab zeigt Name/Größe/Datum +
 * Download-Link (Bytes bytegleich) → zurück toggeln → weg + alter Link
 * 404 → fremde ID 404 → interner Viewer liest inkl. Flag ohne Toggle →
 * Axe → Server-Log ohne Fehler. Portal-Link per UI (F10-07-Muster).
 */

const PDF_MINIMAL = Buffer.from(
  // Echtes Minimal-PDF inkl. %%EOF (Portal-Route prueft Magic + Suffix).
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

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
      throw new Error(`Der private F10-17-E2E-State ist unvollständig (${key}).`);
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

test("F10-17-E2E-01: Portal My-Files freischalten, laden und zurueckziehen", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Portal My-Files");
  await form.getByLabel("Telefon").fill("0151 45678911");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = new URL(page.url()).pathname;

  // Portal-Link per UI (F10-07-Muster: Kundenportal-Sektion).
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
  const filesTab = `${tokenPath}?tab=dateien&lang=de`;

  // E-01: Upload → Portal zeigt die Datei NICHT (Default unsichtbar).
  const section = page.getByTestId("project-files-section");
  await section.getByTestId("project-file-input").setInputFiles({
    name: "freigabe.pdf",
    mimeType: "application/pdf",
    buffer: PDF_MINIMAL,
  });
  await section.getByRole("button", { name: "Hochladen", exact: true }).click();
  await expect(section.getByTestId("project-file-success")).toContainText("Datei hochgeladen");
  const row = section.getByTestId("project-file-row").nth(0);
  await expect(row).toContainText("freigabe.pdf");
  const toggle = row.getByTestId("project-file-visibility-toggle");
  await expect(toggle).not.toBeChecked();

  await page.goto(filesTab);
  const provided = page.getByTestId("portal-provided-files");
  await expect(provided.getByRole("heading", { name: "Vom Anbieter bereitgestellt" })).toBeVisible();
  await expect(provided).toContainText("Aktuell liegen keine Dateien vom Anbieter vor.");
  await expect(provided).not.toContainText("freigabe.pdf");

  // E-02: Toggle sichtbar → Portal zeigt Name/Größe/Datum + Download.
  await page.goto(detailUrl);
  await section.getByTestId("project-file-row").nth(0)
    .getByTestId("project-file-visibility-toggle").check();
  await expect(section.getByTestId("project-file-visibility-feedback"))
    .toContainText("Für Kunden sichtbar.");
  await expect(section.getByTestId("project-file-visibility-toggle")).toBeChecked();

  await page.goto(filesTab);
  const entry = provided.getByTestId("portal-provided-file-row").nth(0);
  await expect(entry).toContainText("freigabe.pdf");
  await expect(entry).toContainText(`${PDF_MINIMAL.byteLength} B`);
  const today = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(new Date());
  await expect(entry).toContainText(today);
  const downloadLink = entry.getByRole("link", { name: "Herunterladen", exact: true });
  const href = await downloadLink.getAttribute("href");
  expect(href).toMatch(/^\/p\/[A-Za-z0-9_-]+\/dateien\/[0-9a-f-]{36}\?lang=de$/u);
  expect(href).not.toContain("immutable");
  const downloadResponse = await page.request.get(href!);
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()["content-type"]).toBe("application/pdf");
  expect(downloadResponse.headers()["content-length"]).toBe(String(PDF_MINIMAL.byteLength));
  expect(downloadResponse.headers()["content-disposition"] ?? "").toMatch(/^attachment;/u);
  expect(Buffer.from(await downloadResponse.body()).equals(PDF_MINIMAL)).toBe(true);

  // E-03: Zurück toggeln → weg aus Liste, alter Link 404 (kein Orakel).
  await page.goto(detailUrl);
  await section.getByTestId("project-file-row").nth(0)
    .getByTestId("project-file-visibility-toggle").uncheck();
  await expect(section.getByTestId("project-file-visibility-feedback"))
    .toContainText("Nicht mehr für Kunden sichtbar.");
  await page.goto(filesTab);
  await expect(provided).toContainText("Aktuell liegen keine Dateien vom Anbieter vor.");
  await expect(provided.getByTestId("portal-provided-file-row")).toHaveCount(0);
  expect((await page.request.get(href!)).status()).toBe(404);

  // E-04: Fremde fileId → 404 (gleicher Endzustand, kein Orakel).
  expect((await page.request.get(`${tokenPath}/dateien/${randomUUID()}`)).status()).toBe(404);

  // E-05: Interner Viewer liest Liste inkl. Flag, sieht KEIN Toggle.
  await page.context().clearCookies();
  await page.goto(detailUrl);
  await loginWithRealOtp(page, data.viewerEmail, detailUrl);
  const viewerSection = page.getByTestId("project-files-section");
  await expect(viewerSection.getByTestId("project-file-row")).toHaveCount(1);
  await expect(viewerSection.getByTestId("project-file-row").nth(0))
    .toContainText("freigabe.pdf");
  await expect(viewerSection.getByTestId("project-file-visibility-state"))
    .toContainText("Für Kunden sichtbar: Nein");
  await expect(viewerSection.getByTestId("project-file-visibility-toggle")).toHaveCount(0);

  // E-06: Axe (Portal-Dateien-Tab + interne Sicht).
  await page.goto(filesTab);
  await expectNoWcagAaAxeViolations(page, "F10-17-Portal-Dateien");

  // E-07: Server-Log ohne Fehler aus diesem Lauf (eigener Offset).
  const serverTail = readFileSync(data.serverLogPath)
    .subarray(Math.min(serverLogOffset, statSync(data.serverLogPath).size))
    .toString("utf8");
  expect(serverTail, "kein Routen-Fehler im Server-Log").not.toMatch(/\[projekt-dateien\]/u);
  expect(serverTail, "kein Uncaught-Fehler im Server-Log").not.toMatch(/uncaughtException|unhandledRejection/u);

  // Erwartete 404-Konsolenmeldungen (E-03/E-04, Muster f7-02g).
  const expected404 = "console: Failed to load resource: the server responded with a status of 404 (Not Found)";
  const kept = errors.filter((error) => error !== expected404);
  errors.length = 0;
  errors.push(...kept);

  expect(errors, "Browser-Konsole und Page-Errors der Portal My-Files").toEqual([]);
});
