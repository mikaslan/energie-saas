import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F7-07 Team-Zeilengruppierung — Chromium-E2E (isolierter Workspace, Actor
 * ist dort Admin): zwei Teams anlegen, Editor nur Alpha zuordnen → Tafel
 * zeigt Sektion „Alpha" mit der Editor-Zeile → Alpha archivieren → Tafel
 * fällt ehrlich auf flach zurück (keine Sektion), Zeile bleibt.
 */

type E2EState = {
  serverLogPath: string;
  editorEmail: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F7-07-E2E-State ist unvollständig (${key}).`);
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

test("F7-07-E2E-01: Plantafel gruppiert Zeilen je Team, Archiv fällt flach", async ({ page }) => {
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

  const stamp = Date.now();
  const alphaName = `Alpha-Team E2E ${stamp}`;
  const betaName = `Beta-Team E2E ${stamp}`;

  // 1) Zwei Teams, Editor nur Alpha zuordnen (Anlageformular per
  // Überschrift abgegrenzt — Teamzeilen tragen eigene Name-Felder).
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  const createSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Team anlegen" }),
  });
  await createSection.getByLabel("Name", { exact: true }).fill(alphaName);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();
  await createSection.getByLabel("Name", { exact: true }).fill(betaName);
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Team angelegt.")).toBeVisible();
  const alphaRow = page.locator("section").filter({
    has: page.getByRole("heading", { name: alphaName }),
  });
  await alphaRow.getByRole("checkbox", { name: data.editorEmail }).check();
  await alphaRow.getByRole("button", { name: "Mitglieder speichern", exact: true }).click();
  await expect(alphaRow.getByText("Mitglieder gespeichert.")).toBeVisible();

  // 2) Tafel: Alpha-Sektion mit Editor-Zeile, kein Beta (leere Teams entfallen).
  const boardPath = `/w/${workspaceId}/plantafel`;
  await page.goto(boardPath);
  const alphaSection = page.locator("th", { hasText: alphaName });
  await expect(alphaSection).toBeVisible();
  const editorRow = page.locator("tr", { has: page.getByText(data.editorEmail) }).first();
  await expect(editorRow).toBeVisible();
  await expect(page.locator("th", { hasText: betaName })).toHaveCount(0);
  await expect(page.locator("th", { hasText: "Ohne Team" })).toHaveCount(0);

  // 3) Alpha archivieren → flach: keine Sektion, Zeile bleibt.
  await page.goto(`/w/${workspaceId}/einstellungen/teams`);
  await alphaRow.getByRole("button", { name: "Archivieren", exact: true }).click();
  await page.reload();
  await expect(alphaRow.getByText("Archiviert", { exact: true })).toBeVisible();
  await page.goto(boardPath);
  await expect(page.locator("th", { hasText: alphaName })).toHaveCount(0);
  await expect(
    page.locator("tr", { has: page.getByText(data.editorEmail) }).first(),
  ).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Gruppierungs-Grenze").toEqual([]);
});
