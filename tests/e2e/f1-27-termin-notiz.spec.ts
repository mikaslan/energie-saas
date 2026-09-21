import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F1-27 Termin-Notiz-Übernahme („Als Notiz übernehmen") — Chromium-E2E (RED).
 *
 * Spec: docs/spec/F1-27-appointment-note-prefill.md (verbindlich).
 * E2E-01 (rot — beide Buttons fehlen noch): Editor legt einen Termin an
 * (Titel/Beginn/Ende/Ort), übernimmt ihn per „Als Notiz übernehmen" in den
 * Notiz-Dialog (Prefill-Zitat: Titel, Datum/Zeit Berlin-Wanduhr, Ort, Bezug
 * #project-appointments), ergänzt Text, speichert (normales create_note,
 * Revision 1) und findet die Notiz mit Zitat in der Projektakte. Danach führt
 * derselbe Button im Plantafel-Drawer (?event=) per ?note=prefill-<id> in die
 * Akte (Prefill da). Rollen: ohne note.write (Viewer) kein Button; unlesbarer
 * Termin → ehrlich leerer Dialog. Keine Konsolen-/Page-Fehler.
 *
 * Selektoren (alle existierend, verifiziert im Code):
 * - Termindialog: section#project-appointments, Button „Termin anlegen" /
 *   „Bearbeiten", Dialog-Überschrift „Termin anlegen"/„Termin bearbeiten",
 *   Labels Titel/Typ/Kalender/Beginn/Ende/Ort, Button „Speichern"
 *   (appointment-dialog.tsx, appointment-calendar-section.tsx).
 * - Notiz-Dialog: section#project-notes, Button „Notiz anlegen", Dialog mit
 *   Überschrift „Notiz anlegen", Textbox „Notiztext", Submit „Notiz anlegen",
 *   Notiz-Artikel article#project-note-<id> mit „Stand <rev>"-Chip
 *   (note-editor-dialog.tsx, project-notes-section.tsx).
 * - Plantafel-Drawer: ?week=<montag>&event=<id>, section[aria-label=
 *   „Termindetails"], Überschrift = Termintitel (plantafel/page.tsx).
 * Neue testids: KEINE nötig — beide Übernahme-Buttons werden per
 * Accessible-Name „Als Notiz übernehmen" gefunden (Drawer: Button ODER Link,
 * da das Element die Spec nicht festlegt). Kein planning-board-note-*-testid
 * eingeführt.
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f93ProjectId: string;
  editorEmail: string;
  viewerEmail: string;
};

const CALENDAR_NAME = "F1-27 E2E Kalender";
const ADOPT_BUTTON = "Als Notiz übernehmen";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f93ProjectId",
    "editorEmail",
    "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F1-27-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function berlinTomorrow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 36 * 3600 * 1000));
}

function mondayOf(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  const noonUtc = Date.UTC(year!, month! - 1, day!, 12);
  const sinceMonday = (new Date(noonUtc).getUTCDay() + 6) % 7;
  return new Date(noonUtc - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

function germanDate(dateIso: string): string {
  const [year, month, day] = dateIso.split("-");
  return `${day}.${month}.${year}`;
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function seedTenancyCalendar(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select gen_random_uuid(), $1::uuid, $3, 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = $3
          )
        limit 1`,
      [data.w3WorkspaceId, data.editorEmail, CALENDAR_NAME],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function findAppointmentIdByTitle(title: string): Promise<string> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const user = await client.query<{ id: string }>(
      `select id from user_identity where email = $1 limit 1`,
      [data.editorEmail],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("Editor-User für F1-27 fehlt.");
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [userId]);
    const found = await client.query<{ id: string }>(
      `select id from project_appointment
        where workspace_id = $1::uuid and title = $2 limit 1`,
      [data.w3WorkspaceId, title],
    );
    await client.query("commit");
    const id = found.rows[0]?.id;
    if (!id) throw new Error("F1-27 E2E-Termin wurde nicht angelegt.");
    return id;
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test("F1-27-E2E-01: Als Notiz übernehmen — Prefill, Plantafel-Link, Rollen", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackErrors(page);
  await seedTenancyCalendar();

  const stamp = Date.now();
  const appointmentTitle = `F1-27 E2E Termin ${stamp}`;
  const appointmentPlace = `Musterstraße 1, Berlin ${stamp}`;
  const ownAddition = `Eigene Ergänzung ${stamp}`;
  const date = berlinTomorrow();
  const monday = mondayOf(date);
  const datePattern = new RegExp(
    `${escapeRegExp(germanDate(date))}|${escapeRegExp(date)}`,
    "u",
  );
  const aktePath = `/w/${data.w3WorkspaceId}/anfragen/${data.f93ProjectId}`;

  // 1. Editor legt den Termin per UI an (Titel/Beginn/Ende/Ort).
  await page.goto(aktePath);
  await loginWithRealOtp(page, data.editorEmail, aktePath);

  const appointments = page.locator("section#project-appointments");
  await expect(appointments).toHaveAttribute("data-appointments-hydrated", "true");
  await appointments.getByRole("button", { name: "Termin anlegen" }).click();
  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByRole("heading", { name: "Termin anlegen" })).toBeVisible();
  await createDialog.getByLabel("Titel").fill(appointmentTitle);
  await createDialog.getByLabel("Typ").selectOption("on_site");
  await createDialog.getByLabel("Kalender").selectOption({ label: CALENDAR_NAME });
  await createDialog.getByLabel("Beginn").fill(`${date}T10:00`);
  await createDialog.getByLabel("Ende", { exact: true }).fill(`${date}T11:00`);
  await createDialog.getByLabel("Ort", { exact: true }).fill(appointmentPlace);
  const editorBox = createDialog.getByRole("checkbox", { name: data.editorEmail });
  if ((await editorBox.count()) > 0) await editorBox.check();
  await createDialog.getByRole("button", { name: "Speichern" }).click();
  await expect(createDialog).toHaveCount(0);
  const appointmentArticle = appointments
    .locator("article")
    .filter({ hasText: appointmentTitle });
  await expect(appointmentArticle).toBeVisible();

  // 2. „Als Notiz übernehmen" öffnet den Notiz-Dialog mit Prefill-Zitat
  // (ROT: Button fehlt).
  await appointmentArticle.getByRole("button", { name: "Bearbeiten" }).click();
  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByRole("heading", { name: "Termin bearbeiten" })).toBeVisible();
  await editDialog.getByRole("button", { name: ADOPT_BUTTON }).click();
  const noteDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Notiz anlegen" }) });
  await expect(noteDialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
  const prefillBox = noteDialog.getByRole("textbox", { name: "Notiztext" });
  await expect(prefillBox).toContainText(appointmentTitle);
  await expect(prefillBox).toContainText(datePattern);
  await expect(prefillBox).toContainText("10:00");
  await expect(prefillBox).toContainText(appointmentPlace);
  await expect(prefillBox).toContainText("project-appointments");

  // 3. Prefill ist editierbar; Speichern = normales create_note (Revision 1).
  await prefillBox.click();
  await prefillBox.press("End");
  await prefillBox.pressSequentially(` ${ownAddition}`);
  await noteDialog.getByRole("button", { name: "Notiz anlegen" }).click();
  await expect(noteDialog).toHaveCount(0);

  // 4. Notiz mit Zitat steht in der Projektakte (persistent nach Reload).
  const notes = page.locator("section#project-notes");
  const noteArticle = notes.locator("article").filter({ hasText: appointmentTitle });
  await expect(noteArticle).toContainText(appointmentTitle);
  await expect(noteArticle).toContainText(appointmentPlace);
  await expect(noteArticle).toContainText(ownAddition);
  await expect(noteArticle).toContainText("project-appointments");
  await expect(noteArticle.getByText("Stand 1")).toBeVisible();
  await page.reload();
  await expect(
    page.locator("section#project-notes article").filter({ hasText: appointmentTitle }),
  ).toBeVisible();

  // 5. Plantafel-Drawer: Button führt mit ?note=prefill-<id> in die Akte
  // (ROT: Button fehlt). Prefill ist dort sichtbar.
  const appointmentId = await findAppointmentIdByTitle(appointmentTitle);
  const drawerUrl = `/w/${data.w3WorkspaceId}/plantafel?week=${monday}&event=${appointmentId}`;
  await page.goto(drawerUrl);
  const drawer = page.locator("section[aria-label='Termindetails']");
  await expect(drawer.getByRole("heading", { name: appointmentTitle })).toBeVisible();
  const drawerAdopt = drawer
    .getByRole("button", { name: ADOPT_BUTTON })
    .or(drawer.getByRole("link", { name: ADOPT_BUTTON }));
  await drawerAdopt.click();
  await page.waitForURL(
    (url) =>
      url.pathname === aktePath
      && url.searchParams.get("note") === `prefill-${appointmentId}`,
  );
  const prefillDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Notiz anlegen" }) });
  await expect(prefillDialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
  await expect(
    prefillDialog.getByRole("textbox", { name: "Notiztext" }),
  ).toContainText(appointmentTitle);
  await prefillDialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(prefillDialog).toHaveCount(0);

  // 6. Rolle ohne note.write (Viewer): kein Übernahme-Button, kein Dialog.
  await page.context().clearCookies();
  await page.goto(drawerUrl);
  await loginWithRealOtp(page, data.viewerEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  await page.goto(drawerUrl);
  const viewerDrawer = page.locator("section[aria-label='Termindetails']");
  await expect(viewerDrawer.getByRole("heading", { name: appointmentTitle })).toBeVisible();
  await expect(viewerDrawer.getByRole("button", { name: ADOPT_BUTTON })).toHaveCount(0);
  await expect(viewerDrawer.getByRole("link", { name: ADOPT_BUTTON })).toHaveCount(0);
  await page.goto(aktePath);
  await expect(
    page.locator("section#project-notes").getByRole("button", { name: "Notiz anlegen" }),
  ).toHaveCount(0);
  await page.goto(`${aktePath}?note=prefill-${appointmentId}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 7. Unlesbarer Termin (fremde ID): ehrlich leerer Dialog, kein Crash.
  await page.context().clearCookies();
  await page.goto(aktePath);
  await loginWithRealOtp(page, data.editorEmail, aktePath);
  await page.goto(`${aktePath}?note=prefill-${randomUUID()}`);
  const emptyDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Notiz anlegen" }) });
  await expect(emptyDialog.getByRole("heading", { name: "Notiz anlegen" })).toBeVisible();
  await expect(emptyDialog.getByRole("textbox", { name: "Notiztext" })).toHaveText(/^\s*$/u);
  await emptyDialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(emptyDialog).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Termin-Notiz-Übernahme").toEqual([]);
});
