import { expect, test } from "playwright/test";

/**
 * F11-02 Service Worker — Chromium-E2E (kein Workspace nötig).
 * Registrierung auf /login beobachtbar; offline zeigt der Reload die
 * Offline-Fallbackseite statt eines Browser-Fehlers. (Outbox/Sync/Push
 * bleiben Folge-Slices.)
 */

test("F11-02-E2E-01: Service Worker registriert, Offline-Reload zeigt Fallback", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto("/login");
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();

  const workerState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      const deadline = Date.now() + 15_000;
      for (;;) {
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        if (worker?.state === "activated") return "activated";
        if (worker?.state === "redundant") return "redundant";
        if (Date.now() > deadline) return worker?.state ?? "no-worker";
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch {
      return "failed";
    }
  });
  expect(workerState).toBe("activated");

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Keine Verbindung" })).toBeVisible();
    await expect(page.getByText("offline nicht verfügbar")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  await page.reload();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Offline-Grenze").toEqual([]);
});
