import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { expect, test, type Download, type Page } from "playwright/test";

import {
  resolveEditorId,
  seedIsolatedWorkspace,
} from "./m1-11g-fixture";
// Seed-Logik in f10-07-fixture.ts ausgelagert (Wiederverwendung durch
// DASH-VG-38, byte-identische SQL-Sequenz).
import {
  OFFER_NUMBER,
  seedApprovedIssuance,
  state,
} from "./f10-07-fixture";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * F10-07 Portal-Dokument-Download (My-Files-Rest) — Chromium-E2E.
 *
 * Durchgängig im isolierten Workspace (f101/f102 behaupten leere
 * Dokumente und dürfen nicht berührt werden): Lead → Projekt → Portal-Link
 * per UI → freigegebene Issuance per SQL-Seed (Replica-Rolle umgeht nur
 * FKs/Trigger, Checks bleiben aktiv) → Übersicht zeigt Download-Link →
 * Klick liefert exakt das versiegelte PDF (Header wie interner Pfad) →
 * unbekannte Issuance 404 ohne Orakel. Keine Browser-Fehler.
 */

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

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  if (stream === null) throw new Error("F10-07: Download-Stream fehlt.");
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("F10-07-E2E-01: Portal-Dokument herunterladen, 404 ohne Orakel", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  // 1) Projekt per manueller Anfrage (F1-11-Muster wie F1-12-E2E).
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Dateien");
  await leadForm.getByLabel("Telefon").fill("0151 45678907");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split("/").pop() ?? "";
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/u);

  // 2) Portal-Link per UI (F10-06-Muster).
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) Freigegebene Issuance seeden (isolierter Workspace, keine
  // Nachbar-Berührung).
  const { issuanceId, artifact } = await seedApprovedIssuance(workspaceId, projectId, actorId);

  // 4) Übersicht zeigt Download-Link; Klick liefert das versiegelte PDF.
  await page.goto(tokenPath);
  const offerRow = page.locator("li", { hasText: `Angebot ${OFFER_NUMBER}` });
  await expect(offerRow).toBeVisible();
  const downloadLink = offerRow.getByRole("link", { name: "Herunterladen", exact: true });
  await expect(downloadLink).toHaveAttribute(
    "href",
    `${tokenPath}/dokumente/${issuanceId}?lang=de`,
  );
  const expectedFilename = `${OFFER_NUMBER}-Ausstellungsfassung.pdf`;
  const [downloadResponse, download] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "GET"
      && new URL(response.url()).pathname === `${tokenPath}/dokumente/${issuanceId}`),
    page.waitForEvent("download"),
    downloadLink.click(),
  ]);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(expectedFilename);
  const downloadedBytes = await bytesFromDownload(download);
  expect(downloadedBytes.equals(artifact)).toBe(true);
  const headers = downloadResponse.headers();
  expect(downloadResponse.status()).toBe(200);
  expect(headers["content-type"]).toBe("application/pdf");
  expect(headers["content-length"]).toBe(String(artifact.byteLength));
  expect(headers["content-disposition"]).toBe(
    `attachment; filename="${expectedFilename}"; filename*=UTF-8''${encodeURIComponent(expectedFilename)}`,
  );
  expect(headers["cache-control"]).toBe("private, no-store, max-age=0");

  // 5) Unbekannte Issuance: 404 ohne Orakel (gleicher Endzustand wie
  // toter Link, keine Inhalte).
  const unknownResponse = await page.request.get(`${tokenPath}/dokumente/${randomUUID()}`);
  expect(unknownResponse.status()).toBe(404);

  expect(errors, "Browser-Konsole und Page-Errors des Downloads").toEqual([]);
});
