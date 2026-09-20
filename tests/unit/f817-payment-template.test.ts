import QRCode from "qrcode-generator";
import { describe, expect, it } from "vitest";

import { buildEpcPayload } from "@/lib/integrations/invoicing/epc-contract";
import type { InvoicePaymentInputV1 } from "@/lib/integrations/invoicing/pdf-contract";
import { renderInvoicePaymentHtml } from "@/lib/integrations/invoicing/payment-template";

function testQrSvg(payload: string): string {
  const qr = QRCode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({});
}

const QR_SVG = testQrSvg("BCD\n002\n1\nSCT\nBELADEBEXXX\nEnergie Saas AG\nDE75512108001245126199\nEUR119.00\n\nRF18539007547034");

function validInput(): InvoicePaymentInputV1 {
  return {
    schemaVersion: "invoice-payment-input.v1",
    canonicalizationVersion: "invoice-pdf-jcs.v1",
    templateVersion: "invoice-payment-template.v1",
    rendererRecipeVersion: "invoice-payment-renderer-recipe.v1",
    preparedAt: "2026-09-17T10:00:00.000Z",
    creditor: {
      name: "Energie Saas AG",
      iban: "DE75512108001245126199",
      bic: "BELADEBEXXX",
    },
    amountCents: 11900,
    currency: "EUR",
    reference: "RF18539007547034",
    documentNumber: "RE-2026-000001",
    epcPayload:
      "BCD\n002\n1\nSCT\nBELADEBEXXX\nEnergie Saas AG\nDE75512108001245126199\nEUR119.00\n\nRF18539007547034",
  };
}

describe("F8-17 Zahlungs-PDF-Template", () => {
  it("F817-CT-03: rendert nur Zahlungsdaten + QR-SVG, keine Positionen", () => {
    const html = renderInvoicePaymentHtml(validInput(), QR_SVG);

    expect(html).toContain("Zahlungsbeleg");
    expect(html).toContain("Energie Saas AG");
    expect(html).toContain("DE75512108001245126199");
    expect(html).toContain("BELADEBEXXX");
    expect(html).toContain("119,00");
    expect(html).toContain("EUR");
    expect(html).toContain("RF18539007547034");
    expect(html).toContain("RE-2026-000001");
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 ');
    expect(html).toContain(QR_SVG);
    expect(html).not.toContain("Position");
    expect(html).not.toContain("invoice-pdf-template");
  });

  it("F817-CT-03: HTML wird escaped (XSS-fail-closed)", () => {
    // EPC-erlaubte Sonderzeichen landen versiegelt im Input (konsistenter
    // Payload), das Template muss trotzdem escapen.
    const evilName = "<img src=x onerror=alert(1)>";
    const epcPayload = buildEpcPayload({
      creditorName: evilName,
      creditorIban: "DE75512108001245126199",
      creditorBic: "BELADEBEXXX",
      amountCents: 11900,
      documentNumber: "RE-2026-000001",
    });
    const html = renderInvoicePaymentHtml(
      {
        ...validInput(),
        creditor: { name: evilName, iban: "DE75512108001245126199", bic: "BELADEBEXXX" },
        reference: epcPayload.split("\n")[9] ?? "",
        epcPayload,
      },
      QR_SVG,
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("F817-CT-03: kein QR-SVG ausserhalb, keine externen Ressourcen", () => {
    const html = renderInvoicePaymentHtml(validInput(), QR_SVG);
    // Der SVG-Namensraum ist Markup, kein Netzbezug.
    const withoutNamespace = html.replaceAll('xmlns="http://www.w3.org/2000/svg"', "");

    expect(html).not.toMatch(/<script[\s>]/iu);
    expect(withoutNamespace).not.toContain("http://");
    expect(withoutNamespace).not.toContain("https://");
    expect(html).not.toMatch(/<link[\s>]/iu);
    expect(html).not.toMatch(/url\(/iu);
  });

  it("F817-CT-03: fremdes SVG wird abgewiesen (nur versiegelte QR-Form)", () => {
    expect(() => renderInvoicePaymentHtml(
      validInput(),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )).toThrow();
    expect(() => renderInvoicePaymentHtml(validInput(), "kein-svg")).toThrow();
  });

  it("F817-CT-03: ungueltiger Input wirft vor dem Rendern", () => {
    expect(() => renderInvoicePaymentHtml(
      { ...validInput(), schemaVersion: "invoice-pdf-input.v1" } as unknown as InvoicePaymentInputV1,
      QR_SVG,
    )).toThrow();
    expect(() => renderInvoicePaymentHtml({ ...validInput(), amountCents: 0 }, QR_SVG)).toThrow();
  });
});
