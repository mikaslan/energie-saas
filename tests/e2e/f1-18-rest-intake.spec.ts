import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "playwright/test";

/**
 * F1-18 REST-Intake via REST — Chromium-E2E (W3-Workspace).
 *
 * - Signierter REST-POST (HMAC, W3-REST-Key aus M1_05_E2E_STATE) legt
 *   Kontakt + Standort + Projekt an (201, Receipt).
 * - Bit-identisches Replay liefert dasselbe Receipt als Duplikat (200).
 * - Gefaelschte Signatur scheitert geschlossen (401).
 * - Die REST-Anfrage erscheint als Karte mit Kontaktname auf dem
 *   Triage-Board; die Detailseite oeffnet mit Kontakt-H1.
 * - Kein eigener Axe-Lauf: keine neue UI (Board-/Akten-Coverage existiert).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  editorEmail: string;
  f118RestKeyId: string;
  f118RestSecretBase64: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "editorEmail",
    "f118RestKeyId",
    "f118RestSecretBase64",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F1-18-E2E-State ist unvollständig.");
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
    await new Promise((resolve) => setTimeout(resolve, 250));
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

function restPayload(recordId: string, contactName: string, email: string): Record<string, unknown> {
  return {
    contractVersion: "rest-intake.v1",
    clientRecordId: recordId,
    sourceName: "E2E-Webseite",
    submittedAt: new Date().toISOString(),
    customer: {
      displayName: contactName,
      email,
      phoneRaw: null,
    },
    site: {
      addressMode: "regional_estimate",
      formattedAddress: "Deutschland (regional)",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      countryCode: "DE",
      latitude: 51.1657,
      longitude: 10.4515,
      geocodeSource: "regional_default",
      precision: "region",
    },
    note: null,
  };
}

function signedHeaders(body: string, secretBase64: string, keyId: string): Record<string, string> {
  const contentSha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const idempotencyKey = randomUUID();
  const message = [
    "v1",
    "POST",
    "/api/inbound/rest/v1",
    keyId,
    timestamp,
    idempotencyKey,
    contentSha256,
  ].join("\n");
  const signature = createHmac("sha256", Buffer.from(secretBase64, "base64"))
    .update(message)
    .digest("base64url");
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-rest-key-id": keyId,
    "x-rest-timestamp": timestamp,
    "x-rest-content-sha256": contentSha256,
    "x-rest-signature": `v1=${signature}`,
  };
}

async function postRestLead(
  request: APIRequestContext,
  baseURL: string,
  payload: Record<string, unknown>,
  secretBase64: string,
  keyId: string,
) {
  const body = JSON.stringify(payload);
  return request.post(`${baseURL}/api/inbound/rest/v1`, {
    headers: signedHeaders(body, secretBase64, keyId),
    data: body,
  });
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

test("F1-18-E2E-01: signierter REST-Lead landet als Board-Karte", async ({ page, request }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const suffix = randomUUID().slice(0, 8);
  const recordId = `E2E-REST-${Date.now()}-${suffix}`;
  const contactName = `Rita W3 Rest ${suffix}`;
  const email = `f118-rest-${suffix}@example.test`;
  const payload = restPayload(recordId, contactName, email);

  const created = await postRestLead(request, data.baseURL, payload, data.f118RestSecretBase64, data.f118RestKeyId);
  expect(created.status()).toBe(201);
  const receipt = (await created.json()) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    contractVersion: "rest-intake-receipt.v1",
    clientRecordId: recordId,
    status: "processed",
    duplicate: false,
  });
  expect(typeof receipt.receiptId).toBe("string");

  const replayed = await postRestLead(request, data.baseURL, payload, data.f118RestSecretBase64, data.f118RestKeyId);
  expect(replayed.status()).toBe(200);
  const replayReceipt = (await replayed.json()) as Record<string, unknown>;
  expect(replayReceipt).toMatchObject({ receiptId: receipt.receiptId, duplicate: true });

  const forged = await postRestLead(
    request,
    data.baseURL,
    payload,
    Buffer.alloc(32, 0x11).toString("base64"),
    data.f118RestKeyId,
  );
  expect(forged.status()).toBe(401);

  const boardPath = `/w/${data.w3WorkspaceId}/anfragen`;
  await page.goto(boardPath);
  await loginWithRealOtp(page, data.editorEmail, boardPath);

  const card = page.locator("article[data-project-id]").filter({ hasText: contactName });
  await expect(card).toHaveCount(1);
  await card.getByRole("link", { name: "Projekt öffnen" }).click();
  await expect(page.getByRole("heading", { name: contactName, level: 1 })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  await page.setViewportSize({ width: 768, height: 900 });
  await expectNoHorizontalOverflow(page, 768);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page, 1440);

  expect(errors, "Browser-Konsole und Page-Errors des REST-Intakes").toEqual([]);
});
