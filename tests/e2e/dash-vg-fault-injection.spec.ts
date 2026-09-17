import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state,
} from "./m1-11g-fixture";

// DASH-VG-36/37: Fault-Injection fuer Fehlergrenze und Lade-Skelett.
// Eigene Datei mit serviceWorkers: "block", weil der App-Service-Worker
// (skipWaiting + clients.claim, public/sw.js) sonst jede Navigation
// abfaengt und page.route nichts mehr sieht (belegt: SEEN-REQUESTS leer
// trotz Reload + Klick). Die pruefenden UIs (error.tsx/loading.tsx) sind
// SW-unabhaengige React-Render-States — die Blockade aendert nur die
// Injizierbarkeit, nicht den Pruefgegenstand.

test.use({ serviceWorkers: "block" });

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
    "DASH-VG-FI: keine nicht-injizierten Console-/Page-/Netzfehler",
  ).toEqual([]);
});

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
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  await expect(page.getByLabel("Sechsstelliger Code")).toBeVisible();
  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
  await page.getByLabel("Sechsstelliger Code").fill(otp);
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function headerNames(route: {
  request: () => { headersArray: () => Promise<Array<{ name: string }>> };
}): Promise<string[]> {
  return (await route.request().headersArray()).map((h) => h.name.toLowerCase());
}

test("DASH-VG-36: Abgebrochene RSC-Navigation faellt auf Voll-Reload zurueck (kein Crash)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);
  let abortedCount = 0;
  await page.route("**/w/**", async (route) => {
    const names = await headerNames(route);
    if (names.includes("rsc") || names.includes("next-router-prefetch")) {
      abortedCount += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.reload();
  await page.getByRole("link", { name: "Anfragen", exact: true }).click();
  await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/anfragen`, { timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Board nicht verfügbar", level: 1 }),
  ).toHaveCount(0);
  await page.unroute("**/w/**");
  expect(abortedCount, "RSC-Abbrueche injiziert").toBeGreaterThan(0);
  const problems = browserProblems.get(page) ?? [];
  const kept = problems.filter(
    (entry) =>
      !entry.startsWith("requestfailed: ")
      && !(entry.startsWith("console-error: ") && /RSC payload|ERR_FAILED/.test(entry)),
  );
  expect(kept, "Nur injizierte RSC-Abbrueche").toEqual([]);
  problems.length = 0;
  problems.push(...kept);
});

test("DASH-VG-37: Board-Skelett erscheint bei gedrosselter Navigation", async ({ page }) => {
  test.setTimeout(240_000);
  const workspaceId = await seedIsolatedWorkspace(await resolveEditorId());
  const dashboardPath = `/w/${workspaceId}/dashboard`;
  // Kein Prefetch-Block noetig: Dev baut keine Prefetches (belegt:
  // Prefetch-Zaehler blieb 0); SW ist dateiweit geblockt.
  await page.goto(dashboardPath);
  await loginWithRealOtp(page, state().editorEmail, dashboardPath);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: 20_000,
    uploadThroughput: 10_000,
    latency: 400,
  });
  await page.getByRole("link", { name: "Anfragen", exact: true }).click();
  await expect(page.locator('[aria-busy="true"]')).toBeVisible({ timeout: 15_000 });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
  await page.waitForURL((url) => url.pathname === `/w/${workspaceId}/anfragen`);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
