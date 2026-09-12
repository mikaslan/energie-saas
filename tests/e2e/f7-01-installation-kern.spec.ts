import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

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
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select i.status as status, i.source as source,
              i.completed_at as "completedAt",
              i.handover_by_name as "handoverByName", p.phase as phase
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
    await endPoolAndWaitForClientRemoval(pool);
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

test("F7-05-E2E-01: Abnahme — Wer/Wann/Notiz sichtbar", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f71ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = installationSection(page);
  await expect(section).toBeVisible();
  // Eigenständig: Anlage + Abschluss falls noch nicht geschehen
  // (Vollsuite teilt sich die frische DB in Datei-Reihenfolge).
  const createButton = section.getByRole("button", { name: "Installation direkt anlegen", exact: true });
  if (await createButton.count() > 0) {
    await createButton.click();
    await expect(section.getByText("Installation angelegt")).toBeVisible();
  }
  const completeButton = section.getByRole("button", { name: "Installation abschließen", exact: true });
  if (await completeButton.count() > 0) {
    await completeButton.click();
    await expect(section.getByText("Installation abgeschlossen.")).toBeVisible();
  }
  await section.getByLabel("Abgenommen durch").fill("Familie Berger");
  await section.getByLabel("Notiz (optional)").fill("Zähler läuft.");
  await section.getByRole("button", { name: "Abnahme speichern", exact: true }).click();
  await expect(section.getByText("Abnahme festgehalten.")).toBeVisible();
  // Exakt: Der Abnahme-Verlauf (F7-14) zeigt denselben Namen als längeren
  // Listeneintrag („Abnahme 1: …“) — der Kopf bleibt die exakte Fundstelle.
  await expect(section.getByText("Familie Berger", { exact: true })).toBeVisible();
  await expect(section.getByText("Zähler läuft.", { exact: true })).toBeVisible();

  await expect.poll(async () => readInstallation(), {
    message: "Die Abnahme muss in der DB sichtbar sein.",
    timeout: 15_000,
  }).toMatchObject({ handoverByName: "Familie Berger" });

  expect(errors, "Browser-Konsole und Page-Errors der Abnahme-Grenze").toEqual([]);
});

async function readHandoverNames(): Promise<string[]> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select h.by_name as "byName"
         from installation_handover h
         join installation i
           on i.workspace_id = h.workspace_id
          and i.id = h.installation_id
        where h.workspace_id = $1::uuid
          and i.project_id = $2::uuid
        order by h.recorded_at asc, h.id asc`,
      [data.w3WorkspaceId, data.f71ProjectId],
    );
    return result.rows.map((row) => (row as { byName: string }).byName);
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F714-E2E-01: Abnahme-Verlauf — zwei Abnahmen bleiben beide sichtbar", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f71ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = installationSection(page);
  await expect(section).toBeVisible();
  // Eigenständig: Anlage + Abschluss falls noch nicht geschehen
  // (Vollsuite teilt sich die frische DB in Datei-Reihenfolge).
  const createButton = section.getByRole("button", { name: "Installation direkt anlegen", exact: true });
  if (await createButton.count() > 0) {
    await createButton.click();
    await expect(section.getByText("Installation angelegt")).toBeVisible();
  }
  const completeButton = section.getByRole("button", { name: "Installation abschließen", exact: true });
  if (await completeButton.count() > 0) {
    await completeButton.click();
    await expect(section.getByText("Installation abgeschlossen.")).toBeVisible();
  }
  await section.getByLabel("Abgenommen durch").fill("Verlauf A");
  await section.getByLabel("Notiz (optional)").fill("Notiz A.");
  await section.getByRole("button", { name: "Abnahme speichern", exact: true }).click();
  await expect(section.getByText("Abnahme festgehalten.")).toBeVisible();

  await section.getByLabel("Abgenommen durch").fill("Verlauf B");
  await section.getByLabel("Notiz (optional)").fill("");
  await section.getByRole("button", { name: "Abnahme speichern", exact: true }).click();
  await expect(section.getByText("Abnahme festgehalten.")).toBeVisible();

  // Verlauf zeigt BEIDE Abnahmen (plus ggf. frühere aus F7-05-E2E-01).
  const history = section.getByTestId("handover-history");
  await expect(history).toBeVisible();
  await expect(history.getByText("Verlauf A")).toBeVisible();
  await expect(history.getByText("Verlauf B")).toBeVisible();
  await expect(history.getByText("Notiz A.")).toBeVisible();

  // DB-Read-back: beide Namen im Verlauf (Reihenfolge egal — Datei-
  // Reihenfolge der Vollsuite legt ggf. F7-05-Einträge davor).
  await expect.poll(async () => readHandoverNames(), {
    message: "Beide Abnahmen müssen im Verlauf der DB sichtbar sein.",
    timeout: 15_000,
  }).toEqual(expect.arrayContaining(["Verlauf A", "Verlauf B"]));

  expect(errors, "Browser-Konsole und Page-Errors der Abnahme-Grenze").toEqual([]);
});

test("F13-01-E2E-01: Servicevorgang anlegen → starten → erledigen", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f71ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = page.locator('[data-service-cases="true"]');
  await expect(section).toBeVisible();
  await section.getByLabel("Titel").fill("F1301-Wechselrichter prüfen");
  await section.getByRole("button", { name: "Vorgang anlegen", exact: true }).click();
  await expect(section.getByText("Servicevorgang angelegt.")).toBeVisible();
  await expect(section.getByText("F1301-Wechselrichter prüfen")).toBeVisible();
  await expect(section.getByText("Offen", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: "Starten", exact: true }).click();
  await expect(section.getByText("Status geändert.")).toBeVisible();
  await expect(section.getByText("In Arbeit", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: "Erledigen", exact: true }).click();
  await expect(section.getByText("Erledigt", { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Service-Grenze").toEqual([]);
});
