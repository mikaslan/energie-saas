import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  poolOne,
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";
import { M2_01_E2E_CONTACT, seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F6-01 Schaltplan Visual-Gates — Chromium (isolierter Workspace).
 * Angebotsdetail mit gerendertem Diagramm bzw. Gate-Hinweis bei
 * 375/768/1440: Axe WCAG A/AA, Console-/Page-/Netzfehler,
 * Hydration-Warnungen, Overflow-Freiheit. Muster: F208-VG
 * (f208-draw-visual-gates.spec.ts); eine F201-VG-Vorlage existiert im Repo
 * nicht.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

const GATE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F601-VG-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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
});

test.afterEach(async ({ page }) => {
  expect(
    browserProblems.get(page) ?? [],
    "F601-VG: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
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
          const rect = node.getBoundingClientRect();
          const classes = typeof node.className === "string" ? node.className : "";
          return `${node.tagName.toLowerCase()}.${classes.split(" ").slice(0, 3).join(".")} :: right=${Math.round(rect.right)}`;
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
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function seedReadyProject(skuSuffix: string): Promise<{ workspaceId: string; projectId: string }> {
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const seed = await seedM201ReadyProject(state().databaseUrl, {
    workspaceId,
    editorIdentityId: actorId,
    skuSuffix,
  });
  return { workspaceId, projectId: seed.projectId };
}

async function openOfferDetail(page: Page, workspaceId: string, projectId: string): Promise<string> {
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, state().editorEmail, projectPath);
  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  return page.url();
}

async function moveProjectToCommercialOfferColumn(workspaceId: string, projectId: string): Promise<void> {
  await poolOne(async (pool) => {
    const lane = await pool.query<{ board_id: string; column_id: string }>(`
      select board.id as board_id, offer_column.id as column_id
        from kanban_board board
        join kanban_column offer_column
          on offer_column.workspace_id = board.workspace_id
         and offer_column.board_id = board.id
         and offer_column.column_type = 'offer'
         and offer_column.archived_at is null
       where board.workspace_id = $1::uuid
         and board.scope = 'commercial'
         and board.is_default = true
         and board.archived_at is null
       order by offer_column.position, offer_column.id
       limit 1
    `, [workspaceId]);
    const target = lane.rows[0];
    if (!target) throw new Error("F601-VG: Gewerbe-Angebots-Spalte fehlt.");
    await pool.query(
      `update project set kanban_board_id = $1::uuid, kanban_column_id = $2::uuid
        where workspace_id = $3::uuid and id = $4::uuid`,
      [target.board_id, target.column_id, workspaceId, projectId],
    );
  });
}

test("F601-VG-01: Angebotsdetail mit Schaltplan ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { workspaceId, projectId } = await seedReadyProject(`f601-vg-${randomUUID().slice(0, 8)}`);
  await openOfferDetail(page, workspaceId, projectId);
  const schematic = page.locator('[data-offer-schematic="true"]');
  await expect(schematic).toBeVisible();
  await expect(schematic.getByRole("img")).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(schematic.getByRole("img")).toBeVisible();
      await expectNoHorizontalOverflow(page, `schaltplan ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `schaltplan ${viewport.width}`);
    });
  }

  await test.step("Export-Button: 44px-Target", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const button = schematic.getByTestId("schematic-export-download");
    await expect(button, "Export-Button sichtbar").toBeVisible();
    const box = await button.boundingBox();
    expect(box, "Export-Button hat messbare Box").not.toBeNull();
    expect(box!.height, "Export-Button mind. 44 px hoch").toBeGreaterThanOrEqual(44);
  });
});

test("F601-VG-02: Gate-Hinweis und Export-Refuse sind axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { workspaceId, projectId } = await seedReadyProject(`f601-vg-gate-${randomUUID().slice(0, 8)}`);
  const offerUrl = await openOfferDetail(page, workspaceId, projectId);
  await moveProjectToCommercialOfferColumn(workspaceId, projectId);
  const offerTarget = new URL(offerUrl);
  await page.goto(`${offerTarget.pathname}${offerTarget.search}`);

  const schematic = page.locator('[data-offer-schematic="true"]');
  await expect(schematic.getByTestId("schematic-gate-notice")).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(schematic.getByTestId("schematic-gate-notice")).toBeVisible();
      await expectNoHorizontalOverflow(page, `schaltplan-gate ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `schaltplan-gate ${viewport.width}`);
    });
  }

  await test.step("Export-Refuse bleibt axe-sauber", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const noDownload = page.waitForEvent("download", { timeout: 2_500 });
    await schematic.getByTestId("schematic-export-download").click();
    await expect(schematic.getByTestId("schematic-export-refused")).toBeVisible();
    await expectNoWcagAaAxeViolations(page, "schaltplan-gate refuse");
    await expect(noDownload).rejects.toThrow();
  });
});
