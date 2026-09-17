import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-02G Bild-Punkt (Katalog F7.2) — Chromium-E2E (isolierter Workspace).
 * Admin legt einen Bildpunkt an, laedt ein Foto hoch (Vorschau), speichert
 * (Reload-fest), ersetzt das Foto; PDF-Upload scheitert sichtbar; Viewer
 * sieht die Vorschau lesend.
 */

const PNG_1X1_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1X1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
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
      throw new Error(`Der private F7-02G-E2E-State ist unvollständig (${key}).`);
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

test("F7-02G-E2E-01: Bild-Punkt mit Foto-Upload ist persistent und ersetzbar", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const workspaceId = await seedIsolatedWorkspace(await resolveAdminId());
  await grantViewerMembership(workspaceId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.adminEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Bild-Punkt");
  await form.getByLabel("Telefon").fill("0151 45678910");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  const url = `/w/${workspaceId}/anfragen/${projectId}/checkliste`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();

  const stamp = Date.now();
  const photoTitle = `Zählerfoto ${stamp}`;
  const taskTitle = `Dachfläche ${stamp}`;
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(photoTitle);
  const photoItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await photoItem.getByLabel("Typ").selectOption("image");
  await photoItem.getByLabel(`${photoTitle}: Pflichtpunkt`).check();
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.2").fill(taskTitle);

  // Fehltyp scheitert sichtbar (kein stilles Ignorieren).
  const fotoInput = photoItem.getByLabel(`${photoTitle}: Foto`);
  await fotoInput.setInputFiles({
    name: "zaehler.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fake", "utf8"),
  });
  await photoItem.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(photoItem.getByRole("alert")).toContainText("Nur JPEG- oder PNG-Bilder");

  await fotoInput.setInputFiles({
    name: "zaehler.png",
    mimeType: "image/png",
    buffer: PNG_1X1_TRANSPARENT,
  });
  await photoItem.getByRole("button", { name: "Foto hochladen" }).click();
  const preview = photoItem.getByRole("img", { name: `${photoTitle}: Foto-Vorschau` });
  await expect(preview).toBeVisible();
  const firstSrc = await preview.getAttribute("src");
  expect(firstSrc).toMatch(/^data:image\/png;base64,/u);

  // Pflicht-Gate zählt den offenen Bildpunkt wie eine Aufgabe.
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toBeVisible();
  const photoCheckbox = photoItem.getByRole("checkbox", { name: photoTitle, exact: true });
  await photoCheckbox.check();
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const photoReloaded = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(photoReloaded.getByRole("checkbox", { name: photoTitle, exact: true })).toBeChecked();
  const previewReloaded = photoReloaded.getByRole("img", { name: `${photoTitle}: Foto-Vorschau` });
  await expect(previewReloaded).toBeVisible();
  await expect(previewReloaded).toHaveAttribute("src", firstSrc!);
  await expect(page.getByText("Punkte: 1/2", { exact: true })).toBeVisible();

  // Ersetzen: neuer Upload, neue Bytes, Version 2.
  await photoReloaded.getByLabel(`${photoTitle}: Foto`).setInputFiles({
    name: "zaehler-neu.png",
    mimeType: "image/png",
    buffer: PNG_1X1_RED,
  });
  await photoReloaded.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(previewReloaded).not.toHaveAttribute("src", firstSrc!, { timeout: 15_000 });
  const secondSrc = await previewReloaded.getAttribute("src");
  expect(secondSrc).toMatch(/^data:image\/png;base64,/u);
  expect(secondSrc).not.toBe(firstSrc);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();

  // Viewer (lesend): Vorschau sichtbar, kein Upload, kein Editor.
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerPhoto = page.locator("li", { hasText: photoTitle });
  await expect(viewerPhoto.getByRole("img", { name: `${photoTitle}: Foto-Vorschau` })).toBeVisible();
  await expect(viewerPhoto.getByRole("checkbox", { name: photoTitle, exact: true })).toBeChecked();
  await expect(viewerPhoto.getByRole("checkbox", { name: photoTitle, exact: true })).toBeDisabled();
  await expect(viewerPhoto.getByLabel(`${photoTitle}: Foto`)).toHaveCount(0);
  await expect(viewerPhoto.getByLabel("Typ")).toHaveCount(0);
  await expect(page.getByText("Punkte: 1/2", { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F7-02G-Bild");

  // Der bewusste PDF-Fehltyp erzeugt eine Chromium-Konsolenmeldung
  // ("Failed to load resource: 400") — das ist der SPEZIFIZIERTE
  // Negativ-Endzustand, kein Defekt. Muster f10-01 (erwartete 404):
  // erwartete Meldung gezielt konsumieren, Rest bleibt Fehler.
  const expected400 = "console: Failed to load resource: the server responded with a status of 400 (Bad Request)";
  const consumed = errors.filter((error) => error === expected400).length;
  expect(consumed, "Erwartete 400-Konsolenmeldung nach PDF-Fehltyp").toBeGreaterThan(0);
  const kept = errors.filter((error) => error !== expected400);
  errors.length = 0;
  errors.push(...kept);

  expect(errors, "Browser-Konsole und Page-Errors des Bild-Punkts").toEqual([]);
});
