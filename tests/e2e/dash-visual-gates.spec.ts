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
  '[data-dashboard-followups="true"]',
  '[data-dashboard-closures="true"]',
  '[data-dashboard-trend="true"]',
  '[data-dashboard-funnel="true"]',
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

type ReflowEvidence = {
  clientWidth: number;
  scrollWidth: number;
  offenders: string[];
};

async function reflowEvidence(page: Page): Promise<ReflowEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const viewportRight = root.clientWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.right > viewportRight + 1 || rect.left < -1;
      })
      .slice(0, 8)
      .map((element) => {
        const id = element.id ? `#${element.id}` : "";
        const cls = element.className && typeof element.className === "string"
          ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
        const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `${element.tagName.toLowerCase()}${id}${cls} :: ${JSON.stringify(text)}`;
      });
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      offenders,
    };
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const evidence = await reflowEvidence(page);
        return evidence.scrollWidth - evidence.clientWidth;
      },
      { message: `${label}: kein horizontaler Dokumentueberlauf` },
    ).toBeLessThanOrEqual(0);
  } catch (error) {
    const evidence = await reflowEvidence(page);
    throw new Error(
      `${label}: Ueberlauf +${evidence.scrollWidth - evidence.clientWidth}px; Taeter: ${JSON.stringify(evidence.offenders)}`,
      { cause: error },
    );
  }
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
    expect(box, `Messung: ${selector} hat eine sichtbare Box`).not.toBeNull();
    boxes.push({
      selector,
      x: box!.x,
      y: box!.y,
      width: box!.width,
      height: box!.height,
    });
  }
  return boxes;
}

function writeMeasurementArtifact(
  name: string,
  route: string,
  viewport: Viewport,
  boxes: MeasuredBox[],
): void {
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
    join(dir, `${name}-${viewport.width}.json`),
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
  // 13. Sektion (Quellenkarte) fehlt ohne Daten — bedingte Karte.
  await expect(page.locator('[data-dashboard-sources="true"]')).toHaveCount(0);

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
      writeMeasurementArtifact("dashboard", dashboardPath, viewport, boxes);
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

type SharedE2EState = {
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  externalEmail: string;
};

function sharedState(): SharedE2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SharedE2EState>;
  const required: Array<keyof SharedE2EState> = [
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private DASH-VG-E2E-State ist unvollständig.");
  }
  return parsed as SharedE2EState;
}

test("DASH-VG-03: Projektakte ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const shared = sharedState();
  const aktePath = `/w/${shared.workspaceId}/anfragen/${shared.mainProjectId}`;
  await page.goto(aktePath);
  await loginWithRealOtp(page, shared.editorEmail, aktePath);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Brotkrumen" })).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `Projektakte ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `Projektakte ${viewport.width}`);
      const boxes = await measureBoxes(page, [
        "main",
        'nav[aria-label="Brotkrumen"]',
        "h1",
        '[aria-label="Projektstatus"]',
      ]);
      writeMeasurementArtifact("projektakte", aktePath, viewport, boxes);
    });
  }
});

test("DASH-VG-04: Angebotsliste ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/angebote`;
  await page.goto(listPath);
  await loginWithRealOtp(page, state().editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Angebote", level: 1 })).toBeVisible();
  await expect(page.getByText("Noch keine Angebote")).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { name: "Angebote", level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `Angebotsliste ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `Angebotsliste ${viewport.width}`);
      const boxes = await measureBoxes(page, ["main", "h1"]);
      writeMeasurementArtifact("angebotsliste", listPath, viewport, boxes);
    });
  }
});

type PortalE2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f101ProjectId: string;
  editorEmail: string;
};

function portalState(): PortalE2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PortalE2EState>;
  const required: Array<keyof PortalE2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f101ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private DASH-VG-Portal-State ist unvollständig.");
  }
  return parsed as PortalE2EState;
}

test("DASH-VG-05: Portal-Resolve ist bei 375/768/1440 axe-/konsolen-sauber (Create/Withdraw)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const data = portalState();
  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f101ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  let created = false;
  let tokenPath = "";
  let stepError: unknown = null;
  let cleanupError: unknown = null;
  try {
    await expect(portal.getByText("Kein aktiver Link.", { exact: false })).toBeVisible();
    await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
    await expect(portal.getByText("Der Portal-Link wurde erstellt und die E-Mail an den Kunden queued. Kopiere ihn jetzt — er wird nicht erneut angezeigt.", { exact: true }))
      .toBeVisible();
    created = true;
    const tokenText = await portal.locator("p.font-mono").textContent();
    tokenPath = tokenText?.trim() ?? "";
    expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

    await page.context().clearCookies();
    await page.goto(tokenPath);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();

    for (const viewport of GATE_VIEWPORTS) {
      await test.step(`Viewport ${viewport.width}`, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoHorizontalOverflow(page, `Portal ${viewport.width}`);
        await expectNoWcagAaAxeViolations(page, `Portal ${viewport.width}`);
        const boxes = await measureBoxes(page, ["main", "h1", "nav"]);
        writeMeasurementArtifact("portal", tokenPath, viewport, boxes);
      });
    }

    await test.step("Portal-Tabs: 44px-Targets und aria-current", async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      for (const tabName of ["Übersicht", "Termine", "Installation", "Dateien"] as const) {
        const tab = page.getByRole("link", { name: tabName, exact: true });
        await expect(tab, `Portal-Tab ${tabName} sichtbar`).toBeVisible();
        const tabBox = await tab.boundingBox();
        expect(tabBox, `Portal-Tab ${tabName} hat messbare Box`).not.toBeNull();
        expect(tabBox!.height, `Portal-Tab ${tabName} mind. 44 px hoch`).toBeGreaterThanOrEqual(44);
      }
      await expect(
        page.getByRole("link", { name: "Übersicht", exact: true }),
        "aktiver Portal-Tab meldet aria-current",
      ).toHaveAttribute("aria-current", "page");
    });
  } catch (error) {
    stepError = error;
  }
  // Garantierter Withdraw (f10-01-Hygiene), ohne den Originalfehler zu maskieren.
  if (created) {
    try {
      await page.goto(projectPath);
      // Login-Seite kommt per async Redirect: bis 12 s abwarten (schnell, wenn
      // abgemeldet; volle Zeit nur im seltenen Noch-angemeldet-Fall).
      const needsLogin = await page
        .waitForURL((url) => url.pathname === "/login", { timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      if (needsLogin) {
        await loginWithRealOtp(page, data.editorEmail, projectPath);
      } else {
        await page.waitForURL((url) => url.pathname === projectPath);
      }
      await page.reload();
      await expect(portal.getByText("Aktiver Link", { exact: false })).toBeVisible();
      await portal.getByRole("button", { name: "Link zurückziehen", exact: true }).click();
      await expect(portal.getByText("Der Portal-Link wurde zurückgezogen.", { exact: true }))
        .toBeVisible();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (stepError) {
    if (cleanupError) {
      throw new Error(
        `Portal-Gates fehlgeschlagen UND Cleanup fehlgeschlagen: ${cleanupError instanceof Error ? (cleanupError.message.split("\n")[0] ?? "") : String(cleanupError)}`,
        { cause: stepError },
      );
    }
    throw stepError;
  }
  if (cleanupError) throw cleanupError;

  // Ungültig-Ansicht (nur nach grünen Gates): spezifizierter 404-Endzustand
  // (Muster m1-08b/f10-01: erwartete Meldungen gezielt konsumieren, Rest bleibt
  // Fehler). Locale-unabhängig über eigene http-404-Einträge belegt.
  await page.context().clearCookies();
  await page.goto(tokenPath);
  await expect(page.getByRole("heading", { name: "Dieser Link ist ungültig.", exact: true }))
    .toBeVisible();
  const problems = browserProblems.get(page) ?? [];
  const http404 = problems.filter((entry) => entry.startsWith("http-404: "));
  expect(http404.length, "Erwartete http-404-Meldung nach Withdraw").toBeGreaterThan(0);
  const kept = problems.filter(
    (entry) => !entry.startsWith("http-404: ") && !(entry.startsWith("console-error:") && entry.includes("404")),
  );
  problems.length = 0;
  problems.push(...kept);
});

async function freshWorkspacePath(suffix: string): Promise<string> {
  const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
  return `/w/${workspaceId}${suffix}`;
}

async function gateEmptyRoute(
  page: Page,
  options: { path: string; email: string; heading: string; emptyText?: string; artifact: string },
): Promise<void> {
  await page.goto(options.path);
  await loginWithRealOtp(page, options.email, options.path);
  await expect(page.getByRole("heading", { name: options.heading, level: 1 })).toBeVisible();
  if (options.emptyText !== undefined) {
    await expect(page.getByText(options.emptyText).first()).toBeVisible();
  }
  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { name: options.heading, level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `${options.artifact} ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `${options.artifact} ${viewport.width}`);
      const boxes = await measureBoxes(page, ["main", "h1"]);
      writeMeasurementArtifact(options.artifact, options.path, viewport, boxes);
    });
  }
}

test("DASH-VG-07: Unangemeldet leitet Uebersicht auf /login um", async ({ page }) => {
  test.setTimeout(240_000);
  const dashboardPath = await freshWorkspacePath("/dashboard");
  await page.goto(dashboardPath);
  await page.waitForURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(dashboardPath);
});

test("DASH-VG-08: Externe sehen RLS-leere Uebersicht (kein Zugriffs-Leck)", async ({ page }) => {
  test.setTimeout(240_000);
  const shared = sharedState();
  const dashboardPath = `/w/${shared.workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, shared.externalEmail, dashboardPath);
  // Externe ohne Zuweisung: Queries passieren Caps, RLS liefert leer —
  // Uebersicht rendert mit ehrlichen Leerzustaenden (kein Zahlen-Leck).
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
  // Partial-Modell (verifiziert): Externe sehen nur Wiedervorlagen + Service;
  // Pipeline, Aufgaben, Abschluesse, Rechnungen etc. sind denied (kein Leck).
  const followups = page.locator('[data-dashboard-followups="true"]');
  await expect(followups).toBeVisible();
  await expect(followups.getByText("Nichts überfällig oder fällig.")).toBeVisible();
  const service = page.locator('[data-dashboard-service="true"]');
  await expect(service).toBeVisible();
  await expect(service.getByText("Keine Datei-Anfragen.")).toBeVisible();
  await expect(service.getByText("Servicevorgänge")).toHaveCount(0);
  await expect(service.getByText("Förderakten")).toHaveCount(0);
  await expect(page.locator('[data-dashboard-pipeline="true"]')).toHaveCount(0);
  await expect(page.locator('[data-dashboard-invoices="true"]')).toHaveCount(0);
  await expect(page.locator('[data-dashboard-closures="true"]')).toHaveCount(0);
  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `dashboard-external ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `dashboard-external ${viewport.width}`);
      const boxes = await measureBoxes(page, ["main", "h1"]);
      writeMeasurementArtifact("dashboard-external", dashboardPath, viewport, boxes);
    });
  }
});

test("DASH-VG-09: Rechnungen sind bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/rechnungen"),
    email: state().editorEmail,
    heading: "Belege ausstellen, versenden und auswerten",
    emptyText: "Keine Einträge",
    artifact: "rechnungen",
  });
});

test("DASH-VG-10: Aufgaben sind bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/aufgaben"),
    email: state().editorEmail,
    heading: "Aufgaben",
    artifact: "aufgaben",
  });
});

test("DASH-VG-11: Kalender ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/kalender"),
    email: state().editorEmail,
    heading: "Kalender",
    artifact: "kalender",
  });
});

test("DASH-VG-12: Katalog ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/katalog"),
    email: state().editorEmail,
    heading: "Produktkatalog",
    emptyText: "Der Katalog ist noch leer",
    artifact: "katalog",
  });
});

test("DASH-VG-13: Plantafel ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/plantafel"),
    email: state().editorEmail,
    heading: "Plantafel",
    artifact: "plantafel",
  });
});

test("DASH-VG-14: Standorte sind bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gateEmptyRoute(page, {
    path: await freshWorkspacePath("/sites"),
    email: state().editorEmail,
    heading: "Standorte",
    artifact: "sites",
  });
});

test("DASH-VG-35: Unbekannte IDs zeigen NotFound-Ansichten (kein Crash)", async ({ page }) => {
  test.setTimeout(240_000);
  const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
  const badAkte = `/w/${workspaceId}/anfragen/00000000-0000-4000-8000-000000000000`;
  await page.goto(badAkte);
  await loginWithRealOtp(page, state().editorEmail, badAkte);
  await expect(
    page.getByRole("heading", { name: "Die Projektakte ist nicht verfügbar.", level: 1 }),
  ).toBeVisible();
  const badOffer = `/w/${workspaceId}/angebote/00000000-0000-4000-8000-000000000000`;
  await page.goto(badOffer);
  await expect(
    page.getByRole("heading", { name: "Der Angebotsentwurf ist nicht verfügbar.", level: 1 }),
  ).toBeVisible();
  // 404 ist spezifizierter Endzustand (Muster VG-05): Meldungen konsumieren,
  // falls vorhanden (Dev-Rendering ist teils ohne 404-Response sauber).
  const problems = browserProblems.get(page) ?? [];
  const kept = problems.filter(
    (entry) => !entry.startsWith("http-404: ") && !(entry.startsWith("console-error:") && entry.includes("404")),
  );
  problems.length = 0;
  problems.push(...kept);
});

/* DASH-VG-36/37 leben in dash-vg-fault-injection.spec.ts (eigene Datei mit
 * serviceWorkers: "block" — der App-Service-Worker (skipWaiting +
 * clients.claim) schluckt sonst die zu injizierenden Netzfehler). */
