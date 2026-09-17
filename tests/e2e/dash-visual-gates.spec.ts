import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state,
} from "./m1-11g-fixture";

// DASH-VG: blockierende Browser-Gates fuer die Workspace-Uebersicht
// (Agent 5, DASH): 375/768/1440, Axe WCAG A/AA, Console-/Page-Errors,
// Hydration-Warnungen, fehlgeschlagene Requests, Overflow-Freiheit,
// mobile Touch-Targets und Klickpfade. Zusaetzlich werden textfreie
// Layout-Messungen (Boxen je Viewport) als JSON-Artefakt abgelegt;
// versionierte Ablage unter docs/parity/dash-measurements/.

type Viewport = { width: number; height: number };

const GATE_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
];

const DASHBOARD_CARDS: readonly string[] = [
  '[data-dashboard-pipeline="true"]',
  '[data-dashboard-overdue="true"]',
  '[data-dashboard-today="true"]',
  '[data-dashboard-closures="true"]',
  '[data-dashboard-trend="true"]',
  '[data-dashboard-invoices="true"]',
  '[data-dashboard-leadtime="true"]',
  '[data-dashboard-offer-leadtime="true"]',
  '[data-dashboard-appointments="true"]',
  '[data-dashboard-service="true"]',
];

const browserProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const problems: string[] = [];
  browserProblems.set(page, problems);
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console-error: ${message.text()}`);
    }
    if (message.type() === "warning" && /hydrat/i.test(message.text())) {
      problems.push(`hydration-warning: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    problems.push(`requestfailed: ${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`http-${response.status()}: ${response.url()}`);
    }
  });
});

test.afterEach(async ({ page }) => {
  expect(
    browserProblems.get(page) ?? [],
    "DASH-VG: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
  ).toEqual([]);
});

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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
  expect(violations, `${stateName}: keine automatisiert pruefbare WCAG-A/AA-Verletzung`)
    .toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  await expect.poll(
    async () => {
      const evidence = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      return evidence.scrollWidth - evidence.clientWidth;
    },
    { message: `${label}: kein horizontaler Dokumentueberlauf` },
  ).toBeLessThanOrEqual(0);
}

type MeasuredBox = {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

async function measureBoxes(page: Page, selectors: readonly string[]): Promise<MeasuredBox[]> {
  const boxes: MeasuredBox[] = [];
  for (const selector of selectors) {
    const box = await page.locator(selector).first().boundingBox();
    boxes.push({
      selector,
      x: box?.x ?? -1,
      y: box?.y ?? -1,
      width: box?.width ?? -1,
      height: box?.height ?? -1,
    });
  }
  return boxes;
}

function writeMeasurementArtifact(route: string, viewport: Viewport, boxes: MeasuredBox[]): void {
  const outputDir = process.env.M1_05_E2E_OUTPUT_DIR ?? "test-results/e2e";
  const dir = join(outputDir, "dash-measurements");
  mkdirSync(dir, { recursive: true });
  const payload = {
    route,
    viewport,
    capturedAt: new Date().toISOString(),
    boxes,
  };
  writeFileSync(
    join(dir, `dashboard-${viewport.width}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

test("DASH-VG-01: Uebersicht ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
      for (const card of DASHBOARD_CARDS) {
        await expect(page.locator(card), `${viewport.width}: ${card} sichtbar`).toBeVisible();
      }
      await expectNoHorizontalOverflow(page, `Dashboard ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `Dashboard ${viewport.width}`);
      const boxes = await measureBoxes(page, [
        '[data-dashboard="true"]',
        ...DASHBOARD_CARDS,
      ]);
      writeMeasurementArtifact(dashboardPath, viewport, boxes);
    });
  }
});

test("DASH-VG-02: mobile Touch-Targets und Klickpfade ab Uebersicht", async ({ page }) => {
  test.setTimeout(240_000);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();

  for (const name of ["Anfragen", "Aufgaben"] as const) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link, `375: Link ${name} sichtbar`).toBeVisible();
    const box = await link.boundingBox();
    expect(box, `375: Link ${name} hat messbare Box`).not.toBeNull();
    expect(box!.height, `375: Link ${name} mind. 44 px hoch`).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("link", { name: "Anfragen", exact: true }).click();
  await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/anfragen`);
  await page.goBack();
  await page.waitForURL((url) => url.pathname === dashboardPath);
  await page.getByRole("link", { name: "Aufgaben", exact: true }).click();
  await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/aufgaben`);
});
