import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  readM201Offer,
  type M201RuntimeState,
} from "./m2-01-fixture";

// DASH-VG-06: blockierende Browser-Gates fuer das Angebots-Detail (Agent 5).
// Laeuft absichtlich spaet (z-Prefix, Muster m2-01-zzz-visual-candidates):
// Das M2-01-Angebot entsteht erst durch die Browser-Action anderer Specs.
// Ohne Suite-Kontext (fokussierter Lauf) wird ehrlich geskippt statt
// erfundener Daten — der verbindliche Nachweis laeuft in der vollen Suite.

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
    "DASH-VG-06: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
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
  serverLogPath: string,
): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const logOffset = statSync(serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  await expect(page.getByLabel("Sechsstelliger Code")).toBeVisible();
  const otp = await otpFromPrivateDevMailLog(serverLogPath, email, logOffset);
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

type M201E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  m201WorkspaceId: string;
  m201ProjectId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201ModuleId: string;
  m201InverterId: string;
  m201BatteryId: string;
  m201WallboxId: string;
};

function m201State(): M201E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<M201E2EState>;
  const required: Array<keyof M201E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "m201WorkspaceId",
    "m201ProjectId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201ModuleId",
    "m201InverterId",
    "m201BatteryId",
    "m201WallboxId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private DASH-VG-06-M201-State ist unvollständig.");
  }
  return parsed as M201E2EState;
}

test("DASH-VG-06: Angebots-Detail ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const data = m201State();
  const runtime: M201RuntimeState = {
    databaseUrl: data.databaseUrl,
    editorEmail: data.m201EditorEmail,
    editorIdentityId: data.m201EditorIdentityId,
    m201BatteryId: data.m201BatteryId,
    m201InverterId: data.m201InverterId,
    m201ModuleId: data.m201ModuleId,
    m201ProjectId: data.m201ProjectId,
    m201WallboxId: data.m201WallboxId,
    serverLogPath: data.serverLogPath,
    workspaceId: data.m201WorkspaceId,
  };
  let offerId: string;
  try {
    offerId = (await readM201Offer(runtime)).offerId;
  } catch {
    test.skip(true, "Kein M2-01-Angebot im Suite-Kontext (fokussierter Lauf ohne Browser-Action).");
    return;
  }
  const detailPath = `/w/${data.m201WorkspaceId}/angebote/${offerId}`;
  await page.goto(detailPath);
  await loginWithRealOtp(page, data.m201EditorEmail, detailPath, data.serverLogPath);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('[data-wmee-scope="offer"]').first()).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `Angebots-Detail ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `Angebots-Detail ${viewport.width}`);
      const boxes = await measureBoxes(page, [
        "main",
        'nav[aria-label="Brotkrumen"]',
        "h1",
        '[data-wmee-scope="offer"]',
      ]);
      writeMeasurementArtifact("angebotdetail", detailPath, viewport, boxes);
    });
  }
});
