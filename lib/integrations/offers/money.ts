export const MAX_OFFER_MONEY_CENTS = 9_000_000_000_000_000 as const;
export const MAX_OFFER_QUANTITY_MILLI = 100_000_000 as const;

export type OfferUnit = "piece" | "set" | "meter";
export type OfferPositionType = "required" | "additional" | "optional";

export interface OfferPricingLineInput {
  lineDomainId: string;
  position: number;
  unit: OfferUnit;
  positionType: OfferPositionType;
  isHidden: boolean;
  quantityMilli: number;
  salesUnitNetCents: number;
  purchaseUnitNetCents: number;
  lineDiscountBps: number;
  taxRateBps: 0 | 1900 | number;
}

export interface OfferPricingSectionInput {
  sectionDomainId: string;
  position: number;
  discountBps: number;
  lines: OfferPricingLineInput[];
}

export interface OfferPricingInput {
  currency: "EUR";
  priceBasis: "net";
  globalDiscountBps: number;
  // F16.3 Slice E: Deckel für den globalen Prozent-Rabatt (null = ungedeckelt).
  globalDiscountCapCents: number | null;
  // F16.3 Slice D: globaler Fix-Rabatt (null = keiner), nach Prozent, vor Steuer.
  globalFixDiscountCents: number | null;
  customDealNetCents: number | null;
  sections: OfferPricingSectionInput[];
}

export interface OfferPricingLineResult extends OfferPricingLineInput {
  sectionDomainId: string;
  sectionPosition: number;
  lineBaseNetCents: number;
  lineDiscountedNetCents: number;
  sectionDiscountedNetCents: number;
  finalSalesNetCents: number;
  salesTaxCents: number;
  salesGrossCents: number;
  purchaseNetCents: number;
}

export interface OfferPricingResult {
  currency: "EUR";
  priceBasis: "net";
  lines: OfferPricingLineResult[];
  totals: {
    basisNetCents: number;
    basisTaxCents: number;
    basisGrossCents: number;
    optionalNetCents: number;
    optionalTaxCents: number;
    optionalGrossCents: number;
  };
}

interface WorkingLine extends OfferPricingLineResult {
  currentNet: bigint;
}

const MAX_MONEY = BigInt(MAX_OFFER_MONEY_CENTS);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const THOUSAND = BigInt(1_000);
const BASIS_POINTS = BigInt(10_000);

function assertSafeIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} liegt ausserhalb des erlaubten Ganzzahlbereichs.`);
  }
}

function money(value: number, field: string): bigint {
  assertSafeIntegerInRange(value, 0, MAX_OFFER_MONEY_CENTS, field);
  return BigInt(value);
}

function basisPoints(value: number, field: string): bigint {
  assertSafeIntegerInRange(value, 0, 10_000, field);
  return BigInt(value);
}

function persisted(value: bigint, field: string): number {
  if (value < ZERO || value > MAX_MONEY) {
    throw new TypeError(`${field} ueberschreitet den persistierbaren Geldbereich.`);
  }
  return Number(value);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < ZERO || denominator <= ZERO) {
    throw new TypeError("Half-up ist in v1 nur fuer nichtnegative Werte definiert.");
  }
  return (numerator + denominator / TWO) / denominator;
}

function compareAllocationOrder(left: WorkingLine, right: WorkingLine): number {
  return left.sectionPosition - right.sectionPosition
    || left.position - right.position
    || (left.lineDomainId < right.lineDomainId
      ? -1
      : left.lineDomainId > right.lineDomainId ? 1 : 0);
}

function allocateTarget(lines: WorkingLine[], target: bigint): void {
  const sourceTotal = lines.reduce((sum, line) => sum + line.currentNet, ZERO);
  if (target < ZERO || target > sourceTotal) {
    throw new TypeError("Allokationsziel darf den aktuellen Nettowert nicht erhoehen.");
  }
  if (sourceTotal === ZERO) {
    for (const line of lines) line.currentNet = ZERO;
    return;
  }

  const shares = lines.map((line) => {
    const numerator = target * line.currentNet;
    return {
      line,
      floor: numerator / sourceTotal,
      remainder: numerator % sourceTotal,
    };
  });
  let remaining = target - shares.reduce((sum, share) => sum + share.floor, ZERO);
  shares.sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return compareAllocationOrder(left.line, right.line);
  });
  for (const share of shares) {
    share.line.currentNet = share.floor + (remaining > ZERO ? ONE : ZERO);
    if (remaining > ZERO) remaining -= ONE;
  }
  if (remaining !== ZERO) throw new TypeError("Allokationsrest konnte nicht verteilt werden.");
}

// F16.3 Slice E: Prozent-Rabatt mit optionalem Cent-Deckel —
// Rabattbetrag = min(Prozentbetrag, Cap), Rest über Largest-Remainder.
function applyDiscount(lines: WorkingLine[], discountBps: bigint, capCents: bigint | null): void {
  const sourceTotal = lines.reduce((sum, line) => sum + line.currentNet, ZERO);
  const uncapped = sourceTotal - roundHalfUp(sourceTotal * (BASIS_POINTS - discountBps), BASIS_POINTS);
  const discount = capCents !== null && uncapped > capCents ? capCents : uncapped;
  allocateTarget(lines, sourceTotal - discount);
}

// F16.3 Slice D: Fix-Betrag vom (bereits prozent-rabattierten) Total abziehen,
// floor 0, exakt-summen Allokation über den bewährten Largest-Remainder.
function applyFixDiscount(lines: WorkingLine[], fixCents: bigint): void {
  const sourceTotal = lines.reduce((sum, line) => sum + line.currentNet, ZERO);
  allocateTarget(lines, sourceTotal - fixCents > ZERO ? sourceTotal - fixCents : ZERO);
}

function sumPersisted(lines: WorkingLine[], select: (line: WorkingLine) => bigint, field: string) {
  return persisted(lines.reduce((sum, line) => sum + select(line), ZERO), field);
}

function toPricingLineResult(line: WorkingLine): OfferPricingLineResult {
  const result = { ...line } as Partial<WorkingLine>;
  delete result.currentNet;
  return result as OfferPricingLineResult;
}

function validateStructure(input: OfferPricingInput): void {
  if (input.currency !== "EUR" || input.priceBasis !== "net") {
    throw new TypeError("M2-01 berechnet ausschliesslich EUR netto.");
  }
  basisPoints(input.globalDiscountBps, "globalDiscountBps");
  if (input.globalDiscountCapCents !== null) money(input.globalDiscountCapCents, "globalDiscountCapCents");
  if (input.globalFixDiscountCents !== null) money(input.globalFixDiscountCents, "globalFixDiscountCents");
  if (input.customDealNetCents !== null) money(input.customDealNetCents, "customDealNetCents");
  if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 25) {
    throw new TypeError("Eine Revision braucht 1 bis 25 Sektionen.");
  }
  const sectionIds = new Set<string>();
  const sectionPositions = new Set<number>();
  const lineIds = new Set<string>();
  let lineCount = 0;
  for (const section of input.sections) {
    if (typeof section.sectionDomainId !== "string" || section.sectionDomainId.length === 0
      || sectionIds.has(section.sectionDomainId)) {
      throw new TypeError("Sektions-IDs muessen eindeutig und nichtleer sein.");
    }
    sectionIds.add(section.sectionDomainId);
    assertSafeIntegerInRange(section.position, 1, 25, "section.position");
    if (sectionPositions.has(section.position)) {
      throw new TypeError("Sektionspositionen muessen eindeutig sein.");
    }
    sectionPositions.add(section.position);
    basisPoints(section.discountBps, "section.discountBps");
    if (!Array.isArray(section.lines) || section.lines.length < 1) {
      throw new TypeError("Eine Sektion braucht mindestens eine Zeile.");
    }
    const linePositions = new Set<number>();
    for (const current of section.lines) {
      lineCount += 1;
      if (typeof current.lineDomainId !== "string" || current.lineDomainId.length === 0
        || lineIds.has(current.lineDomainId)) {
        throw new TypeError("Zeilen-IDs muessen eindeutig und nichtleer sein.");
      }
      lineIds.add(current.lineDomainId);
      assertSafeIntegerInRange(current.position, 1, 500, "line.position");
      if (linePositions.has(current.position)) {
        throw new TypeError("Zeilenpositionen muessen je Sektion eindeutig sein.");
      }
      linePositions.add(current.position);
      if (!["piece", "set", "meter"].includes(current.unit)) {
        throw new TypeError("Unbekannte Einheit.");
      }
      if (!["required", "additional", "optional"].includes(current.positionType)) {
        throw new TypeError("Unbekannter Positionstyp.");
      }
      if (typeof current.isHidden !== "boolean") throw new TypeError("isHidden muss Boolean sein.");
      assertSafeIntegerInRange(
        current.quantityMilli,
        1,
        MAX_OFFER_QUANTITY_MILLI,
        "quantityMilli",
      );
      if (current.unit !== "meter" && current.quantityMilli % 1_000 !== 0) {
        throw new TypeError("piece und set erlauben nur ganze Einheiten.");
      }
      money(current.salesUnitNetCents, "salesUnitNetCents");
      money(current.purchaseUnitNetCents, "purchaseUnitNetCents");
      basisPoints(current.lineDiscountBps, "lineDiscountBps");
      if (current.taxRateBps !== 0 && current.taxRateBps !== 1_900) {
        throw new TypeError("M2-01 erlaubt nur 0 oder 1900 Steuerbasispunkte.");
      }
    }
  }
  if (lineCount > 500) throw new TypeError("Eine Revision darf hoechstens 500 Zeilen haben.");
}

export function calculateOfferPricing(input: OfferPricingInput): OfferPricingResult {
  validateStructure(input);

  const working: WorkingLine[] = input.sections.flatMap((section) =>
    section.lines.map((current) => {
      const quantity = BigInt(current.quantityMilli);
      const lineBase = roundHalfUp(
        money(current.salesUnitNetCents, "salesUnitNetCents") * quantity,
        THOUSAND,
      );
      const purchase = roundHalfUp(
        money(current.purchaseUnitNetCents, "purchaseUnitNetCents") * quantity,
        THOUSAND,
      );
      const discounted = roundHalfUp(
        lineBase * (BASIS_POINTS - basisPoints(current.lineDiscountBps, "lineDiscountBps")),
        BASIS_POINTS,
      );
      return {
        ...current,
        sectionDomainId: section.sectionDomainId,
        sectionPosition: section.position,
        lineBaseNetCents: persisted(lineBase, "lineBaseNetCents"),
        lineDiscountedNetCents: persisted(discounted, "lineDiscountedNetCents"),
        sectionDiscountedNetCents: 0,
        finalSalesNetCents: 0,
        salesTaxCents: 0,
        salesGrossCents: 0,
        purchaseNetCents: persisted(purchase, "purchaseNetCents"),
        currentNet: discounted,
      };
    }),
  );

  for (const section of input.sections) {
    const discount = basisPoints(section.discountBps, "section.discountBps");
    for (const optional of [false, true]) {
      const group = working.filter((line) =>
        line.sectionDomainId === section.sectionDomainId
        && (line.positionType === "optional") === optional);
      // F16.3 Slice E: Sektions-Rabatte bleiben ungedeckelt (Cap nur global).
      if (group.length > 0) applyDiscount(group, discount, null);
    }
  }
  for (const line of working) {
    line.sectionDiscountedNetCents = persisted(line.currentNet, "sectionDiscountedNetCents");
  }

  const basisLines = working.filter((line) => line.positionType !== "optional");
  applyDiscount(
    basisLines,
    basisPoints(input.globalDiscountBps, "globalDiscountBps"),
    input.globalDiscountCapCents === null ? null : money(input.globalDiscountCapCents, "globalDiscountCapCents"),
  );
  if (input.globalFixDiscountCents !== null) {
    applyFixDiscount(basisLines, money(input.globalFixDiscountCents, "globalFixDiscountCents"));
  }
  if (input.customDealNetCents !== null) {
    allocateTarget(basisLines, money(input.customDealNetCents, "customDealNetCents"));
  }

  for (const line of working) {
    const tax = roundHalfUp(line.currentNet * BigInt(line.taxRateBps), BASIS_POINTS);
    const gross = line.currentNet + tax;
    line.finalSalesNetCents = persisted(line.currentNet, "finalSalesNetCents");
    line.salesTaxCents = persisted(tax, "salesTaxCents");
    line.salesGrossCents = persisted(gross, "salesGrossCents");
  }

  const optionalLines = working.filter((line) => line.positionType === "optional");
  const totals = {
    basisNetCents: sumPersisted(basisLines, (line) => line.currentNet, "basisNetCents"),
    basisTaxCents: sumPersisted(basisLines, (line) => BigInt(line.salesTaxCents), "basisTaxCents"),
    basisGrossCents: sumPersisted(basisLines, (line) => BigInt(line.salesGrossCents), "basisGrossCents"),
    optionalNetCents: sumPersisted(optionalLines, (line) => line.currentNet, "optionalNetCents"),
    optionalTaxCents: sumPersisted(optionalLines, (line) => BigInt(line.salesTaxCents), "optionalTaxCents"),
    optionalGrossCents: sumPersisted(optionalLines, (line) => BigInt(line.salesGrossCents), "optionalGrossCents"),
  };

  return {
    currency: "EUR",
    priceBasis: "net",
    lines: working.map(toPricingLineResult),
    totals,
  };
}
