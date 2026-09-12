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
  await expect(pipeline.getByText("Offen (Angebotswert)")).toBeVisible();
  await expect(pipeline.getByText("Gewichtet (ESTIMATE)")).toBeVisible();
  await expect(pipeline.getByText("Gewichte lead 10 %, offer 50 % (ESTIMATE, Referenzfrage offen).")).toBeVisible();
  // DASH-08: ohne Quellen und ohne Board-Karten keine Quellenkarte.
  await expect(dashboard.locator('[data-dashboard-sources="true"]')).toHaveCount(0);
  const offerLead = dashboard.locator('[data-dashboard-offer-leadtime="true"]');
  await expect(offerLead).toBeVisible();
  await expect(offerLead.getByText("Noch keine Angebote.")).toBeVisible();
  const trend = dashboard.locator('[data-dashboard-trend="true"]');
  await expect(trend).toBeVisible();
  await expect(trend.getByText("Noch keine Abschlüsse im Zeitraum.")).toBeVisible();
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
  const leadTime = dashboard.locator('[data-dashboard-leadtime="true"]');
  await expect(leadTime).toBeVisible();
  await expect(leadTime.getByText("Noch keine Unterschriften.")).toBeVisible();
  const appointments = dashboard.locator('[data-dashboard-appointments="true"]');
  await expect(appointments).toBeVisible();
  await expect(appointments.getByText("Keine anstehenden Termine.")).toBeVisible();
  await expect(appointments.getByRole("link", { name: "Zum Kalender" })).toBeVisible();
  // DASH-09: leere Service-/Förder-/Beleg-Karte mit ehrlichen Leerzuständen.
  const emptyService = dashboard.locator('[data-dashboard-service="true"]');
  await expect(emptyService).toBeVisible();
  await expect(emptyService.getByText("Keine offenen Vorgänge.")).toBeVisible();
  await expect(emptyService.getByText("Keine Förderakten.")).toBeVisible();
  await expect(emptyService.getByText("Keine Datei-Anfragen.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Anfragen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aufgaben" })).toBeVisible();
});

test("DASH-08: angelegte Lead-Quelle erscheint als Dashboard-Quellenkarte", async ({
  page,
}) => {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const settingsPath = `/w/${workspaceId}/einstellungen/lead-quellen`;
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, state().editorEmail, settingsPath);

  const createForm = page.getByTestId("lead-source-create-form");
  await createForm.getByLabel("Name").fill("Messe-Portal");
  await createForm.getByRole("button", { name: "Anlegen" }).click();
  // Quellenname auf die Quellenliste scopen (Kampagnen-Select führt ihn
  // als Option).
  const activeSources = page.locator("section", {
    has: page.getByRole("heading", { name: "Aktive Quellen" }),
  });
  await expect(activeSources.getByText("Messe-Portal", { exact: true })).toBeVisible();

  await page.goto(dashboardPath);
  const sources = page.locator('[data-dashboard-sources="true"]');
  await expect(sources).toBeVisible();
  await expect(sources.getByText("Pipeline nach Quelle (ESTIMATE)")).toBeVisible();
  await expect(sources.getByText("Messe-Portal")).toBeVisible();
});

test("DASH-09: Vorgang, Akte und Beleg erscheinen als Dashboard-Kennzahlen", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(listPath);
  await loginWithRealOtp(page, state().editorEmail, listPath);

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Dashboard Service");
  await form.getByLabel("Telefon").fill("0151 45678905");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  const service = page.locator('section[data-service-cases="true"]');
  await service.getByLabel("Titel").fill("Dashboard Wartung");
  await service.getByRole("button", { name: "Vorgang anlegen" }).click();
  await expect(service).toContainText("Dashboard Wartung");

  await page.getByTestId("subsidy-case-create").click();
  await expect(page.getByTestId("subsidy-case-current")).toContainText("In Vorbereitung");

  const files = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await files.getByTestId("file-request-title").fill("Dashboard Beleg");
  await files.getByTestId("file-request-description").fill("Bitte als PDF hochladen.");
  await files.getByTestId("file-request-create").click();
  await expect(files.getByTestId("file-request-create-feedback")).toHaveText(
    "Datei-Anfrage angelegt.",
  );

  await page.goto(dashboardPath);
  const card = page.locator('[data-dashboard-service="true"]');
  await expect(card).toBeVisible();
  await expect(card.getByTestId("dashboard-service-open")).toHaveText("1");
  await expect(card.getByTestId("dashboard-subsidy-vorbereitung")).toHaveText("1");
  await expect(card.getByTestId("dashboard-subsidy-total")).toHaveText("1");
  await expect(card.getByTestId("dashboard-belege-offen")).toHaveText("1");
});

test("DASH-10: Funnel zeigt Bestands-Stufen mit ehrlichen Raten", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);

  const funnel = page.locator('[data-dashboard-funnel="true"]');
  await expect(funnel).toBeVisible();
  await expect(funnel.getByText("Noch keine Projekte im Bestand.")).toBeVisible();

  await page.goto(listPath);
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Funnel");
  await form.getByLabel("Telefon").fill("0151 45678906");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  await expect(page.getByTestId("manual-lead-success")).toContainText("Anfrage angelegt");

  await page.goto(dashboardPath);
  await expect(funnel.getByTestId("dashboard-funnel-requests")).toHaveText("1");
  await expect(funnel.getByTestId("dashboard-funnel-offers")).toContainText("0");
  await expect(funnel.getByTestId("dashboard-funnel-installations")).toContainText("0");
  await expect(funnel.getByTestId("dashboard-funnel-won")).toContainText("0");
});
