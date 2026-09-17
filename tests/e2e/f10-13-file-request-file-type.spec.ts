import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

/**
 * F10-13 Datei-Anfragen Dateityp — Chromium-E2E (LocalStorage-Backend).
 *
 * Durchgängig: interne Anlage mit Typ („Nur PDF"/„Nur Bild") →
 * Portal-Link per UI → `accept`-Attribut + Hinweis je Typ →
 * Pass-Upload ok → Fehltyp-Upload `ungueltig` (beide Typen) → QR +
 * Download byte-identisch → Erledigt. Viewports 375/768/1440 + Axe
 * als anonymer Kunde. Eigenes f1013-Projekt (keine Kopplung an f102).
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f1013ProjectId: string;
  editorEmail: string;
};

const PDF_TITLE = "F1013-Stromrechnung (nur PDF)";
const REJECT_TITLE = "F1013-Ablehnprobe (nur PDF)";
const IMAGE_TITLE = "F1013-Zaehlerfoto (nur Bild)";
const IMAGE_REJECT_TITLE = "F1013-Ablehnprobe (nur Bild)";
const PDF_FILENAME = "strom-f1013.pdf";
const JPG_FILENAME = "foto-f1013.jpg";
const IMAGE_OK_FILENAME = "zaehler-f1013.jpg";
const IMAGE_BAD_FILENAME = "falsch-f1013.pdf";
const PDF_BYTES = Buffer.from("%PDF-1.4\nF1013-E2E-PDF\n%%EOF\n", "utf8");
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x46, 0x31, 0x30, 0x31, 0x33]);

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f1013ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10.13-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
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
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function expectNoAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine WCAG-A/AA-Verletzung`).toEqual([]);
}

test("F10-13-E2E-01: Dateityp schraenkt Portal-Upload ein", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f1013ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  // 1) Vier interne Anlagen: je Typ ein Erfolg- und ein Ablehn-Kandidat.
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Datei-Anfragen", exact: true }),
  });
  await expect(section).toBeVisible();
  const seeds: Array<{ title: string; fileType: string }> = [
    { title: PDF_TITLE, fileType: "pdf" },
    { title: REJECT_TITLE, fileType: "pdf" },
    { title: IMAGE_TITLE, fileType: "image" },
    { title: IMAGE_REJECT_TITLE, fileType: "image" },
  ];
  for (const seed of seeds) {
    await section.getByTestId("file-request-title").fill(seed.title);
    await section.getByTestId("file-request-file-type").selectOption(seed.fileType);
    await section.getByTestId("file-request-create").click();
    await expect(section.getByTestId("file-request-create-feedback")).toHaveText(
      "Datei-Anfrage angelegt.",
    );
  }
  await expect(section.locator("li", { hasText: PDF_TITLE })).toContainText("Nur PDF");
  await expect(section.locator("li", { hasText: IMAGE_TITLE })).toContainText("Nur Bild");

  // 2) Portal-Link per UI.
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  // 3) Portal: accept-Attribut + Hinweis je Typ, Axe bei 375/768/1440.
  await page.goto(`${tokenPath}?tab=dateien`);
  await expect(page.getByTestId("file-requests-section")).toBeVisible();
  const pdfItem = page.locator("li", { hasText: PDF_TITLE });
  await expect(pdfItem.locator('input[type="file"]')).toHaveAttribute("accept", ".pdf");
  await expect(pdfItem.getByTestId("file-request-file-type-hint")).toContainText("PDF");
  const imageItem = page.locator("li", { hasText: IMAGE_TITLE });
  await expect(imageItem.locator('input[type="file"]')).toHaveAttribute(
    "accept",
    ".jpg,.jpeg,.png",
  );
  await expect(imageItem.getByTestId("file-request-file-type-hint")).toContainText("JPG, PNG");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("file-requests-section")).toBeVisible();
    await expectNoAxeViolations(page, `F10-13 Dateien-Tab ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 4) PDF-Upload an PDF-Anfrage → Erfolg.
  await pdfItem.locator('input[type="file"]').setInputFiles({
    name: PDF_FILENAME,
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });
  await pdfItem.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByText(`Hochgeladen (${PDF_FILENAME})`)).toBeVisible();

  // 5) JPG-Upload an zweite PDF-Anfrage → ungueltig (serverseitiger Guard).
  const rejectItem = page.locator("li", { hasText: REJECT_TITLE });
  await rejectItem.locator('input[type="file"]').setInputFiles({
    name: JPG_FILENAME,
    mimeType: "image/jpeg",
    buffer: JPG_BYTES,
  });
  await rejectItem.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "ungueltig"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toBeVisible();

  // 5b) Bild-Grenze spiegelbildlich: JPG ok, PDF ungueltig.
  const imageOkItem = page.locator("li", { hasText: IMAGE_TITLE });
  await imageOkItem.locator('input[type="file"]').setInputFiles({
    name: IMAGE_OK_FILENAME,
    mimeType: "image/jpeg",
    buffer: JPG_BYTES,
  });
  await imageOkItem.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "erfolg"
  );
  await expect(page.getByText(`Hochgeladen (${IMAGE_OK_FILENAME})`)).toBeVisible();
  const imageRejectItem = page.locator("li", { hasText: IMAGE_REJECT_TITLE });
  await imageRejectItem.locator('input[type="file"]').setInputFiles({
    name: IMAGE_BAD_FILENAME,
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });
  await imageRejectItem.getByRole("button", { name: "Hochladen", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === tokenPath && url.searchParams.get("upload") === "ungueltig"
  );
  await expect(page.getByTestId("file-request-upload-feedback")).toBeVisible();

  // 6) Intern: Eingangs-QR (Dateiname + Groesse + SHA-256) +
  // byte-identischer Download + Erledigt.
  await page.goto(projectPath);
  const requestItem = section.locator("li", { hasText: PDF_TITLE });
  await expect(requestItem.getByTestId("file-request-status")).toHaveText("Hochgeladen · Nur PDF");
  await expect(requestItem.getByTestId("file-request-receipt")).toContainText(
    `Beleg: ${PDF_FILENAME}`,
  );
  await expect(requestItem.locator('code[title="SHA-256-Prüfsumme"]')).toHaveText(/^[0-9a-f]{64}$/u);
  await requestItem.getByTestId("file-request-download").click();
  const downloadLink = requestItem.getByTestId("file-request-download-link");
  await expect(downloadLink).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect(readFileSync(downloadPath as string).equals(PDF_BYTES)).toBe(true);
  await requestItem.getByTestId("file-request-transition-erledigt").click();
  await expect(section.getByTestId("file-request-transition-feedback")).toHaveText(
    "Datei-Anfrage aktualisiert.",
  );

  expect(errors, "Browser-Konsole und Page-Errors der Dateityp-Grenze").toEqual([]);
});
