import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F11-03c Stoppuhr-Outbox — Chromium-E2E (isolierter Workspace).
 * Offline gestartete und gestoppte Stoppuhr landet als gemessenes Paar in
 * der Zeit-Outbox (statt Fehlschlag) und wird online genau einmal als
 * Eintrag synchronisiert (Replay-Guard, kein Duplikat).
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
      throw new Error(`Der private F11-03c-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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

test("F1103C-E2E-01: Offline-Stoppuhr wird online genau einmal synchronisiert", async ({
  page,
  context,
}) => {
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
  await leadForm.getByLabel("Name *").fill("E2E Zeit-Outbox");
  await leadForm.getByLabel("Telefon").fill("0151 45678906");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").pop() ?? "";

  await page.goto(`${page.url()}/zeiterfassung`);
  await expect(page.getByRole("heading", { name: "Stoppuhr", exact: true })).toBeVisible();

  const timerSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr", exact: true }),
  });

  // Offline starten → wartender Start statt Server-Call.
  await context.setOffline(true);
  await timerSection.getByRole("button", { name: "Stoppuhr starten", exact: true }).click();
  const pending = page.getByTestId("timer-offline-pending");
  await expect(pending).toBeVisible();
  await expect(page.getByTestId("timer-offline-notice")).toContainText("Offline gestartet");

  // Offline stoppen → Paar in der Zeit-Outbox.
  await pending.getByTestId("timer-offline-stop").click();
  await expect(page.getByTestId("timer-offline-notice")).toContainText("Offline gestoppt");

  // Online → Sync der F11-03b-Bahn, genau ein Eintrag mit 1 Minute
  // (Start/Stop liegen Sekunden auseinander).
  await context.setOffline(false);
  await expect(page.getByText("wurde synchronisiert")).toBeVisible({ timeout: 30_000 });
  const entriesSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Zeiteinträge", exact: true }),
  });
  // Eintragszeile (nicht die Kopf-Summe „Summe: 1 Min.“) zeigt die Dauer.
  const durationRows = entriesSection.locator("li", { hasText: "1 Min." });
  await expect(durationRows).toHaveCount(1);

  // DB-Read-back: genau EIN Eintrag mit genau 1 Arbeitsminute
  // (kein Duplikat aus Doppel-Sync).
  await expect.poll(
    async () => readProjectEntries(workspaceId, projectId),
    { message: "Genau ein synchronisierter Eintrag mit 1 Minute.", timeout: 15_000 },
  ).toEqual([{ workingTimeMinutes: 1 }]);

  expect(errors, "Browser-Konsole und Page-Errors der Outbox-Grenze").toEqual([]);
});

test("F1103C-E2E-02: Offline-Start wird online direkt replayt (ohne Outbox-Umweg)", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const data = state();

  const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
  const leadName = `F1103C ${workspaceId.slice(0, 8)}`;

  const leadsPath = `/w/${workspaceId}/anfragen`;
  await page.goto(leadsPath);
  await loginWithRealOtp(page, data.editorEmail, leadsPath);

  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill(leadName);
  await leadForm.getByLabel("Telefon").fill("0151 45678906");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").pop() ?? "";

  await page.goto(`${page.url()}/zeiterfassung`);
  await expect(page.getByRole("heading", { name: "Stoppuhr", exact: true })).toBeVisible();
  const timerSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr", exact: true }),
  });

  // Offline starten, dann wieder online gehen und stoppen: Das Paar
  // replayt direkt über die Server-Action (kein Sync-Banner nötig).
  await context.setOffline(true);
  await timerSection.getByRole("button", { name: "Stoppuhr starten", exact: true }).click();
  const pending = page.getByTestId("timer-offline-pending");
  await expect(pending).toBeVisible();
  await context.setOffline(false);

  await pending.getByTestId("timer-offline-stop").click();
  await expect(page.getByTestId("timer-offline-notice")).toContainText("übernommen", { timeout: 15_000 });

  const entriesSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Zeiteinträge", exact: true }),
  });
  const durationRows = entriesSection.locator("li", { hasText: "1 Min." });
  await expect(durationRows).toHaveCount(1, { timeout: 15_000 });

  await expect.poll(
    async () => readProjectEntries(workspaceId, projectId),
    { message: "Genau ein direkt replayter Eintrag mit 1 Minute.", timeout: 15_000 },
  ).toEqual([{ workingTimeMinutes: 1 }]);

  expect(errors, "Browser-Konsole und Page-Errors der Outbox-Grenze").toEqual([]);
});

async function readProjectEntries(
  workspaceId: string,
  projectId: string,
): Promise<Array<{ workingTimeMinutes: number }>> {
  const pool = createDrainTrackedPool({ connectionString: state().databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select working_time_minutes as "workingTimeMinutes"
         from time_entry
        where workspace_id = $1::uuid
          and project_id = $2::uuid
        order by created_at asc, id asc`,
      [workspaceId, projectId],
    );
    return result.rows as Array<{ workingTimeMinutes: number }>;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}
