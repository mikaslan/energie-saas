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
 * F11-03d Offline-Stopp online gestarteter Timer — Chromium-E2E
 * (isolierter Workspace). Online gestartete Stoppuhr lässt sich offline
 * stoppen (wartender Intent mit Offline-Instant statt Fehlschlag); online
 * übernimmt der Sync exakt diesen Instant (kein Phantom-Doppel, keine
 * Serverzeit-Ratung) — genau einmal.
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
      throw new Error(`Der private F11-03d-E2E-State ist unvollständig (${key}).`);
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

test("F1103D-E2E-01: Online-Start, Offline-Stopp mit Offline-Instant, genau ein Sync", async ({
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
  await leadForm.getByLabel("Name *").fill("E2E Offline-Stopp");
  await leadForm.getByLabel("Telefon").fill("0151 45678907");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectId = new URL(page.url()).pathname.split("/").pop() ?? "";

  await page.goto(`${page.url()}/zeiterfassung`);
  await expect(page.getByRole("heading", { name: "Stoppuhr", exact: true })).toBeVisible();

  // Online starten (Server-Timer läuft).
  await page.getByRole("button", { name: "Stoppuhr starten", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft" })).toBeVisible();
  const runningSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Stoppuhr läuft" }),
  });
  await runningSection.getByLabel("Arbeitszeit (Minuten)").fill("1");

  // Offline stoppen → wartender Intent mit Offline-Instant (kein Server-Call).
  await context.setOffline(true);
  await runningSection.getByRole("button", { name: "Stoppen", exact: true }).click();
  const pending = page.getByTestId("timer-offline-stop-pending");
  await expect(pending).toBeVisible();
  await expect(page.getByTestId("timer-offline-notice")).toContainText("Offline gestoppt");

  // Zeit verstreichen lassen (weiter offline): Beweist, dass der Sync den
  // Offline-Instant übernimmt statt der Serverzeit beim Sync.
  await page.waitForTimeout(6_000);

  // Online → Sync übernimmt exakt den Offline-Instant, genau einmal.
  await context.setOffline(false);
  const syncStartedAt = Date.now();
  await pending.getByTestId("timer-offline-stop-sync").click();
  await expect(page.getByTestId("timer-offline-notice")).toContainText(
    "Offline-Stopp übernommen",
    { timeout: 15_000 },
  );
  await expect(pending).toHaveCount(0);

  const entriesSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Zeiteinträge", exact: true }),
  });
  const durationRows = entriesSection.locator("li", { hasText: "1 Min." });
  await expect(durationRows).toHaveCount(1, { timeout: 15_000 });

  // DB-Read-back: genau EIN gestoppter Eintrag mit 1 Minute; end_at ist der
  // Offline-Stopp (deutlich vor Sync-Beginn) — keine Serverzeit-Ratung.
  await expect.poll(
    async () => {
      const rows = await readProjectEntries(workspaceId, projectId);
      return rows.length === 1
        && rows[0]!.workingTimeMinutes === 1
        && rows[0]!.endAt !== null;
    },
    { message: "Genau ein synchronisierter Offline-Stopp mit 1 Minute.", timeout: 15_000 },
  ).toBe(true);
  const rows = await readProjectEntries(workspaceId, projectId);
  const endAtMs = new Date(rows[0]!.endAt as unknown as string).getTime();
  expect(endAtMs).toBeLessThan(syncStartedAt - 3_000);

  expect(errors, "Browser-Konsole und Page-Errors der Offline-Stopp-Grenze").toEqual([]);
});

async function readProjectEntries(
  workspaceId: string,
  projectId: string,
): Promise<Array<{ workingTimeMinutes: number; endAt: string | null }>> {
  const pool = createDrainTrackedPool({ connectionString: state().databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select working_time_minutes as "workingTimeMinutes", end_at as "endAt"
         from time_entry
        where workspace_id = $1::uuid
          and project_id = $2::uuid
        order by created_at asc, id asc`,
      [workspaceId, projectId],
    );
    return result.rows as Array<{ workingTimeMinutes: number; endAt: string | null }>;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}
