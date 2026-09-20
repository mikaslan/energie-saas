import { describe, expect, it } from "vitest";
import {
  buildOfferRevisionOperations,
  createOfferEditorDraft,
  moveOfferDraftLine,
  moveOfferDraftSection,
  reorderOfferDraftLineByIndex,
  reorderOfferDraftSectionByIndex,
  type OfferEditorSourceSnapshot,
} from "@/app/w/[workspaceId]/angebote/[offerId]/offer-editor-model";

// F203B-09-Unit (D3-03 Stretch, RED): Die Drag-Reorder-Helfer
// `reorderOfferDraftSectionByIndex` / `reorderOfferDraftLineByIndex`
// existieren noch nicht im UI-Modell — der Import oberhalb schlägt
// fehl, bis GREEN sie als UI-Alternative zu den Hoch/Runter-Buttons
// (offer-editor.tsx: Buttons senden moveOfferDraftSection /
// moveOfferDraftLine → Ops move_section / move_line) liefert.
// Spec: docs/spec/F2-03b-kalkulation-rest.md §D3-03 (gedeckelt:
// gleiche Ops, Buttons bleiben für Tastatur).

const SECTION_A_ID = "d3000000-0000-4000-8000-0000000000a1";
const SECTION_B_ID = "d3000000-0000-4000-8000-0000000000b2";
const LINE_A_ID = "d3000000-0000-4000-8000-0000000000c3";
const LINE_B_ID = "d3000000-0000-4000-8000-0000000000d4";
const LINE_C_ID = "d3000000-0000-4000-8000-0000000000e5";

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
      sectionDomainId: SECTION_A_ID,
      position: 1,
      title: "PV-Anlage",
      category: "module",
      discountBps: 0,
      lines: [
        {
          lineDomainId: LINE_A_ID,
          position: 1,
          positionType: "required",
          isHidden: false,
          quantityMilli: 10_000,
          salesUnitNetCents: 10_000,
          purchaseUnitNetCents: 5_000,
          lineDiscountBps: 0,
          sourceKind: "catalog",
          displayName: "Modul",
          description: null,
          taxTreatment: "standard_19",
          componentCategory: "module",
          unit: "piece",
        },
        {
          lineDomainId: LINE_B_ID,
          position: 2,
          positionType: "additional",
          isHidden: false,
          quantityMilli: 1_000,
          salesUnitNetCents: 25_050,
          purchaseUnitNetCents: 12_000,
          lineDiscountBps: 250,
          sourceKind: "catalog",
          displayName: "Montage",
          description: null,
          taxTreatment: "standard_19",
          componentCategory: "module",
          unit: "piece",
        },
      ],
    }, {
      sectionDomainId: SECTION_B_ID,
      position: 2,
      title: "Sonstiges",
      category: "other",
      discountBps: 0,
      lines: [{
        lineDomainId: LINE_C_ID,
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

describe("F2-03b Drag-Reorder erzeugt identische Ops wie die Buttons (F203B-09-Unit)", () => {
  it("Sektions-Drag auf Index 0 erzeugt exakt die move_section-Op des Hoch-Buttons", () => {
    const snapshot = source();
    const viaButton = moveOfferDraftSection(
      createOfferEditorDraft(snapshot),
      SECTION_B_ID,
      "up",
    );
    const viaDrag = reorderOfferDraftSectionByIndex(
      createOfferEditorDraft(snapshot),
      SECTION_B_ID,
      0,
    );

    const buttonResult = buildOfferRevisionOperations(snapshot, viaButton, ALL_CAPABILITIES);
    const dragResult = buildOfferRevisionOperations(snapshot, viaDrag, ALL_CAPABILITIES);

    expect(buttonResult).toEqual({
      ok: true,
      operations: [
        { operation: "move_section", sectionDomainId: SECTION_B_ID, position: 1 },
      ],
    });
    expect(dragResult).toEqual(buttonResult);
  });

  it("Zeilen-Drag auf Index 0 erzeugt exakt die move_line-Op des Hoch-Buttons", () => {
    const snapshot = source();
    const viaButton = moveOfferDraftLine(
      createOfferEditorDraft(snapshot),
      SECTION_A_ID,
      LINE_B_ID,
      "up",
    );
    const viaDrag = reorderOfferDraftLineByIndex(
      createOfferEditorDraft(snapshot),
      SECTION_A_ID,
      LINE_B_ID,
      0,
    );

    const buttonResult = buildOfferRevisionOperations(snapshot, viaButton, ALL_CAPABILITIES);
    const dragResult = buildOfferRevisionOperations(snapshot, viaDrag, ALL_CAPABILITIES);

    expect(buttonResult).toEqual({
      ok: true,
      operations: [
        {
          operation: "move_line",
          lineDomainId: LINE_B_ID,
          sectionDomainId: SECTION_A_ID,
          position: 1,
        },
      ],
    });
    expect(dragResult).toEqual(buttonResult);
  });
});
