import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-15b Fotodoku-Markup (Katalog F7.8) — Chromium-E2E (isolierter Workspace).
 * Admin markiert ein Galerie-Foto (Pfeil + Text); die annotierte Kopie wird
 * als ZUSAETZLICHES Galerie-Foto gespeichert (Original unberuehrt, Cover
 * bleibt Original), Reload-fest; Viewer ohne Einstieg; volle Galerie (8) =
 * ehrlich disabled; Abbrechen ohne Upload.
 */

// 64x64 einfarbige PNGs (inline-base64) — 1x1 waere kein adressierbares
// Maus-Ziel; 8 verschiedene Farben (inhalts-deterministische Keys: gleiche
// Bytes = gleicher Key, Dedupe wuerde E-06 sonst verfaelschen).
const PNG_64X64_GRAU = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQ0AAAwDoPpXVlmVsHsJOCB9LgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIClwE1q4IsRYcZLAAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64X64_ROT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64X64_GRUEN = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItjCGMb0Ai+hcEKLDX9WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELguuaYEACRaEWwAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64X64_BLAU = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsMtkHLMbxgi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgtfq4FLf0E8ywAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64X64_GELB = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsMtk/xSGMIcRfAuDFVim67UICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwWvdahw5yTJ0kAAAAASUVORK5CYII=",
  "base64",
);
const PNG_64X64_CYAN = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtmf3ybyAi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgtYNGG0sN92HAAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_64X64_MAGENTA = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsEtnbN/GMoJvYbACy1S/FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJ2j8Gl2uFzgwAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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
      throw new Error(`Der private F7-15b-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dataUrlBytes(src: string): Buffer {
  const payload = src.split(",", 2)[1];
  if (!src.startsWith("data:image/png;base64,") || !payload) {
    throw new Error("Erwartete PNG-Daten-URL als Galerie-Vorschau.");
  }
  return Buffer.from(payload, "base64");
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

function isFotoPost(url: string, method: string): boolean {
  return method === "POST" && new URL(url).pathname.endsWith("/checkliste/foto");
}

test("F7-15b-E2E-01: Fotodoku-Markup als zusaetzliches Galerie-Foto", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const serverLogOffset = statSync(data.serverLogPath).size;
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  let fotoPosts = 0;
  page.on("request", (request) => {
    if (isFotoPost(request.url(), request.method())) fotoPosts += 1;
  });

  const workspaceId = await seedIsolatedWorkspace(await resolveAdminId());
  await grantViewerMembership(workspaceId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.adminEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Fotodoku-Markup");
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
  const photoTitle = `Schadenfoto ${stamp}`;
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(photoTitle);
  const photoItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await photoItem.getByLabel("Typ").selectOption("image");

  // E-01: Upload 1 Foto → Markieren-Button sichtbar + aktiv.
  await photoItem.getByLabel(`${photoTitle}: Foto`, { exact: true }).setInputFiles({
    name: "schaden.png",
    mimeType: "image/png",
    buffer: PNG_64X64_GRAU,
  });
  await photoItem.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(photoItem.getByRole("img", { name: photoTitle })).toHaveCount(1);
  expect(fotoPosts).toBe(1);
  const markButton = photoItem.getByRole("button", { name: `${photoTitle}: Foto 1 markieren` });
  await expect(markButton).toBeVisible();
  await expect(markButton).toBeEnabled();
  const originalSrc = await photoItem
    .getByRole("img", { name: `${photoTitle}: Foto 1 von 1` })
    .getAttribute("src");
  expect(originalSrc).toBe(`data:image/png;base64,${PNG_64X64_GRAU.toString("base64")}`);

  // E-02: Dialog oeffnet OHNE Server-Upload (Request-Zaehler still).
  await markButton.click();
  const dialog = page.getByRole("dialog", { name: "Foto markieren" });
  await expect(dialog).toBeVisible();
  const canvas = dialog.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("Keine Markierungen.");
  await expect(dialog.getByLabel("Markierungstext")).toHaveAttribute("maxlength", "140");
  expect(fotoPosts).toBe(1);
  await expectNoWcagAaAxeViolations(page, "F7-15B-Markup-Dialog");

  // E-07: Abbrechen nach Pfeil → kein POST, Galerie unveraendert.
  const cancelBox = await canvas.boundingBox();
  if (!cancelBox) throw new Error("Markup-Canvas unsichtbar (Abbrechen).");
  await page.mouse.move(cancelBox.x + 8, cancelBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + 56, cancelBox.y + 56, { steps: 10 });
  await page.mouse.up();
  await expect(dialog.getByRole("status")).toHaveText("1 Markierung.");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fotoPosts).toBe(1);
  await expect(photoItem.getByRole("img", { name: photoTitle })).toHaveCount(1);

  // E-03: Pfeil per Maus (02i-Muster) + Text → Save → Galerie 2 Fotos,
  // Original-Bytes unveraendert, Kopie = PNG, Cover = Original.
  await photoItem.getByRole("button", { name: `${photoTitle}: Foto 1 markieren` }).click();
  const editDialog = page.getByRole("dialog", { name: "Foto markieren" });
  await expect(editDialog).toBeVisible();
  const editCanvas = editDialog.locator("canvas");
  const box = await editCanvas.boundingBox();
  if (!box) throw new Error("Markup-Canvas unsichtbar (Speichern).");
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 56, box.y + 56, { steps: 10 });
  await page.mouse.up();
  await expect(editDialog.getByRole("status")).toHaveText("1 Markierung.");
  await editDialog.getByRole("button", { name: "Text", exact: true }).click();
  await editDialog.getByLabel("Markierungstext").fill("Riss hier");
  await editCanvas.click();
  await expect(editDialog.getByRole("status")).toHaveText("2 Markierungen.");
  expect(fotoPosts).toBe(1);
  const saveResponsePromise = page.waitForResponse((response) =>
    isFotoPost(response.url(), response.request().method()));
  await editDialog.getByRole("button", { name: "Markierung speichern" }).click();
  expect((await saveResponsePromise).status()).toBe(200);
  await expect(editDialog).toHaveCount(0);
  expect(fotoPosts).toBe(2);
  const thumbs = photoItem.getByRole("img", { name: photoTitle });
  await expect(thumbs).toHaveCount(2);
  await expect(photoItem.getByText("Titelbild", { exact: true })).toBeVisible();
  const keptSrc = await photoItem
    .getByRole("img", { name: `${photoTitle}: Foto 1 von 2` })
    .getAttribute("src");
  const markedSrc = await photoItem
    .getByRole("img", { name: `${photoTitle}: Foto 2 von 2` })
    .getAttribute("src");
  expect(keptSrc).toBe(originalSrc);
  expect(sha256Hex(dataUrlBytes(keptSrc!))).toBe(sha256Hex(PNG_64X64_GRAU));
  expect(markedSrc).not.toBe(originalSrc);
  expect(dataUrlBytes(markedSrc!).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-04: Reload-fest (beide Fotos lesbar, Cover weiter Original).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const photoReloaded = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(photoReloaded.getByRole("img", { name: photoTitle })).toHaveCount(2);
  await expect(photoReloaded.getByRole("img", { name: `${photoTitle}: Foto 1 von 2` }))
    .toHaveAttribute("src", originalSrc!);
  await expect(photoReloaded.getByRole("img", { name: `${photoTitle}: Foto 2 von 2` }))
    .toHaveAttribute("src", markedSrc!);
  await expect(photoReloaded.getByRole("button", { name: `${photoTitle}: Foto 1 markieren` }))
    .toBeEnabled();

  // E-05: Viewer (lesend) sieht beide Fotos, kein Markieren-Button.
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerPhoto = page.locator("li", { hasText: photoTitle });
  await expect(viewerPhoto.getByRole("img", { name: photoTitle })).toHaveCount(2);
  await expect(viewerPhoto.getByRole("img", { name: `${photoTitle}: Foto 1 von 2` })).toBeVisible();
  await expect(viewerPhoto.getByRole("button", { name: /markieren/u })).toHaveCount(0);

  // E-06: volle Galerie (8) → Markieren-Buttons ehrlich disabled.
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.adminEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const photoAdmin = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(photoAdmin.getByRole("img", { name: photoTitle })).toHaveCount(2);
  const extraColors: Array<[string, Buffer]> = [
    ["rot.png", PNG_64X64_ROT],
    ["gruen.png", PNG_64X64_GRUEN],
    ["blau.png", PNG_64X64_BLAU],
    ["gelb.png", PNG_64X64_GELB],
    ["cyan.png", PNG_64X64_CYAN],
    ["magenta.png", PNG_64X64_MAGENTA],
  ];
  await photoAdmin.getByLabel(`${photoTitle}: Foto`, { exact: true }).setInputFiles(
    extraColors.map(([name, buffer]) => ({ name, mimeType: "image/png", buffer })),
  );
  await photoAdmin.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(photoAdmin.getByText("8 von 8 Fotos.", { exact: true })).toBeVisible();
  const fullButtons = photoAdmin.getByRole("button", { name: /markieren/u });
  await expect(fullButtons).toHaveCount(8);
  for (const button of await fullButtons.all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "Galerie voll");
  }
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();

  // E-08: Axe (volle Galerie, Admin-Sicht).
  await expectNoWcagAaAxeViolations(page, "F7-15B-Galerie-voll");

  // E-09: Server-Log ohne Fehler aus diesem Lauf (eigener Offset).
  const serverTail = readFileSync(data.serverLogPath)
    .subarray(Math.min(serverLogOffset, statSync(data.serverLogPath).size))
    .toString("utf8");
  expect(serverTail, "kein Routen-Fehler im Server-Log").not.toMatch(/\[checkliste\] foto/u);
  expect(serverTail, "kein Uncaught-Fehler im Server-Log").not.toMatch(/uncaughtException|unhandledRejection/u);

  expect(errors, "Browser-Konsole und Page-Errors des Fotodoku-Markups").toEqual([]);
});
