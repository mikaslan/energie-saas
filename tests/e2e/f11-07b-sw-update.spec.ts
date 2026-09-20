import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

/**
 * F11-07b SW-Update-UI — Chromium-E2E (kein Workspace nötig, ECHTER
 * Service-Worker-Lebenszyklus). Der Testrunner tauscht `public/sw.js`
 * dateibasiert (Byte-Änderung, finally-Restore mit Byte-Assert —
 * ungefährlich, weil die Suite seriell läuft), `update()` erzeugt einen
 * echten wartenden Worker, die Notice erscheint, „Aktualisieren" löst
 * echtes SKIP_WAITING + Reload aus, danach ist der neue Worker aktiv.
 */

// CJS-Spec (kein import.meta): Pfad ab Repo-Root (CWD des E2E-Laufs).
const SW_PATH = resolve("public/sw.js");
if (!existsSync(SW_PATH)) {
  throw new Error(`public/sw.js nicht gefunden (CWD: ${process.cwd()}).`);
}

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

async function fireInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const result = { outcome: "accepted", platform: "" };
    const event = new Event("beforeinstallprompt");
    (event as unknown as { prompt: () => Promise<typeof result> }).prompt = () =>
      Promise.resolve(result);
    (event as unknown as { userChoice: Promise<typeof result> }).userChoice =
      Promise.resolve(result);
    window.dispatchEvent(event);
  });
}

test("F11-07b-E2E-01: SW-Update meldet sich, Aktualisieren aktiviert echten neuen Worker", async ({
  page,
}) => {
  test.setTimeout(240_000);
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
  const notice = page.getByTestId("sw-update-notice");
  await expect(notice).toHaveCount(0);

  // Erstinstallation abwarten (Muster F11-02): update() auf eine noch
  // installierende Registrierung würfe InvalidStateError.
  const workerState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const worker = registration.active ?? registration.waiting ?? registration.installing;
      if (worker?.state === "activated") return "activated";
      if (worker?.state === "redundant") return "redundant";
      if (Date.now() > deadline) return worker?.state ?? "no-worker";
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
  expect(workerState).toBe("activated");

  const original = readFileSync(SW_PATH, "utf8");
  const versionMatch = /const SW_VERSION = "([^"]+)"/u.exec(original);
  if (!versionMatch?.[1]) throw new Error("SW_VERSION in public/sw.js nicht gefunden.");
  const e2eVersion = `${versionMatch[1]}-e2e`;
  const cachesBefore = await page.evaluate(() =>
    caches.keys().then((keys) => keys.filter((key) => key.startsWith("wmee-"))),
  );

  // Koexistenz: Install-Hinweis zeigen, dann updaten — die Notice gewinnt,
  // der Hinweis tritt zurück (keine doppelten Banner).
  await fireInstallPrompt(page);
  const hint = page.getByTestId("pwa-install-hint");
  await expect(hint).toBeVisible();

  writeFileSync(SW_PATH, original.replace(versionMatch[0], `const SW_VERSION = "${e2eVersion}"`));
  let restoreError = "";
  try {
    const updated = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return "unsupported";
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return "no-registration";
      await registration.update();
      return "update-requested";
    });
    expect(updated).toBe("update-requested");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice.getByText("Eine neue Version ist verfügbar.")).toBeVisible();
    await expect(hint).toHaveCount(0);

    // Axe + Überlauf im SICHTBAREN Zustand (nicht nur versteckt am Ende).
    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "F11-07b SW-Update-UI sichtbar");
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.evaluate(() => {
      (window as unknown as { __preUpdate: boolean }).__preUpdate = true;
    });
    await notice.getByRole("button", { name: "Aktualisieren", exact: true }).click();
    await page.waitForFunction(
      () => (window as unknown as { __preUpdate?: boolean }).__preUpdate === undefined,
    );
    await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();

    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames).toContain(`wmee-static-${e2eVersion}`);
    for (const stale of cachesBefore) {
      expect(cacheNames, `Alt-Cache ${stale} geraeumt`).not.toContain(stale);
    }
  } finally {
    try {
      writeFileSync(SW_PATH, original);
      if (readFileSync(SW_PATH, "utf8") !== original) {
        restoreError = "Byte-Vergleich nach Restore ungleich";
      }
    } catch (error) {
      restoreError = String(error);
    }
  }
  expect(restoreError, "sw.js-Restore").toBe("");

  for (const width of [375, 768, 1440]) await expectNoHorizontalOverflow(page, width);
  await expectNoWcagAaAxeViolations(page, "F11-07b SW-Update-UI");
  expect(failedResponses, "keine 4xx/5xx-Antworten").toEqual([]);
  expect(errors, "Browser-Konsole und Page-Errors der SW-Update-UI").toEqual([]);
});
