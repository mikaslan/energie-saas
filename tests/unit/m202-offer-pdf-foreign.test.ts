import { describe, expect, it } from "vitest";
import {
  FOREIGN_PDF_MAX_BYTES,
  ForeignPdfValidationError,
  countForeignPdfPages,
  parseForeignPdfDescriptors,
  validateForeignPdfUpload,
  type ForeignPdfDescriptor,
  type ForeignPdfValidationCode,
} from "@/lib/integrations/offers/foreign-pdf";
import type { OfferPdfDraftInputV1 } from "@/lib/integrations/offers/pdf-contract";
import { renderOfferPdfDraftHtml } from "@/lib/integrations/offers/pdf-template";

function pdfBytes(extra = ""): Uint8Array {
  const doc = [
    "%PDF-1.4",
    "% abstand-abstand-abstand-abstand-abstand-abstand-abstand-abstand-ab",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    "endobj",
    extra,
  ].join("\n");
  return new TextEncoder().encode(doc);
}

function codeOf(fn: () => unknown): ForeignPdfValidationCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForeignPdfValidationError);
    return (error as ForeignPdfValidationError).code;
  }
  throw new Error("ForeignPdfValidationError erwartet");
}

function inputFixture(): OfferPdfDraftInputV1 {
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    recipient: { displayName: "Mia Muster" },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: { name: "Basis", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalDiscountCapCents: null, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Leistungsumfang",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Position 1",
        description: null,
        quantityMilli: 1_000,
        unit: "piece",
        positionType: "required",
        isHidden: false,
        salesUnitNetCents: 100,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100,
        taxCents: 19,
        grossCents: 119,
      }],
    }],
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  };
}

describe("offer PDF Fremd-PDF-Upload (F2.7 R1)", () => {
  it("nimmt ein valides Fremd-PDF ab und beschreibt es deterministisch", () => {
    const bytes = pdfBytes();
    const first = validateForeignPdfUpload({
      bytes,
      filename: "  Datenblatt Werk.PDF  ",
      mimeType: "application/pdf",
    });
    const second = validateForeignPdfUpload({
      bytes: Uint8Array.from(bytes),
      filename: "Datenblatt Werk.PDF",
      mimeType: "application/pdf",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      filename: "Datenblatt Werk.PDF",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      pageCount: 1,
    });
    expect(first.sha256Hex).toMatch(/^[0-9a-f]{64}$/u);
    expect(countForeignPdfPages(bytes)).toBe(1);
  });

  it("verweigert MIME, Dateinamen und Größen fail-closed", () => {
    const bytes = pdfBytes();
    expect(codeOf(() => validateForeignPdfUpload({ bytes, filename: "x.pdf", mimeType: "application/octet-stream" })))
      .toBe("bad_mime");

    for (const filename of ["datenblatt.txt", "../escape.pdf", "a/b.pdf", "x.pdf\u0000", ".pdf", "a.pd", ""]) {
      expect(codeOf(() => validateForeignPdfUpload({ bytes, filename, mimeType: "application/pdf" })), filename)
        .toBe("bad_filename");
    }
    expect(codeOf(() => validateForeignPdfUpload({
      bytes,
      filename: 123 as unknown as string,
      mimeType: "application/pdf",
    }))).toBe("bad_filename");

    expect(codeOf(() => validateForeignPdfUpload({
      bytes: new TextEncoder().encode("%PDF-1.4 kurz"),
      filename: "klein.pdf",
      mimeType: "application/pdf",
    }))).toBe("too_small");

    const huge = new Uint8Array(FOREIGN_PDF_MAX_BYTES + 1);
    huge.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(codeOf(() => validateForeignPdfUpload({ bytes: huge, filename: "gross.pdf", mimeType: "application/pdf" })))
      .toBe("too_large");
  });

  it("verweigert Nicht-PDF, verschlüsselte und seitenlose Dokumente", () => {
    const notPdf = new Uint8Array(200).fill(0x41);
    expect(codeOf(() => validateForeignPdfUpload({ bytes: notPdf, filename: "x.pdf", mimeType: "application/pdf" })))
      .toBe("not_pdf");

    expect(codeOf(() => validateForeignPdfUpload({
      bytes: pdfBytes("4 0 obj << /Encrypt << /Filter /Standard >> >>"),
      filename: "secret.pdf",
      mimeType: "application/pdf",
    }))).toBe("encrypted");

    expect(codeOf(() => validateForeignPdfUpload({
      bytes: new TextEncoder().encode(`%PDF-1.4\n${"%".padEnd(120, "0")}`),
      filename: "leer.pdf",
      mimeType: "application/pdf",
    }))).toBe("no_pages");

    expect(codeOf(() => validateForeignPdfUpload({
      bytes: pdfBytes("/Type /Page ".repeat(60)),
      filename: "dick.pdf",
      mimeType: "application/pdf",
    }))).toBe("too_many_pages");
  });

  it("validiert Deskriptor-Listen strikt (eindeutig, begrenzt, wohlgeformt)", () => {
    const first = validateForeignPdfUpload({ bytes: pdfBytes(), filename: "a.pdf", mimeType: "application/pdf" });
    const second = validateForeignPdfUpload({ bytes: pdfBytes("% extra"), filename: "b.pdf", mimeType: "application/pdf" });
    expect(first.sha256Hex).not.toBe(second.sha256Hex);

    expect(parseForeignPdfDescriptors([first, second])).toEqual([first, second]);
    expect(() => parseForeignPdfDescriptors([first, first])).toThrow(/Fremd-PDF/u);
    expect(() => parseForeignPdfDescriptors([])).toThrow(/Fremd-PDF/u);
    expect(() => parseForeignPdfDescriptors(
      Array.from({ length: 6 }, (_, index) => ({ ...first, sha256Hex: `${index}`.padStart(64, "0") })),
    )).toThrow(/Fremd-PDF/u);
    expect(() => parseForeignPdfDescriptors([{ ...first, sha256Hex: "xyz" }])).toThrow(/Fremd-PDF/u);
  });

  it("rendert Fremd-PDFs als escapte Anhangliste ohne aktive Inhalte", () => {
    const one = validateForeignPdfUpload({ bytes: pdfBytes(), filename: "Preis<VIP>.pdf", mimeType: "application/pdf" });
    const two: ForeignPdfDescriptor = {
      ...validateForeignPdfUpload({
        bytes: pdfBytes("4 0 obj << /Type /Page /Parent 2 0 R >>"),
        filename: "details.pdf",
        mimeType: "application/pdf",
      }),
    };
    expect(two.pageCount).toBe(2);

    const html = renderOfferPdfDraftHtml(inputFixture(), { foreignPdfs: [one, two] });

    expect(html).toContain("Eingebettete Fremd-PDFs (2)");
    expect(html).toContain("Preis&lt;VIP&gt;.pdf");
    expect(html).not.toContain("Preis<VIP>.pdf");
    expect(html).toContain("1 Seite");
    expect(html).toContain("2 Seiten");
    expect(html).toContain(one.sha256Hex);
    expect(html).toContain("&nbsp;KB");
    expect(html).toContain("unveränderte Anhänge Dritter");
    expect(html).not.toMatch(/<(?:img|link|iframe|object|embed|video|audio|source)\b/iu);
  });

  it("rendert ohne Fremd-PDFs keinen Anhang und verweigert ungültige Listen", () => {
    const input = inputFixture();
    expect(renderOfferPdfDraftHtml(input)).not.toContain("Eingebettete Fremd-PDFs");
    expect(() => renderOfferPdfDraftHtml(input, { foreignPdfs: [{ ungueltig: true }] }))
      .toThrow(/Fremd-PDF/u);
  });
});
