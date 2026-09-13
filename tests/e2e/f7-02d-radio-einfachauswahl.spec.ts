import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { poolOne, seedIsolatedWorkspace, state as fixtureState } from "./m1-11g-fixture";

/**
 * F7-02D Radio-Einfachauswahl (Katalog F7.2, Slice B) — Chromium-E2E
 * (isolierter Workspace). Admin legt zwei Punkte an, stellt beide auf Typ
 * „Einfachauswahl", wählt den ersten (Pflicht-Gate zählt offen), wählt den
 * zweiten: der erste wird automatisch abgewählt (Exklusivität je Segment).
 * Speichern + Reload belegt die Persistenz; Viewer sieht deaktivierte Radios.
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
      throw new Error(`Der private F7-02D-E2E-State ist unvollständig (${key}).`);
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

test("F7-02D-E2E-01: Einfachauswahl ist je Segment exklusiv und persistent", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Radio-Auswahl");
  await form.getByLabel("Telefon").fill("0151 45678909");
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
  const firstTitle = `Wechselrichter A ${stamp}`;
  const secondTitle = `Wechselrichter B ${stamp}`;
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("PV");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Auswahl");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill(firstTitle);
  const firstItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  await firstItem.getByLabel("Typ").selectOption("radio");
  await firstItem.getByLabel(`${firstTitle}: Pflichtpunkt`).check();
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.2").fill(secondTitle);
  const secondItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.2") });
  await secondItem.getByLabel("Typ").selectOption("radio");

  // Ehrliches Umschreiben: erledigte Aufgabe → Radio fällt auf unerledigt,
  // statt einen speicherbaren Doppel-done zu erzeugen.
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  const thirdTitle = `Wechselrichter C ${stamp}`;
  await page.getByLabel("Punkt-Name 1.3").fill(thirdTitle);
  const thirdItem = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.3") });
  await thirdItem.getByRole("checkbox", { name: thirdTitle, exact: true }).check();
  await thirdItem.getByLabel("Typ").selectOption("radio");
  await expect(thirdItem.getByRole("radio", { name: thirdTitle })).not.toBeChecked();

  // Pflicht-Gate zählt den offenen Radio-Punkt wie eine Aufgabe.
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toBeVisible();

  const firstRadio = firstItem.getByRole("radio", { name: firstTitle });
  const secondRadio = secondItem.getByRole("radio", { name: secondTitle });
  await expect(firstRadio).toBeVisible();
  await expect(secondRadio).toBeVisible();
  await firstRadio.check();
  await expect(firstRadio).toBeChecked();
  // Pflicht erfüllt: Zähler verschwindet ehrlich.
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toHaveCount(0);
  await secondRadio.check();
  await expect(secondRadio).toBeChecked();
  // Exklusivität je Segment: die erste Auswahl fällt automatisch — und das
  // Pflicht-Gate zählt den offenen Pflicht-Punkt wieder ehrlich mit.
  await expect(firstRadio).not.toBeChecked();
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toBeVisible();
  await firstRadio.check();
  await expect(firstRadio).toBeChecked();
  await expect(secondRadio).not.toBeChecked();
  await expect(page.getByText("Noch 1 Pflichtpunkt offen.", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const firstReloaded = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.1") });
  const secondReloaded = page.locator("li").filter({ has: page.getByLabel("Punkt-Name 1.2") });
  await expect(firstReloaded.getByRole("radio", { name: firstTitle })).toBeChecked();
  await expect(secondReloaded.getByRole("radio", { name: secondTitle })).not.toBeChecked();
  await expect(page.getByText("Punkte: 1/3", { exact: true })).toBeVisible();

  // Viewer (lesend): Radios sichtbar, aber deaktiviert, ohne Typ-Editor.
  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  const viewerFirst = page.locator("li", { hasText: firstTitle });
  await expect(viewerFirst.getByRole("radio", { name: firstTitle })).toBeChecked();
  await expect(viewerFirst.getByRole("radio", { name: firstTitle })).toBeDisabled();
  await expect(viewerFirst.getByLabel("Typ")).toHaveCount(0);
  await expect(page.getByText("Punkte: 1/3", { exact: true })).toBeVisible();

  await expectNoWcagAaAxeViolations(page, "F7-02D-Radio");

  expect(errors, "Browser-Konsole und Page-Errors der Radio-Auswahl").toEqual([]);
});
