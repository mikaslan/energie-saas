import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-07B Handover-Gegenzeichnung (Katalog F7.7, on-screen, intern) —
 * Chromium-E2E (isolierter Workspace). Admin schliesst ab, nimmt ab,
 * zeichnet die Kunden-Gegenzeichnung (Canvas), speichert (Reload-fest);
 * Viewer sieht Name und Vorschau lesend.
 */

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
      throw new Error(`Der private F7-07B-E2E-State ist unvollständig (${key}).`);
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
function installationSection(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Installation", exact: true }),
  });
}

test("F7-07B-E2E-01: Handover-Gegenzeichnung ist persistent und lesbar", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Gegenzeichnung");
  await form.getByLabel("Telefon").fill("0151 45678910");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const section = installationSection(page);
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "Installation direkt anlegen", exact: true }).click();
  await expect(section.getByText("Installation angelegt")).toBeVisible();
  await section.getByRole("button", { name: "Installation abschließen", exact: true }).click();
  await expect(section.getByText("Installation abgeschlossen.")).toBeVisible();
  await section.getByLabel("Abgenommen durch").fill("Monteur Martin");
  await section.getByRole("button", { name: "Abnahme speichern", exact: true }).click();
  await expect(section.getByText("Abnahme festgehalten.")).toBeVisible();

  // Ohne Abnahme kein Formular — hier vorhanden (Abnahme gerade erfolgt).
  await section.getByLabel("Gegengezeichnet von").fill("Familie Berger");
  // Leeres Speichern warnt.
  await section.getByRole("button", { name: "Gegenzeichnung speichern", exact: true }).click();
  await expect(section.getByText("Bitte zuerst unterschreiben.", { exact: true })).toBeVisible();

  const canvas = section.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Gegenzeichnungs-Canvas unsichtbar.");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 12 });
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 6 });
  await page.mouse.up();
  await section.getByRole("button", { name: "Gegenzeichnung speichern", exact: true }).click();
  await expect(section.getByText("Gegenzeichnung festgehalten.", { exact: true })).toBeVisible();
  const preview = section.getByRole("img", { name: "Gegenzeichnung-Vorschau" });
  await expect(preview).toBeVisible();
  const firstSrc = await preview.getAttribute("src");
  expect(firstSrc).toMatch(/^data:image\/png;base64,/u);
  await expect(section.getByText("Familie Berger", { exact: true })).toBeVisible();

  await page.reload();
  const reloaded = installationSection(page);
  await expect(reloaded).toBeVisible();
  const previewReloaded = reloaded.getByRole("img", { name: "Gegenzeichnung-Vorschau" });
  await expect(previewReloaded).toBeVisible();
  await expect(previewReloaded).toHaveAttribute("src", firstSrc!);
  await expect(reloaded.getByText("Familie Berger", { exact: true })).toBeVisible();

  // Korrektur: neuer Name + neuer Strich ersetzen Anzeige und Vorschau.
  await reloaded.getByLabel("Gegengezeichnet von").fill("Familie Berger-Kramer");
  const canvas2 = reloaded.locator("canvas");
  const box2 = await canvas2.boundingBox();
  if (!box2) throw new Error("Gegenzeichnungs-Canvas unsichtbar.");
  await page.mouse.move(box2.x + box2.width - 20, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 20, box2.y + box2.height / 2, { steps: 12 });
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height - 20, { steps: 6 });
  await page.mouse.up();
  await reloaded.getByRole("button", { name: "Gegenzeichnung speichern", exact: true }).click();
  await expect(reloaded.getByText("Gegenzeichnung festgehalten.", { exact: true })).toBeVisible();
  await expect(reloaded.getByText("Familie Berger-Kramer", { exact: true })).toBeVisible();
  await expect(previewReloaded).not.toHaveAttribute("src", firstSrc!, { timeout: 15_000 });
  const secondSrc = await previewReloaded.getAttribute("src");
  expect(secondSrc).toMatch(/^data:image\/png;base64,/u);

  // Viewer (lesend): Name und Vorschau, kein Formular.
  const projectPath = new URL(page.url()).pathname;
  await page.context().clearCookies();
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.viewerEmail, projectPath);
  const viewerSection = installationSection(page);
  await expect(viewerSection).toBeVisible();
  await expect(viewerSection.getByRole("img", { name: "Gegenzeichnung-Vorschau" })).toBeVisible();
  await expect(viewerSection.getByText("Familie Berger-Kramer", { exact: true })).toBeVisible();
  await expect(viewerSection.locator("canvas")).toHaveCount(0);
  await expect(viewerSection.getByLabel("Gegengezeichnet von")).toHaveCount(0);

  await expectNoWcagAaAxeViolations(page, "F7-07B-Gegenzeichnung");

  expect(errors, "Browser-Konsole und Page-Errors der Gegenzeichnung").toEqual([]);
});
