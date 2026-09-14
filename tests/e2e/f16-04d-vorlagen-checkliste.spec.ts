import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F16-04d Vorlagen mit Checklisten-Inhalt — Chromium-E2E (isolierter
 * Workspace). Vorlage mit zwei Checklistenpunkten per UI anlegen
 * (Karte zeigt „2 Checklistenpunkte"), auf der Projektseite anwenden →
 * Aufgabe trägt beide Punkte unerledigt.
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
      throw new Error(`Der private F16-04D-E2E-State ist unvollständig (${key}).`);
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

test("F16-04D-E2E-01: Vorlage mit Checkliste anlegen und anwenden", async ({ page }) => {
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

  // Projekt per UI (manueller Lead → Projektakte).
  const stamp = Date.now();
  await page.getByTestId("manual-lead-open").click();
  const leadForm = page.getByTestId("manual-lead-form");
  await leadForm.getByLabel("Name *").fill("E2E Vorlagen-Checkliste");
  await leadForm.getByLabel("Telefon").fill("0151 45678908");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const projectPath = new URL(page.url()).pathname;

  // Vorlage mit zwei Checklistenpunkten per UI.
  const templateName = `F16-04d E2E Checkliste ${stamp}`;
  const itemA = `Wechselrichter prüfen ${stamp}`;
  const itemB = `Zählerstand notieren ${stamp}`;
  await page.goto(`/w/${workspaceId}/einstellungen/aufgaben-vorlagen`);
  await expect(page.getByRole("heading", { name: "Aufgaben-Vorlagen", level: 1 })).toBeVisible();
  const createSection = page.locator("section[aria-label=\"Neue Vorlage\"]");
  await createSection.getByLabel("Name").fill(templateName);
  await createSection.getByLabel("Aufgaben-Titel").fill(`F16-04d E2E Aufgabe ${stamp}`);
  await createSection.getByLabel("Checkliste (eine Zeile je Punkt, leer = ohne)").fill(`${itemA}\n${itemB}`);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  const article = page.locator("section[aria-label=\"Vorlagen\"] article").filter({
    has: page.getByRole("heading", { name: templateName }),
  });
  await expect(article).toHaveCount(1);
  await expect(article).toContainText("2 Checklistenpunkte");

  // Auf der Projektseite anwenden → Aufgabe trägt beide Punkte unerledigt.
  await page.goto(projectPath);
  await page.getByLabel("Aufgabenvorlage").selectOption({ label: `${templateName} – F16-04d E2E Aufgabe ${stamp}` });
  await page.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
  await expect(page.getByText("Die Aufgabe wurde aus der Vorlage erstellt.", { exact: true }))
    .toBeVisible();
  const checklist = page.getByRole("list", { name: "Checkliste" });
  await expect(checklist.getByText(itemA, { exact: true })).toBeVisible();
  await expect(checklist.getByText(itemB, { exact: true })).toBeVisible();
  await expect(page.getByText("Checkliste: 0/2 erledigt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Vorlagen-Checkliste").toEqual([]);
});
