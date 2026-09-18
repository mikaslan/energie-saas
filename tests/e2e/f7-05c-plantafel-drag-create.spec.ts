import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7.05c Plantafel Drag-to-create — Chromium-E2E.
 *
 * Seeding + OTP-Login nach F7-05-Muster (eigener E2E-Kalender,
 * M1-15-Actor-Kontext). Drag-Geste per Maus über Tageszellen einer
 * Mitgliedszeile; Anlage weiter über den bestehenden CAS-Pfad.
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f93ProjectId: string;
  editorEmail: string;
  viewerEmail: string;
};

const APPOINTMENT_TITLE = "F705-Planken-Termin";
const WEEK_MONDAY = "2026-06-08";
const DRAG_START = "2026-06-09";
const DRAG_END = "2026-06-11";
const SINGLE_DAY = "2026-06-10";
const PLUS_DAY = "2026-06-12";
const MULTI_TITLE = "F705c-Drag-Mehrtag";
const SINGLE_TITLE = "F705c-Drag-Eintag";
const PLUS_TITLE = "F705c-Plus-Fallback";

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
    throw new Error("Der private F7.05c-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

async function seedBoardAppointment(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const seed = await pool.connect();
  try {
    const membership = await seed.query<{ membership_id: string; user_id: string }>(
      `select m.id as membership_id, m.user_id
         from membership m
         join user_identity u on u.id = m.user_id
        where m.workspace_id = $1::uuid and u.email = $2
        limit 1`,
      [data.w3WorkspaceId, data.editorEmail],
    );
    const membershipId = membership.rows[0]?.membership_id;
    const userId = membership.rows[0]?.user_id;
    if (!membershipId || !userId) throw new Error("Editor-Membership für F7.05c fehlt.");
    await seed.query("begin");
    await seed.query("select pg_catalog.set_config('app.actor_id', $1, true)", [userId]);
    await seed.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select $1::uuid, $2::uuid, 'F7-05 E2E Kalender', 'tenancy', $3::uuid
        where not exists (
          select 1 from calendar
           where workspace_id = $2::uuid and name = 'F7-05 E2E Kalender'
        )`,
      [randomUUID(), data.w3WorkspaceId, userId],
    );
    const calendar = await seed.query<{ id: string }>(
      `select id from calendar where workspace_id = $1::uuid and name = 'F7-05 E2E Kalender' limit 1`,
      [data.w3WorkspaceId],
    );
    const calendarId = calendar.rows[0]?.id;
    if (!calendarId) throw new Error("F7-05 E2E-Kalender fehlt.");
    await seed.query(
      `insert into project_appointment (
         id, workspace_id, project_id, title, start_at, end_at,
         all_day, appointment_type, calendar_id, created_by
       )
       select $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz,
              false, 'on_site', $7::uuid, $8::uuid
        where not exists (
          select 1 from project_appointment
           where workspace_id = $2::uuid and title = $4
        )`,
      [
        randomUUID(),
        data.w3WorkspaceId,
        data.f93ProjectId,
        APPOINTMENT_TITLE,
        "2026-06-09T10:00:00+02:00",
        "2026-06-09T11:00:00+02:00",
        calendarId,
        userId,
      ],
    );
    const appointment = await seed.query<{ id: string }>(
      `select id from project_appointment
        where workspace_id = $1::uuid and title = $2 limit 1`,
      [data.w3WorkspaceId, APPOINTMENT_TITLE],
    );
    const appointmentId = appointment.rows[0]?.id;
    if (!appointmentId) throw new Error("F7-05 Seed-Termin fehlt.");
    await seed.query(
      `insert into project_appointment_attendee (workspace_id, appointment_id, membership_id)
       select $1::uuid, $2::uuid, $3::uuid
        where not exists (
          select 1 from project_appointment_attendee
           where workspace_id = $1::uuid and appointment_id = $2::uuid
             and membership_id = $3::uuid
        )`,
      [data.w3WorkspaceId, appointmentId, membershipId],
    );
    await seed.query("commit");
  } finally {
    seed.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
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
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
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

function boardUrl(data: E2EState): string {
  return `/w/${data.w3WorkspaceId}/plantafel?week=${WEEK_MONDAY}`;
}

async function editorMemberId(page: Page, data: E2EState): Promise<string> {
  const href = await page
    .getByRole("link", { name: `Termin am ${DRAG_START} für ${data.editorEmail} anlegen` })
    .getAttribute("href");
  const member = href === null ? null : new URL(href, "http://local").searchParams.get("member");
  if (!member) throw new Error("Editor-Membership-ID nicht aus ＋-Link lesbar.");
  return member;
}

async function dragCells(
  page: Page,
  memberId: string,
  fromDate: string,
  toDate: string,
): Promise<void> {
  const from = page.locator(`td[data-member="${memberId}"][data-date="${fromDate}"]`);
  const to = page.locator(`td[data-member="${memberId}"][data-date="${toDate}"]`);
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error("Drag-Zellen nicht vermessen.");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("F7-05c-E2E-01: Drag-Spanne navigiert mit create/member/end (E-01/E-02/E-06)", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  await seedBoardAppointment();

  const url = boardUrl(data);
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  const memberId = await editorMemberId(page, data);

  // E-01: Drag über 3 Zellen einer Zeile → create/member/end + vorbefülltes Formular.
  await dragCells(page, memberId, DRAG_START, DRAG_END);
  await page.waitForURL((target) => target.searchParams.get("create") === DRAG_START);
  {
    const current = new URL(page.url());
    expect(current.searchParams.get("create")).toBe(DRAG_START);
    expect(current.searchParams.get("member")).toBe(memberId);
    expect(current.searchParams.get("end")).toBe(DRAG_END);
  }
  const multiForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: `vom ${DRAG_START} bis ${DRAG_END}` }),
  });
  await expect(multiForm).toBeVisible();
  await expect(multiForm.getByLabel("Enddatum")).toHaveValue(DRAG_END);

  // E-02: Eintag-Drag → URL ohne &end= (＋-äquivalent).
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  await dragCells(page, memberId, SINGLE_DAY, SINGLE_DAY);
  await page.waitForURL((target) => target.searchParams.get("create") === SINGLE_DAY);
  {
    const current = new URL(page.url());
    expect(current.searchParams.get("create")).toBe(SINGLE_DAY);
    expect(current.searchParams.get("member")).toBe(memberId);
    expect(current.searchParams.get("end")).toBeNull();
  }
  await expect(page.locator("section").filter({
    has: page.getByRole("heading", { name: `Neuer Termin am ${SINGLE_DAY}` }),
  })).toBeVisible();

  // E-06: ESC bricht ab (keine Navigation, keine Auswahl).
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  {
    const cell = page.locator(`td[data-member="${memberId}"][data-date="${DRAG_START}"]`);
    const end = page.locator(`td[data-member="${memberId}"][data-date="${DRAG_END}"]`);
    const cellBox = await cell.boundingBox();
    const endBox = await end.boundingBox();
    if (!cellBox || !endBox) throw new Error("ESC-Drag-Zellen nicht vermessen.");
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
  expect(new URL(page.url()).searchParams.get("create")).toBeNull();
  await expect(page.locator("td.planning-board-drag-selected")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Neuer Termin/ })).toHaveCount(0);

  // E-06: Zeilenwechsel bricht ab (keine Navigation).
  const others = page.locator(`td[data-member]:not([data-member="${memberId}"])`);
  expect(await others.count(), "zweite Mitgliedszeile für Zeilenwechsel-Abbruch").toBeGreaterThan(0);
  {
    const cell = page.locator(`td[data-member="${memberId}"][data-date="${DRAG_START}"]`);
    const cellBox = await cell.boundingBox();
    const otherBox = await others.first().boundingBox();
    if (!cellBox || !otherBox) throw new Error("Zeilenwechsel-Zellen nicht vermessen.");
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2, { steps: 4 });
    await page.mouse.up();
  }
  expect(new URL(page.url()).searchParams.get("create")).toBeNull();
  await expect(page.getByRole("heading", { name: /Neuer Termin/ })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors des Drag-Pfads").toEqual([]);
});

test("F7-05c-E2E-02: Anlage aus Spanne, ＋-Fallback, Tastatur, Reload (E-03/E-04/E-07/E-08)", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackErrors(page);
  await seedBoardAppointment();

  const url = boardUrl(data);
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  const memberId = await editorMemberId(page, data);
  const basePath = `/w/${data.w3WorkspaceId}/plantafel`;
  const row = page.locator("tbody tr").filter({ hasText: data.editorEmail });

  // E-03: Mehrtag-Anlage aus der Drag-URL → Termin steht in der Tafelwoche.
  await page.goto(`${basePath}?week=${WEEK_MONDAY}&create=${DRAG_START}&member=${memberId}&end=${DRAG_END}`);
  const multiForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: `vom ${DRAG_START} bis ${DRAG_END}` }),
  });
  await expect(multiForm).toBeVisible();
  await multiForm.getByLabel("Titel").fill(MULTI_TITLE);
  await multiForm.getByLabel("Beginn (Uhrzeit)").fill("14:00");
  await multiForm.getByLabel("Ende (Uhrzeit)").fill("15:00");
  await multiForm.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(multiForm.getByText("Termin angelegt — er steht in der Tafelwoche.", { exact: true }))
    .toBeVisible();
  await page.goto(url);
  await expect(row.getByText(MULTI_TITLE, { exact: true }).first()).toBeVisible();

  // E-03: Eintag-Anlage → Termin steht in der Tafelwoche.
  await page.goto(`${basePath}?week=${WEEK_MONDAY}&create=${SINGLE_DAY}&member=${memberId}`);
  const singleForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: `Neuer Termin am ${SINGLE_DAY}` }),
  });
  await expect(singleForm).toBeVisible();
  await singleForm.getByLabel("Titel").fill(SINGLE_TITLE);
  await singleForm.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(singleForm.getByText("Termin angelegt — er steht in der Tafelwoche.", { exact: true }))
    .toBeVisible();
  await page.goto(url);
  await expect(row.getByText(SINGLE_TITLE, { exact: true }).first()).toBeVisible();

  // E-04: ＋-Klick bleibt grüner Fallback.
  await page
    .getByRole("link", { name: `Termin am ${PLUS_DAY} für ${data.editorEmail} anlegen` })
    .click();
  const plusForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: `Neuer Termin am ${PLUS_DAY}` }),
  });
  await expect(plusForm).toBeVisible();
  await plusForm.getByLabel("Titel").fill(PLUS_TITLE);
  await plusForm.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(plusForm.getByText("Termin angelegt — er steht in der Tafelwoche.", { exact: true }))
    .toBeVisible();

  // E-07: ＋-Link per Tastatur erreichbar + Enddatum manuell änderbar.
  await page.goto(url);
  const plusLink = page.getByRole("link", { name: `Termin am ${PLUS_DAY} für ${data.editorEmail} anlegen` });
  await plusLink.focus();
  await expect(plusLink).toBeFocused();
  await page.keyboard.press("Enter");
  const keyForm = page.locator("section").filter({
    has: page.getByRole("heading", { name: `Neuer Termin am ${PLUS_DAY}` }),
  });
  await expect(keyForm).toBeVisible();
  await keyForm.getByLabel("Enddatum").fill(DRAG_END);
  await expect(keyForm.getByLabel("Enddatum")).toHaveValue(DRAG_END);

  // E-08: Reload stabil (Formular + Grid).
  await page.reload();
  await expect(page.locator("section").filter({
    has: page.getByRole("heading", { name: `Neuer Termin am ${PLUS_DAY}` }),
  })).toBeVisible();
  await page.goto(url);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  await expect(row.getByText(MULTI_TITLE, { exact: true }).first()).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Spanne-Anlage").toEqual([]);
});

test("F7-05c-E2E-03: ohne Schreibrecht kein Drag (E-05)", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  await seedBoardAppointment();

  const url = boardUrl(data);
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();

  // Kein Drag-Ziel, kein ＋-Link.
  await expect(page.locator("td[data-member]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /anlegen$/ })).toHaveCount(0);
  await expect(page.getByText(APPOINTMENT_TITLE, { exact: true })).toBeVisible();

  // Drag-Versuch navigiert nicht.
  const cells = page.locator("tbody td");
  expect(await cells.count()).toBeGreaterThan(1);
  const firstBox = await cells.first().boundingBox();
  const lastBox = await cells.last().boundingBox();
  if (!firstBox || !lastBox) throw new Error("Viewer-Zellen nicht vermessen.");
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 4 });
  await page.mouse.up();
  expect(new URL(page.url()).searchParams.get("create")).toBeNull();
  await expect(page.getByRole("heading", { name: /Neuer Termin/ })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Viewer-Grenze").toEqual([]);
});

test("F7-05c-E2E-04: Axe + Server-Log (E-09/E-10)", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const serverLogOffset = statSync(data.serverLogPath).size;
  await seedBoardAppointment();

  const url = boardUrl(data);
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();

  // E-09: Axe auf Tafel + Anlageformular.
  await expectNoWcagAaAxeViolations(page, "F7-05c-Plantafel");
  const memberId = await editorMemberId(page, data);
  await page.goto(`/w/${data.w3WorkspaceId}/plantafel?week=${WEEK_MONDAY}&create=${DRAG_START}&member=${memberId}&end=${DRAG_END}`);
  await expect(page.locator("section").filter({
    has: page.getByRole("heading", { name: `vom ${DRAG_START} bis ${DRAG_END}` }),
  })).toBeVisible();
  await expectNoWcagAaAxeViolations(page, "F7-05c-Anlageformular");

  // E-10: Server-Log ohne Fehler aus diesem Lauf.
  const serverTail = readFileSync(data.serverLogPath)
    .subarray(Math.min(serverLogOffset, statSync(data.serverLogPath).size))
    .toString("utf8");
  expect(serverTail, "kein Routen-Fehler im Server-Log").not.toMatch(/\[plantafel\]/u);
  expect(serverTail, "kein Uncaught-Fehler im Server-Log").not.toMatch(/uncaughtException|unhandledRejection/u);

  expect(errors, "Browser-Konsole und Page-Errors der A11y-Prüfung").toEqual([]);
});
