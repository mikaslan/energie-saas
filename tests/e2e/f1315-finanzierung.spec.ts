import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F13-15 Finanzierungs-Intake — Chromium-E2E (isolierter Workspace).
 * Akte: Guards-Feedback → anlegen → Kette (bonitaet/entschieden/ausgezahlt/
 * abgeschlossen) → Historie → neuer Vorgang; Portal: grober Stand lesend
 * + Disclaimer, Referenz/Volumen treten nie aus. Portal-Antrag (E2E-02)
 * Owner-verdrahtet (Server-Action + Kapsel, Reload nach Submit).
 * NICHT lokal ausführen (Owner zentral).
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
      throw new Error(`Der private F1315-E2E-State ist unvollständig (${key}).`);
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

async function createLeadAndOpenProject(page: Page, name: string, phone: string): Promise<void> {
  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill(name);
  await form.getByLabel("Telefon").fill(phone);
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
}

async function createPortalLink(page: Page): Promise<string> {
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
  return tokenPath;
}

test("F1315-E2E-01: Finanzierung anlegen, Kette, Historie, Portal liest grob", async ({ page }) => {
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

  await createLeadAndOpenProject(page, "E2E Finanzierung", "0151 78901234");

  // §5-Disclaimer (intern, exakter Spec-Wortlaut).
  await expect(page.getByTestId("financing-case-disclaimer")).toContainText(
    "Wir vermitteln keine Finanzierung und beraten nicht",
  );
  await expect(page.getByTestId("financing-case-current")).toContainText(
    "Noch kein Finanzierungsvorgang",
  );

  // Guards-Feedback: Ratenkauf mit falschem Provider scheitert serverseitig.
  await page.getByTestId("financing-case-produkttyp").selectOption("ratenkauf");
  await page.getByTestId("financing-case-laufzeit").fill("10");
  await page.getByTestId("financing-case-volumen").fill("50000");
  await page.getByTestId("financing-case-provider").selectOption("psd_bank");
  await page.getByTestId("financing-case-create").click();
  await expect(page.getByTestId("financing-case-feedback")).toContainText(
    "Die Eingabe ist ungültig.",
  );

  // Korrekt anlegen (Ratenkauf, Bees & Bears). React 19 resettet
  // uncontrolled Felder nach der Server-Action → alle Werte neu setzen.
  await page.getByTestId("financing-case-produkttyp").selectOption("ratenkauf");
  await page.getByTestId("financing-case-laufzeit").fill("10");
  await page.getByTestId("financing-case-volumen").fill("50000");
  await page.getByTestId("financing-case-provider").selectOption("bees_bears");
  await page.getByTestId("financing-case-referenz").fill("REF-E2E-FIN-1");
  await page.getByTestId("financing-case-create").click();
  // Erfolg: Anlegeformular (samt Feedback) weicht dem Statusblock.
  await expect(page.getByTestId("financing-case-current")).toContainText("Beantragt");

  // §3 Human-Gate: Kette per Folge-Buttons + Referenz per Hand.
  await page.getByTestId("financing-case-to-bonitaet").click();
  await expect(page.getByTestId("financing-case-transition-feedback")).toContainText(
    "Status geändert.",
  );
  await page.getByTestId("financing-case-to-entschieden").click();
  await expect(page.getByTestId("financing-case-current")).toContainText("Entschieden");
  await page.getByTestId("financing-case-reference").fill("REF-E2E-FIN-2");
  await page.getByTestId("financing-case-to-ausgezahlt").click();
  await expect(page.getByTestId("financing-case-current")).toContainText("Ausgezahlt");
  await expect(page.getByTestId("financing-case-current")).toContainText("REF-E2E-FIN-2");
  await page.getByTestId("financing-case-to-abgeschlossen").click();
  await expect(page.getByTestId("financing-case-current")).toContainText(
    "Noch kein Finanzierungsvorgang",
  );

  // Historie: abgeschlossener Vorgang bleibt lesend erhalten.
  await expect(page.getByTestId("financing-case-history")).toContainText("Abgeschlossen");

  // Reopen nur via neuen Vorgang (Kredit, PSD, freitextlich > 70.000 €).
  await page.getByTestId("financing-case-produkttyp").selectOption("kredit");
  await page.getByTestId("financing-case-laufzeit").fill("15");
  await page.getByTestId("financing-case-volumen").fill("120000");
  await page.getByTestId("financing-case-provider").selectOption("psd_bank");
  await page.getByTestId("financing-case-create").click();
  await expect(page.getByTestId("financing-case-current")).toContainText("Beantragt");
  await expect(page.getByTestId("financing-case-history")).toContainText("Abgeschlossen");

  // Portal: grober Stand lesend + Disclaimer; Interna treten nie aus.
  const tokenPath = await createPortalLink(page);
  await page.goto(tokenPath);
  await expect(page.getByTestId("portal-financing-section")).toBeVisible();
  await expect(page.getByTestId("portal-financing-status")).toContainText("Beantragt");
  await expect(page.getByTestId("portal-financing-disclaimer")).toContainText(
    "vermitteln keine Finanzierung",
  );
  await expect(page.locator("main")).not.toContainText("REF-E2E-FIN-1");
  await expect(page.locator("main")).not.toContainText("REF-E2E-FIN-2");
  await expect(page.locator("main")).not.toContainText("120.000");

  expect(errors, "Browser-Konsole und Page-Errors der Finanzierungs-Grenze").toEqual([]);
});

// F13-15/Owner: Kapsel-verdrahtet (requestPortalFinancingAction) — aktiv.
test(
  "F1315-E2E-02: Portal-Antrag legt Beantragt-Vorgang an",
  async ({ page }) => {
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

    await createLeadAndOpenProject(page, "E2E Finanzportal", "0151 89012345");
    const tokenPath = await createPortalLink(page);

    // Ohne Vorgang: Antragsformular + Disclaimer, kein Status-Block.
    await page.goto(tokenPath);
    await expect(page.getByTestId("portal-financing-section")).toBeVisible();
    await expect(page.getByTestId("portal-financing-form")).toBeVisible();
    await expect(page.getByTestId("portal-financing-disclaimer")).toContainText(
      "vermitteln keine Finanzierung",
    );

    await page.getByTestId("portal-financing-produkttyp").selectOption("ratenkauf");
    await page.getByTestId("portal-financing-laufzeit").fill("12");
    await page.getByTestId("portal-financing-volumen").fill("45000");
    await page.getByTestId("portal-financing-submit").click();
    await expect(page.getByTestId("portal-financing-feedback")).toContainText(
      "Antrag eingegangen",
    );
    // Server-Action: frischer Server-Render für den Status-Block.
    await page.reload();
    await expect(page.getByTestId("portal-financing-status")).toContainText("Beantragt");

    expect(errors, "Browser-Konsole und Page-Errors des Portal-Antrags").toEqual([]);
  },
);
