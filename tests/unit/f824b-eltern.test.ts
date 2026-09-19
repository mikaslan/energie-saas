import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/w/[workspaceId]/rechnungen/actions", () => ({
  createPartialInvoiceAction: vi.fn(),
}));

import { PartialInvoicePanel } from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/partial-invoice-panel";
import { formatEuro } from "@/app/w/[workspaceId]/rechnungen/labels";
import type { PartialChain } from "@/modules/invoicing";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";

function chain(overrides: Partial<PartialChain> = {}): PartialChain {
  return {
    order: { id: DOCUMENT_ID, number: "AB-1", name: "AB Eltern", grossCents: 1130500 },
    orderLines: [],
    partials: [],
    billedGrossCents: 678300,
    remainingGrossCents: 452200,
    consumedLineIds: [],
    paidGrossCents: 100000,
    openGrossCents: 578300,
    parentPaymentStatus: "partially_paid",
    ...overrides,
  };
}

function renderPanel(value: PartialChain): string {
  return renderToStaticMarkup(createElement(PartialInvoicePanel, {
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    chain: value,
    canWrite: false,
  }));
}

describe("F8-24b Eltern-Zahlstatus im Ketten-Kopf", () => {
  it("F824B-CT-02a: zeigt Offen/Bezahlt-Betraege und Teilstatus", () => {
    const html = renderPanel(chain());
    expect(html).toContain('data-testid="partial-payment-summary"');
    expect(html).toContain(`Offen ${formatEuro(578300)}`);
    expect(html).toContain(`bezahlt ${formatEuro(100000)}`);
    expect(html).toContain("Teilweise bezahlt");
  });

  it("F824B-CT-02b: vollbezahlte Kette — open 0 und Status Bezahlt", () => {
    const html = renderPanel(chain({
      billedGrossCents: 678300,
      remainingGrossCents: 452200,
      paidGrossCents: 678300,
      openGrossCents: 0,
      parentPaymentStatus: "paid",
    }));
    expect(html).toContain('data-testid="partial-payment-summary"');
    expect(html).toContain(`Offen ${formatEuro(0)}`);
    expect(html).toContain(`bezahlt ${formatEuro(678300)}`);
    expect(html).toContain("Bezahlt");
  });

  it("F824B-CT-02c: unbezahlte Kette — Status Offen, Rest-Anzeige unberuehrt", () => {
    const html = renderPanel(chain({
      paidGrossCents: 0,
      openGrossCents: 678300,
      parentPaymentStatus: "unpaid",
    }));
    expect(html).toContain('data-testid="partial-payment-summary"');
    expect(html).toContain(`bezahlt ${formatEuro(0)}`);
    expect(html).toContain("· Offen");
    // Bestehende Ketten-Kopf-Anzeige bleibt bestehen.
    expect(html).toContain('data-testid="partial-chain-summary"');
    expect(html).toContain(`Rest: ${formatEuro(452200)}`);
  });
});
