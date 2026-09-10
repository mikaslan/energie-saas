import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state,
} from "./m1-11g-fixture";

// DASH-01 Workspace-Übersicht (eigene Daten, ESTIMATE-Layout). Isolierter
// Workspace ohne Anfragen/Aufgaben: Abschnitte rendern mit ehrlichen
// Leerzuständen, keine erfundenen Zahlen.

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
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  await expect(page.getByLabel("Sechsstelliger Code")).toBeVisible();
  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
  await page.getByLabel("Sechsstelliger Code").fill(otp);
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

test("DASH-01: leere Workspace-Übersicht rendert ehrliche Leerzustände", async ({ page }) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);

  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
  const dashboard = page.locator('[data-dashboard="true"]');
  await expect(dashboard).toBeVisible();
  const pipeline = dashboard.locator('[data-dashboard-pipeline="true"]');
  await expect(pipeline).toBeVisible();
  await expect(pipeline.getByText("Keine offenen Anfragen.")).toBeVisible();
  const overdue = dashboard.locator('[data-dashboard-overdue="true"]');
  await expect(overdue).toBeVisible();
  await expect(overdue.getByText("Nichts überfällig.")).toBeVisible();
  const today = dashboard.locator('[data-dashboard-today="true"]');
  await expect(today).toBeVisible();
  await expect(today.getByText("Heute nichts fällig.")).toBeVisible();
  const closures = dashboard.locator('[data-dashboard-closures="true"]');
  await expect(closures).toBeVisible();
  await expect(closures.getByText("Noch keine Abschlüsse.")).toBeVisible();
  const invoices = dashboard.locator('[data-dashboard-invoices="true"]');
  await expect(invoices).toBeVisible();
  await expect(invoices.getByText("0,00 €").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Anfragen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aufgaben" })).toBeVisible();
});
