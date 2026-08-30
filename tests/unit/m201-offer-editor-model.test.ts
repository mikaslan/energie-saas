import { describe, expect, it } from "vitest";
import {
  buildOfferRevisionOperations,
  canRemoveOfferDraftSection,
  createOfferEditorRecoveryEnvelope,
  createOfferEditorDraft,
  isOfferEditorDraftDirty,
  isOfferEditorPriceInputChanged,
  moveOfferDraftLine,
  moveOfferDraftSection,
  moveOfferDraftLineToSection,
  addCustomOfferDraftSection,
  addCustomOfferDraftLine,
  calculateOfferEditorPreview,
  rebaseOfferEditorDraft,
  redactOfferEditorPurchaseDraft,
  prepareOfferEditorRecoveryDrafts,
  removeCustomOfferDraftLine,
  type OfferEditorSourceSnapshot,
} from "@/app/w/[workspaceId]/angebote/[offerId]/offer-editor-model";

const SECTION_ID = "50000000-0000-4000-8000-000000000005";
const LINE_A_ID = "60000000-0000-4000-8000-000000000006";
const LINE_B_ID = "70000000-0000-4000-8000-000000000007";
const SECTION_B_ID = "80000000-0000-4000-8000-000000000008";
const CUSTOM_LINE_ID = "90000000-0000-4000-8000-000000000009";
const CUSTOM_LINE_B_ID = "c0000000-0000-4000-8000-00000000000c";
const NEW_SECTION_ID = "a0000000-0000-4000-8000-00000000000a";
const NEW_LINE_ID = "b0000000-0000-4000-8000-00000000000b";

function source(): OfferEditorSourceSnapshot {
  return {
    revision: 3,
    variantName: "Basis",
    description: "Gespeicherter Entwurf",
    globalDiscountBps: 0,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: SECTION_ID,
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
        description: "Ausgangstext",
        taxTreatment: "standard_19",
        componentCategory: "other",
        unit: "set",
      }, {
        lineDomainId: CUSTOM_LINE_B_ID,
        position: 2,
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        salesUnitNetCents: 1_000,
        purchaseUnitNetCents: 500,
        lineDiscountBps: 0,
        sourceKind: "custom",
        displayName: "Verbleibende freie Position",
        description: null,
        taxTreatment: "standard_19",
        componentCategory: "other",
        unit: "piece",
      }],
    }],
  };
}

const ALL_CAPABILITIES = {
  canEditPrice: true,
  canApplyDiscount: true,
  canEditPurchasePrice: true,
} as const;

describe("M2-01 Offer-Editor-Draft", () => {
  it("startet exakt auf dem gespeicherten Snapshot und erzeugt ohne Änderung keinen Patch", () => {
    const snapshot = source();
    const draft = createOfferEditorDraft(snapshot);

    expect(isOfferEditorDraftDirty(snapshot, draft)).toBe(false);
    expect(buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES)).toEqual({
      ok: true,
      operations: [],
    });
  });

  it("behandelt reine Override-Gründe und kanonisch äquivalente Schreibweisen als fachliches No-op", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      variantName: "  Basis  ",
      sections: initial.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? {
              ...line,
              quantity: "10,000",
              salesUnitNetEuros: "100,00",
              salesPriceReason: "negotiated" as const,
            }
          : line.lineDomainId === CUSTOM_LINE_ID
            ? {
                ...line,
                purchaseUnitNetEuros: "20,00",
                purchasePriceReason: "other" as const,
              }
            : line),
      })),
    };

    expect(isOfferEditorDraftDirty(snapshot, draft)).toBe(false);
    expect(buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES)).toEqual({
      ok: true,
      operations: [],
    });
    expect(isOfferEditorPriceInputChanged("100,00", 10_000)).toBe(false);
    expect(isOfferEditorPriceInputChanged("100,01", 10_000)).toBe(true);
  });

  it("persistiert auch für EK-berechtigte Akteure niemals EK-Klartext im Recovery-Envelope", () => {
    const draft = createOfferEditorDraft(source());
    const purchaseSentinel = "87654321,99";
    const withPurchaseDraft = {
      ...draft,
      sections: draft.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === CUSTOM_LINE_ID
          ? {
              ...line,
              purchaseUnitNetEuros: purchaseSentinel,
              purchasePriceReason: "negotiated" as const,
            }
          : line),
      })),
    };

    const redacted = redactOfferEditorPurchaseDraft(withPurchaseDraft);

    expect(JSON.stringify(redacted)).not.toContain(purchaseSentinel);
    expect(redacted.sections.flatMap((section) => section.lines).every(
      (line) => line.purchaseUnitNetEuros === "" && line.purchasePriceReason === "correction",
    )).toBe(true);

    const actorAScope = "a".repeat(64);
    const envelope = createOfferEditorRecoveryEnvelope({
      offerId: "10000000-0000-4000-8000-000000000001",
      variantId: "20000000-0000-4000-8000-000000000002",
      recoveryScope: actorAScope,
      expectedRevision: 3,
      previousBase: draft,
      localDraft: withPurchaseDraft,
    });
    expect(envelope.purchaseDraftOmitted).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(purchaseSentinel);
    expect(JSON.stringify(envelope)).not.toContain("20,00");

    const actorBScope = "b".repeat(64);
    expect(prepareOfferEditorRecoveryDrafts({
      recoveryScope: actorAScope,
      previousBase: withPurchaseDraft,
      localDraft: withPurchaseDraft,
    }, actorBScope)).toBeNull();
    const sameActor = prepareOfferEditorRecoveryDrafts({
      recoveryScope: actorAScope,
      previousBase: withPurchaseDraft,
      localDraft: withPurchaseDraft,
    }, actorAScope);
    expect(JSON.stringify(sameActor)).not.toContain(purchaseSentinel);
  });

  it("bündelt Name, Reorder, Menge, VK, Rabatt, Positionsart und Sichtbarkeit in genau einen Patch", () => {
    const snapshot = source();
    let draft = createOfferEditorDraft(snapshot);
    draft = {
      ...draft,
      variantName: "Empfohlen Plus",
      sections: draft.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? {
              ...line,
              quantity: "12",
              salesUnitNetEuros: "125,50",
              lineDiscountPercent: "7,5",
              positionType: "optional",
              isHidden: true,
              salesPriceReason: "negotiated",
            }
          : line),
      })),
    };
    draft = moveOfferDraftLine(draft, SECTION_ID, LINE_B_ID, "up");

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);

    expect(isOfferEditorDraftDirty(snapshot, draft)).toBe(true);
    expect(result).toEqual({
      ok: true,
      operations: [
        { operation: "set_variant_name", name: "Empfohlen Plus" },
        {
          operation: "move_line",
          lineDomainId: LINE_B_ID,
          sectionDomainId: SECTION_ID,
          position: 1,
        },
        {
          operation: "set_line_quantity",
          lineDomainId: LINE_A_ID,
          quantityMilli: 12_000,
        },
        {
          operation: "set_line_position_type",
          lineDomainId: LINE_A_ID,
          positionType: "optional",
        },
        {
          operation: "set_line_visibility",
          lineDomainId: LINE_A_ID,
          isHidden: true,
        },
        {
          operation: "set_line_sales_price",
          lineDomainId: LINE_A_ID,
          salesUnitNetCents: 12_550,
          reasonCode: "negotiated",
        },
        {
          operation: "set_line_discount",
          lineDomainId: LINE_A_ID,
          discountBps: 750,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/totals|Gross|Tax|computed/u);
  });

  it("weist ungültige Dezimalwerte und unberechtigte Preis-/Rabattänderungen feldbezogen ab", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) => ({
        ...section,
        discountPercent: "2",
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? {
              ...line,
              quantity: "1,2345",
              salesUnitNetEuros: "99",
              lineDiscountPercent: "4",
            }
          : line),
      })),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, {
      canEditPrice: false,
      canApplyDiscount: false,
      canEditPurchasePrice: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("RED: ungültiger Draft wurde akzeptiert");
    expect(result.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      `line-${LINE_A_ID}-quantity`,
      `line-${LINE_A_ID}-sales-price`,
      `line-${LINE_A_ID}-discount`,
      `section-${SECTION_ID}-discount`,
    ]));
  });

  it("bündelt globale Konditionen, Sektionsreorder, Cross-Section-Move, Steuer und freien EK", () => {
    const snapshot = source();
    let draft = createOfferEditorDraft(snapshot);
    draft = {
      ...draft,
      globalDiscountPercent: "3,5",
      customDealNetEuros: "875,25",
      sections: draft.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === CUSTOM_LINE_ID
          ? {
              ...line,
              purchaseUnitNetEuros: "25,00",
              purchasePriceReason: "negotiated" as const,
              taxTreatment: "zero_operator_confirmed" as const,
              zeroTaxConfirmed: true,
            }
          : line),
      })),
    };
    draft = moveOfferDraftSection(draft, SECTION_B_ID, "up");
    draft = moveOfferDraftLineToSection(draft, LINE_A_ID, SECTION_B_ID, 2);

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("RED: vollständiger Editor-Patch wurde abgewiesen");
    expect(result.operations).toEqual(expect.arrayContaining([
      { operation: "set_global_discount", discountBps: 350 },
      { operation: "set_custom_deal", customDealNetCents: 87_525 },
      { operation: "move_section", sectionDomainId: SECTION_B_ID, position: 1 },
      { operation: "move_line", lineDomainId: LINE_A_ID, sectionDomainId: SECTION_B_ID, position: 2 },
      {
        operation: "set_line_purchase_price",
        lineDomainId: CUSTOM_LINE_ID,
        purchaseUnitNetCents: 2_500,
        reasonCode: "negotiated",
      },
      {
        operation: "set_line_tax",
        lineDomainId: CUSTOM_LINE_ID,
        taxTreatment: "zero_operator_confirmed",
        zeroConfirmation: {
          code: "zero_tax_draft_operator_confirmed",
          confirmed: true,
        },
      },
    ]));
  });

  it("erzeugt und entfernt freie Sektionen/Zeilen ausschließlich mit vollständigen Commands", () => {
    const snapshot = source();
    let draft = createOfferEditorDraft(snapshot);
    draft = removeCustomOfferDraftLine(draft, CUSTOM_LINE_ID);
    draft = addCustomOfferDraftSection(draft, {
      sectionDomainId: NEW_SECTION_ID,
      title: "Freie Arbeiten",
      category: "other",
    });
    draft = addCustomOfferDraftLine(draft, NEW_SECTION_ID, {
      lineDomainId: NEW_LINE_ID,
      displayName: "Sonderleistung",
    });
    draft = {
      ...draft,
      sections: draft.sections.map((section) => section.sectionDomainId === NEW_SECTION_ID
        ? {
            ...section,
            lines: section.lines.map((line) => ({
              ...line,
              description: "Sauber dokumentiert",
              unit: "meter" as const,
              quantity: "2,5",
              salesUnitNetEuros: "100",
              purchaseUnitNetEuros: "60",
              positionType: "additional" as const,
              taxTreatment: "standard_19" as const,
            })),
          }
        : section),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("RED: freie Struktur wurde abgewiesen");
    expect(result.operations).toEqual(expect.arrayContaining([
      { operation: "remove_custom_line", lineDomainId: CUSTOM_LINE_ID },
      {
        operation: "add_custom_section",
        sectionDomainId: NEW_SECTION_ID,
        position: 3,
        title: "Freie Arbeiten",
        category: "other",
      },
      expect.objectContaining({
        operation: "add_custom_line",
        lineDomainId: NEW_LINE_ID,
        sectionDomainId: NEW_SECTION_ID,
        position: 1,
        description: "Sauber dokumentiert",
        unit: "meter",
        quantityMilli: 2_500,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 6_000,
        taxTreatment: "standard_19",
      }),
    ]));
  });

  it("lässt weder die letzte Zeile zurück noch eine geleerte Katalogsektion als frei entfernbar erscheinen", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const withOneCustomLine = removeCustomOfferDraftLine(initial, CUSTOM_LINE_B_ID);

    expect(moveOfferDraftLineToSection(
      withOneCustomLine,
      CUSTOM_LINE_ID,
      SECTION_ID,
      1,
    )).toBe(withOneCustomLine);

    const syntheticallyEmptiedCatalogSection = {
      ...initial,
      sections: initial.sections.map((section) => section.sectionDomainId === SECTION_ID
        ? { ...section, lines: [] }
        : section),
    };
    const syntheticallyEmptiedCustomSection = {
      ...initial,
      sections: initial.sections.map((section) => section.sectionDomainId === SECTION_B_ID
        ? { ...section, lines: [] }
        : section),
    };

    expect(canRemoveOfferDraftSection(snapshot, syntheticallyEmptiedCatalogSection, SECTION_ID)).toBe(false);
    expect(canRemoveOfferDraftSection(snapshot, syntheticallyEmptiedCustomSection, SECTION_B_ID)).toBe(true);
  });

  it("verweigert EK für Katalogzeilen und 0 % ohne frische Bestätigung", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? {
              ...line,
              purchaseUnitNetEuros: "1",
              taxTreatment: "zero_operator_confirmed" as const,
              zeroTaxConfirmed: false,
            }
          : line),
      })),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("RED: unsicherer EK-/Steuerpatch wurde akzeptiert");
    expect(result.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      `line-${LINE_A_ID}-purchase-price`,
      `line-${LINE_A_ID}-zero-confirmation`,
    ]));
  });

  it("verwirft einen geleerten bestehenden Custom-EK niemals still", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === CUSTOM_LINE_ID
          ? { ...line, purchaseUnitNetEuros: "" }
          : line),
      })),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("RED: geleerter Custom-EK wurde still verworfen");
    expect(result.errors.map((error) => error.field)).toContain(
      `line-${CUSTOM_LINE_ID}-purchase-price`,
    );
  });

  it("speichert Metadaten einer bestehenden freien Position ohne Preisrechte als geschlossenen Command", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === CUSTOM_LINE_ID
          ? {
              ...line,
              displayName: "Individuelle Gerüststellung",
              description: "Mit Seitenschutz",
              unit: "piece" as const,
            }
          : line),
      })),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, {
      canEditPrice: false,
      canApplyDiscount: false,
      canEditPurchasePrice: false,
    });

    expect(result).toEqual({
      ok: true,
      operations: [{
        operation: "set_custom_line_details",
        lineDomainId: CUSTOM_LINE_ID,
        displayName: "Individuelle Gerüststellung",
        description: "Mit Seitenschutz",
        unit: "piece",
      }],
    });
  });

  it("verwirft veränderte Katalogmetadaten niemals still", () => {
    const snapshot = source();
    const initial = createOfferEditorDraft(snapshot);
    const draft = {
      ...initial,
      sections: initial.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? { ...line, displayName: "Manipulierter Snapshot" }
          : line),
      })),
    };

    const result = buildOfferRevisionOperations(snapshot, draft, ALL_CAPABILITIES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("RED: veränderte Katalogmetadaten wurden still verworfen");
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "editor-structure" }));
  });

  it("berechnet eine rein lokale Vorschau mit demselben ganzzahligen Money-Code", () => {
    const draft = createOfferEditorDraft(source());
    const changed = {
      ...draft,
      globalDiscountPercent: "10",
    };

    const preview = calculateOfferEditorPreview(changed);
    expect(preview).not.toBeNull();
    expect(preview?.totals.basisNetCents).toBe(117_382);
    expect(preview?.totals.basisTaxCents).toBe(22_303);
  });

  it("rebasiert lokale Eingaben als Drei-Wege-Merge auf einen neuen Serverstand", () => {
    const base = createOfferEditorDraft(source());
    const local = {
      ...base,
      sections: base.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? { ...line, quantity: "12" }
          : line),
      })),
    };
    const current = {
      ...base,
      variantName: "Parallel umbenannt",
    };

    const rebased = rebaseOfferEditorDraft(base, local, current);
    expect(rebased.draft.variantName).toBe("Parallel umbenannt");
    expect(rebased.draft.sections.flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === LINE_A_ID)?.quantity).toBe("12");
    expect(rebased.notices).toEqual([]);
  });

  it("behält lokale Feldedits bei serverseitigem Cross-Section-Move global per Zeilen-ID", () => {
    const base = createOfferEditorDraft(source());
    const local = {
      ...base,
      sections: base.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? { ...line, quantity: "14" }
          : line),
      })),
    };
    const moving = base.sections[0]?.lines.find((line) => line.lineDomainId === LINE_A_ID);
    if (!moving) throw new Error("synthetische Rebase-Zeile fehlt");
    const current = {
      ...base,
      sections: base.sections.map((section) => section.sectionDomainId === SECTION_ID
        ? { ...section, lines: section.lines.filter((line) => line.lineDomainId !== LINE_A_ID) }
        : section.sectionDomainId === SECTION_B_ID
          ? { ...section, lines: [...section.lines, moving] }
          : section),
    };

    const rebased = rebaseOfferEditorDraft(base, local, current);
    const target = rebased.draft.sections.find((section) => section.sectionDomainId === SECTION_B_ID);
    expect(target?.lines.find((line) => line.lineDomainId === LINE_A_ID)?.quantity).toBe("14");
  });

  it("hält lokal geänderte, serverseitig entfernte Zeilen als prüfbare Recoverywerte", () => {
    const base = createOfferEditorDraft(source());
    const local = {
      ...base,
      sections: base.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) => line.lineDomainId === LINE_A_ID
          ? { ...line, salesUnitNetEuros: "222" }
          : line),
      })),
    };
    const current = {
      ...base,
      sections: base.sections.map((section) => section.sectionDomainId === SECTION_ID
        ? { ...section, lines: section.lines.filter((line) => line.lineDomainId !== LINE_A_ID) }
        : section),
    };

    const rebased = rebaseOfferEditorDraft(base, local, current);
    expect(rebased.notices.join(" ")).toMatch(/serverseitig entfernt/iu);
    expect(rebased.unappliedLines).toEqual([
      expect.objectContaining({ lineDomainId: LINE_A_ID, salesUnitNetEuros: "222" }),
    ]);
  });

  it("hält lokal geänderte, serverseitig entfernte Custom-Sektionen prüfbar", () => {
    const base = createOfferEditorDraft(source());
    const local = {
      ...base,
      sections: base.sections.map((section) => section.sectionDomainId === SECTION_B_ID
        ? { ...section, discountPercent: "7" }
        : section),
    };
    const current = {
      ...base,
      sections: base.sections.filter((section) => section.sectionDomainId !== SECTION_B_ID),
    };

    const rebased = rebaseOfferEditorDraft(base, local, current);
    expect(rebased.notices.join(" ")).toMatch(/Sektionswerte/iu);
    expect(rebased.unappliedSections).toEqual([
      expect.objectContaining({ sectionDomainId: SECTION_B_ID, discountPercent: "7" }),
    ]);
  });
});
