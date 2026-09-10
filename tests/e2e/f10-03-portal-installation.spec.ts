import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F10-03 Installation-Tab — Chromium-E2E.
 *
 * Abgeschlossene Installation mit Abnahme (interne Namen/Notizen) per
 * SQL seeden + Portal-Link per UI → öffentlicher Link, Tab
 * „Installation" zeigt „Abgenommen am …", aber NIEMALS interne
 * Namen/Notizen. Eigenes f102-Projekt, Rerun-sicher per Upsert.
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const INTERNAL_NAME = "F1003-Interne-Abnehmerin";
const INTERNAL_NOTE = "F1003-Interne-Notiz — nie öffentlich";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f102ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10.3-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedCompletedInstallation(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into installation (
         workspace_id, project_id, source, status,
         completed_at, handover_at, handover_by_name, handover_note
       ) values (
         $1::uuid, $2::uuid, 'direct', 'completed',
         '2026-09-08T10:00:00.000Z'::timestamptz,
         '2026-09-09T10:00:00.000Z'::timestamptz, $3, $4
       )
       on conflict (workspace_id, project_id) do update set
         status = 'completed',
         completed_at = '2026-09-08T10:00:00.000Z'::timestamptz,
         handover_at = '2026-09-09T10:00:00.000Z'::timestamptz,
         handover_by_name = $3,
         handover_note = $4`,
      [data.w3WorkspaceId, data.f102ProjectId, INTERNAL_NAME, INTERNAL_NOTE],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
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

test("F10-03-E2E-01: Installation-Tab zeigt Abnahme ohne interne Namen", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await seedCompletedInstallation();
  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f102ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(tokenPath);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Installation", exact: true }).click();
  await expect(page.getByText("Abgenommen am 09.09.2026", { exact: true })).toBeVisible();
  await expect(page.getByText(INTERNAL_NAME, { exact: true })).toHaveCount(0);
  await expect(page.getByText(INTERNAL_NOTE, { exact: true })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Portal-Grenze").toEqual([]);
});
