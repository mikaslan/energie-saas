import { expect, test } from "playwright/test";

/**
 * F11-01 PWA-Skeleton — Chromium-E2E ohne Login (statische Dateien).
 * Manifest + Icons werden ausgeliefert, die Startseite verlinkt
 * Manifest, Theme-Farbe und Touch-Icon.
 */

test("F11-01-E2E-01: Manifest und Icons sind öffentlich erreichbar und verlinkt", async ({
  page,
  request,
}) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as {
    name: string;
    display: string;
    icons: Array<{ src: string }>;
  };
  expect(manifest.name).toBe("WMEE Vertrieb");
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), `Icon ${icon.src} erreichbar`).toBe(200);
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
  }

  const homeResponse = await request.get("/");
  expect(homeResponse.status()).toBeLessThan(400);
  const html = await homeResponse.text();
  expect(html).toContain("/manifest.webmanifest");
  expect(html).toContain("#1d4ed8");
  expect(html).toContain("/icons/apple-touch-icon.png");

  // Beobachtbar: Manifest-Link steht im gerenderten <head>.
  await page.goto("/");
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");
});
