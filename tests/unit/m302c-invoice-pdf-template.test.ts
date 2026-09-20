import { describe, expect, it } from "vitest";
import type { InvoicePdfInputV1 } from "@/lib/integrations/invoicing/pdf-contract";
import { renderInvoicePdfHtml } from "@/lib/integrations/invoicing/pdf-template";

function validInput(): InvoicePdfInputV1 {
  return {
    schemaVersion: "invoice-pdf-input.v1",
    canonicalizationVersion: "invoice-pdf-jcs.v1",
    templateVersion: "invoice-pdf-template.v1",
    rendererRecipeVersion: "invoice-pdf-renderer-recipe.v1",
    preparedAt: "2026-09-17T10:00:00.000Z",
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
    lines: [
      {
        position: 1,
        title: "PV-Module <script>alert('x')</script>",
        quantityMilli: 10_000,
        unit: "piece",
        netCents: 100_000,
        taxCents: 19_000,
        grossCents: 119_000,
        taxRateBps: 1900,
      },
    ],
    totals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
  };
}

describe("M3-02c Invoice-PDF-Template", () => {
  it("M302C-CT-05a: versiegelte Felder erscheinen, finale Rechnung ohne Entwurf", () => {
    const html = renderInvoicePdfHtml(validInput());
    expect(html).toContain("RE-2026-000001");
    expect(html).toContain("Rechnung");
    expect(html).toContain("Muster GmbH");
    expect(html).toContain("Energie Saas AG");
    expect(html).toContain("DE75512108001245126199");
    expect(html).toContain("1.190,00&nbsp;€");
    expect(html).not.toMatch(/entwurf/i);
  });

  it("M302C-CT-05b: HTML wird escaped (XSS-fail-closed)", () => {
    const html = renderInvoicePdfHtml(validInput());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("M302C-CT-05c: keine externen Ressourcen, keine Leak-Felder", () => {
    const html = renderInvoicePdfHtml(validInput());
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toContain("url(");
    for (const leak of [
      "contactId",
      "workspaceId",
      "paidCents",
      "paymentStatus",
      "createdBy",
      "accountingMethod",
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it("M302C-CT-05d: Gutschrift trägt Gutschrift-Titel und Typ", () => {
    const html = renderInvoicePdfHtml({
      ...validInput(),
      document: {
        ...validInput().document,
        type: "credit_note",
        invoiceKind: null,
        creditNoteType: "minderleistung",
      },
    });
    expect(html).toContain("Gutschrift");
  });

  it("M302C-CT-05e: ungueltiger Input wirft vor dem Rendern", () => {
    expect(() => renderInvoicePdfHtml({} as never)).toThrow();
    expect(() => renderInvoicePdfHtml(null as never)).toThrow();
  });
});
