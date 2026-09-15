import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  M2_01_E2E_CONTACT,
  readM201Offer,
  readM201RevisionEvidence,
  seedM201ReadyProject,
  type M201RuntimeState,
} from "./m2-01-fixture";

/**
 * F16-11 Paket-Vorlagen — Chromium-E2E.
 * - Editor legt ein Paket mit zwei Positionen in den Einstellungen an
 *   (Karte zeigt „2 Positionen"); Viewer bleibt read-only.
 * - Editor erstellt ein Angebot am F1606-Projekt und setzt das Paket ein →
 *   Paket-Sektion mit beiden Zeilen in Revision 2 (Custom-Ebene ersetzt).
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1611State = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  viewerEmail: string;
  f1606ProjectId: string;
  w3WorkspaceId: string;
  serverLogPath: string;
};

type F1611State = M201RuntimeState & { f1606ProjectId: string; w3WorkspaceId: string; viewerEmail: string };

function runtimeState(): F1611State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1611State>;
  const required: Array<keyof SerializedF1611State> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "viewerEmail",
    "f1606ProjectId",
    "w3WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-11-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedF1611State;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.editorEmail,
    editorIdentityId: complete.editorIdentityId,
    m201BatteryId: "",
    m201InverterId: "",
    m201ModuleId: "",
    m201ProjectId: complete.f1606ProjectId,
    f1606ProjectId: complete.f1606ProjectId,
    w3WorkspaceId: complete.w3WorkspaceId,
    m201WallboxId: "",
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.w3WorkspaceId,
    viewerEmail: complete.viewerEmail,
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
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte F16-11-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedTarget: string): Promise<void> {
  const data = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(await otpFromPrivateDevMailLog(data.serverLogPath, email, logOffset));
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

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "F16-11 Browser-Konsole und Page-Errors").toEqual([]);
});

async function fillLine(
  creator: ReturnType<Page["locator"]>,
  index: number,
  line: { name: string; quantity: string; sales: string; purchase: string },
): Promise<void> {
  await creator.getByLabel(`Positionsname ${index}`).fill(line.name);
  await creator.getByLabel(`Menge ${index}`).fill(line.quantity);
  await creator.getByLabel(`VK je Einheit € ${index}`).fill(line.sales);
  await creator.getByLabel(`EK je Einheit € ${index}`).fill(line.purchase);
}

test.describe("F16-11 Paket-Vorlagen", () => {
  // F16-11b E2E-03: eigenes angebotsfähiges Projekt im selben Workspace —
  // jede Angebotsanlage versteckt das Create-Widget, und E2E-04 belegt das
  // F1606-Projekt zuerst (Templates sind Workspace-scoped, daher kein
  // zweiter Workspace nötig).
  let isolatedProjectId = "";
  test.beforeAll(async () => {
    const data = runtimeState();
    const isolated = await seedM201ReadyProject(data.databaseUrl, {
      workspaceId: data.w3WorkspaceId,
      editorIdentityId: data.editorIdentityId,
      skuSuffix: `w3-f1611-${randomUUID().slice(0, 8)}`,
    });
    isolatedProjectId = isolated.projectId;
  });

  test("F16-11-E2E-04: 0-%-Paket nur mit frischer Bestätigung einsetzen", async ({ page }) => {
    test.setTimeout(240_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const packageName = `F1611 E2E Nullsteuer ${stamp}`;
    const sectionTitle = `F1611 E2E Sektion 0 % ${stamp}`;
    const lineZero = `F1611 E2E Modul 0 % ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();

    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neues Paket", exact: true }),
    });
    await creator.getByLabel("Paketname").fill(packageName);
    await creator.getByLabel("Sektionstitel").fill(sectionTitle);
    await creator.getByLabel("Kategorie").selectOption("module");
    await fillLine(creator, 1, { name: lineZero, quantity: "4", sales: "200,00", purchase: "150,00" });
    await creator.getByLabel("Steuer 1").selectOption("zero_operator_confirmed");
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName })).toHaveCount(1);

    const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f1606ProjectId}`;
    await page.goto(projectPath);
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntry).toBeVisible();
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
    const w3State = { ...data, workspaceId: data.w3WorkspaceId, m201ProjectId: data.f1606ProjectId };
    const initial = await readM201Offer(w3State);
    const variantId = new URL(page.url()).searchParams.get("variante");
    expect(variantId).toBe(initial.variantId);

    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const packagePanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Paket einsetzen", exact: true }),
    });
    await packagePanel.getByLabel("Paket wählen").selectOption({ label: `${packageName} (1 Position, davon 1 mit 0 %)` });
    // Ohne frische Bestätigung bleibt das Einsetzen ungültig.
    await packagePanel.getByRole("button", { name: "Paket einsetzen", exact: true }).click();
    await expect(packagePanel.getByText("Eingaben prüfen (Paket wählen).", { exact: true })).toBeVisible();
    await packagePanel.getByLabel("0-%-Steuerentwurf frisch bestätigen").selectOption("true");
    await packagePanel.getByRole("button", { name: "Paket einsetzen", exact: true }).click();
    await expect(packagePanel.getByText("Paket eingesetzt (1 Position übernommen).", { exact: true })).toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(w3State, initial.offerId, variantId!)
    ).revision, {
      message: "Das 0-%-Paket muss Revision 2 dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(2);
    const evidence = await readM201RevisionEvidence(w3State, initial.offerId, variantId!);
    const snapshot = JSON.parse(evidence.snapshotText) as {
      sections: Array<{ title: string; lines: Array<{ product: { displayName: string }; taxTreatment: string; taxRateBps: number }> }>;
    };
    const zeroLine = snapshot.sections.flatMap((section) => section.lines).find((line) => line.product.displayName === lineZero);
    expect(zeroLine).toMatchObject({ taxTreatment: "zero_operator_confirmed", taxRateBps: 0 });
    expect(errors, "Browser-Konsole beim 0-%-Einsetzen").toEqual([]);
  });

  test("F16-11-E2E-01: Editor verwaltet Paket (Positionen, Archiv, Restore); Viewer read-only", async ({ page }) => {
    test.setTimeout(180_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const packageName = `F1611 E2E Paket ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();

    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neues Paket", exact: true }),
    });
    await creator.getByLabel("Paketname").fill(packageName);
    await creator.getByLabel("Sektionstitel").fill(`F1611 E2E Sektion ${stamp}`);
    await creator.getByLabel("Kategorie").selectOption("module");
    await fillLine(creator, 1, { name: `F1611 E2E Modul ${stamp}`, quantity: "10", sales: "250,00", purchase: "150,00" });
    await creator.getByRole("button", { name: "Position hinzufügen", exact: true }).click();
    await fillLine(creator, 2, { name: `F1611 E2E Kabel ${stamp}`, quantity: "25", sales: "2,50", purchase: "1,00" });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    const article = page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName });
    await expect(article).toHaveCount(1);
    await expect(article.getByText("2 Positionen", { exact: false })).toBeVisible();
    expect(errors, "Browser-Konsole beim Anlegen").toEqual([]);

    await article.getByRole("button", { name: `${packageName} archivieren`, exact: true }).click();
    await expect(article.getByText("archiviert", { exact: true })).toBeVisible();
    await article.getByRole("button", { name: `${packageName} reaktivieren`, exact: true }).click();
    await expect(article.getByText("aktiv", { exact: true })).toBeVisible();
    expect(errors, "Browser-Konsole bei Archiv/Restore").toEqual([]);
  });

  test("F16-11-E2E-02: Viewer sieht Pakete ausschließlich lesend", async ({ page }) => {
    test.setTimeout(150_000);
    const data = runtimeState();
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.viewerEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();
    await expect(page.locator("section[aria-label=\"Neues Paket\"]")).toHaveCount(0);
  });

  test("F16-11-E2E-03: Paket am Angebot einsetzen ersetzt freie Ebene", async ({ page }) => {
    test.setTimeout(240_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const stamp = Date.now();
    const packageName = `F1611 E2E Einsatz ${stamp}`;
    const sectionTitle = `F1611 E2E Sektion ${stamp}`;
    const lineA = `F1611 E2E Modul ${stamp}`;
    const lineB = `F1611 E2E Kabel ${stamp}`;
    const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/paket-vorlagen`;

    await page.goto(settingsPath);
    await loginWithRealOtp(page, data.editorEmail, settingsPath);
    await expect(page.getByRole("heading", { name: "Paket-Vorlagen", level: 1 })).toBeVisible();

    const creator = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Neues Paket", exact: true }),
    });
    await creator.getByLabel("Paketname").fill(packageName);
    await creator.getByLabel("Sektionstitel").fill(sectionTitle);
    await creator.getByLabel("Kategorie").selectOption("module");
    await fillLine(creator, 1, { name: lineA, quantity: "10", sales: "250,00", purchase: "150,00" });
    await creator.getByRole("button", { name: "Position hinzufügen", exact: true }).click();
    await fillLine(creator, 2, { name: lineB, quantity: "25", sales: "2,50", purchase: "1,00" });
    await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
    await expect(page.locator("section[aria-label=\"Pakete\"] article").filter({ hasText: packageName })).toHaveCount(1);

    const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${isolatedProjectId}`;
    await page.goto(projectPath);
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntry).toBeVisible();
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
    const w3State = { ...data, workspaceId: data.w3WorkspaceId, m201ProjectId: isolatedProjectId };
    const initial = await readM201Offer(w3State);
    const variantId = new URL(page.url()).searchParams.get("variante");
    expect(variantId).toBe(initial.variantId);

    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const packagePanel = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Paket einsetzen", exact: true }),
    });
    await packagePanel.getByLabel("Paket wählen").selectOption({ label: `${packageName} (2 Positionen)` });
    await packagePanel.getByRole("button", { name: "Paket einsetzen", exact: true }).click();
    await expect(packagePanel.getByText("Paket eingesetzt (2 Positionen übernommen).", { exact: true })).toBeVisible();
    await expect.poll(async () => (
      await readM201RevisionEvidence(w3State, initial.offerId, variantId!)
    ).revision, {
      message: "Das Paket-Einsetzen muss Revision 2 dauerhaft persistieren.",
      timeout: 15_000,
    }).toBe(2);
    const evidence = await readM201RevisionEvidence(w3State, initial.offerId, variantId!);
    const snapshot = JSON.parse(evidence.snapshotText) as {
      sections: Array<{ title: string; lines: Array<{ product: { displayName: string } }> }>;
    };
    const titles = snapshot.sections.map((section) => section.title);
    expect(titles).toContain(sectionTitle);
    const names = snapshot.sections.flatMap((section) => section.lines.map((line) => line.product.displayName));
    expect(names).toContain(lineA);
    expect(names).toContain(lineB);
    expect(errors, "Browser-Konsole beim Einsetzen").toEqual([]);
  });
});
