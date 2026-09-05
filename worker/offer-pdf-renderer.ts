import { createHash } from "node:crypto";
import { chromium } from "playwright";

import {
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  validateOfferPdfDraftInput,
  type OfferPdfDraftInputV1,
} from "../lib/integrations/offers/pdf-contract";
import { renderOfferPdfDraftHtml } from "../lib/integrations/offers/pdf-template";

export const MAX_OFFER_PDF_BYTES = 8 * 1024 * 1024;

export type OfferPdfRenderFailureCode =
  | "browser_unavailable"
  | "render_timeout"
  | "network_attempted"
  | "invalid_input"
  | "invalid_pdf"
  | "pdf_too_large";

export class OfferPdfRenderError extends Error {
  constructor(
    public readonly code: OfferPdfRenderFailureCode,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super("offer PDF render failed", options);
    this.name = "OfferPdfRenderError";
  }
}

export type RenderedOfferPdf = {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  mimeType: "application/pdf";
};

export type OfferPdfRenderer = {
  render(input: OfferPdfDraftInputV1): Promise<RenderedOfferPdf>;
};

export type OfferPdfRendererOptions = Readonly<{
  /** Verification-only seam. Production callers use the sealed template. */
  htmlRenderer?: (input: OfferPdfDraftInputV1) => string;
  /** Host-only diagnostics. Production and the container smoke never set it. */
  allowUnpinnedRuntimeForVerification?: boolean;
}>;

type SealedOfferPdfInput = Readonly<{
  rendererRecipeVersion: string;
  preparedAt: string;
}>;

type SealedOfferPdfInputValidation<TInput extends SealedOfferPdfInput> =
  | Readonly<{ ok: true; value: TInput }>
  | Readonly<{ ok: false; paths: readonly string[] }>;

export type SealedOfferPdfRenderer<TInput extends SealedOfferPdfInput> = {
  render(input: TInput): Promise<RenderedOfferPdf>;
};

export type SealedOfferPdfRendererConfiguration<
  TInput extends SealedOfferPdfInput,
> = Readonly<{
  expectedRendererRecipeVersion: string;
  validateInput: (value: unknown) => SealedOfferPdfInputValidation<TInput>;
  htmlRenderer: (input: TInput) => string;
  /** Host-only diagnostics. Production callers must leave this false. */
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
          () => reject(new OfferPdfRenderError("render_timeout", true)),
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
    throw new OfferPdfRenderError("invalid_input", false);
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
    throw new OfferPdfRenderError("invalid_pdf", false);
  }
  return Buffer.from(normalized, "latin1");
}

export function validateRenderedOfferPdf(
  bytes: Buffer,
  preparedAt: string,
): RenderedOfferPdf {
  if (bytes.length > MAX_OFFER_PDF_BYTES) {
    throw new OfferPdfRenderError("pdf_too_large", false);
  }
  if (bytes.length < 100 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new OfferPdfRenderError("invalid_pdf", false);
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
  if (!/%%EOF[\t\r\n ]*$/u.test(tail)) {
    throw new OfferPdfRenderError("invalid_pdf", false);
  }
  const normalized = normalizeChromiumPdfMetadata(bytes, preparedAt);
  return {
    bytes: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    sizeBytes: normalized.length,
    mimeType: "application/pdf",
  };
}

/**
 * Shared fail-closed Chromium envelope for sealed offer documents. Template,
 * validator and recipe are supplied as one immutable configuration so a
 * caller cannot validate one document kind and render another accidentally.
 */
export function createSealedPlaywrightOfferPdfRenderer<
  TInput extends SealedOfferPdfInput,
>({
  expectedRendererRecipeVersion,
  validateInput,
  htmlRenderer,
  allowUnpinnedRuntimeForVerification = false,
}: SealedOfferPdfRendererConfiguration<TInput>): SealedOfferPdfRenderer<TInput> {
  return {
    async render(value) {
      const validated = validateInput(value);
      if (!validated.ok) throw new OfferPdfRenderError("invalid_input", false);
      const input = validated.value;
      if (input.rendererRecipeVersion !== expectedRendererRecipeVersion) {
        throw new OfferPdfRenderError("invalid_input", false);
      }
      if (!isPinnedRendererRuntime() && !allowUnpinnedRuntimeForVerification) {
        // The recipe promises bytes for one exact OCI child image and CPU
        // architecture. A production worker on any other runtime must not
        // render under the same version string.
        throw new OfferPdfRenderError("browser_unavailable", true);
      }
      let html: string;
      try {
        html = htmlRenderer(input);
      } catch {
        throw new OfferPdfRenderError("invalid_input", false);
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
        // Cause bleibt lesbar (rls.test.ts-Muster); Typ/Code/Meldung
        // unveraendert — nur Observability fuer CI-Launch-Fehler.
        throw new OfferPdfRenderError("browser_unavailable", true, { cause: error });
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
            throw new OfferPdfRenderError("network_attempted", false);
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
            throw new OfferPdfRenderError("network_attempted", false);
          }
          return validateRenderedOfferPdf(raw, input.preparedAt);
        } catch (error) {
          if (error instanceof OfferPdfRenderError) throw error;
          const message = error instanceof Error ? error.message : "";
          throw new OfferPdfRenderError(
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

export function createPlaywrightOfferPdfRenderer(
  options: OfferPdfRendererOptions = {},
): OfferPdfRenderer {
  return createSealedPlaywrightOfferPdfRenderer({
    expectedRendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
    validateInput: validateOfferPdfDraftInput,
    htmlRenderer: options.htmlRenderer ?? renderOfferPdfDraftHtml,
    allowUnpinnedRuntimeForVerification:
      options.allowUnpinnedRuntimeForVerification,
  });
}
