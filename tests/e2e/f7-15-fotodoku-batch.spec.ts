import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-15 Fotodoku-Batch (Katalog F7.8) — Chromium-E2E (isolierter Workspace).
 * Admin haengt 3 Fotos in einem Vorgang an (Galerie mit Cover), Reload-fest,
 * Duplikat deduped, Entfernen mit Cover-Promotion; Legacy-Einzelfoto lesbar;
 * Viewer liest die Galerie.
 */

const PNG_1X1_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1X1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1X1_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
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
      throw new Error(`Der private F7-15-E2E-State ist unvollständig (${key}).`);
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

// E-04: Legacy-Bestand simulieren — `photos` direkt aus dem gespeicherten
// Baum streichen (`photo` bleibt); ehrlicher 02g-Lesepfad, kein UI-Trick.
async function stripPhotosToLegacy(projectId: string, workspaceId: string): Promise<void> {
  const adminId = await resolveAdminId();
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', $2, true)",
        [workspaceId, adminId],
      );
      const updated = await client.query(
        `update public.project_checklist
            set blocks = blocks #- '{0,segments,0,items,0,photos}'
          where project_id = $1::uuid`,
        [projectId],
      );
      if (updated.rowCount !== 1) throw new Error("Legacy-Strip traf keine Checkliste.");
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

test("F7-15-E2E-01: Fotodoku-Batch mit Galerie, Entfernen und Legacy", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Fotodoku-Batch");
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
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Protokoll");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(photoTitle);
  const photoItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await photoItem.getByLabel("Typ").selectOption("image");

  // E-01: Ein Upload-Vorgang mit 3 Dateien → Galerie mit Cover.
  const thumbs = photoItem.getByRole("img", { name: photoTitle });
  await photoItem.getByLabel(`${photoTitle}: Foto`, { exact: true }).setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: PNG_1X1_TRANSPARENT },
    { name: "b.png", mimeType: "image/png", buffer: PNG_1X1_RED },
    { name: "c.png", mimeType: "image/png", buffer: PNG_1X1_BLUE },
  ]);
  await photoItem.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(thumbs).toHaveCount(3);
  const cover = photoItem.getByRole("img", { name: `${photoTitle}: Foto 1 von 3` });
  await expect(cover).toBeVisible();
  const coverSrc = await cover.getAttribute("src");
  expect(coverSrc).toMatch(/^data:image\/png;base64,/u);
  const redSrc = await photoItem.getByRole("img", { name: `${photoTitle}: Foto 2 von 3` }).getAttribute("src");
  expect(redSrc).toMatch(/^data:image\/png;base64,/u);
  expect(redSrc).not.toBe(coverSrc);
  await expect(photoItem.getByText("3 von 8 Fotos.", { exact: true })).toBeVisible();
  await expect(photoItem.getByText("Titelbild", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  // E-02: Reload-fest (Server-Bytes = lokale Bytes).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const photoReloaded = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  const thumbsReloaded = photoReloaded.getByRole("img", { name: photoTitle });
  await expect(thumbsReloaded).toHaveCount(3);
  await expect(photoReloaded.getByRole("img", { name: `${photoTitle}: Foto 1 von 3` }))
    .toHaveAttribute("src", coverSrc!);

  // E-07: Duplikat-Bytes (anderer Dateiname) → deduped, kein 4. Thumb.
  await photoReloaded.getByLabel(`${photoTitle}: Foto`, { exact: true }).setInputFiles({
    name: "rot-kopie.png",
    mimeType: "image/png",
    buffer: PNG_1X1_RED,
  });
  await photoReloaded.getByRole("button", { name: "Foto hochladen" }).click();
  await expect(photoReloaded.getByText("3 von 8 Fotos.", { exact: true })).toBeVisible();
  await expect(photoReloaded.getByRole("img", { name: photoTitle })).toHaveCount(3);

  // E-03: Cover entfernen → naechstes Foto wird Cover (Promotion).
  await photoReloaded.getByRole("button", { name: `${photoTitle}: Foto 1 entfernen` }).click();
  const thumbsAfterRemove = photoReloaded.getByRole("img", { name: photoTitle });
  await expect(thumbsAfterRemove).toHaveCount(2);
  await expect(photoReloaded.getByRole("img", { name: `${photoTitle}: Foto 1 von 2` }))
    .toHaveAttribute("src", redSrc!);
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const photoPromoted = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await expect(photoPromoted.getByRole("img", { name: photoTitle })).toHaveCount(2);
  await expect(photoPromoted.getByRole("img", { name: `${photoTitle}: Foto 1 von 2` }))
    .toHaveAttribute("src", redSrc!);

  // E-05: Viewer (lesend) sieht die Galerie, kein Upload/Entfernen.
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerPhoto = page.locator("li", { hasText: photoTitle });
  await expect(viewerPhoto.getByRole("img", { name: photoTitle })).toHaveCount(2);
  await expect(viewerPhoto.getByRole("img", { name: `${photoTitle}: Foto 1 von 2` })).toBeVisible();
  await expect(viewerPhoto.getByLabel(`${photoTitle}: Foto`, { exact: true })).toHaveCount(0);
  await expect(viewerPhoto.getByRole("button", { name: /entfernen/u })).toHaveCount(0);

  // E-06: Axe (Viewer-Sicht mit Galerie).
  await expectNoWcagAaAxeViolations(page, "F7-15-Batch");

  // E-04: Legacy-Einzelfoto (photos gestrichen, photo bleibt) lesbar.
  await stripPhotosToLegacy(projectId, workspaceId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerLegacy = page.locator("li", { hasText: photoTitle });
  await expect(viewerLegacy.getByRole("img", { name: photoTitle })).toHaveCount(1);
  const legacySrc = await viewerLegacy
    .getByRole("img", { name: `${photoTitle}: Foto 1 von 1` })
    .getAttribute("src");
  expect(legacySrc).toMatch(/^data:image\/png;base64,/u);

  expect(errors, "Browser-Konsole und Page-Errors des Fotodoku-Batch").toEqual([]);
});
