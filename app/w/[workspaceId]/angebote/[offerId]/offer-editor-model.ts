import { calculateOfferPricing, type OfferPricingResult } from "@/lib/integrations/offers/money";

export type OfferPositionType = "required" | "additional" | "optional";
export type OfferPriceReason = "customer_specific_pricing" | "negotiated" | "correction" | "other";
export type OfferTaxTreatment = "standard_19" | "zero_operator_confirmed";
export type OfferComponentCategory = "module" | "inverter" | "battery" | "wallbox" | "heat_pump" | "mounting" | "other";
export type OfferUnit = "piece" | "set" | "meter";

export interface OfferEditorSourceLine {
  lineDomainId: string;
  position: number;
  positionType: OfferPositionType;
  isHidden: boolean;
  quantityMilli: number;
  salesUnitNetCents: number;
  purchaseUnitNetCents?: number;
  lineDiscountBps: number;
  unit?: OfferUnit | string;
  sourceKind?: "catalog" | "custom";
  componentCategory?: OfferComponentCategory;
  displayName?: string;
  description?: string | null;
  taxTreatment?: OfferTaxTreatment;
}

export interface OfferEditorSourceSection {
  sectionDomainId: string;
  position?: number;
  title?: string;
  category?: OfferComponentCategory;
  discountBps: number;
  lines: readonly OfferEditorSourceLine[];
}

export interface OfferEditorSourceSnapshot {
  revision: number;
  variantName: string;
  description: string | null;
  globalDiscountBps?: number;
  globalDiscountCapCents?: number | null;
  globalFixDiscountCents?: number | null;
  customDealNetCents?: number | null;
  sections: readonly OfferEditorSourceSection[];
}

export interface OfferEditorDraftLine {
  lineDomainId: string;
  sourceKind: "catalog" | "custom";
  isNew: boolean;
  displayName: string;
  description: string;
  unit: OfferUnit;
  quantity: string;
  salesUnitNetEuros: string;
  purchaseUnitNetEuros: string;
  lineDiscountPercent: string;
  positionType: OfferPositionType;
  isHidden: boolean;
  salesPriceReason: OfferPriceReason;
  purchasePriceReason: OfferPriceReason;
  taxTreatment: OfferTaxTreatment;
  zeroTaxConfirmed: boolean;
}

export interface OfferEditorDraftSection {
  sectionDomainId: string;
  isNew: boolean;
  title: string;
  category: OfferComponentCategory;
  discountPercent: string;
  lines: readonly OfferEditorDraftLine[];
}

export interface OfferEditorDraft {
  variantName: string;
  description: string;
  globalDiscountPercent: string;
  // F16.3 Slice E: Deckel in Euro ("" = ungedeckelt).
  globalDiscountCapEuros: string;
  // F16.3 Slice D: globaler Fix-Rabatt in Euro ("" = keiner).
  globalFixDiscountEuros: string;
  customDealNetEuros: string;
  sections: readonly OfferEditorDraftSection[];
}

type ZeroConfirmation = { code: "zero_tax_draft_operator_confirmed"; confirmed: true };
export type OfferRevisionOperation =
  | { operation: "set_variant_name"; name: string }
  | { operation: "set_variant_description"; description: string | null }
  | { operation: "set_global_discount"; discountBps: number; capCents?: number | null }
  | { operation: "set_global_fix_discount"; fixDiscountCents: number | null }
  | { operation: "set_custom_deal"; customDealNetCents: number | null }
  | { operation: "set_section_discount"; sectionDomainId: string; discountBps: number }
  | { operation: "move_section"; sectionDomainId: string; position: number }
  | { operation: "move_line"; lineDomainId: string; sectionDomainId: string; position: number }
  | { operation: "set_line_quantity"; lineDomainId: string; quantityMilli: number }
  | { operation: "set_custom_line_details"; lineDomainId: string; displayName: string; description: string | null; unit: OfferUnit }
  | { operation: "set_line_position_type"; lineDomainId: string; positionType: OfferPositionType }
  | { operation: "set_line_visibility"; lineDomainId: string; isHidden: boolean }
  | { operation: "set_line_sales_price"; lineDomainId: string; salesUnitNetCents: number; reasonCode: OfferPriceReason }
  | { operation: "set_line_purchase_price"; lineDomainId: string; purchaseUnitNetCents: number; reasonCode: OfferPriceReason }
  | { operation: "set_line_discount"; lineDomainId: string; discountBps: number }
  | { operation: "remove_custom_line"; lineDomainId: string }
  | { operation: "add_custom_section"; sectionDomainId: string; position: number; title: string; category: OfferComponentCategory }
  | { operation: "remove_custom_section"; sectionDomainId: string }
  | {
      operation: "add_custom_line";
      lineDomainId: string;
      sectionDomainId: string;
      position: number;
      displayName: string;
      description: string | null;
      unit: OfferUnit;
      quantityMilli: number;
      salesUnitNetCents: number;
      purchaseUnitNetCents: number;
      positionType: OfferPositionType;
      isHidden: boolean;
      taxTreatment: OfferTaxTreatment;
      zeroConfirmation?: ZeroConfirmation;
    }
  | { operation: "set_line_tax"; lineDomainId: string; taxTreatment: "standard_19" }
  | { operation: "set_line_tax"; lineDomainId: string; taxTreatment: "zero_operator_confirmed"; zeroConfirmation: ZeroConfirmation };

export interface OfferEditorError { field: string; message: string }
export type OfferEditorBuildResult =
  | { ok: true; operations: readonly OfferRevisionOperation[] }
  | { ok: false; errors: readonly OfferEditorError[] };
interface OfferEditorCapabilities {
  canEditPrice: boolean;
  canApplyDiscount: boolean;
  canEditPurchasePrice?: boolean;
}

const MAX_MONEY_CENTS = 9_000_000_000_000_000;
const MAX_PATCH_OPERATIONS = 500;
const MAX_SECTIONS = 25;
const MAX_LINES = 500;
const ZERO_CONFIRMATION: ZeroConfirmation = { code: "zero_tax_draft_operator_confirmed", confirmed: true };

function formatScaledInteger(value: number, scaleDigits: number): string {
  const scale = 10 ** scaleDigits;
  const whole = Math.floor(value / scale);
  const fraction = String(value % scale).padStart(scaleDigits, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? String(whole) : `${whole},${fraction}`;
}

function parseScaledInteger(value: string, scaleDigits: number, maximum: number): number | null {
  const normalized = value.trim();
  const expression = new RegExp(`^(?:0|[1-9]\\d*)(?:[.,](\\d{1,${scaleDigits}}))?$`, "u");
  const match = expression.exec(normalized);
  if (!match) return null;
  const scale = 10 ** scaleDigits;
  const fraction = (match[1] ?? "").padEnd(scaleDigits, "0");
  const result = Number(normalized.split(/[.,]/u)[0]) * scale + Number(fraction || "0");
  return Number.isSafeInteger(result) && result <= maximum ? result : null;
}

function sourceSections(snapshot: OfferEditorSourceSnapshot): OfferEditorSourceSection[] {
  return [...snapshot.sections].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
}
function sourceLines(section: OfferEditorSourceSection): OfferEditorSourceLine[] {
  return [...section.lines].sort((left, right) => left.position - right.position);
}
function normalizedText(value: string): string { return value.normalize("NFC").trim(); }
function addError(errors: OfferEditorError[], field: string, message: string): void {
  if (!errors.some((error) => error.field === field)) errors.push({ field, message });
}

function draftLineFromSource(line: OfferEditorSourceLine): OfferEditorDraftLine {
  const unit = line.unit === "meter" || line.unit === "set" ? line.unit : "piece";
  return {
    lineDomainId: line.lineDomainId,
    sourceKind: line.sourceKind ?? "catalog",
    isNew: false,
    displayName: line.displayName ?? "Position",
    description: line.description ?? "",
    unit,
    quantity: formatScaledInteger(line.quantityMilli, 3),
    salesUnitNetEuros: formatScaledInteger(line.salesUnitNetCents, 2),
    purchaseUnitNetEuros: line.purchaseUnitNetCents === undefined ? "" : formatScaledInteger(line.purchaseUnitNetCents, 2),
    lineDiscountPercent: formatScaledInteger(line.lineDiscountBps, 2),
    positionType: line.positionType,
    isHidden: line.isHidden,
    salesPriceReason: "correction",
    purchasePriceReason: "correction",
    taxTreatment: line.taxTreatment ?? "standard_19",
    zeroTaxConfirmed: false,
  };
}

export function createOfferEditorDraft(snapshot: OfferEditorSourceSnapshot): OfferEditorDraft {
  return {
    variantName: snapshot.variantName,
    description: snapshot.description ?? "",
    globalDiscountPercent: formatScaledInteger(snapshot.globalDiscountBps ?? 0, 2),
    globalDiscountCapEuros: snapshot.globalDiscountCapCents === null || snapshot.globalDiscountCapCents === undefined
      ? "" : formatScaledInteger(snapshot.globalDiscountCapCents, 2),
    globalFixDiscountEuros: snapshot.globalFixDiscountCents === null || snapshot.globalFixDiscountCents === undefined
      ? "" : formatScaledInteger(snapshot.globalFixDiscountCents, 2),
    customDealNetEuros: snapshot.customDealNetCents === null || snapshot.customDealNetCents === undefined
      ? "" : formatScaledInteger(snapshot.customDealNetCents, 2),
    sections: sourceSections(snapshot).map((section) => ({
      sectionDomainId: section.sectionDomainId,
      isNew: false,
      title: section.title ?? "Sektion",
      category: section.category ?? "other",
      discountPercent: formatScaledInteger(section.discountBps, 2),
      lines: sourceLines(section).map(draftLineFromSource),
    })),
  };
}

export function isOfferEditorDraftDirty(snapshot: OfferEditorSourceSnapshot, draft: OfferEditorDraft): boolean {
  const result = buildOfferRevisionOperations(snapshot, draft, {
    canEditPrice: true,
    canApplyDiscount: true,
    canEditPurchasePrice: true,
  });
  return !result.ok || result.operations.length > 0;
}

export function isOfferEditorPriceInputChanged(value: string, currentCents: number): boolean {
  const parsed = parseScaledInteger(value, 2, MAX_MONEY_CENTS);
  return parsed === null || parsed !== currentCents;
}

export function redactOfferEditorPurchaseDraft(
  draft: OfferEditorDraft,
): OfferEditorDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      lines: section.lines.map((line) => ({
        ...line,
        purchaseUnitNetEuros: "",
        purchasePriceReason: "correction",
      })),
    })),
  };
}

function purchaseDraftChanged(
  previousBase: OfferEditorDraft,
  localDraft: OfferEditorDraft,
): boolean {
  const previousLines = new Map(previousBase.sections.flatMap((section) =>
    section.lines.map((line) => [line.lineDomainId, line] as const)));
  return localDraft.sections.some((section) => section.lines.some((line) => {
    const previous = previousLines.get(line.lineDomainId);
    if (!previous) {
      return line.purchaseUnitNetEuros.trim() !== ""
        || line.purchasePriceReason !== "correction";
    }
    return line.purchaseUnitNetEuros !== previous.purchaseUnitNetEuros
      || line.purchasePriceReason !== previous.purchasePriceReason;
  }));
}

export function createOfferEditorRecoveryEnvelope(input: {
  offerId: string;
  variantId: string;
  recoveryScope: string;
  expectedRevision: number;
  previousBase: OfferEditorDraft;
  localDraft: OfferEditorDraft;
}) {
  return {
    schemaVersion: "offer-editor-rebase.v1" as const,
    offerId: input.offerId,
    variantId: input.variantId,
    recoveryScope: input.recoveryScope,
    expectedRevision: input.expectedRevision,
    purchaseDraftOmitted: purchaseDraftChanged(input.previousBase, input.localDraft),
    // Session Storage is same-origin browser state, not an authenticated
    // secret store. Purchase values are therefore stripped even when the
    // current actor may read/edit them; the fresh server snapshot remains the
    // only purchase-price source after reload.
    previousBase: redactOfferEditorPurchaseDraft(input.previousBase),
    localDraft: redactOfferEditorPurchaseDraft(input.localDraft),
  };
}

export function prepareOfferEditorRecoveryDrafts(
  envelope: {
    recoveryScope: string;
    previousBase: OfferEditorDraft;
    localDraft: OfferEditorDraft;
  },
  currentRecoveryScope: string,
): { previousBase: OfferEditorDraft; localDraft: OfferEditorDraft } | null {
  if (envelope.recoveryScope !== currentRecoveryScope) return null;
  return {
    // Defense in depth for stale envelopes written by an older client.
    previousBase: redactOfferEditorPurchaseDraft(envelope.previousBase),
    localDraft: redactOfferEditorPurchaseDraft(envelope.localDraft),
  };
}

export function moveOfferDraftLine(
  draft: OfferEditorDraft,
  sectionDomainId: string,
  lineDomainId: string,
  direction: "up" | "down",
): OfferEditorDraft {
  const section = draft.sections.find((entry) => entry.sectionDomainId === sectionDomainId);
  const index = section?.lines.findIndex((line) => line.lineDomainId === lineDomainId) ?? -1;
  if (!section || index < 0) return draft;
  const position = direction === "up" ? index : index + 2;
  return moveOfferDraftLineToSection(draft, lineDomainId, sectionDomainId, position);
}

export function moveOfferDraftSection(
  draft: OfferEditorDraft,
  sectionDomainId: string,
  direction: "up" | "down",
): OfferEditorDraft {
  const index = draft.sections.findIndex((section) => section.sectionDomainId === sectionDomainId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= draft.sections.length) return draft;
  const sections = [...draft.sections];
  const [section] = sections.splice(index, 1);
  if (!section) return draft;
  sections.splice(target, 0, section);
  return { ...draft, sections };
}

export function moveOfferDraftLineToSection(
  draft: OfferEditorDraft,
  lineDomainId: string,
  targetSectionDomainId: string,
  targetPosition: number,
): OfferEditorDraft {
  const sourceSection = draft.sections.find((section) => section.lines.some(
    (line) => line.lineDomainId === lineDomainId,
  ));
  const targetSection = draft.sections.find((section) => section.sectionDomainId === targetSectionDomainId);
  if (!sourceSection || !targetSection) return draft;
  if (sourceSection.sectionDomainId !== targetSectionDomainId && sourceSection.lines.length <= 1) {
    return draft;
  }
  let movingLine: OfferEditorDraftLine | undefined;
  const without = draft.sections.map((section) => {
    const match = section.lines.find((line) => line.lineDomainId === lineDomainId);
    if (!match) return section;
    movingLine = match;
    return { ...section, lines: section.lines.filter((line) => line.lineDomainId !== lineDomainId) };
  });
  if (!movingLine) return draft;
  let inserted = false;
  const sections = without.map((section) => {
    if (section.sectionDomainId !== targetSectionDomainId) return section;
    const lines = [...section.lines];
    lines.splice(Math.max(0, Math.min(lines.length, targetPosition - 1)), 0, movingLine!);
    inserted = true;
    return { ...section, lines };
  });
  return inserted ? { ...draft, sections } : draft;
}

export function canRemoveOfferDraftSection(
  snapshot: OfferEditorSourceSnapshot,
  draft: OfferEditorDraft,
  sectionDomainId: string,
): boolean {
  if (draft.sections.length <= 1) return false;
  const draftSection = draft.sections.find((section) => section.sectionDomainId === sectionDomainId);
  if (!draftSection || draftSection.lines.some((line) => line.sourceKind !== "custom")) return false;
  if (draftSection.isNew) return true;
  const sourceSection = snapshot.sections.find((section) => section.sectionDomainId === sectionDomainId);
  return sourceSection !== undefined
    && sourceSection.lines.every((line) => (line.sourceKind ?? "catalog") === "custom");
}

export function addCustomOfferDraftSection(
  draft: OfferEditorDraft,
  input: { sectionDomainId: string; title?: string; category?: OfferComponentCategory },
): OfferEditorDraft {
  if (draft.sections.some((section) => section.sectionDomainId === input.sectionDomainId)) return draft;
  return { ...draft, sections: [...draft.sections, {
    sectionDomainId: input.sectionDomainId,
    isNew: true,
    title: input.title ?? "Freie Sektion",
    category: input.category ?? "other",
    discountPercent: "0",
    lines: [],
  }] };
}

export function removeCustomOfferDraftSection(draft: OfferEditorDraft, sectionDomainId: string): OfferEditorDraft {
  const section = draft.sections.find((entry) => entry.sectionDomainId === sectionDomainId);
  if (!section || section.lines.some((line) => line.sourceKind !== "custom")) return draft;
  return { ...draft, sections: draft.sections.filter((entry) => entry.sectionDomainId !== sectionDomainId) };
}

export function addCustomOfferDraftLine(
  draft: OfferEditorDraft,
  sectionDomainId: string,
  input: { lineDomainId: string; displayName?: string },
): OfferEditorDraft {
  if (draft.sections.some((section) => section.lines.some((line) => line.lineDomainId === input.lineDomainId))) return draft;
  return { ...draft, sections: draft.sections.map((section) => section.sectionDomainId === sectionDomainId
    ? { ...section, lines: [...section.lines, {
        lineDomainId: input.lineDomainId,
        sourceKind: "custom",
        isNew: true,
        displayName: input.displayName ?? "Freie Position",
        description: "",
        unit: "piece",
        quantity: "1",
        salesUnitNetEuros: "0",
        purchaseUnitNetEuros: "0",
        lineDiscountPercent: "0",
        positionType: "required",
        isHidden: false,
        salesPriceReason: "correction",
        purchasePriceReason: "correction",
        taxTreatment: "standard_19",
        zeroTaxConfirmed: false,
      }] }
    : section) };
}

export function removeCustomOfferDraftLine(draft: OfferEditorDraft, lineDomainId: string): OfferEditorDraft {
  const line = draft.sections.flatMap((section) => section.lines).find((entry) => entry.lineDomainId === lineDomainId);
  if (!line || line.sourceKind !== "custom") return draft;
  return { ...draft, sections: draft.sections.map((section) => ({
    ...section,
    lines: section.lines.filter((entry) => entry.lineDomainId !== lineDomainId),
  })) };
}

function parsedLineValues(line: OfferEditorDraftLine, errors: OfferEditorError[]) {
  const prefix = `line-${line.lineDomainId}`;
  const quantityMilli = parseScaledInteger(line.quantity, 3, 100_000_000);
  if (quantityMilli === null || quantityMilli < 1 || (line.unit !== "meter" && quantityMilli % 1_000 !== 0)) {
    addError(errors, `${prefix}-quantity`, line.unit === "meter"
      ? "Die Menge muss positiv sein und darf höchstens drei Nachkommastellen haben."
      : "Stück und Set müssen als positive ganze Menge eingegeben werden.");
  }
  const salesUnitNetCents = parseScaledInteger(line.salesUnitNetEuros, 2, MAX_MONEY_CENTS);
  if (salesUnitNetCents === null) addError(errors, `${prefix}-sales-price`, "Der VK muss ein gültiger Eurobetrag sein.");
  const purchaseUnitNetCents = line.purchaseUnitNetEuros.trim() === "" ? null
    : parseScaledInteger(line.purchaseUnitNetEuros, 2, MAX_MONEY_CENTS);
  if (line.purchaseUnitNetEuros.trim() !== "" && purchaseUnitNetCents === null) {
    addError(errors, `${prefix}-purchase-price`, "Der EK muss ein gültiger Eurobetrag sein.");
  }
  const discountBps = parseScaledInteger(line.lineDiscountPercent, 2, 10_000);
  if (discountBps === null) addError(errors, `${prefix}-discount`, "Der Rabatt muss zwischen 0 und 100 Prozent liegen.");
  const displayName = normalizedText(line.displayName);
  const description = normalizedText(line.description) || null;
  if (displayName.length === 0 || displayName.length > 200) addError(errors, `${prefix}-name`, "Der Positionsname muss 1 bis 200 Zeichen enthalten.");
  if (description !== null && description.length > 1_000) addError(errors, `${prefix}-description`, "Die Positionsbeschreibung darf höchstens 1.000 Zeichen enthalten.");
  if (quantityMilli === null || salesUnitNetCents === null || discountBps === null) return null;
  return { quantityMilli, salesUnitNetCents, purchaseUnitNetCents, discountBps, displayName, description };
}

export function buildOfferRevisionOperations(
  snapshot: OfferEditorSourceSnapshot,
  draft: OfferEditorDraft,
  capabilities: OfferEditorCapabilities,
): OfferEditorBuildResult {
  const errors: OfferEditorError[] = [];
  const operations: OfferRevisionOperation[] = [];
  const normalizedName = normalizedText(draft.variantName);
  const normalizedDescription = normalizedText(draft.description);
  if (normalizedName.length === 0 || normalizedName.length > 120) addError(errors, "variant-name", "Der Variantenname muss 1 bis 120 Zeichen enthalten.");
  else if (normalizedName !== snapshot.variantName) operations.push({ operation: "set_variant_name", name: normalizedName });
  if (normalizedDescription.length > 1_000) addError(errors, "variant-description", "Die Beschreibung darf höchstens 1.000 Zeichen enthalten.");
  else if ((normalizedDescription || null) !== snapshot.description) operations.push({ operation: "set_variant_description", description: normalizedDescription || null });

  const globalDiscountBps = parseScaledInteger(draft.globalDiscountPercent, 2, 10_000);
  // F16.3 Slice E: Cap ("" = ungedeckelt); Prozent- oder Cap-Änderung ->
  // genau eine set_global_discount mit beiden Werten.
  const globalDiscountCapCents = draft.globalDiscountCapEuros.trim() === "" ? null
    : parseScaledInteger(draft.globalDiscountCapEuros, 2, MAX_MONEY_CENTS);
  if (globalDiscountBps === null) addError(errors, "global-discount", "Der globale Rabatt muss zwischen 0 und 100 Prozent liegen.");
  else if (draft.globalDiscountCapEuros.trim() !== "" && globalDiscountCapCents === null) addError(errors, "global-discount-cap", "Der Deckel muss ein gültiger Eurobetrag sein.");
  else if (globalDiscountBps !== (snapshot.globalDiscountBps ?? 0)
    || globalDiscountCapCents !== (snapshot.globalDiscountCapCents ?? null)) {
    if (!capabilities.canApplyDiscount) addError(errors, "global-discount", "Für globale Rabatte fehlt die Berechtigung.");
    else operations.push({ operation: "set_global_discount", discountBps: globalDiscountBps, capCents: globalDiscountCapCents });
  }
  const customDealNetCents = draft.customDealNetEuros.trim() === "" ? null
    : parseScaledInteger(draft.customDealNetEuros, 2, MAX_MONEY_CENTS);
  if (draft.customDealNetEuros.trim() !== "" && customDealNetCents === null) addError(errors, "custom-deal", "Der Custom Deal muss ein gültiger Eurobetrag sein.");
  else if (customDealNetCents !== (snapshot.customDealNetCents ?? null)) {
    if (!capabilities.canApplyDiscount) addError(errors, "custom-deal", "Für den Custom Deal fehlt die Berechtigung.");
    else operations.push({ operation: "set_custom_deal", customDealNetCents });
  }
  // F16.3 Slice D: globaler Fix-Rabatt ("" = aufheben).
  const globalFixDiscountCents = draft.globalFixDiscountEuros.trim() === "" ? null
    : parseScaledInteger(draft.globalFixDiscountEuros, 2, MAX_MONEY_CENTS);
  if (draft.globalFixDiscountEuros.trim() !== "" && globalFixDiscountCents === null) addError(errors, "global-fix-discount", "Der globale Fix-Rabatt muss ein gültiger Eurobetrag sein.");
  else if (globalFixDiscountCents !== (snapshot.globalFixDiscountCents ?? null)) {
    if (!capabilities.canApplyDiscount) addError(errors, "global-fix-discount", "Für globale Rabatte fehlt die Berechtigung.");
    else operations.push({ operation: "set_global_fix_discount", fixDiscountCents: globalFixDiscountCents });
  }

  const originalSections = sourceSections(snapshot);
  const sourceSectionById = new Map(originalSections.map((section) => [section.sectionDomainId, section]));
  const sourceLineById = new Map(originalSections.flatMap((section) => sourceLines(section).map((line) => [line.lineDomainId, { line, sectionDomainId: section.sectionDomainId }] as const)));
  const draftSectionIds = draft.sections.map((section) => section.sectionDomainId);
  const draftLines = draft.sections.flatMap((section) => section.lines);
  const draftLineIds = draftLines.map((line) => line.lineDomainId);
  if (draft.sections.length === 0 || draft.sections.length > MAX_SECTIONS || new Set(draftSectionIds).size !== draftSectionIds.length
    || draftLines.length === 0 || draftLines.length > MAX_LINES || new Set(draftLineIds).size !== draftLineIds.length
    || draft.sections.some((section) => section.lines.length === 0)) {
    addError(errors, "editor-structure", "Jede eindeutige Sektion braucht mindestens eine eindeutige Position.");
  }

  const removedSectionIds = new Set<string>();
  for (const sourceSection of originalSections) {
    if (draftSectionIds.includes(sourceSection.sectionDomainId)) continue;
    if (sourceSection.lines.some((line) => (line.sourceKind ?? "catalog") !== "custom")) {
      addError(errors, "editor-structure", "Sektionen mit Katalogpositionen können nicht entfernt werden.");
    } else {
      removedSectionIds.add(sourceSection.sectionDomainId);
      operations.push({ operation: "remove_custom_section", sectionDomainId: sourceSection.sectionDomainId });
    }
  }
  for (const [lineId, sourceEntry] of sourceLineById) {
    if (removedSectionIds.has(sourceEntry.sectionDomainId) || draftLineIds.includes(lineId)) continue;
    if ((sourceEntry.line.sourceKind ?? "catalog") !== "custom") addError(errors, "editor-structure", "Katalogpositionen können nicht entfernt werden.");
    else operations.push({ operation: "remove_custom_line", lineDomainId: lineId });
  }

  for (const [sectionIndex, section] of draft.sections.entries()) {
    if (sourceSectionById.has(section.sectionDomainId)) continue;
    const title = normalizedText(section.title);
    if (!section.isNew || title.length === 0 || title.length > 120) addError(errors, `section-${section.sectionDomainId}-title`, "Der Sektionsname muss 1 bis 120 Zeichen enthalten.");
    else operations.push({ operation: "add_custom_section", sectionDomainId: section.sectionDomainId, position: sectionIndex + 1, title, category: section.category });
  }

  const workingSections = originalSections.map((section) => section.sectionDomainId).filter((id) => !removedSectionIds.has(id));
  for (const section of draft.sections) if (!workingSections.includes(section.sectionDomainId)) workingSections.push(section.sectionDomainId);
  draftSectionIds.forEach((sectionId, targetIndex) => {
    if (workingSections[targetIndex] === sectionId) return;
    const currentIndex = workingSections.indexOf(sectionId);
    if (currentIndex < 0) return;
    workingSections.splice(currentIndex, 1);
    workingSections.splice(targetIndex, 0, sectionId);
    operations.push({ operation: "move_section", sectionDomainId: sectionId, position: targetIndex + 1 });
  });

  const workingLines = new Map<string, string[]>();
  for (const section of originalSections) {
    if (!removedSectionIds.has(section.sectionDomainId)) workingLines.set(section.sectionDomainId,
      sourceLines(section).map((line) => line.lineDomainId).filter((lineId) => draftLineIds.includes(lineId)));
  }
  for (const section of draft.sections) {
    if (!workingLines.has(section.sectionDomainId)) workingLines.set(section.sectionDomainId, []);
    const sectionField = `section-${section.sectionDomainId}-discount`;
    const sectionDiscount = parseScaledInteger(section.discountPercent, 2, 10_000);
    const sourceSection = sourceSectionById.get(section.sectionDomainId);
    if (sectionDiscount === null) addError(errors, sectionField, "Der Sektionsrabatt muss zwischen 0 und 100 Prozent liegen.");
    else if (sectionDiscount !== (sourceSection?.discountBps ?? 0)) {
      if (!capabilities.canApplyDiscount) addError(errors, sectionField, "Für Sektionsrabatte fehlt die Berechtigung.");
      else operations.push({ operation: "set_section_discount", sectionDomainId: section.sectionDomainId, discountBps: sectionDiscount });
    }
    for (const line of section.lines) {
      if (sourceLineById.has(line.lineDomainId)) continue;
      const values = parsedLineValues(line, errors);
      if (!line.isNew || line.sourceKind !== "custom") { addError(errors, "editor-structure", "Unbekannte Positionen müssen als freie Position angelegt werden."); continue; }
      if (!capabilities.canEditPrice || !capabilities.canEditPurchasePrice) { addError(errors, `line-${line.lineDomainId}-purchase-price`, "Freie Positionen benötigen VK- und EK-Berechtigung."); continue; }
      if (!values || values.purchaseUnitNetCents === null) { addError(errors, `line-${line.lineDomainId}-purchase-price`, "Eine freie Position benötigt einen Einkaufspreis."); continue; }
      if (line.taxTreatment === "zero_operator_confirmed" && !line.zeroTaxConfirmed) { addError(errors, `line-${line.lineDomainId}-zero-confirmation`, "0 % USt. muss für diese Position frisch bestätigt werden."); continue; }
      const targetLines = workingLines.get(section.sectionDomainId)!;
      const addOperation: Extract<OfferRevisionOperation, { operation: "add_custom_line" }> = {
        operation: "add_custom_line", lineDomainId: line.lineDomainId, sectionDomainId: section.sectionDomainId,
        position: targetLines.length + 1, displayName: values.displayName, description: values.description,
        unit: line.unit, quantityMilli: values.quantityMilli, salesUnitNetCents: values.salesUnitNetCents,
        purchaseUnitNetCents: values.purchaseUnitNetCents, positionType: line.positionType, isHidden: line.isHidden,
        taxTreatment: line.taxTreatment,
      };
      if (line.taxTreatment === "zero_operator_confirmed") addOperation.zeroConfirmation = ZERO_CONFIRMATION;
      operations.push(addOperation);
      targetLines.push(line.lineDomainId);
      if (values.discountBps !== 0) {
        if (!capabilities.canApplyDiscount) addError(errors, `line-${line.lineDomainId}-discount`, "Für Rabatte fehlt die Berechtigung.");
        else operations.push({ operation: "set_line_discount", lineDomainId: line.lineDomainId, discountBps: values.discountBps });
      }
    }
  }

  for (const section of draft.sections) {
    section.lines.forEach((line, targetIndex) => {
      let currentSectionId: string | undefined;
      let currentIndex = -1;
      for (const [candidateSectionId, ids] of workingLines) {
        const index = ids.indexOf(line.lineDomainId);
        if (index >= 0) { currentSectionId = candidateSectionId; currentIndex = index; break; }
      }
      if (currentSectionId === undefined || (currentSectionId === section.sectionDomainId && currentIndex === targetIndex)) return;
      workingLines.get(currentSectionId)!.splice(currentIndex, 1);
      workingLines.get(section.sectionDomainId)!.splice(targetIndex, 0, line.lineDomainId);
      operations.push({ operation: "move_line", lineDomainId: line.lineDomainId, sectionDomainId: section.sectionDomainId, position: targetIndex + 1 });
    });
  }

  for (const section of draft.sections) {
    for (const line of section.lines) {
      const sourceEntry = sourceLineById.get(line.lineDomainId);
      if (!sourceEntry) continue;
      const originalLine = sourceEntry.line;
      const prefix = `line-${line.lineDomainId}`;
      if (originalLine.purchaseUnitNetCents !== undefined && line.purchaseUnitNetEuros.trim() === "") {
        addError(errors, `${prefix}-purchase-price`, "Ein vorhandener Einkaufspreis darf nicht leer gespeichert werden.");
      }
      const rawSalesPrice = parseScaledInteger(line.salesUnitNetEuros, 2, MAX_MONEY_CENTS);
      const rawDiscount = parseScaledInteger(line.lineDiscountPercent, 2, 10_000);
      if (
        rawSalesPrice !== null
        && rawSalesPrice !== originalLine.salesUnitNetCents
        && !capabilities.canEditPrice
      ) {
        addError(errors, `${prefix}-sales-price`, "Für VK-Änderungen fehlt die Berechtigung.");
      }
      if (
        rawDiscount !== null
        && rawDiscount !== originalLine.lineDiscountBps
        && !capabilities.canApplyDiscount
      ) {
        addError(errors, `${prefix}-discount`, "Für Rabatte fehlt die Berechtigung.");
      }
      const values = parsedLineValues(line, errors);
      if (!values) continue;
      const originalDisplayName = originalLine.displayName ?? "Position";
      const originalDescription = originalLine.description ?? null;
      const originalUnit = originalLine.unit === "meter" || originalLine.unit === "set"
        ? originalLine.unit
        : "piece";
      const detailsChanged = values.displayName !== originalDisplayName
        || values.description !== originalDescription
        || line.unit !== originalUnit;
      if (detailsChanged) {
        if ((originalLine.sourceKind ?? "catalog") !== "custom") {
          addError(errors, "editor-structure", "Produktmetadaten aus dem Katalog-Snapshot können nicht verändert werden.");
        } else {
          operations.push({
            operation: "set_custom_line_details",
            lineDomainId: line.lineDomainId,
            displayName: values.displayName,
            description: values.description,
            unit: line.unit,
          });
        }
      }
      if (values.quantityMilli !== originalLine.quantityMilli) operations.push({ operation: "set_line_quantity", lineDomainId: line.lineDomainId, quantityMilli: values.quantityMilli });
      if (line.positionType !== originalLine.positionType) operations.push({ operation: "set_line_position_type", lineDomainId: line.lineDomainId, positionType: line.positionType });
      if (line.isHidden !== originalLine.isHidden) operations.push({ operation: "set_line_visibility", lineDomainId: line.lineDomainId, isHidden: line.isHidden });
      if (values.salesUnitNetCents !== originalLine.salesUnitNetCents) {
        if (!capabilities.canEditPrice) addError(errors, `${prefix}-sales-price`, "Für VK-Änderungen fehlt die Berechtigung.");
        else operations.push({ operation: "set_line_sales_price", lineDomainId: line.lineDomainId, salesUnitNetCents: values.salesUnitNetCents, reasonCode: line.salesPriceReason });
      }
      if (values.discountBps !== originalLine.lineDiscountBps) {
        if (!capabilities.canApplyDiscount) addError(errors, `${prefix}-discount`, "Für Rabatte fehlt die Berechtigung.");
        else operations.push({ operation: "set_line_discount", lineDomainId: line.lineDomainId, discountBps: values.discountBps });
      }
      if (values.purchaseUnitNetCents !== null && values.purchaseUnitNetCents !== originalLine.purchaseUnitNetCents) {
        if ((originalLine.sourceKind ?? "catalog") !== "custom" || !capabilities.canEditPurchasePrice) addError(errors, `${prefix}-purchase-price`, "EK kann nur bei freien Positionen mit EK-Berechtigung geändert werden.");
        else operations.push({ operation: "set_line_purchase_price", lineDomainId: line.lineDomainId, purchaseUnitNetCents: values.purchaseUnitNetCents, reasonCode: line.purchasePriceReason });
      }
      const originalTax = originalLine.taxTreatment ?? "standard_19";
      if (line.taxTreatment !== originalTax) {
        if (!capabilities.canEditPrice) addError(errors, `${prefix}-tax`, "Für Steueränderungen fehlt die Preisberechtigung.");
        else if (line.taxTreatment === "zero_operator_confirmed") {
          if (!line.zeroTaxConfirmed) addError(errors, `${prefix}-zero-confirmation`, "0 % USt. muss für diese Position frisch bestätigt werden.");
          else operations.push({ operation: "set_line_tax", lineDomainId: line.lineDomainId, taxTreatment: line.taxTreatment, zeroConfirmation: ZERO_CONFIRMATION });
        } else operations.push({ operation: "set_line_tax", lineDomainId: line.lineDomainId, taxTreatment: "standard_19" });
      }
    }
  }
  if (operations.length > MAX_PATCH_OPERATIONS) addError(errors, "editor-operations", "Der Entwurf enthält zu viele Änderungen für einen einzelnen Speichervorgang.");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, operations };
}

export function calculateOfferEditorPreview(
  draft: OfferEditorDraft,
): OfferPricingResult | null {
  const globalDiscountBps = parseScaledInteger(draft.globalDiscountPercent, 2, 10_000);
  const customDealNetCents = draft.customDealNetEuros.trim() === "" ? null
    : parseScaledInteger(draft.customDealNetEuros, 2, MAX_MONEY_CENTS);
  const globalDiscountCapCents = draft.globalDiscountCapEuros.trim() === "" ? null
    : parseScaledInteger(draft.globalDiscountCapEuros, 2, MAX_MONEY_CENTS);
  const globalFixDiscountCents = draft.globalFixDiscountEuros.trim() === "" ? null
    : parseScaledInteger(draft.globalFixDiscountEuros, 2, MAX_MONEY_CENTS);
  if (globalDiscountBps === null || (draft.customDealNetEuros.trim() !== "" && customDealNetCents === null)
    || (draft.globalFixDiscountEuros.trim() !== "" && globalFixDiscountCents === null)
    || (draft.globalDiscountCapEuros.trim() !== "" && globalDiscountCapCents === null)) {
    return null;
  }
  try {
    return calculateOfferPricing({
      currency: "EUR",
      priceBasis: "net",
      globalDiscountBps,
      globalDiscountCapCents,
      globalFixDiscountCents,
      customDealNetCents,
      sections: draft.sections.map((section, sectionIndex) => {
        const discountBps = parseScaledInteger(section.discountPercent, 2, 10_000);
        if (discountBps === null) throw new TypeError("invalid section discount");
        return {
          sectionDomainId: section.sectionDomainId,
          position: sectionIndex + 1,
          discountBps,
          lines: section.lines.map((line, lineIndex) => {
            const quantityMilli = parseScaledInteger(line.quantity, 3, 100_000_000);
            const salesUnitNetCents = parseScaledInteger(line.salesUnitNetEuros, 2, MAX_MONEY_CENTS);
            const purchaseUnitNetCents = line.purchaseUnitNetEuros.trim() === "" ? 0
              : parseScaledInteger(line.purchaseUnitNetEuros, 2, MAX_MONEY_CENTS);
            const lineDiscountBps = parseScaledInteger(line.lineDiscountPercent, 2, 10_000);
            if (
              quantityMilli === null || quantityMilli < 1
              || (line.unit !== "meter" && quantityMilli % 1_000 !== 0)
              || salesUnitNetCents === null || purchaseUnitNetCents === null
              || lineDiscountBps === null
            ) throw new TypeError("invalid line");
            return {
              lineDomainId: line.lineDomainId,
              position: lineIndex + 1,
              unit: line.unit,
              positionType: line.positionType,
              isHidden: line.isHidden,
              quantityMilli,
              salesUnitNetCents,
              purchaseUnitNetCents,
              lineDiscountBps,
              taxRateBps: line.taxTreatment === "standard_19" ? 1_900 : 0,
            };
          }),
        };
      }),
    });
  } catch {
    return null;
  }
}

export interface OfferEditorRebaseResult {
  draft: OfferEditorDraft;
  notices: readonly string[];
  unappliedLines: readonly OfferEditorDraftLine[];
  unappliedSections: readonly OfferEditorDraftSection[];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Drei-Wege-Rebase: Nur lokal gegenüber der alten Basis geänderte Felder
 * werden auf den neuen Server-Draft übertragen. Bei parallelen Änderungen
 * bleibt der lokale Wert sichtbar und wird ausdrücklich als Prüfpunkt gemeldet.
 */
export function rebaseOfferEditorDraft(
  previousBase: OfferEditorDraft,
  localDraft: OfferEditorDraft,
  currentServerDraft: OfferEditorDraft,
): OfferEditorRebaseResult {
  const notices: string[] = [];
  const unappliedLines: OfferEditorDraftLine[] = [];
  const unappliedSections: OfferEditorDraftSection[] = [];
  const mergeValue = <T,>(label: string, base: T, local: T, current: T): T => {
    if (sameValue(local, base)) return current;
    if (!sameValue(current, base) && !sameValue(current, local)) notices.push(label);
    return local;
  };
  const result = structuredClone(currentServerDraft);
  result.variantName = mergeValue("Variantenname parallel geändert", previousBase.variantName, localDraft.variantName, currentServerDraft.variantName);
  result.description = mergeValue("Beschreibung parallel geändert", previousBase.description, localDraft.description, currentServerDraft.description);
  result.globalDiscountPercent = mergeValue("Globaler Rabatt parallel geändert", previousBase.globalDiscountPercent, localDraft.globalDiscountPercent, currentServerDraft.globalDiscountPercent);
  result.customDealNetEuros = mergeValue("Custom Deal parallel geändert", previousBase.customDealNetEuros, localDraft.customDealNetEuros, currentServerDraft.customDealNetEuros);

  const structure = (draftValue: OfferEditorDraft) => draftValue.sections.map((section) => ({
    id: section.sectionDomainId,
    lines: section.lines.map((line) => line.lineDomainId),
  }));
  const serverStructureChanged = !sameValue(structure(previousBase), structure(currentServerDraft));
  const localStructureChanged = !sameValue(structure(previousBase), structure(localDraft));
  if (localStructureChanged && !serverStructureChanged) {
    const currentSectionMap = new Map(result.sections.map((section) => [section.sectionDomainId, section]));
    result.sections = localDraft.sections.map((localSection) => {
      const currentSection = currentSectionMap.get(localSection.sectionDomainId);
      if (!currentSection) return structuredClone(localSection);
      const currentLineMap = new Map(currentSection.lines.map((line) => [line.lineDomainId, line]));
      return {
        ...currentSection,
        lines: localSection.lines.map((localLine) => currentLineMap.get(localLine.lineDomainId)
          ?? structuredClone(localLine)),
      };
    });
  } else if (localStructureChanged && serverStructureChanged) {
    notices.push("BOM-Struktur wurde parallel geändert; Serverreihenfolge wurde beibehalten");
    for (const localSection of localDraft.sections.filter((section) => section.isNew)) {
      if (!result.sections.some((section) => section.sectionDomainId === localSection.sectionDomainId)) {
        result.sections = [...result.sections, structuredClone(localSection)];
      }
    }
    const resultSectionMap = new Map(result.sections.map((section) => [section.sectionDomainId, section]));
    for (const localSection of localDraft.sections) {
      const target = resultSectionMap.get(localSection.sectionDomainId);
      if (!target) continue;
      for (const localLine of localSection.lines.filter((line) => line.isNew)) {
        if (!result.sections.some((section) => section.lines.some((line) => line.lineDomainId === localLine.lineDomainId))) {
          target.lines = [...target.lines, structuredClone(localLine)];
        }
      }
    }
  }

  const baseSectionMap = new Map(previousBase.sections.map((section) => [section.sectionDomainId, section]));
  const localSectionMap = new Map(localDraft.sections.map((section) => [section.sectionDomainId, section]));
  const resultSectionIds = new Set(result.sections.map((section) => section.sectionDomainId));
  for (const [sectionId, localSection] of localSectionMap) {
    const baseSection = baseSectionMap.get(sectionId);
    if (
      baseSection
      && !resultSectionIds.has(sectionId)
      && !sameValue(localSection.discountPercent, baseSection.discountPercent)
    ) {
      notices.push(`${localSection.title} wurde serverseitig entfernt; lokale Sektionswerte bleiben unten prüfbar`);
      unappliedSections.push(structuredClone(localSection));
    }
  }
  for (const currentSection of result.sections) {
    const baseSection = baseSectionMap.get(currentSection.sectionDomainId);
    const localSection = localSectionMap.get(currentSection.sectionDomainId);
    if (!baseSection || !localSection) continue;
    currentSection.discountPercent = mergeValue(
      `Sektionsrabatt ${localSection.title} parallel geändert`,
      baseSection.discountPercent,
      localSection.discountPercent,
      currentSection.discountPercent,
    );
  }

  const baseLines = new Map(previousBase.sections.flatMap((section) => section.lines)
    .map((line) => [line.lineDomainId, line]));
  const localLines = new Map(localDraft.sections.flatMap((section) => section.lines)
    .map((line) => [line.lineDomainId, line]));
  const resultLines = new Map(result.sections.flatMap((section) => section.lines)
    .map((line) => [line.lineDomainId, line]));
  const editableKeys = [
    "displayName", "description", "unit", "quantity", "salesUnitNetEuros",
    "purchaseUnitNetEuros", "lineDiscountPercent", "positionType", "isHidden",
    "salesPriceReason", "purchasePriceReason", "taxTreatment", "zeroTaxConfirmed",
  ] as const;
  for (const [lineId, localLine] of localLines) {
    const baseLine = baseLines.get(lineId);
    const currentLine = resultLines.get(lineId);
    if (!baseLine || !currentLine) {
      if (baseLine && editableKeys.some((key) => !sameValue(localLine[key], baseLine[key]))) {
        notices.push(`${localLine.displayName} wurde serverseitig entfernt; lokale Feldwerte bleiben unten prüfbar`);
        unappliedLines.push(structuredClone(localLine));
      }
      continue;
    }
    for (const key of editableKeys) {
      currentLine[key] = mergeValue(
        `${localLine.displayName}: ${key} parallel geändert`,
        baseLine[key],
        localLine[key],
        currentLine[key],
      ) as never;
    }
  }
  return {
    draft: result,
    notices: [...new Set(notices)],
    unappliedLines,
    unappliedSections,
  };
}
