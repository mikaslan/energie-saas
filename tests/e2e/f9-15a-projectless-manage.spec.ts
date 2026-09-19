import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-15a projektlos Edit/Archiv/Freigabe — Chromium-E2E.
 * Bindung: `docs/spec/F9-15-projektlos-folge.md` (Track R1a).
 * Seed: EIGENER isolierter Workspace (NIEMALS W3). Erwartung: Eintrag
 * per UI anlegen → Kommentar editieren → freigeben → Entsperren →
 * archivieren (jeweils Feedback + UI-Folgezustand).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
  editorIdentityId: string;
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
    "databaseUrl",
    "serverLogPath",
    "editorEmail",
    "editorIdentityId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9-15a-E2E-State ist unvollständig.");
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
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte F9-15a-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.goto(`/login?${new URLSearchParams({ next: expectedPath }).toString()}`);
  await page.waitForURL((url) => url.pathname === "/login");

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
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

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function seedIsolatedWorkspace(): Promise<{ workspaceId: string }> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email = $1",
      [data.editorEmail],
    );
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!editorId) throw new Error("F9-15a-E2E: Editor-Identität fehlt.");
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        workspaceId,
        "F9-15a isolierter Manage-Workspace",
      ]);
      await client.query(
        "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
        [workspaceId],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb)`,
        [workspaceId, editorId],
      );
    } finally {
      client.release();
    }
    return { workspaceId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F915a-E2E-01: projektlosen Eintrag editieren, freigeben, entsperren, archivieren", async ({ page }) => {
  test.setTimeout(300_000);
  const data = state();
  const { workspaceId } = await seedIsolatedWorkspace();
  const stamp = randomUUID().slice(0, 8);
  const comment = `F915a Verwalten ${stamp}`;
  const edited = `F915a Geändert ${stamp}`;

  const path = `/w/${workspaceId}/zeiterfassung-ohne-projekt`;
  await loginWithRealOtp(page, data.editorEmail, path);
  await expect(page.getByRole("heading", { name: "Zeiterfassung ohne Projekt", level: 1 })).toBeVisible();
  await page.getByLabel("Ereignistyp").selectOption({ label: "Travel" });
  await page.getByLabel("Beginn").fill("2026-09-06T08:00");
  await page.getByLabel("Ende").fill("2026-09-06T10:00");
  await page.getByLabel("Arbeitszeit (Minuten)").fill("120");
  await page.getByLabel("Kommentar").fill(comment);
  await page.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();

  const row = page.locator("li", { hasText: comment });
  await expect(row).toBeVisible();

  // Editieren.
  await row.getByRole("button", { name: "Bearbeiten" }).click();
  await row.getByLabel("Kommentar").fill(edited);
  await row.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Zeiteintrag aktualisiert.", { exact: true })).toBeVisible();
  await expect(page.getByText(edited, { exact: true })).toBeVisible();

  // Freigeben → Entsperren.
  const editedRow = page.locator("li", { hasText: edited });
  await editedRow.getByRole("button", { name: "Freigeben" }).click();
  await expect(page.getByText("Zeiteintrag freigegeben.", { exact: true })).toBeVisible();
  await expect(editedRow.getByRole("button", { name: "Entsperren" })).toBeVisible();
  await editedRow.getByRole("button", { name: "Entsperren" }).click();
  await expect(page.getByText("Freigabe aufgehoben.", { exact: true })).toBeVisible();

  // Archivieren → Zeile weg.
  await editedRow.getByRole("button", { name: "Archivieren" }).click();
  await expect(page.getByText("Zeiteintrag archiviert.", { exact: true })).toBeVisible();
  await expect(page.locator("li", { hasText: edited })).toHaveCount(0);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoHorizontalOverflow(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F9-15a-Manage");
});
