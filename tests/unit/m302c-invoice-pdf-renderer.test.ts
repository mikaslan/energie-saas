import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { InvoicePdfInputV1 } from "@/lib/integrations/invoicing/pdf-contract";
import {
  MAX_INVOICE_PDF_BYTES,
  InvoicePdfRenderError,
  createPlaywrightInvoicePdfRenderer,
  normalizeChromiumPdfMetadata,
  validateRenderedInvoicePdf,
} from "@/worker/invoice-pdf-renderer";

const PREPARED_AT = "2026-09-17T10:00:00.000Z";

function validInput(): InvoicePdfInputV1 {
  return {
    schemaVersion: "invoice-pdf-input.v1",
    canonicalizationVersion: "invoice-pdf-jcs.v1",
    templateVersion: "invoice-pdf-template.v1",
    rendererRecipeVersion: "invoice-pdf-renderer-recipe.v1",
    preparedAt: PREPARED_AT,
    document: {
      type: "invoice",
      invoiceKind: "schlussrechnung",
      creditNoteType: null,
      number: "RE-2026-000001",
      numberYear: 2026,
      numberSequence: 1,
      issuedAt: "2026-09-10T08:00:00.000Z",
      dueDate: "2026-09-24",
      serviceDate: "2026-09-01",
      skontoPercentBps: 200,
      skontoDays: 14,
    },
    recipient: {
      displayName: "Muster GmbH",
      street: "Musterstrasse",
      houseNumber: "12a",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    sender: {
      companyName: "Energie Saas AG",
      companyEmail: "rechnung@beispiel.de",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: "DE123456789",
      companyAddressLine1: "Werftstrasse 1",
      companyAddressLine2: null,
      companyPostalCode: "20457",
      companyCity: "Hamburg",
      companyCountry: "DE",
      paymentAccountHolder: "Energie Saas AG",
      paymentIban: "DE75512108001245126199",
      paymentBic: "BELADEBEXXX",
      settingsRevision: 3,
    },
    lines: [{
      position: 1,
      title: "PV-Module",
      quantityMilli: 10_000,
      unit: "piece",
      netCents: 100_000,
      taxCents: 19_000,
      grossCents: 119_000,
      taxRateBps: 1900,
    }],
    totals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
  };
}

function syntheticChromiumPdf(options?: {
  header?: string;
  eof?: string;
  metadata?: string;
  trailing?: string;
}): Buffer {
  const body = [
    options?.header ?? "%PDF-1.7",
    options?.metadata
      ?? "/CreationDate (D:20260101010203+00'00')\n/ModDate (D:20260101010204+00'00')",
    "0".repeat(160),
    options?.eof ?? "%%EOF",
    options?.trailing ?? "",
  ].join("\n");
  return Buffer.from(`${body}\n`, "latin1");
}

function expectRenderError(
  operation: () => unknown,
  code: InvoicePdfRenderError["code"],
): void {
  try {
    operation();
    throw new Error("expected renderer failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InvoicePdfRenderError);
    expect((error as InvoicePdfRenderError).code).toBe(code);
    expect((error as InvoicePdfRenderError).message).toBe("invoice PDF render failed");
  }
}

describe("M3-02c invoice PDF renderer envelope", () => {
  it("normalizes Chromium dates to the sealed preparation time without moving xref offsets", () => {
    const source = syntheticChromiumPdf();
    const normalized = normalizeChromiumPdfMetadata(source, PREPARED_AT);

    expect(normalized).not.toBe(source);
    expect(normalized.length).toBe(source.length);
    expect(normalized.toString("latin1")).toContain(
      "/CreationDate (D:20260917100000+00'00')",
    );
    expect(normalized.toString("latin1")).toContain(
      "/ModDate (D:20260917100000+00'00')",
    );
    expect(source.toString("latin1")).toContain("D:20260101010203+00'00'");
  });

  it("rejects absent metadata and invalid sealed timestamps", () => {
    expectRenderError(
      () => normalizeChromiumPdfMetadata(
        syntheticChromiumPdf({ metadata: "/Producer (Chromium)" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => normalizeChromiumPdfMetadata(syntheticChromiumPdf(), "not-a-date"),
      "invalid_input",
    );
  });

  it("accepts one strict PDF envelope and derives its bytes, size and hash together", () => {
    const result = validateRenderedInvoicePdf(syntheticChromiumPdf(), PREPARED_AT);

    expect(result.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7");
    expect(result.bytes.toString("latin1")).toMatch(/%%EOF\s*$/u);
    expect(result.sizeBytes).toBe(result.bytes.length);
    expect(result.sizeBytes).toBeLessThanOrEqual(MAX_INVOICE_PDF_BYTES);
    expect(MAX_INVOICE_PDF_BYTES).toBe(8 * 1024 * 1024);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex"),
    );
  });

  it("rejects malformed headers, missing/fake EOF markers and oversized output", () => {
    expectRenderError(
      () => validateRenderedInvoicePdf(
        syntheticChromiumPdf({ header: "%PNG-1.7" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedInvoicePdf(
        syntheticChromiumPdf({ eof: "not-an-eof" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedInvoicePdf(
        syntheticChromiumPdf({ trailing: "untrusted trailing bytes" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedInvoicePdf(
        Buffer.concat([
          syntheticChromiumPdf(),
          Buffer.alloc(MAX_INVOICE_PDF_BYTES),
        ]),
        PREPARED_AT,
      ),
      "pdf_too_large",
    );
  });

  it("fails invalid document input before a browser is needed", async () => {
    const renderer = createPlaywrightInvoicePdfRenderer();
    const invalid = { ...validInput(), preparedAt: "<invalid>" };

    await expect(renderer.render(invalid)).rejects.toMatchObject({
      name: "InvoicePdfRenderError",
      message: "invoice PDF render failed",
      code: "invalid_input",
      retryable: false,
    });
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")(
    "rejects a production render outside the pinned linux/amd64 recipe",
    async () => {
      await expect(createPlaywrightInvoicePdfRenderer().render(validInput()))
        .rejects.toMatchObject({
          name: "InvoicePdfRenderError",
          message: "invoice PDF render failed",
          code: "browser_unavailable",
          retryable: true,
        });
    },
  );

  it("fails closed when print-only CSS attempts a request during page.pdf", async () => {
    const renderer = createPlaywrightInvoicePdfRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => `<!doctype html>
<html><head><style>
@media print { body { background-image: url("https://print-only.invalid/pixel.png"); } }
</style></head><body>Print-only network probe</body></html>`,
    });

    await expect(renderer.render(validInput())).rejects.toMatchObject({
      name: "InvoicePdfRenderError",
      message: "invoice PDF render failed",
      code: "network_attempted",
      retryable: false,
    });
  }, 60_000);
});

// Kein Sandbox-Describe: Der Invoice-Renderer laeuft im selben
// Worker-Container (M2-02-Profil, worker/Dockerfile:33); das
// M2-02-Sandbox-Contract-Suite deckt das geteilte Profil ab.
