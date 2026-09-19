import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import type { M201RuntimeState } from "./m2-01-fixture";
import { seedM204ReleasedOffer } from "./m2-04-fixture";

/**
 * F2-Epic Visual-Gates M202/M203A/M203B1/M204 — Chromium (isoliert).
 * 375/768/1440: Axe WCAG A/AA, Console-/Page-/Netzfehler, Hydration,
 * Overflow-Freiheit. Muster: f201-number-format-visual-gates.spec.ts.
 *
 * M202/M203A/M203B1 teilen sich die Angebotsdetail-Route; die
 * Freigabe-/Ausstellungs-Panels rendern nur mit Release-/Issuance-State,
 * daher seedet jeder authentifizierte Test eine eigene freigegebene
 * Ausstellungsfassung in einem isolierten Workspace (Muster M2-04).
 * M204 gate-t die oeffentliche Token-Route ohne Login.
 */

const GATE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

type SerializedF2EpicVgState = {
  databaseUrl: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF2EpicVgState>;
  const required: Array<keyof SerializedF2EpicVgState> = [
    "databaseUrl",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F2EPIC-VG-State ist unvollständig.");
  }
  const complete = parsed as SerializedF2EpicVgState;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.m201EditorEmail,
    editorIdentityId: complete.m201EditorIdentityId,
    m201BatteryId: complete.m201BatteryId,
    m201InverterId: complete.m201InverterId,
    m201ModuleId: complete.m201ModuleId,
    m201ProjectId: complete.m201ProjectId,
    m201WallboxId: complete.m201WallboxId,
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.m201WorkspaceId,
  };
}

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
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(
    browserProblems.get(page) ?? [],
    "F2EPIC-VG: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
  ).toEqual([]);
});

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

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      offenders: Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const rect = (element as HTMLElement).getBoundingClientRect();
          return rect.right > window.innerWidth + 1 || rect.left < -1;
        })
        .slice(0, 5)
        .map((element) => {
          const node = element as HTMLElement;
          const classes = typeof node.className === "string" ? node.className : "";
          const right = Math.round(node.getBoundingClientRect().right);
          return `${node.tagName.toLowerCase()}.${classes.split(" ").slice(0, 3).join(".")} :: right=${right}`;
        }),
    };
  });
  const delta = overflow.scrollWidth - overflow.clientWidth;
  expect(
    delta,
    `${label}: kein horizontaler Ueberlauf (scroll=${overflow.scrollWidth}, client=${overflow.clientWidth}; Taeter: ${JSON.stringify(overflow.offenders)})`,
  ).toBeLessThanOrEqual(0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loginWithRealOtp(page: Page, email: string, expectedTarget: string): Promise<void> {
  const data = runtimeState();
  // M2-04-Muster: Angebotsrouten leiten nicht um — explizit zum Login.
  await page.goto(`/login?next=${encodeURIComponent(expectedTarget)}`);
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  let code = "";
  while (Date.now() < deadline) {
    const log = readFileSync(data.serverLogPath);
    const tail = log.subarray(Math.min(logOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match?.[1]) {
      code = match[1];
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (code === "") throw new Error("Der echte F2EPIC-VG-OTP wurde nicht protokolliert.");
  await otpInput.fill(code);
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedTarget);
}

async function gotoReleasedOffer(page: Page, validThroughOffsetDays: number): Promise<string> {
  const data = runtimeState();
  const released = await seedM204ReleasedOffer(data, {
    validThroughOffsetDays,
    isolatedWorkspace: true,
  });
  const offerPath = `/w/${released.workspaceId}/angebote/${released.offerId}?variante=${released.variantId}`;
  await page.goto(offerPath);
  await loginWithRealOtp(page, data.editorEmail, offerPath);
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
  return offerPath;
}

async function gateViewports(
  page: Page,
  label: string,
  anchor: () => Promise<void>,
): Promise<void> {
  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await anchor();
      await expectNoHorizontalOverflow(page, `${label} ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `${label} ${viewport.width}`);
    });
  }
}

test("F2EPIC-VG-01: M202 PDF-Entwurf-Panel ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gotoReleasedOffer(page, 21);
  const draftHeading = page.getByRole("heading", {
    name: "Interner, nicht verbindlicher PDF-Entwurf",
    exact: true,
  });
  await expect(draftHeading).toBeVisible();
  await draftHeading.scrollIntoViewIfNeeded();
  await gateViewports(page, "m202-pdf-entwurf", async () => {
    await expect(draftHeading).toBeVisible();
  });
});

test("F2EPIC-VG-02: M203A Freigabekandidat-Panel ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gotoReleasedOffer(page, 22);
  const releaseHeading = page.getByRole("heading", {
    name: "Angebots-Freigabekandidat",
    exact: true,
  });
  await expect(releaseHeading).toBeVisible();
  await releaseHeading.scrollIntoViewIfNeeded();
  await gateViewports(page, "m203a-freigabekandidat", async () => {
    await expect(releaseHeading).toBeVisible();
  });
});

test("F2EPIC-VG-03: M203B1 Ausstellungsfassung-Panel ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await gotoReleasedOffer(page, 23);
  const issuanceHeading = page.getByRole("heading", {
    name: "Ausstellungsfassung",
    exact: true,
  });
  await expect(issuanceHeading).toBeVisible();
  await issuanceHeading.scrollIntoViewIfNeeded();
  await gateViewports(page, "m203b1-ausstellungsfassung", async () => {
    await expect(issuanceHeading).toBeVisible();
  });
});

test("F2EPIC-VG-04: M204 Token-Route ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await page.goto(`/s/${token}`);
  const guardHeading = page.getByRole("heading", {
    name: "Signaturlink vorbereitet · noch nicht freigegeben",
    level: 1,
  });
  await expect(guardHeading).toBeVisible();
  await gateViewports(page, "m204-token-route", async () => {
    await expect(guardHeading).toBeVisible();
  });
});
