import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Download, type Page } from "playwright/test";
import {
  claimOfferPdfDraftJob,
  finalizeOfferPdfDraftSuccess,
} from "../../worker/offer-pdf-database";
import {
  M2_01_E2E_CONTACT,
  readM201Offer,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

const CURRENT_VARIANT_NAME = "Aktuelle Browser-Basis";
const browserErrors = new WeakMap<Page, string[]>();

type SerializedM202State = {
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

type QueuedPdfDraft = {
  jobId: string;
  state: string;
  variantRevision: number;
};

type SyntheticPdfArtifact = {
  mimeType: "application/pdf";
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM202State>;
  const required: Array<keyof SerializedM202State> = [
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
    throw new Error("Der private M2-02-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM202State;
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
  throw new Error("Der echte M2-02-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  const loginSurface = page.getByLabel("E-Mail-Adresse");
  const sessionExpiredSurface = page.locator(
    '[data-offer-detail-state="unauthenticated"]',
  );
  const surface = await Promise.race([
    loginSurface.waitFor({ state: "visible" }).then(() => "login" as const),
    sessionExpiredSurface.waitFor({ state: "visible" })
      .then(() => "session_expired" as const),
  ]);
  if (surface === "session_expired") {
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toHaveCount(0);
    await page.goto(`/login?next=${encodeURIComponent(expectedTarget)}`);
  }
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(
    state.serverLogPath,
    state.editorEmail,
    logOffset,
  );
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

function selectedVariantId(page: Page): string {
  const variantId = new URL(page.url()).searchParams.get("variante");
  if (!variantId) throw new Error("M2-02-E2E-URL enthält keine aktive Variante.");
  return variantId;
}

function syntheticPdfArtifact(): SyntheticPdfArtifact {
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "(Synthetic M2-02 E2E draft - not a production render) Tj",
    "ET",
    "",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`,
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets: number[] = [];
  let byteOffset = chunks[0].length;
  for (const [index, body] of objects.entries()) {
    const objectBytes = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "ascii");
    offsets.push(byteOffset);
    chunks.push(objectBytes);
    byteOffset += objectBytes.length;
  }
  const xrefOffset = byteOffset;
  const xrefEntries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}`
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
      + `startxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  ));
  const bytes = Buffer.concat(chunks);
  return {
    mimeType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

async function readQueuedPdfDraft(
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
): Promise<QueuedPdfDraft> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<QueuedPdfDraft & { [key: string]: unknown }>(sql`
      select id as "jobId", state, variant_revision as "variantRevision"
        from offer_pdf_draft
       where workspace_id = ${state.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
       order by created_at desc, id desc
    `);
    if (result.rows.length !== 1 || result.rows[0].state !== "queued") {
      throw new Error("Der sichtbare M2-02-PDF-Auftrag ist nicht eindeutig queued persistiert.");
    }
    return result.rows[0];
  });
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
  expect(browserErrors.get(page) ?? [], "M2-02 Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M2-02 interner Angebots-PDF-Entwurf", () => {
  test("fordert den aktuellen Stand im Browser an und prüft den synthetischen E2E-Abschluss bis zum privaten Download", async ({ page }) => {
    test.setTimeout(120_000);
    const state = runtimeState();
    const offer = await readM201Offer(state);
    const initialPath = `/w/${state.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;
    await page.goto(initialPath);
    await loginWithRealOtp(page, initialPath);

    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const variantNavigation = page.getByRole("navigation", { name: "Angebotsvarianten" });
    const currentVariantLink = variantNavigation.getByRole("link", {
      name: /^Aktuelle Browser-Basis\s*Rev\.\s*\d+$/u,
    });
    await expect(currentVariantLink).toHaveCount(1);
    const currentVariantHref = await currentVariantLink.getAttribute("href");
    if (!currentVariantHref) {
      throw new Error("Die aktuelle M2-01-Angebotsvariante hat kein Browserziel.");
    }
    await currentVariantLink.click();
    await page.waitForURL((url) => `${url.pathname}${url.search}` === currentVariantHref);

    const currentVariantId = selectedVariantId(page);
    expect(currentVariantId).not.toBe(offer.variantId);
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    await expect(currentVariantLink).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("Variantenname").first()).toHaveValue(CURRENT_VARIANT_NAME);
    await expect(page.getByText(
      "Die Projektgrundlage ist nicht mehr aktuell.",
      { exact: true },
    )).toHaveCount(0);

    const pdfPanel = page.locator("aside").filter({
      has: page.getByRole("heading", {
        name: "Interner, nicht verbindlicher PDF-Entwurf",
        exact: true,
      }),
    });
    await expect(pdfPanel).toBeVisible();
    const revisionValue = await pdfPanel
      .locator('input[name="expectedVariantRevision"]')
      .inputValue();
    const variantRevision = Number(revisionValue);
    expect(variantRevision).toBeGreaterThan(0);

    const generateResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === `/w/${state.workspaceId}/angebote/${offer.offerId}`
        && url.searchParams.get("variante") === currentVariantId;
    });
    await pdfPanel.getByRole("button", {
      name: "Internen PDF-Entwurf erzeugen",
      exact: true,
    }).click();
    expect((await generateResponsePromise).status()).toBe(200);
    await expect(pdfPanel.getByText(
      `Der PDF-Auftrag für Revision ${variantRevision} wurde angenommen.`,
      { exact: true },
    )).toBeVisible();
    await expect(pdfPanel.getByText(
      `Revision ${variantRevision} · In Warteschlange`,
      { exact: true },
    )).toBeVisible();

    const queued = await readQueuedPdfDraft(
      state,
      offer.offerId,
      currentVariantId,
    );
    expect(queued.variantRevision).toBe(variantRevision);

    const leaseToken = randomUUID();
    const claim = await withM201Database(state, (tx) => claimOfferPdfDraftJob(tx, {
      workspaceId: state.workspaceId,
      jobId: queued.jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("Der queued M2-02-E2E-Auftrag war nicht claimbar.");
    expect(claim).toMatchObject({
      workspaceId: state.workspaceId,
      jobId: queued.jobId,
      leaseToken,
      attemptCount: 1,
    });
    expect(claim.input.variant).toMatchObject({
      name: CURRENT_VARIANT_NAME,
      revision: variantRevision,
    });

    // Bewusst kein Produktionsrenderer-Beleg: Das formal gültige, deterministische
    // PDF isoliert hier ausschließlich Browser-, Worker-DB- und Downloadvertrag.
    const artifact = syntheticPdfArtifact();
    const completion = await withM201Database(state, (tx) =>
      finalizeOfferPdfDraftSuccess(tx, {
        workspaceId: state.workspaceId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        attemptCount: claim.attemptCount,
        artifact,
      }));
    expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });

    await page.reload();
    await expect(pdfPanel.getByText(
      `Revision ${variantRevision} · PDF-Entwurf ist bereit`,
      { exact: true },
    )).toBeVisible();
    const downloadLink = pdfPanel.getByRole("link", {
      name: `PDF-Entwurf der Revision ${variantRevision} laden`,
      exact: true,
    });
    await expect(downloadLink).toBeVisible();
    const downloadPath = await downloadLink.getAttribute("href");
    expect(downloadPath).toBe(
      `/w/${state.workspaceId}/angebote/${offer.offerId}/pdf/${queued.jobId}`,
    );

    const [downloadResponse, download] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "GET"
        && new URL(response.url()).pathname === downloadPath),
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);
    const downloadedBytes = await bytesFromDownload(download);
    expect(await download.failure()).toBeNull();

    const expectedFilename = `${claim.input.offerNumber}-Variante-R${variantRevision}.pdf`;
    const expectedDisposition = `attachment; filename="${expectedFilename}"; filename*=UTF-8''${encodeURIComponent(expectedFilename)}`;
    const headers = downloadResponse.headers();
    expect(downloadResponse.status()).toBe(200);
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["content-length"]).toBe(String(artifact.sizeBytes));
    expect(headers["content-disposition"]).toBe(expectedDisposition);
    expect(headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(headers["pragma"]).toBe("no-cache");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(download.suggestedFilename()).toBe(expectedFilename);
    expect(downloadedBytes.equals(artifact.bytes)).toBe(true);
    expect(downloadedBytes).toHaveLength(artifact.sizeBytes);
    expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(artifact.sha256);
  });
});
