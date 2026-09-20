import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F11-06 Quick Actions — Chromium-E2E (isolierter Workspace).
 * Die Kontaktwege der Projektakte sind echte Aktionen (tel/sms/wa.me/
 * mailto/OSM-Navigation, Katalog F11.2); fehlende Daten blenden die
 * jeweilige Aktion aus statt tot zu verlinken.
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
      throw new Error(`Der private F11-06-E2E-State ist unvollständig (${key}).`);
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

// Sektion „Identität und Kontakt" der Projektakte (Muster m1-14) —
// grenzt Edit-Felder/Buttons gegen gleichnamige Elemente (z. B. das
// Checklisten-„Speichern") auf derselben Seite ab.
function contactSection(page: Page): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Identität und Kontakt", level: 2 }),
  });
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `kein horizontaler Überlauf bei ${width}px`).toBeLessThanOrEqual(0);
}

test("F11-06-E2E-01: Kontaktwege sind echte Aktionen, Adressnachtrag bringt Navigation", async ({
  page,
}) => {
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
  // Ab hier (nach dem Login-Redirect) darf keine Antwort 4xx/5xx sein.
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Quick Actions");
  await form.getByLabel("E-Mail").fill("qa-kontakt@example.test");
  await form.getByLabel("Telefon").fill("0151 45678911");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  // Festnetz-Fall (Mobil/Adresse fehlen): 4 Aktionen, keine Navigation.
  const quick = page.getByTestId("quick-actions");
  await expect(quick).toBeVisible();
  await expect(quick.getByRole("link")).toHaveCount(4);
  const call = quick.getByRole("link", { name: "Anrufen", exact: true });
  await expect(call).toHaveAttribute("href", "tel:+4915145678911");
  await expect(call).not.toHaveAttribute("target", "_blank");
  const sms = quick.getByRole("link", { name: "SMS", exact: true });
  await expect(sms).toHaveAttribute("href", "sms:+4915145678911");
  await expect(sms).not.toHaveAttribute("target", "_blank");
  const whatsapp = quick.getByRole("link", { name: "WhatsApp", exact: true });
  await expect(whatsapp).toHaveAttribute("href", "https://wa.me/4915145678911");
  await expect(whatsapp).toHaveAttribute("target", "_blank");
  await expect(whatsapp).toHaveAttribute("rel", "noreferrer");
  const email = quick.getByRole("link", { name: "E-Mail", exact: true });
  await expect(email).toHaveAttribute("href", "mailto:qa-kontakt@example.test");
  await expect(email).not.toHaveAttribute("target", "_blank");
  await expect(quick.getByRole("link", { name: "Navigation", exact: true })).toHaveCount(0);
  await expectNoWcagAaAxeViolations(page, "F11-06 Quick Actions (4 Aktionen)");

  // Nachtrag: Mobil übernimmt Anruf/SMS/WhatsApp, Adresse bringt Navigation.
  const section = contactSection(page);
  await section.getByRole("button", { name: "Kontakt bearbeiten" }).click();
  await section.getByLabel(/Mobil \(E\.164/).fill("+491702345678");
  await section.getByLabel("Straße").fill("Musterstraße");
  await section.getByLabel("Hausnummer").fill("1");
  await section.getByLabel("Postleitzahl").fill("10115");
  await section.getByLabel("Ort", { exact: true }).fill("Berlin");
  await section.getByLabel("Land").fill("DE");
  await section.getByRole("button", { name: "Speichern" }).click();
  await expect(section.getByRole("button", { name: "Kontakt bearbeiten" })).toBeVisible();
  await expect(quick.getByRole("link")).toHaveCount(5);
  await expect(quick.getByRole("link", { name: "Anrufen", exact: true }))
    .toHaveAttribute("href", "tel:+491702345678");
  await expect(quick.getByRole("link", { name: "SMS", exact: true }))
    .toHaveAttribute("href", "sms:+491702345678");
  await expect(quick.getByRole("link", { name: "WhatsApp", exact: true }))
    .toHaveAttribute("href", "https://wa.me/491702345678");
  const navigate = quick.getByRole("link", { name: "Navigation", exact: true });
  await expect(navigate).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/search?query=Musterstra%C3%9Fe%201%2C%2010115%20Berlin%2C%20DE",
  );
  await expect(navigate).toHaveAttribute("target", "_blank");
  await expect(navigate).toHaveAttribute("rel", "noreferrer");

  await page.setViewportSize({ width: 375, height: 900 });
  for (const width of [375, 768, 1440]) await expectNoHorizontalOverflow(page, width);
  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoWcagAaAxeViolations(page, "F11-06 Quick Actions");
  expect(failedResponses, "keine 4xx/5xx-Antworten").toEqual([]);
  expect(errors, "Browser-Konsole und Page-Errors der Quick Actions").toEqual([]);
});
