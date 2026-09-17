import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state,
} from "./m1-11g-fixture";

// DASH-VG-15..34: blockierende Browser-Gates fuer die 20 Einstellungsseiten
// (Agent 5, Folgeauftrag §7.1). Helfer dupliziert nach Repo-Konvention
// (Entscheidung in dash-screen-inventory.md §6).

type Viewport = { width: number; height: number };

const GATE_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
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
    "DASH-VG-EINSTELLUNGEN: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
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

async function loginWithRealOtp(
  page: Page,
  email: string,
  expectedPath: string,
  direct = false,
): Promise<void> {
  if (direct) {
    // Route ohne Redirect (In-Place-Auth wie Angebotsprofile): direkt zum Login.
    await page.goto(`/login?next=${encodeURIComponent(expectedPath)}`);
  }
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

type SettingsRoute = { slug: string; heading: string; directLogin?: boolean };

const SETTINGS_ROUTES: readonly SettingsRoute[] = [
  { slug: "angebots-vorlagen", heading: "Angebots-Vorlagen" },
  { slug: "angebotsprofile", heading: "Angebotsprofile", directLogin: true },
  { slug: "aufgaben-vorlagen", heading: "Aufgaben-Vorlagen" },
  { slug: "checklisten-vorlagen", heading: "Checklisten-Vorlagen" },
  { slug: "datei-anfragen-vorlagen", heading: "Datei-Anfragen-Vorlagen" },
  { slug: "e-mail-vorlagen", heading: "E-Mail-Vorlagen" },
  { slug: "ereignistypen", heading: "Ereignistypen" },
  { slug: "foerder-vorlagen", heading: "Förder-Vorlagen" },
  { slug: "lead-quellen", heading: "Lead-Quellen" },
  { slug: "paket-vorlagen", heading: "Paket-Vorlagen" },
  { slug: "planung", heading: "Planung" },
  { slug: "planungs-vorlagen", heading: "Planungs-Vorlagen" },
  { slug: "portal-status", heading: "Portal-Status" },
  { slug: "rabatt-vorlagen", heading: "Rabatt-Vorlagen" },
  { slug: "rechnungsstellung", heading: "Rechnungsstellung" },
  { slug: "teams", heading: "Teams" },
  { slug: "termin-vorlagen", heading: "Termin-Vorlagen" },
  { slug: "verlustgruende", heading: "Verlustgründe" },
  { slug: "wirtschaftlichkeit", heading: "Wirtschaftlichkeit" },
  { slug: "zahlarten", heading: "Zahlarten" },
];

for (const [index, route] of SETTINGS_ROUTES.entries()) {
  const vgNumber = String(index + 15).padStart(2, "0");
  test(`DASH-VG-${vgNumber}: Einstellungen/${route.slug} sind bei 375/768/1440 axe-/konsolen-sauber und overflow-frei`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
    const settingsPath = `/w/${workspaceId}/einstellungen/${route.slug}`;
    if (route.directLogin === true) {
      await loginWithRealOtp(page, state().editorEmail, settingsPath, true);
    } else {
      await page.goto(settingsPath);
      await loginWithRealOtp(page, state().editorEmail, settingsPath);
    }
    await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();

    for (const viewport of GATE_VIEWPORTS) {
      await test.step(`Viewport ${viewport.width}`, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
        await expectNoHorizontalOverflow(page, `einstellungen-${route.slug} ${viewport.width}`);
        await expectNoWcagAaAxeViolations(page, `einstellungen-${route.slug} ${viewport.width}`);
        const boxes = await measureBoxes(page, ["main", "h1"]);
        writeMeasurementArtifact(`einstellungen-${route.slug}`, settingsPath, viewport, boxes);
      });
    }
  });
}
