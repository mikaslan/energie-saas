import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F11-05 Mobile Tab-Leiste — Chromium-E2E (isolierter Workspace).
 * Jede Workspace-Seite zeigt auf 375 px die 5 Katalog-Tabs (F11.1);
 * jeder Tab navigiert, der aktive trägt aria-current; auf Desktop ist
 * die Leiste verborgen; die Mehr-Seite verlinkt die übrigen Bereiche.
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
      throw new Error(`Der private F11-05-E2E-State ist unvollständig (${key}).`);
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

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `kein horizontaler Überlauf bei ${width}px`).toBeLessThanOrEqual(0);
}

test("F11-05-E2E-01: Tab-Leiste navigiert auf Mobil, Mehr-Seite verlinkt Rest", async ({
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
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, data.editorEmail, dashboardPath);
  // Ab hier (nach dem Login-Redirect) darf keine Antwort 4xx/5xx sein.
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.setViewportSize({ width: 375, height: 900 });
  const tabBar = page.getByTestId("mobile-tab-bar");
  await expect(tabBar).toBeVisible();
  await expect(tabBar.getByRole("link")).toHaveCount(5);
  const tabs: Array<[string, string]> = [
    ["Home", "dashboard"],
    ["Projekte", "anfragen"],
    ["Aufgaben", "aufgaben"],
    ["Kalender", "kalender"],
    ["Mehr", "mehr"],
  ];
  for (const [label, segment] of tabs) {
    const link = tabBar.getByRole("link", { name: label, exact: true });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height ?? 0, `${label}: Touch-Ziel mindestens 44px hoch`).toBeGreaterThanOrEqual(44);
    expect(
      Math.round((box?.y ?? 0) + (box?.height ?? 0)),
      `${label}: Leiste am unteren Viewport-Rand (900px)`,
    ).toBe(900);
    // Tastatur-Aktivierung statt Zeiger-Klick: Im Dev-Server-Harness
    // liegt das Next-Dev-Overlay (`nextjs-portal`) links unten ueber dem
    // Home-Tab und faengt Zeiger-Events ab (gemessen: Geometrie stabil
    // x0/y856/w75/h44, genau 1 Leiste, position fixed — App-Seite
    // korrekt, Prod kennt kein Overlay). Enter auf dem fokussierten Link
    // nutzt denselben Navigationspfad bei gleichen Assertions;
    // Zeiger-Klicks bleiben ueber die Mehr-Schleife abgedeckt (echte
    // click() auf Mehr-Tab + Bereichs-Links, rechte Bildschirmhaelfte).
    await link.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/${segment}`);
    const activeLink = tabBar.getByRole("link", { name: label, exact: true });
    await expect(activeLink).toHaveAttribute("aria-current", "page");
    await expect(activeLink).toHaveCSS("font-weight", "700");
  }
  // Wir stehen auf der Mehr-Seite: Home ist inaktiv (semibold, kein Fett).
  await expect(tabBar.getByRole("link", { name: "Home", exact: true })).toHaveCSS("font-weight", "600");

  const moreLinks: Array<[string, string]> = [
    ["Angebote", "angebote"],
    ["Plantafel", "plantafel"],
    ["Rechnungen", "rechnungen"],
    ["Sites", "sites"],
    ["Katalog", "katalog"],
  ];
  const moreList = page.getByTestId("more-links");
  await expect(moreList.getByRole("link")).toHaveCount(5);
  // Tote-Links-Verbot: kein Einstellungen-Link (keine Root-Seite) und
  // keine Katalog-Namen ohne Feature dahinter (AR/Chat/Assistant).
  for (const absent of ["Einstellungen", "AR", "Chats", "Sales Assistant"]) {
    await expect(moreList.getByRole("link", { name: absent, exact: true })).toHaveCount(0);
  }
  for (const [label, segment] of moreLinks) {
    await page.getByTestId("mobile-tab-bar").getByRole("link", { name: "Mehr", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/mehr`);
    await page.getByTestId("more-links").getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/${segment}`);
  }

  await page.goto(dashboardPath);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("mobile-tab-bar")).toBeHidden();

  await page.setViewportSize({ width: 375, height: 900 });
  for (const width of [375, 768, 1440]) await expectNoHorizontalOverflow(page, width);
  await page.goto(`/w/${workspaceId}/mehr`);
  await page.setViewportSize({ width: 375, height: 900 });
  for (const width of [375, 768, 1440]) await expectNoHorizontalOverflow(page, width);
  // Axe bei SICHTBARER Leiste (der Overflow-Loop endet auf 1440px).
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByTestId("mobile-tab-bar")).toBeVisible();
  await expectNoWcagAaAxeViolations(page, "F11-05 Tab-Leiste");
  expect(failedResponses, "keine 4xx/5xx-Antworten").toEqual([]);
  expect(errors, "Browser-Konsole und Page-Errors der Tab-Leiste").toEqual([]);
});
