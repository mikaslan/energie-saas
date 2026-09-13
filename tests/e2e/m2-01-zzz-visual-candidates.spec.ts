import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "playwright/test";
import {
  clearM201ActorMutationWindow,
  createM201RedactedViewer,
  exhaustM201ActorMutationWindow,
  readM201Offer,
  readM201RevisionEvidence,
  seedM201AdditionalReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

type SerializedVisualState = {
  databaseUrl: string;
  editorEmail: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
  visualWorkspaceId: string;
  workspaceId: string;
};

type Viewport = { width: number; height: number };

const ALL_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1_024 },
  { width: 1_024, height: 900 },
  { width: 1_440, height: 1_000 },
  { width: 1_920, height: 1_080 },
];
const STATE_VIEWPORTS: readonly Viewport[] = [
  { width: 390, height: 844 },
  { width: 1_440, height: 1_000 },
];

const candidateDirectory = process.env.M201_VISUAL_CANDIDATES_DIR;
test.skip(!candidateDirectory, "Review-Kandidaten entstehen nur im expliziten Visual-Lauf.");

function state(): SerializedVisualState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) throw new Error("M1_05_E2E_STATE fehlt.");
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedVisualState>;
  const required: Array<keyof SerializedVisualState> = [
    "databaseUrl",
    "editorEmail",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
    "visualWorkspaceId",
    "workspaceId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M2-01-Visual-State ist unvollständig.");
  }
  return parsed as SerializedVisualState;
}

function runtimeState(data: SerializedVisualState): M201RuntimeState {
  return {
    databaseUrl: data.databaseUrl,
    editorEmail: data.m201EditorEmail,
    editorIdentityId: data.m201EditorIdentityId,
    m201BatteryId: data.m201BatteryId,
    m201InverterId: data.m201InverterId,
    m201ModuleId: data.m201ModuleId,
    m201ProjectId: data.m201ProjectId,
    m201WallboxId: data.m201WallboxId,
    serverLogPath: data.serverLogPath,
    workspaceId: data.m201WorkspaceId,
  };
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

async function login(page: Page, email: string, target: string): Promise<void> {
  const data = state();
  await page.goto(target);
  const authenticatedSurface = page.locator([
    '[data-offer-create-state="ready"]',
    '[data-offer-detail-state="loaded"]',
    '[data-offer-detail-state="outdated"]',
    '[data-offer-detail-state="read_only"]',
    'h1:text-is("Anfragen")',
  ].join(", ")).first();
  const unauthenticatedSurface = page.locator(
    '[data-offer-detail-state="unauthenticated"]',
  );
  const arrival = await Promise.race([
    authenticatedSurface.waitFor({ state: "visible" }).then(() => "authenticated" as const),
    unauthenticatedSurface.waitFor({ state: "visible" }).then(() => "unauthenticated" as const),
    page.waitForURL((url) => url.pathname === "/login").then(() => "login" as const),
  ]);
  if (arrival === "authenticated") return;
  if (arrival === "unauthenticated") {
    await page.goto(`/login?next=${encodeURIComponent(target)}`);
  }
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

type VisualOverlayCleanup = () => Promise<void>;

// Schwärzt dynamische Inhalte AUSSCHLIESSLICH per Overlay-Boxen — der DOM-Text
// wird nie mutiert. Text-Mutation trieb jeden späteren React-Commit in einen
// Hydration-Mismatch (beobachtet: Projekt-UUID auf der Triage-Seite, sobald
// die Maskierung vor abgeschlossener Hydration landete). Overlays sind
// React-fremde Body-Geschwister (kein Eingriff in React-Container) und
// beeinflussen kein Layout; Cleanup direkt nach dem Shot.
const VISUAL_REDACT_PATTERNS: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,
  /AN-\d{4}-\d{5}/gu,
  /[\w.+-]+@(?:[\w-]+\.)+[\w-]+/gu,
  /\b\d{1,2}\.\d{1,2}\.\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/gu,
  /Erika M2-01 Browser/gu,
  /Erika E2E Muster/gu,
  /Vera Visual E2E/gu,
  /Testweg 7, 69168 Dielheim/gu,
];

async function maskDynamicVisualData(page: Page): Promise<VisualOverlayCleanup> {
  await page.evaluate((patterns: string[]) => {
    const overlayRoot = document.createElement("div");
    overlayRoot.setAttribute("data-visual-redaction-root", "true");
    overlayRoot.style.cssText = "position:static;";
    const compiled = patterns.map((source) => new RegExp(source, "giu"));
    const matches = (value: string): boolean =>
      compiled.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      });
    const filter = {
      acceptNode(node: Node): number {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, filter);
    const boxes: Array<{ left: number; top: number; width: number; height: number }> = [];
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      if (text.trim() !== "" && matches(text)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && rect.height > 0) {
            boxes.push({
              left: rect.left + window.scrollX,
              top: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height,
            });
          }
        }
      }
      node = walker.nextNode();
    }
    for (const box of boxes) {
      const cover = document.createElement("div");
      cover.setAttribute("data-visual-redaction", "true");
      cover.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;`
        + `width:${box.width}px;height:${box.height}px;background:#cbd5e1;z-index:2147483647;`;
      overlayRoot.appendChild(cover);
    }
    document.body.appendChild(overlayRoot);
  }, VISUAL_REDACT_PATTERNS.map((pattern) => pattern.source));
  return async () => {
    await page.evaluate(() => {
      document.querySelectorAll("[data-visual-redaction-root]").forEach((root) => root.remove());
    });
  };
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
    message: "Das Next-DevTools-Portal muss vor dem Review-Capture nachweisbar verborgen sein.",
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
  role: string,
  visualState: string,
  viewport: Viewport,
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const restoreMask = await maskDynamicVisualData(page);
  try {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    const name = `${route}__${role}__${visualState}__${viewport.width}x${viewport.height}.png`;
    expect(captured.has(name), `${name} wird genau einmal erzeugt`).toBe(false);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      path: join(directory, name),
    });
    captured.add(name);
  } finally {
    await restoreMask();
  }
}

async function captureViewports(
  page: Page,
  directory: string,
  captured: Set<string>,
  route: string,
  role: string,
  visualState: string,
  viewports: readonly Viewport[],
): Promise<void> {
  for (const viewport of viewports) {
    await capture(page, directory, captured, route, role, visualState, viewport);
  }
}

test("erzeugt die vollständige maskierte M201-VISUAL-01-Reviewmatrix", async ({ browser }) => {
  test.setTimeout(300_000);
  const requestedDirectory = candidateDirectory;
  if (!requestedDirectory) throw new Error("Visual-Ausgabeverzeichnis fehlt.");
  const directory = resolve(requestedDirectory);
  if (existsSync(directory)) {
    throw new Error(`Visual-Ausgabeverzeichnis existiert bereits: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });

  const data = state();
  const m201 = runtimeState(data);
  const baseURL = process.env.M1_05_E2E_BASE_URL;
  if (!baseURL) throw new Error("M1_05_E2E_BASE_URL fehlt.");
  const contextOptions = {
    baseURL,
    colorScheme: "light" as const,
    deviceScaleFactor: 1,
    locale: "de-DE",
    reducedMotion: "reduce" as const,
    timezoneId: "Europe/Berlin",
    viewport: ALL_VIEWPORTS[0],
  };
  const captured = new Set<string>();

  const boardContext = await browser.newContext(contextOptions);
  visualContext(boardContext);
  try {
    const board = await boardContext.newPage();
    // Eigener Visual-Workspace: genau ein Projekt, deterministisch
    // unabhaengig vom Main-Board-Wachstum anderer Specs.
    const boardPath = `/w/${data.visualWorkspaceId}/anfragen`;
    await login(board, data.editorEmail, boardPath);
    await expect(board.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
    await expect(board.locator("article[data-project-id]")).toHaveCount(1);
    await captureViewports(
      board,
      directory,
      captured,
      "offer-board",
      "editor",
      "loaded",
      ALL_VIEWPORTS,
    );
  } finally {
    await boardContext.close();
  }

  const editorContext = await browser.newContext(contextOptions);
  visualContext(editorContext);
  try {
    const readyProjectId = await seedM201AdditionalReadyProject(m201);
    const readiness = await editorContext.newPage();
    const readinessPath = `/w/${m201.workspaceId}/anfragen/${readyProjectId}`;
    await login(readiness, m201.editorEmail, readinessPath);
    await expect(readiness.locator('[data-offer-create-state="ready"]')).toBeVisible();
    await captureViewports(
      readiness,
      directory,
      captured,
      "project-readiness",
      "editor",
      "ready-cta",
      ALL_VIEWPORTS,
    );

    const offer = await readM201Offer(m201);
    const offerPath = `/w/${m201.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;
    const filled = await editorContext.newPage();
    await filled.goto(offerPath);
    await expect(filled.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();
    await expect(filled.getByLabel("Positionsname", { exact: true })).toHaveCount(2);
    await captureViewports(
      filled,
      directory,
      captured,
      "offer-editor",
      "editor",
      "filled",
      ALL_VIEWPORTS,
    );

    const dirty = await editorContext.newPage();
    await dirty.goto(offerPath);
    await dirty.locator("#variant-description").fill("SYNTHETIC VISUAL DIRTY DRAFT");
    await dirty.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await expect(dirty.getByRole("dialog", {
      name: "Möchtest du den lokalen Entwurf verlassen?",
    })).toBeVisible();
    await captureViewports(
      dirty,
      directory,
      captured,
      "offer-editor",
      "editor",
      "dirty-dialog",
      STATE_VIEWPORTS,
    );

    const conflict = await editorContext.newPage();
    await conflict.goto(offerPath);
    const conflictEvidence = await readM201RevisionEvidence(
      m201,
      offer.offerId,
      offer.variantId,
    );
    await conflict.locator("#variant-description").fill("SYNTHETIC VISUAL LOCAL CONFLICT");
    const parallel = await editorContext.newPage();
    await parallel.goto(offerPath);
    await parallel.locator("#variant-description").fill("SYNTHETIC VISUAL SERVER CONFLICT");
    await parallel.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect.poll(async () => (
      await readM201RevisionEvidence(m201, offer.offerId, offer.variantId)
    ).revision).toBe(conflictEvidence.revision + 1);
    await parallel.close();
    await conflict.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
    await conflict.getByRole("dialog", {
      name: "Möchtest du den lokalen Entwurf verlassen?",
    }).getByRole("button", { name: "Speichern und fortfahren" }).click();
    await expect(conflict.locator('[data-offer-detail-state="conflict"]')).toBeVisible();
    await captureViewports(
      conflict,
      directory,
      captured,
      "offer-editor",
      "editor",
      "conflict",
      STATE_VIEWPORTS,
    );

    const unavailable = await editorContext.newPage();
    await unavailable.goto(offerPath);
    await unavailable.locator("#variant-description").fill("SYNTHETIC VISUAL UNAVAILABLE");
    await exhaustM201ActorMutationWindow(m201);
    try {
      await unavailable.getByRole("link", { name: "Zur Angebotsübersicht" }).click();
      await unavailable.getByRole("dialog", {
        name: "Möchtest du den lokalen Entwurf verlassen?",
      }).getByRole("button", { name: "Speichern und fortfahren" }).click();
      await expect(unavailable.locator('[data-offer-detail-state="unavailable"]')).toBeVisible();
      await captureViewports(
        unavailable,
        directory,
        captured,
        "offer-editor",
        "editor",
        "unavailable",
        STATE_VIEWPORTS,
      );
    } finally {
      await clearM201ActorMutationWindow(m201);
    }
  } finally {
    await editorContext.close();
  }

  const viewer = await createM201RedactedViewer(m201);
  const viewerContext = await browser.newContext(contextOptions);
  visualContext(viewerContext);
  try {
    const offer = await readM201Offer(m201);
    const offerPath = `/w/${m201.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;
    const readOnly = await viewerContext.newPage();
    await login(readOnly, viewer.email, offerPath);
    await expect(readOnly.locator("#offer-readonly-main")).toBeVisible();
    await expect(readOnly.getByText("Einkaufspreis", { exact: true })).toHaveCount(0);
    await captureViewports(
      readOnly,
      directory,
      captured,
      "offer-editor",
      "viewer",
      "read-only",
      STATE_VIEWPORTS,
    );
  } finally {
    await viewerContext.close();
  }

  const expected = new Set<string>();
  for (const viewport of ALL_VIEWPORTS) {
    for (const [route, visualState] of [
      ["offer-board", "loaded"],
      ["project-readiness", "ready-cta"],
      ["offer-editor", "filled"],
    ] as const) {
      expected.add(`${route}__editor__${visualState}__${viewport.width}x${viewport.height}.png`);
    }
  }
  for (const viewport of STATE_VIEWPORTS) {
    for (const visualState of ["dirty-dialog", "conflict", "unavailable"] as const) {
      expected.add(`offer-editor__editor__${visualState}__${viewport.width}x${viewport.height}.png`);
    }
    expected.add(`offer-editor__viewer__read-only__${viewport.width}x${viewport.height}.png`);
  }
  expect([...captured].sort()).toEqual([...expected].sort());
  expect(captured.size).toBe(26);

  if (process.env.M201_VISUAL_SPOTCHECK_HOLD === "true") {
    await new Promise((resolveHold) => setTimeout(resolveHold, 45_000));
  }
});
