import { createHash, randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import type { Pool } from "pg";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM204ReleasedOffer } from "./m2-04-fixture";
import {
  resolveEditorId,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F2.8 Draw-Signatur Visual-Gates — Chromium (isolierter Workspace).
 * Portal-Dokumentzeile mit geöffneter Draw-Erfassung bei 375/768/1440:
 * Axe WCAG A/AA, Console-/Page-/Netzfehler, Hydration-Warnungen,
 * Overflow-Freiheit. F2-Routen-Gate (Agent 5, Lane 5b).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
};

const GATE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F208-VG-State ist unvollständig (${key}).`);
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
    "F208-VG: keine Console-/Page-/Netzfehler und keine Hydration-Warnung",
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

async function tenantFn(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test("F208-VG-01: Portal-Draw-Erfassung ist bei 375/768/1440 axe-/konsolen-sauber und overflow-frei", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const data = state();
  const editorIdentityId = await resolveEditorId();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const released = await seedM204ReleasedOffer(
      { databaseUrl: data.databaseUrl, editorIdentityId, workspaceId: "" } as never,
      { isolatedWorkspace: true },
    );
    const signatureRaw = randomBytes(32);
    await tenantFn(
      pool,
      released.workspaceId,
      editorIdentityId,
      `select public.create_signature_request($1::uuid, $2::uuid, $3::uuid, 14, $4::bytea) as result`,
      [released.workspaceId, released.offerId, released.variantId, createHash("sha256").update(signatureRaw).digest()],
    );
    const inviteRaw = randomBytes(32);
    await tenantFn(
      pool,
      released.workspaceId,
      editorIdentityId,
      `select public.create_portal_invite($1::uuid, $2::uuid, 14, $3::bytea) as result`,
      [released.workspaceId, released.projectId, createHash("sha256").update(inviteRaw).digest()],
    );
    const tokenPath = `/p/${inviteRaw.toString("base64url")}`;
    await page.goto(tokenPath);
    await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();

    const disclosure = page.getByTestId("draw-signature-disclosure");
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    await expect(page.getByTestId("draw-signature-canvas")).toBeVisible();

    for (const viewport of GATE_VIEWPORTS) {
      await test.step(`Viewport ${viewport.width}`, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByTestId("draw-signature-canvas")).toBeVisible();
        await expectNoHorizontalOverflow(page, `portal-draw ${viewport.width}`);
        await expectNoWcagAaAxeViolations(page, `portal-draw ${viewport.width}`);
      });
    }

    // Touch-Targets der Draw-Aktionen (44px-Skill-Bar).
    await test.step("Draw-Aktionen: 44px-Targets", async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      for (const testId of ["draw-signature-clear", "draw-signature-submit"] as const) {
        const button = page.getByTestId(testId);
        await expect(button, `${testId} sichtbar`).toBeVisible();
        const box = await button.boundingBox();
        expect(box, `${testId} hat messbare Box`).not.toBeNull();
        expect(box!.height, `${testId} mind. 44 px hoch`).toBeGreaterThanOrEqual(44);
      }
    });
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
});
