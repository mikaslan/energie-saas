import { createHash } from "node:crypto";
import { chromium } from "playwright";

import {
  DRAFT_PDF_RENDERER_RECIPE_VERSION,
  validateDraftPdfInput,
  type DraftPdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import { renderDraftPdfHtml } from "../lib/integrations/invoicing/draft-template";

export const MAX_DRAFT_PDF_BYTES = 8 * 1024 * 1024;

export type DraftPdfRenderFailureCode =
  | "browser_unavailable"
  | "render_timeout"
  | "network_attempted"
  | "invalid_input"
  | "invalid_pdf"
  | "pdf_too_large";

export class DraftPdfRenderError extends Error {
  constructor(
    public readonly code: DraftPdfRenderFailureCode,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super("draft PDF render failed", options);
    this.name = "DraftPdfRenderError";
  }
}

export type RenderedDraftPdf = {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  mimeType: "application/pdf";
};

export type DraftPdfRenderer = {
  render(input: DraftPdfInputV1): Promise<RenderedDraftPdf>;
};

export type DraftPdfRendererOptions = Readonly<{
  /** Verification-only seam. Production callers use the sealed template. */
  htmlRenderer?: (input: DraftPdfInputV1) => string;
  /** Host-only diagnostics. Production and the container smoke never set it. */
  allowUnpinnedRuntimeForVerification?: boolean;
}>;

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
          () => reject(new DraftPdfRenderError("render_timeout", true)),
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
    throw new DraftPdfRenderError("invalid_input", false);
  }
  const compact = date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return `D:${compact}+00'00'`;
}

/**
 * Chromium schreibt die aktuelle Renderzeit in das Info-Dictionary. Diese
 * feste, laengengleiche Normalisierung bindet die Metadaten stattdessen an
 * den bereits versiegelten DB-Zeitpunkt. Der PDF-xref bleibt dadurch gueltig.
 */
export function normalizeDraftPdfMetadata(
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
    throw new DraftPdfRenderError("invalid_pdf", false);
  }
  return Buffer.from(normalized, "latin1");
}

export function validateRenderedDraftPdf(
  bytes: Buffer,
  preparedAt: string,
): RenderedDraftPdf {
  if (bytes.length > MAX_DRAFT_PDF_BYTES) {
    throw new DraftPdfRenderError("pdf_too_large", false);
  }
  if (bytes.length < 100 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new DraftPdfRenderError("invalid_pdf", false);
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
  if (!/%%EOF[\t\r\n ]*$/u.test(tail)) {
    throw new DraftPdfRenderError("invalid_pdf", false);
  }
  const normalized = normalizeDraftPdfMetadata(bytes, preparedAt);
  return {
    bytes: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    sizeBytes: normalized.length,
    mimeType: "application/pdf",
  };
}

export function createPlaywrightDraftPdfRenderer(
  options: DraftPdfRendererOptions = {},
): DraftPdfRenderer {
  const htmlOverride = options.htmlRenderer;
  const allowUnpinnedRuntimeForVerification =
    options.allowUnpinnedRuntimeForVerification ?? false;
  return {
    async render(value) {
      const validated = validateDraftPdfInput(value);
      if (!validated.ok) throw new DraftPdfRenderError("invalid_input", false);
      const input = validated.value;
      if (input.rendererRecipeVersion !== DRAFT_PDF_RENDERER_RECIPE_VERSION) {
        throw new DraftPdfRenderError("invalid_input", false);
      }
      if (!isPinnedRendererRuntime() && !allowUnpinnedRuntimeForVerification) {
        // The recipe promises bytes for one exact OCI child image and CPU
        // architecture. A production worker on any other runtime must not
        // render under the same version string.
        throw new DraftPdfRenderError("browser_unavailable", true);
      }
      let html: string;
      try {
        html = htmlOverride !== undefined
          ? htmlOverride(input)
          : renderDraftPdfHtml(input);
      } catch (error) {
        if (error instanceof DraftPdfRenderError) throw error;
        throw new DraftPdfRenderError("invalid_input", false);
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
        throw new DraftPdfRenderError("browser_unavailable", true, { cause: error });
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
            throw new DraftPdfRenderError("network_attempted", false);
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
            throw new DraftPdfRenderError("network_attempted", false);
          }
          return validateRenderedDraftPdf(raw, input.preparedAt);
        } catch (error) {
          if (error instanceof DraftPdfRenderError) throw error;
          const message = error instanceof Error ? error.message : "";
          throw new DraftPdfRenderError(
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
