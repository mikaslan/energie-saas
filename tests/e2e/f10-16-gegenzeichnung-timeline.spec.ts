import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F10-16 Gegenzeichnung in der Portal-Timeline — Chromium-E2E (isolierter
 * Workspace, UI-Pfad wie 03b + 07b: Anlage + Abschluss + Abnahme +
 * Gegenzeichnung per Canvas-UI + Portal-Link, Portal ohne Login).
 *
 * F1016-E2E-01: Installations-Tab zeigt 4 Verlaufs-Zeilen mit
 * „Gegengezeichnet am …"; Kundenname und Unterschrift bleiben intern.
 */

const CUSTOMER_NAME = "F1016 Berger";

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
      throw new Error(`Der private F10-16-E2E-State ist unvollständig (${key}).`);
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

async function expectNoAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine WCAG-A/AA-Verletzung`).toEqual([]);
}

test("F10-16-E2E-01: Portal-Timeline zeigt die Gegenzeichnung ohne Namen", async ({ page }) => {
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
  await leadForm.getByLabel("Name *").fill("E2E Gegenzeichnung-Timeline");
  await leadForm.getByLabel("Telefon").fill("0151 45678916");
  await leadForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  // 1) Installation anlegen + abschließen + Abnahme (03b-Muster).
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Installation", exact: true }),
  });
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "Installation direkt anlegen", exact: true }).click();
  await expect(section.getByText("Installation angelegt")).toBeVisible();
  await section.getByRole("button", { name: "Installation abschließen", exact: true }).click();
  await expect(section.getByText("Installation abgeschlossen.", { exact: true })).toBeVisible();
  await section.getByLabel("Abgenommen durch").fill("Monteur Martin");
  await section.getByRole("button", { name: "Abnahme speichern", exact: true }).click();
  await expect(section.getByText("Abnahme festgehalten.", { exact: true })).toBeVisible();

  // 2) Gegenzeichnung per 07b-UI (Name + Canvas-Strich).
  await section.getByLabel("Gegengezeichnet von").fill(CUSTOMER_NAME);
  const canvas = section.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Gegenzeichnungs-Canvas unsichtbar.");
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 12 });
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 6 });
  await page.mouse.up();
  await section.getByRole("button", { name: "Gegenzeichnung speichern", exact: true }).click();
  await expect(section.getByText("Gegenzeichnung festgehalten.", { exact: true })).toBeVisible();

  // 3) Portal-Link erstellen, Token abgreifen.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await expect(portal).toBeVisible();
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 4) Öffentlich ohne Login: 4 Verlaufs-Zeilen, kein Kundenname.
  await page.context().clearCookies();
  await page.goto(`${tokenPath}?tab=installation`);
  await expect(page.getByRole("heading", { name: "Installation", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verlauf", exact: true })).toBeVisible();
  for (const word of ["Angelegt", "Abgeschlossen", "Abgenommen", "Gegengezeichnet"]) {
    await expect(
      page.locator("li").filter({ hasText: new RegExp(`${word} am \\d{2}\\.\\d{2}\\.\\d{4}`, "u") }),
    ).toBeVisible();
  }
  await expect(page.locator("ol", { hasText: "Angelegt" }).locator("li")).toHaveCount(4);
  await expect(page.getByText(CUSTOMER_NAME, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Gegenzeichnung-Vorschau" })).toHaveCount(0);

  await expectNoAxeViolations(page, "F10-16-Portal-Timeline");

  expect(errors, "Browser-Konsole und Page-Errors der Gegenzeichnungs-Timeline").toEqual([]);
});
