import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F10-09 Portal-FAQ je Installationsstand — Chromium-E2E (isolierter
 * Workspace). Editor setzt die FAQ für laufende Installationen in den
 * Einstellungen → Portal-Installation-Tab zeigt sie unter dem Stand;
 * Entfernen blendet den FAQ-Block wieder aus.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F10-09-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedActiveInstallation(workspaceId: string, projectId: string): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into installation (workspace_id, project_id, source, status)
       values ($1::uuid, $2::uuid, 'direct', 'active')
       on conflict (workspace_id, project_id) do update set status = 'active'`,
      [workspaceId, projectId],
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

test("F10-09-E2E-01: FAQ erreicht das Portal und blendet sich aus", async ({ page }) => {
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

  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Portal-FAQ");
  await leadForm.getByLabel("Telefon").fill("0151 45678909");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(projectId).toMatch(/^[0-9a-f-]+$/u);
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  await seedActiveInstallation(workspaceId, projectId);

  const stamp = Date.now();
  const customFaq = `Die Montage läuft planmäßig ${stamp}.`;
  const settingsPath = `/w/${workspaceId}/einstellungen/portal-status`;
  await page.goto(settingsPath);
  const faqRow = page.getByTestId("portal-status-faqs").locator("section").filter({
    has: page.getByRole("heading", { name: "Laufende Installation", exact: true }),
  });
  await faqRow.getByLabel(/FAQ für laufende installation/i).fill(customFaq);
  await faqRow.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(faqRow.getByText("FAQ gespeichert.")).toBeVisible();

  await page.goto(projectPath);
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(`${tokenPath}?tab=installation`);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gut zu wissen", exact: true })).toBeVisible();
  await expect(page.getByText(customFaq, { exact: true })).toBeVisible();

  await page.goto(settingsPath);
  const resetRow = page.getByTestId("portal-status-faqs").locator("section").filter({
    has: page.getByRole("heading", { name: "Laufende Installation", exact: true }),
  });
  await resetRow.getByRole("button", { name: "FAQ entfernen", exact: true }).click();
  await expect(resetRow.getByText("FAQ entfernt.")).toBeVisible();

  await page.goto(`${tokenPath}?tab=installation`);
  await expect(page.getByRole("heading", { name: "Gut zu wissen", exact: true })).toHaveCount(0);
  expect(await page.getByText(customFaq, { exact: true }).count()).toBe(0);

  expect(errors, "Browser-Konsole und Page-Errors der Portal-Grenze").toEqual([]);
});
