import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F2.1 Visual-Gates Einstellungsseite Angebotsnummern — Chromium (isoliert).
 * 375/768/1440: Axe WCAG A/AA, Console-/Page-/Netzfehler, Hydration,
 * Overflow-Freiheit, 44px-Submit.
 */

const GATE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

type SerializedF201VgState = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  serverLogPath: string;
};

function runtimeState(): SerializedF201VgState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF201VgState>;
  const required: Array<keyof SerializedF201VgState> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F201-VG-State ist unvollständig.");
  }
  return parsed as SerializedF201VgState;
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
    "F201-VG: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
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
  if (code === "") throw new Error("Der echte F201-VG-OTP wurde nicht protokolliert.");
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

test("F201-VG-01: Angebotsnummern-Seite ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const data = runtimeState();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
      workspaceId,
      "F2.1 isolierter VG-Workspace",
    ]);
    await client.query(
      "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
      [workspaceId],
    );
    await client.query(
      `insert into membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb)`,
      [workspaceId, data.editorIdentityId],
    );
  } finally {
    client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }

  const settingsPath = `/w/${workspaceId}/einstellungen/angebotsnummern`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Angebotsnummern", exact: true })).toBeVisible();
  await expect(page.getByTestId("number-format-preview")).toBeVisible();

  for (const viewport of GATE_VIEWPORTS) {
    await test.step(`Viewport ${viewport.width}`, async () => {
      await page.setViewportSize(viewport);
      await expect(page.getByTestId("number-format-preview")).toBeVisible();
      await expectNoHorizontalOverflow(page, `angebotsnummern ${viewport.width}`);
      await expectNoWcagAaAxeViolations(page, `angebotsnummern ${viewport.width}`);
    });
  }

  await test.step("Submit: 44px-Target", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const submit = page.getByTestId("number-format-submit");
    await expect(submit).toBeVisible();
    const box = await submit.boundingBox();
    expect(box, "Submit hat messbare Box").not.toBeNull();
    expect(box!.height, "Submit mind. 44 px hoch").toBeGreaterThanOrEqual(44);
  });
});
