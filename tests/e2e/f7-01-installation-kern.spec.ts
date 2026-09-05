import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F7.1 Installation Kern Slice A — Chromium-E2E.
 *
 * Abdeckung: Direktanlage per UI auf der Projektseite (Phasenwechsel im
 * DB-Read-back) + Abschluss per UI (Status/Datum sichtbar).
 * Service-Kanten (Conflict, Scope-Miss, Doppel-Abschluss, Isolation)
 * decken die Vitest-DB-Tests tests/db/f701-installation-kern.test.ts ab.
 * Eigenes W3-Projekt: keine Kopplung an andere Specs (f7-03-Lehre).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  f71ProjectId: string;
  editorEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "f71ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7.1-E2E-State ist unvollständig.");
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

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

type InstallationRow = {
  status: string;
  source: string;
  completedAt: string | null;
  phase: string;
};

async function readInstallation(): Promise<InstallationRow | null> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select i.status as status, i.source as source,
              i.completed_at as "completedAt", p.phase as phase
         from installation i
         join project p
           on p.workspace_id = i.workspace_id
          and p.id = i.project_id
        where i.workspace_id = $1::uuid
          and i.project_id = $2::uuid`,
      [data.w3WorkspaceId, data.f71ProjectId],
    );
    return (result.rows[0] as InstallationRow | undefined) ?? null;
  } finally {
    await pool.end();
  }
}

function installationSection(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Installation", exact: true }),
  });
}

test("F7.1-E2E-01: Direktanlage — Sektion, Phasenwechsel im Read-back", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f71ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = installationSection(page);
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "Installation direkt anlegen", exact: true }).click();
  await expect(section.getByText("Installation angelegt")).toBeVisible();
  await expect(section.getByText("Aktiv", { exact: true })).toBeVisible();

  await expect.poll(async () => readInstallation(), {
    message: "Die Installation muss in der DB sichtbar sein.",
    timeout: 15_000,
  }).toMatchObject({ status: "active", source: "direct", phase: "installation" });

  expect(errors, "Browser-Konsole und Page-Errors der Projekt-Grenze").toEqual([]);
});

test("F7.1-E2E-02: Abschluss — Status und Datum sichtbar", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f71ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = installationSection(page);
  await expect(section).toBeVisible();
  // E2E-01 hat die Installation angelegt (Datei-Reihenfolge, frische DB).
  await section.getByRole("button", { name: "Installation abschließen", exact: true }).click();
  await expect(section.getByText("Installation abgeschlossen.")).toBeVisible();
  await expect(section.getByText("Abgeschlossen", { exact: true })).toBeVisible();

  await expect.poll(async () => readInstallation(), {
    message: "Der Abschluss muss in der DB sichtbar sein.",
    timeout: 15_000,
  }).toMatchObject({ status: "completed" });
  const row = await readInstallation();
  expect(row?.completedAt).not.toBeNull();

  expect(errors, "Browser-Konsole und Page-Errors der Projekt-Grenze").toEqual([]);
});
