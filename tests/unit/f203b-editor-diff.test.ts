import { describe, expect, it } from "vitest";
import {
  buildOfferRevisionOperations,
  createOfferEditorDraft,
  type OfferEditorSourceSnapshot,
} from "@/app/w/[workspaceId]/angebote/[offerId]/offer-editor-model";

const CUSTOM_SECTION_ID = "51000000-0000-4000-8000-000000000051";
const CUSTOM_LINE_ID = "52000000-0000-4000-8000-000000000052";

function source(): OfferEditorSourceSnapshot {
  return {
    revision: 3,
    variantName: "Basis",
    description: "Gespeicherter Entwurf",
    planningMode: "quick",
    globalDiscountBps: 0,
    globalDiscountCapCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: CUSTOM_SECTION_ID,
      position: 1,
      title: "Freie Arbeiten",
      category: "other",
      discountBps: 0,
      lines: [{
        lineDomainId: CUSTOM_LINE_ID,
        position: 1,
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        salesUnitNetCents: 5_000,
        purchaseUnitNetCents: 2_000,
        lineDiscountBps: 0,
        sourceKind: "custom",
        displayName: "Freie Position",
        description: null,
        taxTreatment: "standard_19",
        componentCategory: "other",
        unit: "set",
      }],
    }],
  };
}

const ALL_CAPABILITIES = {
  canEditPrice: true,
  canApplyDiscount: true,
  canEditPurchasePrice: true,
} as const;

describe("F2-03b F203B-08 Editor-Diff Sektionstitel", () => {
  it("erzeugt bei Titeländerung einer bestehenden Custom-Sektion genau eine set_custom_section_title-Op", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) =>
        section.sectionDomainId === CUSTOM_SECTION_ID
          ? { ...section, title: "Umbenannte Freie Sektion" }
          : section),
    };

    expect(buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES)).toEqual({
      ok: true,
      operations: [{
        operation: "set_custom_section_title",
        sectionDomainId: CUSTOM_SECTION_ID,
        title: "Umbenannte Freie Sektion",
      }],
    });
  });

  it("erzeugt ohne Titeländerung keine set_custom_section_title-Op", () => {
    const snapshot = source();
    const draft = createOfferEditorDraft(snapshot);

    expect(buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES)).toEqual({
      ok: true,
      operations: [],
    });
  });
});
