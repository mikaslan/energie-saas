import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7-04c Segment-Outbox — Chromium-E2E.
 * Offline getippter Segmentabschluss landet in der Outbox (statt
 * Fehlschlag) und wird online genau einmal synchronisiert; nie
 * überschrieben, keine Browser-Fehler, Axe sauber.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  w3WorkspaceId: string;
  f704cProjectId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
  mainProjectId: string;
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
    "w3WorkspaceId",
    "f704cProjectId",
    "adminEmail",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
    "mainProjectId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7-04c-E2E-State ist unvollständig.");
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

const f704cPath = (): string =>
  `/w/${state().w3WorkspaceId}/anfragen/${state().f704cProjectId}/checkliste`;

async function activateF704Installation(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query("begin");
    await pool.query(
      "select set_config('app.workspace_id', $1, true)",
      [data.w3WorkspaceId],
    );
    await pool.query(
      `update project
          set phase = 'installation', updated_at = statement_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid`,
      [data.w3WorkspaceId, data.f704cProjectId],
    );
    // Eigenes f704c-Projekt je Spec (kein Shared-Seed mehr).
    await pool.query(
      `insert into installation (workspace_id, project_id, source, status)
       values ($1::uuid, $2::uuid, 'direct', 'active')`,
      [data.w3WorkspaceId, data.f704cProjectId],
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F704C-E2E-01: Offline-Abschluss wird online genau einmal synchronisiert", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = f704cPath();
  await activateF704Installation();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await page.getByRole("button", { name: "Block hinzufügen" }).click();
  await page.getByLabel("Block-Name 1").fill("Montage");
  await page.getByRole("button", { name: "Segment hinzufügen" }).click();
  await page.getByLabel("Segment-Name").fill("Dachmontage");
  await page.getByRole("button", { name: "Punkt hinzufügen" }).click();
  await page.getByLabel("Punkt-Name 1.1").fill("Unterkonstruktion dokumentiert");
  await page.getByRole("checkbox", {
    name: "Unterkonstruktion dokumentiert",
    exact: true,
  }).check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 1).", { exact: true })).toBeVisible();

  const completeButton = page.getByRole("button", { name: /Dachmontage: Segment abschließen/u });
  await expect(completeButton).toBeEnabled();

  await context.setOffline(true);
  await completeButton.click();
  await expect(page.getByText("Offline gespeichert — wird synchronisiert, sobald du wieder online bist.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("segment-outbox-pending")).toBeVisible();
  await expect(page.getByText("Segment abgeschlossen (Version 2).", { exact: true })).toHaveCount(0);

  await context.setOffline(false);
  // Hintergrund-Sync nutzt seine eigene Meldung (kein Formular-Toast,
  // weil der Direkt-Call nicht durch useActionState läuft).
  await expect(page.getByText("Ein Offline-Abschluss wurde synchronisiert.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Segmentfortschritt: 1/1 (100 %)", { exact: true })).toBeVisible();
  await expect(page.getByTestId("segment-outbox-pending")).toHaveCount(0);

  await expectNoWcagAaAxeViolations(page, "F7-04c Segment-Outbox");
  expect(errors, "Browser-Konsole und Page-Errors der Segment-Outbox").toEqual([]);
});
