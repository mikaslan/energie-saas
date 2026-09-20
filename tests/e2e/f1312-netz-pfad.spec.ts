import { readFileSync, statSync } from "node:fs";
import type { Pool } from "pg";
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
 * F13-12 Netzpfad-Vertiefung — Chromium-E2E (isolierter Workspace).
 * Projektakte: anlegen → Add-ons + Betreiber/Zähler speichern →
 * einreichen (Details-Sperre + Frist lesbar) → Rückfrage →
 * wiedereinreichen → genehmigen → Einspeisezusage → Stufe-2-Anfrage
 * anlegen → Fertigmeldung ohne 16 Fotos fail-closed abgewiesen →
 * 16 Uploads seeden → fertigmeldet → abgeschlossen.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
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
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1312-E2E-State ist unvollständig (${key}).`);
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

// F13-12 §2-Happy-Path: 16 Fertigmeldungs-Fotos als DB-Seed (1 Erst-Beleg
// + 15 Folge-Uploads, alle CHECK-konform). 16 echte Portal-Uploads per
// UI sind im E2E-Takt nicht sinnvoll abbildbar; der Guard zählt nur
// Zeilen (Erst-Beleg + uploads.length), kein Storage-Inhalt.
async function seedSixteenPhotos(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  projectId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId]);
    const found = await client.query<{ id: string }>(
      `select id from file_request
        where workspace_id = $1::uuid and project_id = $2::uuid
          and title = 'Netz-Fertigmeldungs-Fotos'
        limit 1`,
      [workspaceId, projectId],
    );
    const requestId = found.rows[0]?.id;
    if (!requestId) throw new Error("F1312-E2E: Stufe-2-Anfrage fehlt (Seed braucht UI-Anlage).");
    const sha = "ab".repeat(32);
    await client.query(
      `update file_request
          set status = 'hochgeladen',
              storage_key = 'e2e/f1312/foto-00.jpg',
              file_sha256 = $1,
              content_type = 'image/jpeg',
              byte_size = 1024,
              original_filename = 'foto-00.jpg',
              uploaded_at = statement_timestamp()
        where id = $2::uuid`,
      [sha, requestId],
    );
    for (let i = 1; i <= 15; i++) {
      const name = `foto-${String(i).padStart(2, "0")}.jpg`;
      await client.query(
        `insert into file_request_upload
           (workspace_id, project_id, file_request_id, storage_key, file_sha256,
            content_type, byte_size, original_filename, uploaded_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'image/jpeg', 1024, $6, statement_timestamp())`,
        [workspaceId, projectId, requestId, `e2e/f1312/${name}`, sha, name],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test("F1312-E2E-01: Netzpfad mit Rückfrage-Loop, Einspeisezusage, Foto-Guard", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Netzpfad F1312");
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  // Anlage + Datei-Slot-Vorgaben (§3 als Text lesbar).
  await expect(page.getByTestId("grid-registration-current")).toContainText("Noch keine Netzanmeldung");
  await page.getByTestId("grid-registration-create").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("In Vorbereitung");
  const slots = page.getByTestId("grid-registration-file-slots");
  await expect(slots).toContainText("Netz-Vollmacht");
  await expect(slots).toContainText("Netz-Fertigmeldungs-Fotos");

  // Details speichern und rundlesen.
  await page.getByTestId("grid-registration-operator").fill("Netze BW");
  await page.getByTestId("grid-registration-meter").fill("1EMH0012345678");
  await page.getByTestId("grid-registration-save").click();
  await expect(page.getByTestId("grid-registration-details-feedback")).toContainText("Angaben gespeichert.");
  await expect(page.getByTestId("grid-registration-current")).toContainText("Netze BW");

  // Add-ons (§5, eigenes Formular ohne Sperre) speichern und rundlesen.
  await page.getByTestId("grid-registration-addon-mastr").check();
  await page.getByTestId("grid-registration-addon-produkt").selectOption("pv");
  await page.getByTestId("grid-registration-addon-betrag").fill("4900");
  await page.getByTestId("grid-registration-addons-save").click();
  await expect(page.getByTestId("grid-registration-addons-feedback")).toContainText("Add-ons gespeichert.");
  await expect(page.getByTestId("grid-registration-addons")).toContainText("MaStR-Service");
  await expect(page.getByTestId("grid-registration-addons")).toContainText("PV-Anlage");

  // Einreichen → Details-Sperre (§6) + Frist (§4) lesbar.
  await page.getByTestId("grid-registration-to-eingereicht").click();
  await expect(page.getByTestId("grid-registration-transition-feedback")).toContainText("Status geändert.");
  await expect(page.getByTestId("grid-registration-current")).toContainText("Eingereicht");
  await expect(page.getByTestId("grid-registration-frozen-hint")).toBeVisible();
  await expect(page.getByTestId("grid-registration-operator")).toBeDisabled();
  await expect(page.getByTestId("grid-registration-due")).toContainText("Fertigmeldung fällig:");

  // Rückfrage-Loop: rueckfrage → wieder editierbar → wiedereinreichen.
  await page.getByTestId("grid-registration-to-rueckfrage").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("Rückfrage");
  await expect(page.getByTestId("grid-registration-frozen-hint")).toHaveCount(0);
  await expect(page.getByTestId("grid-registration-operator")).toBeEnabled();
  await page.getByTestId("grid-registration-to-eingereicht").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("Eingereicht");

  // Genehmigung → Einspeisezusage (§1-Kette).
  await page.getByTestId("grid-registration-to-genehmigt").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("Genehmigt");
  await page.getByTestId("grid-registration-to-einspeisezusage").click();
  await expect(page.getByTestId("grid-registration-current")).toContainText("Einspeisezusage");

  // Stufe-2-Sammelanfrage per Titel-Vorgabe anlegen (kein Automatismus).
  const fileSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(fileSection).toBeVisible();
  await fileSection.getByTestId("file-request-title").fill("Netz-Fertigmeldungs-Fotos");
  await fileSection.getByTestId("file-request-allow-many").check();
  await fileSection.getByTestId("file-request-create").click();
  await expect(fileSection.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );

  // Foto-Guard (§2): 0 < 16 Fotos → Fertigmeldung fail-closed abgewiesen.
  await page.getByTestId("grid-registration-to-fertiggemeldet").click();
  await expect(page.getByTestId("grid-registration-transition-feedback")).toContainText(
    "Dieser Übergang ist nicht zulässig.",
  );
  await expect(page.getByTestId("grid-registration-current")).toContainText("Einspeisezusage");

  // Happy-Path: 16 Uploads seeden → fertigmeldet → abgeschlossen.
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const projectId = new URL(page.url()).pathname.split("/").at(-1);
    if (!projectId) throw new Error("F1312-E2E-URL enthält kein Projekt.");
    await seedSixteenPhotos(pool, workspaceId, actorId, projectId);
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
  await page.getByTestId("grid-registration-to-fertiggemeldet").click();
  await expect(page.getByTestId("grid-registration-transition-feedback")).toContainText("Status geändert.");
  await expect(page.getByTestId("grid-registration-current")).toContainText("Fertig gemeldet");
  await page.getByTestId("grid-registration-to-abgeschlossen").click();
  await expect(page.getByTestId("grid-registration-transition-feedback")).toContainText("Status geändert.");
  await expect(page.getByTestId("grid-registration-current")).toContainText("Abgeschlossen");

  expect(errors, "Browser-Konsole und Page-Errors des F1312-Netzpfads").toEqual([]);
});
