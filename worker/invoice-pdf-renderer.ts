import { createHash } from "node:crypto";
import { chromium } from "playwright";
import QRCode from "qrcode-generator";

import {
  INVOICE_PAYMENT_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  validateInvoicePaymentInput,
  validateInvoicePdfInput,
  type InvoicePaymentInputV1,
  type InvoicePdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import { renderInvoicePaymentHtml } from "../lib/integrations/invoicing/payment-template";
import { renderInvoicePdfHtml } from "../lib/integrations/invoicing/pdf-template";

export const MAX_INVOICE_PDF_BYTES = 8 * 1024 * 1024;

export type InvoicePdfRenderFailureCode =
  | "browser_unavailable"
  | "render_timeout"
  | "network_attempted"
  | "invalid_input"
  | "invalid_pdf"
  | "pdf_too_large";

export class InvoicePdfRenderError extends Error {
  constructor(
    public readonly code: InvoicePdfRenderFailureCode,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super("invoice PDF render failed", options);
    this.name = "InvoicePdfRenderError";
  }
}

export type RenderedInvoicePdf = {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  mimeType: "application/pdf";
};

export type InvoicePdfRenderInput = InvoicePdfInputV1 | InvoicePaymentInputV1;

export type InvoicePdfRenderer = {
  render(input: InvoicePdfRenderInput): Promise<RenderedInvoicePdf>;
};

export type InvoicePdfRendererOptions = Readonly<{
  /** Verification-only seam. Production callers use the sealed template. */
  htmlRenderer?: (input: InvoicePdfRenderInput) => string;
  /** Host-only diagnostics. Production and the container smoke never set it. */
  allowUnpinnedRuntimeForVerification?: boolean;
}>;

/**
 * F8-17: deterministischer EPC-QR (qrcode-generator@2.0.4, ECC M,
 * Auto-Version). Reine Funktion des versiegelten Payloads — keine
 * Zeit, kein Zufall, kein Netz.
 */
export function renderEpcQrSvg(epcPayload: string): string {
  try {
    const qr = QRCode(0, "M");
    qr.addData(epcPayload);
    qr.make();
    return qr.createSvgTag({});
  } catch (error) {
    throw new InvoicePdfRenderError("invalid_input", false, { cause: error });
  }
}

const PINNED_RENDERER_PLATFORM = "linux";
const PINNED_RENDERER_ARCH = "x64";

function isPinnedRendererRuntime(): boolean {
  return process.platform === PINNED_RENDERER_PLATFORM
    && process.arch === PINNED_RENDERER_ARCH;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new InvoicePdfRenderError("render_timeout", true)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function pdfDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new InvoicePdfRenderError("invalid_input", false);
  }
  const compact = date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return `D:${compact}+00'00'`;
}

/**
 * Chromium schreibt die aktuelle Renderzeit in das Info-Dictionary. Diese
 * feste, laengengleiche Normalisierung bindet die Metadaten stattdessen an
 * den bereits versiegelten DB-Zeitpunkt. Der PDF-xref bleibt dadurch gueltig.
 */
export function normalizeChromiumPdfMetadata(
  bytes: Buffer,
  preparedAt: string,
): Buffer {
  const fixedDate = pdfDate(preparedAt);
  const source = bytes.toString("latin1");
  let replacements = 0;
  const normalized = source.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/gu,
    (_match, field: string) => {
      replacements += 1;
      return `/${field} (${fixedDate})`;
    },
  );
  if (replacements === 0 || normalized.length !== source.length) {
    throw new InvoicePdfRenderError("invalid_pdf", false);
  }
  return Buffer.from(normalized, "latin1");
}

export function validateRenderedInvoicePdf(
  bytes: Buffer,
  preparedAt: string,
): RenderedInvoicePdf {
  if (bytes.length > MAX_INVOICE_PDF_BYTES) {
    throw new InvoicePdfRenderError("pdf_too_large", false);
  }
  if (bytes.length < 100 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new InvoicePdfRenderError("invalid_pdf", false);
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
  if (!/%%EOF[\t\r\n ]*$/u.test(tail)) {
    throw new InvoicePdfRenderError("invalid_pdf", false);
  }
  const normalized = normalizeChromiumPdfMetadata(bytes, preparedAt);
  return {
    bytes: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    sizeBytes: normalized.length,
    mimeType: "application/pdf",
  };
}

export function createPlaywrightInvoicePdfRenderer(
  options: InvoicePdfRendererOptions = {},
): InvoicePdfRenderer {
  const htmlOverride = options.htmlRenderer;
  const allowUnpinnedRuntimeForVerification =
    options.allowUnpinnedRuntimeForVerification ?? false;
  return {
    async render(value) {
      const schemaVersion = (value as { schemaVersion?: unknown } | null | undefined)
        ?.schemaVersion;
      // F8-17: Template-Dispatch per versiegelter Schema-Version; alles
      // andere fail-closed (kein Fallback-Rendering).
      const isPayment = schemaVersion === "invoice-payment-input.v1";
      const validated = isPayment
        ? validateInvoicePaymentInput(value)
        : validateInvoicePdfInput(value);
      if (!validated.ok) throw new InvoicePdfRenderError("invalid_input", false);
      const input = validated.value;
      const expectedRecipe = isPayment
        ? INVOICE_PAYMENT_RENDERER_RECIPE_VERSION
        : INVOICE_PDF_RENDERER_RECIPE_VERSION;
      if (input.rendererRecipeVersion !== expectedRecipe) {
        throw new InvoicePdfRenderError("invalid_input", false);
      }
      if (!isPinnedRendererRuntime() && !allowUnpinnedRuntimeForVerification) {
        // The recipe promises bytes for one exact OCI child image and CPU
        // architecture. A production worker on any other runtime must not
        // render under the same version string.
        throw new InvoicePdfRenderError("browser_unavailable", true);
      }
      let html: string;
      try {
        html = htmlOverride !== undefined
          ? htmlOverride(input)
          : input.schemaVersion === "invoice-payment-input.v1"
            ? renderInvoicePaymentHtml(input, renderEpcQrSvg(input.epcPayload))
            : renderInvoicePdfHtml(input);
      } catch (error) {
        if (error instanceof InvoicePdfRenderError) throw error;
        throw new InvoicePdfRenderError("invalid_input", false);
      }
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
          timeout: 20_000,
          // Der Browser erbt keine Worker-Secrets via execve. Der Container-
          // Einstieg setzt den Node-Elternprozess zusaetzlich non-dumpable,
          // damit ein Same-UID-Browser sie nicht ueber /proc zurueckliest.
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            TMPDIR: "/tmp",
            XDG_CACHE_HOME: "/tmp",
            XDG_CONFIG_HOME: "/tmp",
            LANG: "C.UTF-8",
            TZ: "Europe/Berlin",
          },
        });
      } catch (error) {
        throw new InvoicePdfRenderError("browser_unavailable", true, { cause: error });
      }

      try {
        const context = await browser.newContext({
          locale: "de-DE",
          timezoneId: "Europe/Berlin",
          colorScheme: "light",
          reducedMotion: "reduce",
          javaScriptEnabled: false,
          serviceWorkers: "block",
          acceptDownloads: false,
          viewport: { width: 794, height: 1_123 },
        });
        let attemptedNetwork = false;
        await context.route("**/*", async (route) => {
          attemptedNetwork = true;
          await route.abort("blockedbyclient");
        });
        await context.setOffline(true);
        const page = await context.newPage();
        page.on("request", () => {
          attemptedNetwork = true;
        });
        try {
          await page.setContent(html, {
            waitUntil: "load",
            timeout: 15_000,
          });
          if (attemptedNetwork) {
            throw new InvoicePdfRenderError("network_attempted", false);
          }
          const raw = Buffer.from(await withTimeout(page.pdf({
            format: "A4",
            preferCSSPageSize: true,
            printBackground: true,
            tagged: true,
            outline: true,
            displayHeaderFooter: false,
          }), 30_000));
          // Print media is activated by page.pdf(). A URL hidden behind
          // @media print can therefore request only after setContent() has
          // completed. Offline mode and routing block the request; this
          // second check also rejects the otherwise apparently valid bytes.
          if (attemptedNetwork) {
            throw new InvoicePdfRenderError("network_attempted", false);
          }
          return validateRenderedInvoicePdf(raw, input.preparedAt);
        } catch (error) {
          if (error instanceof InvoicePdfRenderError) throw error;
          const message = error instanceof Error ? error.message : "";
          throw new InvoicePdfRenderError(
            /timeout/iu.test(message) ? "render_timeout" : "browser_unavailable",
            true,
          );
        } finally {
          await context.close().catch(() => undefined);
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}
