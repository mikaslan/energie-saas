import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  readM201Offer,
  type M201RuntimeState,
} from "./m2-01-fixture";

const browserErrors = new WeakMap<Page, string[]>();

type SerializedM201State = {
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

type ReflowEvidence = {
  clientWidth: number;
  scrollWidth: number;
  offenders: string[];
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM201State>;
  const required: Array<keyof SerializedM201State> = [
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
    throw new Error("Der private M2-01-A11y-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM201State;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maximumCssDurationSeconds(value: string): number {
  return Math.max(...value.split(",").map((part) => {
    const normalized = part.trim();
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) throw new Error(`Ungültige CSS-Dauer: ${normalized}`);
    return normalized.endsWith("ms") ? numeric / 1_000 : numeric;
  }));
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte M2-01-A11y-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  const currentUrl = new URL(page.url());
  if (`${currentUrl.pathname}${currentUrl.search}` === expectedTarget) {
    const offerState = await page.locator("[data-offer-detail-state]")
      .getAttribute("data-offer-detail-state");
    if (offerState !== "unauthenticated") return;
    await page.goto(`/login?next=${encodeURIComponent(expectedTarget)}`);
  }
  await page.waitForURL((url) => url.pathname === "/login");
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(
    state.serverLogPath,
    state.editorEmail,
    logOffset,
  );
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));
  expect(violations, `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`)
    .toEqual([]);
}

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
        return `${element.tagName.toLowerCase()}${id}`;
      });
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      offenders,
    };
  });
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  await expect.poll(async () => {
    const evidence = await reflowEvidence(page);
    return evidence.scrollWidth - evidence.clientWidth;
  }, {
    message: `${label}: kein horizontaler Dokumentüberlauf`,
  }).toBeLessThanOrEqual(0);
  const evidence = await reflowEvidence(page);
  expect(
    evidence.scrollWidth,
    `${label}: ${JSON.stringify(evidence.offenders)} ragen aus dem Dokument`,
  ).toBeLessThanOrEqual(evidence.clientWidth);
}

async function expectReadableBodyCopy(page: Page): Promise<void> {
  const copy = page.getByText(
    "Separater gespeicherter Vertriebswert. Er beeinflusst weder lokale Positionen noch serverberechnete Kundensummen.",
    { exact: true },
  );
  await expect(copy).toBeVisible();
  const computed = await copy.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(computed.fontSize, "repräsentative Bodycopy hat mindestens 16 CSS-Pixel")
    .toBeGreaterThanOrEqual(16);
  expect(computed.lineHeight, "repräsentative Bodycopy hat mindestens 24 CSS-Pixel Zeilenhöhe")
    .toBeGreaterThanOrEqual(24);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "M2-01 A11y Browser-Konsole und Page-Errors")
    .toEqual([]);
});

test.describe("M2-01 A11y-Gate", () => {
  test("belegt Axe, Tastatur, Fokus, Reflow und reduzierte Bewegung", async ({ page }) => {
    test.setTimeout(150_000);
    const state = runtimeState();
    const offer = await readM201Offer(state);
    const offerPath = `/w/${state.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;

    await page.goto(offerPath);
    await loginWithRealOtp(page, offerPath);
    await expect(page.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();

    await test.step("Basiszustand, Skip-Link und aktive Variante", async () => {
      const desktopNavigation = page.getByRole("navigation", { name: "Angebotsvarianten" });
      await expect(desktopNavigation).toBeVisible();
      await expect(desktopNavigation.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(desktopNavigation.locator('[aria-current="page"]'))
        .toHaveAttribute("href", offerPath);

      const skipLink = page.getByRole("link", { name: "Zum Angebotseditor springen" });
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await expect.poll(() => page.evaluate(() => document.activeElement === document.body))
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.locator("#offer-editor-main")).toBeFocused();

      await expectReadableBodyCopy(page);
      await expectNoWcagAaAxeViolations(page, "Angebotseditor Basiszustand");
    });

    await test.step("Mobile/Desktop-A11y-Tree und Reflow-Matrix", async () => {
      const widths = [320, 375, 390, 768, 1024, 1440, 1920] as const;
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await expectNoHorizontalOverflow(page, `${width} CSS px`);

        const mobileSelect = page.getByRole("combobox", { name: "Angebotsvariante" });
        const desktopNavigation = page.getByRole("navigation", { name: "Angebotsvarianten" });
        if (width < 640) {
          await expect(mobileSelect).toHaveCount(1);
          await expect(desktopNavigation).toHaveCount(0);
        } else {
          await expect(mobileSelect).toHaveCount(0);
          await expect(desktopNavigation).toHaveCount(1);
        }
      }

      await page.setViewportSize({ width: 1024, height: 1000 });
      const zoomStyle = await page.addStyleTag({
        content: ":root { font-size: 200% !important; }",
      });
      await expectNoHorizontalOverflow(page, "200 % Textzoom bei 1024 CSS px");
      await expect(page.getByRole("button", { name: "Angebotsentwurf speichern" }))
        .toBeVisible();
      await zoomStyle.evaluate((element) => (element as Element).remove());

      await page.setViewportSize({ width: 320, height: 1000 });
      await expectNoHorizontalOverflow(page, "400-%-Reflowäquivalent bei 320 CSS px");
      await expectNoWcagAaAxeViolations(page, "mobiler 320-CSS-px-Zustand");
    });

    await test.step("Reduced Motion wird im berechneten Stil wirksam", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(() => page.evaluate(() =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      const motion = await page.locator('main[data-wmee-scope="offer"]').evaluate((element) => {
        const scoped = window.getComputedStyle(element);
        const descendant = element.querySelector<HTMLElement>("button");
        if (!descendant) throw new Error("Der Angebotseditor enthält keinen Button.");
        const computed = window.getComputedStyle(descendant);
        return {
          token: scoped.getPropertyValue("--offer-duration-4").trim(),
          transitionDuration: computed.transitionDuration,
          animationDuration: computed.animationDuration,
          scrollBehavior: computed.scrollBehavior,
        };
      });
      expect(motion.token).toMatch(/^0?\.01ms$/u);
      expect(maximumCssDurationSeconds(motion.transitionDuration))
        .toBeLessThanOrEqual(0.000_01);
      expect(maximumCssDurationSeconds(motion.animationDuration))
        .toBeLessThanOrEqual(0.000_01);
      expect(motion.scrollBehavior).toBe("auto");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });

    await test.step("Tastatur-Reorder meldet Status und behält Zeilenfokus", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const addPosition = page.getByRole("button", {
        name: "Freie Position hinzufügen",
        exact: true,
      }).first();
      await addPosition.click();
      await addPosition.click();
      const downButton = page.getByRole("button", {
        name: / in .+ nach unten verschieben$/u,
      }).and(page.locator(":enabled")).first();
      await expect(downButton).toBeVisible();
      const accessibleName = await downButton.getAttribute("aria-label");
      expect(accessibleName).toMatch(/^.+ in .+ nach unten verschieben$/u);
      const sameRowDownButton = page.getByRole("button", {
        name: accessibleName ?? "",
        exact: true,
      });
      const positionName = (accessibleName ?? "").replace(/ nach unten verschieben$/u, "");

      await sameRowDownButton.focus();
      await page.keyboard.press("Enter");
      await expect(sameRowDownButton).toBeFocused();
      await expect(page.getByRole("status").filter({
        hasText: new RegExp(`^${escapeRegExp(positionName)} ist jetzt Position \\d+\\.$`, "u"),
      })).toBeAttached();
    });

    await test.step("Dirty-Dialog trappt Fokus, Escape schließt und gibt Fokus zurück", async () => {
      const overviewLink = page.getByRole("link", { name: "Zur Angebotsübersicht" });
      await overviewLink.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "Möchtest du den lokalen Entwurf verlassen?",
      });
      const stayButton = dialog.getByRole("button", { name: "Bleiben" });
      const saveAndContinue = dialog.getByRole("button", { name: "Speichern und fortfahren" });
      await expect(dialog).toBeVisible();
      await expect(stayButton).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(saveAndContinue).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(stayButton).toBeFocused();
      await expectNoWcagAaAxeViolations(page, "Dirty-Navigation-Dialog");

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(overviewLink).toBeFocused();
      await page.getByRole("button", { name: "Änderungen verwerfen" }).click();
    });

    await test.step("Validierungsfehler ist fokussiert und mit dem Feld verknüpft", async () => {
      const variantName = page.getByLabel("Variantenname").first();
      await variantName.fill("");
      await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
      const validationSummary = page.getByRole("alert").filter({
        hasText: "Bitte prüfe den lokalen Entwurf.",
      });
      await expect(validationSummary).toBeVisible();
      await expect(variantName).toBeFocused();
      await expect(variantName).toHaveAttribute("aria-invalid", "true");
      const errorLink = validationSummary.getByRole("link").filter({
        hasText: /Variantenname|1 bis 120 Zeichen/u,
      });
      await expect(errorLink).toHaveAttribute("href", "#variant-name");
      await expectNoWcagAaAxeViolations(page, "Validierungszustand");
    });
  });
});
