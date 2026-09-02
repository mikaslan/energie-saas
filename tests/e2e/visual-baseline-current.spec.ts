import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "playwright/test";

/**
 * Frische visuelle Baseline-KANDIDATEN der heutigen Kernseiten (Light Mode).
 *
 * Dies ist ein reiner Read-only-Capture-Lauf: Es werden keine Fremdkonten
 * erfunden, keine Fixtures verändert und keine Mutationen ausgelöst. Genutzt
 * wird ausschließlich der synthetische M2-01-Testworkspace aus
 * `tests/e2e/run.mts` (Fixtures aus `m2-01-fixture.ts`).
 *
 * Der Test ist wie das M2-01-Vorbild opt-in: Er läuft nur, wenn der Harness die
 * Ausgabevariable `VISUAL_BASELINE_DIR` setzt. Im regulären `npm run test:e2e`
 * bleibt er übersprungen und stört die funktionalen Fälle nicht.
 *
 * Ergebnis: KANDIDATEN, die der Eigentümer später ausdrücklich freigibt. Ohne
 * Freigabe bleibt die visuelle Baseline INCONCLUSIVE (kein stilles PASS).
 */

type SerializedState = {
  serverLogPath: string;
  m201EditorEmail: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WorkspaceId: string;
};

type Viewport = { width: number; height: number };

const VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 768, height: 1_024 },
  { width: 1_024, height: 900 },
  { width: 1_440, height: 1_000 },
  { width: 1_920, height: 1_080 },
];

const candidateDirectory = process.env.VISUAL_BASELINE_DIR;
test.skip(!candidateDirectory, "Baseline-Kandidaten entstehen nur im expliziten Visual-Lauf.");

function state(): SerializedState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) throw new Error("M1_05_E2E_STATE fehlt.");
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedState>;
  const required: Array<keyof SerializedState> = [
    "serverLogPath",
    "m201EditorEmail",
    "m201ModuleId",
    "m201ProjectId",
    "m201WorkspaceId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der Visual-Baseline-State ist unvollständig.");
  }
  return parsed as SerializedState;
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der Visual-OTP wurde nicht rechtzeitig protokolliert.");
}

async function dumpMaskedText(page: Page, route: string): Promise<void> {
  const directory = "/tmp/visual-baseline-masked";
  mkdirSync(directory, { recursive: true });
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(join(directory, `${route}.txt`), text, "utf8");
}

async function dumpPageState(page: Page, label: string): Promise<void> {
  const directory = "/tmp/visual-baseline-diag";
  mkdirSync(directory, { recursive: true });
  const url = page.url();
  const headings = await page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3")].map((heading) => heading.textContent?.trim() ?? "").filter(Boolean));
  const bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 3_000);
  writeFileSync(
    join(directory, `${label}.txt`),
    `URL: ${url}\n\nHEADINGS:\n${headings.join("\n")}\n\nBODY:\n${bodyText}\n`,
    "utf8",
  );
  const serverLogPath = state().serverLogPath;
  const log = readFileSync(serverLogPath);
  const tail = log.subarray(Math.max(0, log.byteLength - 24_000)).toString("utf8");
  writeFileSync(join(directory, `${label}-server-log.txt`), tail, "utf8");
}

async function login(
  page: Page,
  email: string,
  target: string,
  authenticatedSurface: Locator,
): Promise<void> {
  const data = state();
  await page.goto(target);
  // Bewährtes M2-01-Muster: Authentifizierung wird über einen sichtbaren
  // Seiten-Locator (nicht über die URL) erkannt; ein Server-/Client-Redirect
  // auf /login wird über waitForURL abgewartet. Ein reiner page.url()-Check
  // würde die Redirect-Zwischenstufe überholen und den OTP-Schritt überspringen.
  const arrival = await Promise.race([
    authenticatedSurface.first().waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "authenticated" as const),
    page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 })
      .then(() => "login" as const),
  ]);
  if (arrival === "authenticated") return;

  const offset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const send = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await send).status()).toBe(200);
  const otp = await otpFromPrivateDevMailLog(data.serverLogPath, email, offset);
  await page.getByLabel("Sechsstelliger Code").fill(otp);
  const signIn = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signIn).status()).toBe(200);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === target);
}

function visualContext(context: BrowserContext): void {
  context.on("page", (page) => {
    page.on("pageerror", (error) => {
      throw error;
    });
  });
}

/**
 * Normalisiert ausschließlich dynamische Daten (IDs, Personen-/Kontaktnamen,
 * Adressen, E-Mail-Adressen, Datums-/Zeitstempel, Telefonnummern) zu
 * layoutstabilen Masken. Deterministische synthetische Fachdaten (Preise,
 * Leistungswerte, Katalognamen) bleiben bewusst erhalten — sie sind Bestandteil
 * der visuellen Beurteilung und keine PII.
 */
async function maskDynamicVisualData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements: Array<[RegExp, string]> = [
      [/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,
        "00000000-0000-4000-8000-000000000000"],
      [/AN-\d{4}-\d{5}/gu, "AN-0000-00000"],
      [/[\w.+-]+@(?:[\w-]+\.)+[\w-]+/gu, "maskiert@example.test"],
      [/\b\d{1,2}\.\d{1,2}\.\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/gu,
        "00.00.0000, 00:00"],
      [/\+\d{1,4}[\s\d()/-]{6,}/gu, "maskierte Telefonnummer"],
      [/\b\d{1,2},\d{4,6},\s*\d{1,2},\d{4,6}\b/gu, "0,00000, 0,00000"],
      [/Testweg 7, 69168 Dielheim/gu, "Maskierte Testadresse 00, 00000 Testort"],
      [/69168 Dielheim/gu, "00000 Testort"],
      [/\bDielheim\b/gu, "Testort"],
      [/Erika M2-01 Browser/gu, "Maskierte Testperson"],
      [/Erika E2E Muster/gu, "Maskierte Testperson"],
      [/Fremdmandant E2E Geheim/gu, "Maskierte Testperson"],
    ];
    const replace = (value: string) => replacements.reduce(
      (current, [pattern, replacement]) => current.replace(pattern, replacement),
      value,
    );
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      node.textContent = replace(node.textContent ?? "");
      node = walker.nextNode();
    }
  });
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation: none !important;
      caret-color: transparent !important;
      transition: none !important;
    }
    nextjs-portal {
      display: none !important;
      visibility: hidden !important;
    }
  ` });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  });
  await expect.poll(async () => page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal");
    if (!(portal instanceof HTMLElement)) return null;
    return {
      display: window.getComputedStyle(portal).display,
      hasOpenShadowRoot: portal.shadowRoot !== null,
      visibility: window.getComputedStyle(portal).visibility,
    };
  }), {
    message: "Das Next-DevTools-Portal muss vor dem Baseline-Capture nachweisbar verborgen sein.",
  }).toEqual({
    display: "none",
    hasOpenShadowRoot: true,
    visibility: "hidden",
  });
}

async function capture(
  page: Page,
  directory: string,
  captured: Set<string>,
  route: string,
  viewport: Viewport,
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await maskDynamicVisualData(page);
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  const name = `${route}__editor__light__${viewport.width}x${viewport.height}.png`;
  expect(captured.has(name), `${name} wird genau einmal erzeugt`).toBe(false);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: resolve(directory, name),
  });
  captured.add(name);
}

test("erzeugt maskierte Baseline-KANDIDATEN aller heutigen Kernseiten (Light Mode)", async ({ browser }) => {
  test.setTimeout(300_000);
  const requestedDirectory = candidateDirectory;
  if (!requestedDirectory) throw new Error("Visual-Ausgabeverzeichnis fehlt.");
  const directory = resolve(requestedDirectory);
  if (existsSync(directory)) {
    throw new Error(`Visual-Ausgabeverzeichnis existiert bereits: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });

  const data = state();
  const baseURL = process.env.M1_05_E2E_BASE_URL;
  if (!baseURL) throw new Error("M1_05_E2E_BASE_URL fehlt.");

  const workspaceId = data.m201WorkspaceId;
  const projectId = data.m201ProjectId;
  const moduleId = data.m201ModuleId;

  type CorePage = {
    route: string;
    path: string;
    ready: (page: Page) => ReturnType<Page["locator"]>;
  };

  const pages: readonly CorePage[] = [
    {
      route: "anfragen",
      path: `/w/${workspaceId}/anfragen`,
      ready: (page) => page.getByRole("heading", { name: "Anfragen", level: 1 }),
    },
    {
      route: "projektakte",
      path: `/w/${workspaceId}/anfragen/${projectId}`,
      ready: (page) => page.locator('[data-offer-create-state="ready"]'),
    },
    {
      route: "energieprofil",
      path: `/w/${workspaceId}/anfragen/${projectId}/energieprofil`,
      ready: (page) => page.getByRole("heading", { name: "Energieprofil prüfen", level: 1 }),
    },
    {
      route: "produkte",
      path: `/w/${workspaceId}/anfragen/${projectId}/produkte`,
      ready: (page) => page.getByRole("heading", { name: "Produkte revisionssicher zuordnen", level: 1 }),
    },
    {
      route: "angebote",
      path: `/w/${workspaceId}/angebote`,
      ready: (page) => page.getByRole("heading", { name: "Angebote", level: 1 }),
    },
    {
      route: "katalog",
      path: `/w/${workspaceId}/katalog`,
      ready: (page) => page.getByRole("heading", { name: "Produktkatalog", level: 1 }),
    },
    {
      route: "katalog-detail",
      path: `/w/${workspaceId}/katalog/${moduleId}`,
      ready: (page) => page.getByRole("heading", {
        name: "Synthetische M2-01 module-Komponente",
        level: 1,
      }),
    },
    {
      route: "standorte",
      path: `/w/${workspaceId}/sites`,
      ready: (page) => page.getByRole("heading", { name: "Standorte", level: 1 }),
    },
  ];

  const contextOptions = {
    baseURL,
    colorScheme: "light" as const,
    deviceScaleFactor: 1,
    locale: "de-DE",
    reducedMotion: "reduce" as const,
    timezoneId: "Europe/Berlin",
    viewport: VIEWPORTS[0],
  };
  const captured = new Set<string>();

  const context = await browser.newContext(contextOptions);
  visualContext(context);
  try {
    const page = await context.newPage();
    for (const [index, corePage] of pages.entries()) {
      if (index === 0) {
        await login(page, data.m201EditorEmail, corePage.path, corePage.ready(page));
      } else {
        await page.goto(corePage.path);
      }
      try {
        await expect(corePage.ready(page).first()).toBeVisible();
      } catch (error) {
        await dumpPageState(page, corePage.route);
        throw error;
      }
      for (const viewport of VIEWPORTS) {
        await capture(page, directory, captured, corePage.route, viewport);
      }
      await dumpMaskedText(page, corePage.route);
    }
  } finally {
    await context.close();
  }

  const expected = new Set<string>();
  for (const corePage of pages) {
    for (const viewport of VIEWPORTS) {
      expected.add(`${corePage.route}__editor__light__${viewport.width}x${viewport.height}.png`);
    }
  }
  expect([...captured].sort()).toEqual([...expected].sort());
  expect(captured.size).toBe(pages.length * VIEWPORTS.length);
});
