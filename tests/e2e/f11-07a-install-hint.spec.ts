import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

/**
 * F11-07a Install-Hinweis — Chromium-E2E (kein Workspace nötig).
 * Der Hinweis erscheint nur auf das echte `beforeinstallprompt`-Signal
 * (im Test synthetisch befeuert, Browser-Verdrahtung inklusive
 * prompt()/userChoice), nie im Standalone-Mode und nie nach „Nicht
 * jetzt" (Reload-fest). Doppelklick ruft prompt() genau einmal.
 */

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

async function fireInstallPrompt(page: Page, outcome: "accepted" | "dismissed"): Promise<void> {
  await page.evaluate((choice) => {
    const result = { outcome: choice, platform: "" };
    const event = new Event("beforeinstallprompt");
    (event as unknown as { prompt: () => Promise<typeof result> }).prompt = () => {
      const counter = window as unknown as { __pwaPromptCalls?: number };
      counter.__pwaPromptCalls = (counter.__pwaPromptCalls ?? 0) + 1;
      return Promise.resolve(result);
    };
    (event as unknown as { userChoice: Promise<typeof result> }).userChoice =
      Promise.resolve(result);
    window.dispatchEvent(event);
  }, outcome);
}

async function promptCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __pwaPromptCalls?: number }).__pwaPromptCalls ?? 0,
  );
}

async function fireInstallPromptUntilVisible(
  page: Page,
  outcome: "accepted" | "dismissed",
): Promise<void> {
  // Hydrations-Race: Ein Dispatch vor Effekt-Anhang (SSR gemalt, React noch
  // nicht hydriert — CI-okkasionell) geht verloren. Wiederholen bis sichtbar;
  // dauerhaftes Fehlen bleibt rot (ehrlicher Fail, kein Maskieren).
  const hint = page.getByTestId("pwa-install-hint");
  const deadline = Date.now() + 10_000;
  for (;;) {
    await fireInstallPrompt(page, outcome);
    try {
      await expect(hint).toBeVisible({ timeout: 1000 });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("Install-Hinweis erscheint nicht (trotz Re-Dispatch).");
      }
    }
  }
}

test("F11-07a-E2E-01: Install-Hinweis folgt dem Browser-Signal, Dismiss und Standalone blenden aus", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto("/login");
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  const hint = page.getByTestId("pwa-install-hint");
  await expect(hint).toHaveCount(0);

  // Signal → sichtbar → Installieren ruft prompt() → ausgeblendet.
  await fireInstallPromptUntilVisible(page, "accepted");
  await expect(hint.getByText("WMEE als App installieren?")).toBeVisible();
  // Axe + Überlauf im SICHTBAREN Zustand (nicht nur versteckt am Ende).
  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  await expectNoWcagAaAxeViolations(page, "F11-07a Install-Hinweis sichtbar");
  await page.setViewportSize({ width: 1280, height: 900 });
  await hint.getByRole("button", { name: "Installieren", exact: true }).click();
  expect(await promptCallCount(page)).toBe(1);
  await expect(hint).toHaveCount(0);

  // Accepted wird NICHT gemerkt: Reload + Signal → wieder sichtbar.
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPromptUntilVisible(page, "accepted");

  // Doppelklick ruft prompt() genau einmal (Ref-Guard).
  await hint.getByRole("button", { name: "Installieren", exact: true }).dblclick();
  await expect(hint).toHaveCount(0);
  expect(await promptCallCount(page)).toBe(1);

  // userChoice dismissed → gemerkt wie „Nicht jetzt" (Reload-fest).
  await fireInstallPromptUntilVisible(page, "dismissed");
  await hint.getByRole("button", { name: "Installieren", exact: true }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPrompt(page, "accepted");
  await expect(hint).toHaveCount(0);

  // „Nicht jetzt" → ausgeblendet und Reload-fest (frischer Storage erst).
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPromptUntilVisible(page, "accepted");
  await hint.getByRole("button", { name: "Nicht jetzt", exact: true }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPrompt(page, "accepted");
  await expect(hint).toHaveCount(0);

  // appinstalled (Menü-Installation) → weg + gemerkt.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPromptUntilVisible(page, "accepted");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPrompt(page, "accepted");
  await expect(hint).toHaveCount(0);

  // Standalone-Mode → Signal wird ignoriert. Vorher Storage leeren,
  // damit „versteckt" eindeutig der Standalone-Guard ist (nicht das
  // gemerkte Wegklicken von oben).
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) =>
      query.includes("display-mode: standalone")
        ? {
          matches: true,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }
        : original(query)) as unknown as typeof window.matchMedia;
  });
  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPrompt(page, "accepted");
  await expect(hint).toHaveCount(0);

  for (const width of [375, 768, 1440]) await expectNoHorizontalOverflow(page, width);
  await expectNoWcagAaAxeViolations(page, "F11-07a Install-Hinweis");
  expect(failedResponses, "keine 4xx/5xx-Antworten").toEqual([]);
  expect(errors, "Browser-Konsole und Page-Errors des Install-Hinweises").toEqual([]);
});

test("F11-07a-E2E-02: iOS-standalone blendet den Hinweis aus", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "standalone", {
      value: true,
      configurable: true,
    });
  });
  await page.goto("/login");
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
  await fireInstallPrompt(page, "accepted");
  await expect(page.getByTestId("pwa-install-hint")).toHaveCount(0);
});
