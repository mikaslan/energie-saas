import { defineConfig, devices } from "playwright/test";

const outputDir = process.env.M1_05_E2E_OUTPUT_DIR ?? "test-results/e2e";
const baseURL = process.env.M1_05_E2E_BASE_URL;

if (!baseURL) {
  throw new Error("M1_05_E2E_BASE_URL fehlt; bitte über npm run test:e2e starten.");
}

const parsedBaseURL = new URL(baseURL);
if (
  parsedBaseURL.protocol !== "http:"
  || parsedBaseURL.hostname !== "localhost"
  || parsedBaseURL.pathname !== "/"
  || parsedBaseURL.search !== ""
  || parsedBaseURL.hash !== ""
  || parsedBaseURL.username !== ""
  || parsedBaseURL.password !== ""
  || parsedBaseURL.port === ""
  || parsedBaseURL.origin !== baseURL
) {
  throw new Error("M1_05_E2E_BASE_URL muss ein kanonischer dynamischer Loopback-Origin sein.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [["line"]],
  outputDir,
  use: {
    baseURL,
    actionTimeout: 12_000,
    navigationTimeout: 30_000,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
