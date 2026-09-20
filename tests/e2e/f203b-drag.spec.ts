import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  readM201RevisionEvidence,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

// F203B-09-E2E (D3-03 Stretch, RED): Drag-Reorder als UI-Alternative
// zu den Hoch/Runter-Buttons (gleiche Ops move_section/move_line,
// Buttons bleiben für Tastatur).
// RED, weil die Drag-Handles `[data-section-drag-handle]` /
// `[data-line-drag-handle]` im Editor noch nicht existieren.
// Spec: docs/spec/F2-03b-kalkulation-rest.md §D3-03 + F203B-09.
// Setup-Muster: F202B/F207B — eigenes Ready-Projekt per
// seedM201ReadyProject + skuSuffix je Test (1-Offer/Projekt-Regel),
// Offer-IDs per URL-Read-back wie F202B (readM201Offer ist an
// m201ProjectId gebunden und entfällt daher).

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
    throw new Error("Der private F203B-E2E-State ist unvollständig.");
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
  throw new Error("Der echte F203B-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
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

  const otp = await otpFromPrivateDevMailLog(state.serverLogPath, state.editorEmail, logOffset);
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

async function seedOwnReadyProject(): Promise<string> {
  const state = runtimeState();
  const seed = await seedM201ReadyProject(state.databaseUrl, {
    workspaceId: state.workspaceId,
    editorIdentityId: state.editorIdentityId,
    skuSuffix: `w3-f203b-drag-${randomUUID().slice(0, 8)}`,
  });
  return seed.projectId;
}

async function createOfferViaBrowser(page: Page, projectId: string): Promise<{
  offerId: string;
  state: M201RuntimeState;
  variantId: string;
}> {
  const state = runtimeState();
  const projectPath = `/w/${state.workspaceId}/anfragen/${projectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, projectPath);

  await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
  await expect(page.locator('[data-energy-calculation-state="current"]')).toBeVisible();
  await expect(page.getByText("Produkte sind revisionssicher zugeordnet.", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("Keine offenen Triage-Blocker.", { exact: true })).toBeVisible();

  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await expect(createEntry.getByRole("heading", {
    name: "Angebotsentwurf erstellen",
    exact: true,
  })).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));

  // F202B-Read-back: IDs aus der URL (eigener Seed je Test).
  const createdUrl = new URL(page.url());
  const offerId = createdUrl.pathname.split("/").pop();
  const variantId = createdUrl.searchParams.get("variante");
  if (!offerId) throw new Error("Der Angebots-Pfad enthält keine Offer-ID.");
  if (!variantId) throw new Error("Der Angebots-Pfad enthält keine Varianten-ID.");
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
  return { offerId, state, variantId };
}

// HTML5-DnD per page.evaluate (Befund: weder page- noch
// locator.dispatch_event existiert in dieser Playwright-Instanz;
// Maus-dragTo löst kein natives HTML5-Drag aus — Tooling-Limitation,
// kein Produkt-Fehler). Die Sequenz feuert echte DragEvents im
// Browser-Kontext inkl. lebendem DataTransfer. Handler-Befund
// (offer-editor.tsx, gelesen): Die Drag-Identität ist Ref-basiert
// (draggedSectionIdRef/draggedLineRef, gesetzt in onDragStart,
// gelesen in onDrop) — dataTransfer wird nur beschrieben
// (setData/effectAllowed/dropEffect), nie für Logik gelesen.
// Drop-Ziele sind die <section>/<li>-Container; die auf den Handles
// gefeuerten Events bubbeln dorthin. Kein SPEC-Abbruch nötig.
async function html5SectionDrag(page: Page, sourceIndex: number, targetIndex: number): Promise<void> {
  await page.evaluate(({ source, target }) => {
    const handles = document.querySelectorAll("[data-section-drag-handle]");
    const sourceEl = handles[source];
    const targetEl = handles[target];
    if (!(sourceEl instanceof HTMLElement) || !(targetEl instanceof HTMLElement)) {
      throw new Error(`F203B-Drag-Handles fehlen (Quelle ${source}, Ziel ${target}).`);
    }
    const transfer = new DataTransfer();
    const fire = (element: HTMLElement, type: string): void => {
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      }));
    };
    fire(sourceEl, "dragstart");
    fire(targetEl, "dragenter");
    fire(targetEl, "dragover");
    fire(targetEl, "drop");
    fire(sourceEl, "dragend");
  }, { source: sourceIndex, target: targetIndex });
}

async function sectionTitles(page: Page): Promise<string[]> {
  return page.locator("section header h2").allTextContents();
}

function trackBrowserErrors(page: Page): void {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F203B-Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F2-03b Drag-Reorder Stretch (F203B-09-E2E)", () => {
  test("Drag per Maus ändert die Sektionsreihenfolge und persistiert sie", async ({ page }) => {
    test.setTimeout(120_000);
    const { offerId, state, variantId } = await createOfferViaBrowser(page, await seedOwnReadyProject());
    const firstEvidence = await readM201RevisionEvidence(state, offerId, variantId);

    const handles = page.locator("[data-section-drag-handle]");
    await expect(handles, "Sektions-Drag-Handles (Stretch-UI-Alternative zu Hoch/Runter)")
      .toHaveCount(await sectionTitles(page).then((titles) => titles.length));
    expect(await handles.count()).toBeGreaterThanOrEqual(2);

    const before = await sectionTitles(page);
    await html5SectionDrag(page, 0, before.length - 1);
    const after = await sectionTitles(page);
    expect(after, "Drag per Maus muss die sichtbare Sektionsreihenfolge ändern")
      .not.toEqual(before);

    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect(page.getByText(`Revision ${firstEvidence.revision + 1} wurde gespeichert.`, { exact: true }))
      .toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(state, offerId, variantId)
    ).revision, {
      message: "Der Drag-Reorder muss als move_section-Op dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(firstEvidence.revision + 1);

    await page.reload();
    await expect(page.locator(
      '[data-offer-detail-state="loaded"], [data-offer-detail-state="outdated"]',
    )).toBeVisible();
    await expect.poll(() => sectionTitles(page), {
      message: "Die per Drag geänderte Reihenfolge muss nach Reload bestehen.",
      timeout: 15_000,
    }).toEqual(after);
  });

  test("Tastaturpfad (Hoch/Runter-Buttons) bleibt neben Drag unverändert", async ({ page }) => {
    test.setTimeout(120_000);
    const { offerId, state, variantId } = await createOfferViaBrowser(page, await seedOwnReadyProject());
    const firstEvidence = await readM201RevisionEvidence(state, offerId, variantId);

    // Stretch-Koexistenz: Drag-Handles ergänzen die Buttons, ersetzen sie nicht.
    await expect(page.locator("[data-section-drag-handle]").first())
      .toBeVisible();

    const before = await sectionTitles(page);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const secondTitle = before[1];
    const upButton = page.getByRole("button", {
      name: `Sektion ${secondTitle} nach oben verschieben`,
      exact: true,
    });
    await expect(upButton).toBeEnabled();
    await upButton.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => sectionTitles(page), {
      message: "Der Hoch-Button muss per Tastatur die Sektion nach oben bewegen.",
      timeout: 15_000,
    }).toEqual([before[1], before[0], ...before.slice(2)]);

    await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
    await expect(page.getByText(`Revision ${firstEvidence.revision + 1} wurde gespeichert.`, { exact: true }))
      .toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(state, offerId, variantId)
    ).revision, {
      message: "Der Tastatur-Reorder muss als move_section-Op dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(firstEvidence.revision + 1);
  });
});
