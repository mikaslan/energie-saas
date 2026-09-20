import { describe, expect, it } from "vitest";

import { buildEpcPayload } from "@/lib/integrations/invoicing/epc-contract";
import { buildInvoicePaymentInput } from "@/lib/integrations/invoicing/pdf-contract";
import { renderInvoicePaymentHtml } from "@/lib/integrations/invoicing/payment-template";
import {
  createPlaywrightInvoicePdfRenderer,
  InvoicePdfRenderError,
  renderEpcQrSvg,
} from "@/worker/invoice-pdf-renderer";

const EPC_PAYLOAD = buildEpcPayload({
  creditorName: "Energie Saas AG",
  creditorIban: "DE75512108001245126199",
  creditorBic: "BELADEBEXXX",
  amountCents: 11900,
  documentNumber: "RE-2026-000001",
});

function validPaymentInput() {
  const built = buildInvoicePaymentInput({
    creditor: {
      name: "Energie Saas AG",
      iban: "DE75512108001245126199",
      bic: "BELADEBEXXX",
    },
    amountCents: 11900,
    reference: EPC_PAYLOAD.split("\n")[9] ?? "",
    documentNumber: "RE-2026-000001",
    epcPayload: EPC_PAYLOAD,
    preparedAt: "2026-09-17T10:00:00.000Z",
  });
  if (!built.ok) throw new Error("F817-Test-Fixture ungueltig");
  return built.value;
}

describe("F8-17 Payment-Renderer-Dispatch", () => {
  it("F817-CT-04: EPC-QR ist deterministisch und passiert das Template-Gate", () => {
    const first = renderEpcQrSvg(EPC_PAYLOAD);
    const second = renderEpcQrSvg(EPC_PAYLOAD);

    expect(second).toBe(first);
    expect(first).toContain('xmlns="http://www.w3.org/2000/svg"');
    const html = renderInvoicePaymentHtml(validPaymentInput(), first);
    expect(html).toContain(first);
  });

  it("F817-CT-04: Cross-Mix (Payment-Input + Invoice-Rezept) scheitert vor dem Browser", async () => {
    const renderer = createPlaywrightInvoicePdfRenderer();
    const mixed = {
      ...validPaymentInput(),
      rendererRecipeVersion: "invoice-pdf-renderer-recipe.v1",
    } as unknown as Parameters<typeof renderer.render>[0];

    await expect(renderer.render(mixed)).rejects.toMatchObject({
      name: "InvoicePdfRenderError",
      code: "invalid_input",
      retryable: false,
    });
  });

  it("F817-CT-04: unbekannte Schema-Version scheitert vor dem Browser", async () => {
    const renderer = createPlaywrightInvoicePdfRenderer();

    await expect(renderer.render({
      schemaVersion: "invoice-pdf-input.v99",
    } as unknown as Parameters<typeof renderer.render>[0])).rejects.toBeInstanceOf(
      InvoicePdfRenderError,
    );
  });
});
