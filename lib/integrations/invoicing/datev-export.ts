// F8-11 DATEV-EXTF Buchungsstapel (reiner, deterministischer Builder).
// ESTIMATE-Subset des öffentlichen DATEV-ASCII-Formats: Vorspann mit
// EXTF-Kennung, Spaltenköpfe, eine Buchungszeile je Beleg. Berater-/
// Mandantennummer bleiben leer (beim DATEV-Import zu setzen); nur
// 19-%-Standardfall über Automatikkonto, alles andere fail-closed.
//
// F8-22 DATEV-Sonderfaelle: echte 0-%-Buchungen (§12 Abs. 3, §13b
// Reverse-Charge) ueber eine Konstanten-Matrix Behandlung →
// { BU-Schluessel, Erloeskonto } je SKR. Mischbelege splitten in EINE
// Buchungszeile je Behandlungsgruppe (deterministische Reihenfolge,
// bruto summengleich). Unbekannte oder inkonsistente Behandlungen
// verweigern fail-closed mit Belegnummer (kein stiller Teil-Export).

export type DatevSkr = "03" | "04";
export type DatevBookingKind = "invoice" | "credit_note";
// Spiegel von commercial_document_line.tax_treatment (Migration 0197,
// DECIDED): 1900 bps ↔ standard_19, 0 bps ↔ zero_12_3/reverse_13b.
export type DatevTaxTreatment = "standard_19" | "zero_12_3" | "reverse_13b";

export type DatevBookingLineInput = {
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
  // Fehlt die Behandlung, wird sie nur aus dem eindeutigen 19-%-Satz
  // abgeleitet (CHECK-gekoppelt, F8-11-kompatibel); 0-%-Zeilen ohne
  // Behandlung verweigern fail-closed (zero vs. reverse ist mehrdeutig).
  taxTreatment?: DatevTaxTreatment;
};

export type DatevBookingInput = {
  kind: DatevBookingKind;
  number: string;
  issueDate: string;
  contactName: string;
  currency: string;
  lines: DatevBookingLineInput[];
  netCents: number;
  taxCents: number;
  grossCents: number;
};

export type DatevBatchInput = {
  month: string;
  skr: DatevSkr;
  bookings: DatevBookingInput[];
};

// Datenservice-Vorstufe (DECIDED): maschinenlesbare Belegsicht je Stapel,
// Grundlage fuer den spaeteren Buchungsdatenservice.
export type DatevBatchDocumentGroup = {
  taxTreatment: DatevTaxTreatment;
  netCents: number;
  taxCents: number;
  grossCents: number;
  buKey: string;
  revenueAccount: string;
};

export type DatevBatchDocument = {
  number: string;
  kind: DatevBookingKind;
  issueDate: string;
  grossCents: number;
  groups: DatevBatchDocumentGroup[];
};

export type DatevExportErrorCode = "booking" | "sums" | "scope";

export class DatevExportError extends Error {
  readonly code: DatevExportErrorCode;
  constructor(code: DatevExportErrorCode, detail: string) {
    super(`datev-export:${code}: ${detail}`);
    this.name = "DatevExportError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/u;

// Forderung an Erlös (19 % Automatikkonto, BU-Schlüssel leer).
const DATEV_ACCOUNTS: Record<DatevSkr, { receivable: string; revenue: string }> = {
  "03": { receivable: "1400", revenue: "8400" },
  "04": { receivable: "1200", revenue: "4400" },
};

// ESTIMATE (F8-22): BU-Schluessel + Erloeskonten der 0-%-Behandlungen sind
// reversible Naeherung aus oeffentlicher DATEV-Dokumentation; finale Werte
// nur per Steuerberater-Review (PLAN.md-Gate vor Pilot). Single-source
// Tabelle — standard_19 unveraendert Automatikkonto, BU leer.
const DATEV_TREATMENT_POSTINGS: Record<
  DatevTaxTreatment,
  { buKey: string; revenue: Record<DatevSkr, string>; estimate: boolean }
> = {
  standard_19: { buKey: "", revenue: { "03": "8400", "04": "4400" }, estimate: false },
  zero_12_3: { buKey: "43", revenue: { "03": "8340", "04": "4340" }, estimate: true },
  reverse_13b: { buKey: "40", revenue: { "03": "8338", "04": "4338" }, estimate: true },
};

const DATEV_TREATMENT_ORDER: readonly DatevTaxTreatment[] = [
  "standard_19",
  "zero_12_3",
  "reverse_13b",
];

// §13b-Buchungstext-Suffix (Spec ESTIMATE): die 60-Zeichen-Kappung greift
// zuerst auf den F8-11-Basistext, danach wird das Suffix angehaengt.
const REVERSE_13B_SUFFIX = " - §13b Steuerschuldnerschaft des Leistungsempfaengers";

function fail(code: DatevExportErrorCode, detail: string): never {
  throw new DatevExportError(code, detail);
}

function cell(value: string): string {
  const guarded = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  if (/[";\r\n]/u.test(guarded)) {
    return `"${guarded.replace(/"/gu, '""')}"`;
  }
  return guarded;
}

// DATEV-Konvention: Komma-Dezimal, 2 Stellen.
function euros(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

// EXTF-Belegdatum: TTMMJJJJ.
function belegDatum(isoDate: string, field: string): string {
  if (!ISO_DATE.test(isoDate)) fail("booking", `${field} ist kein ISO-Datum`);
  const [year, month, day] = isoDate.split("-");
  return `${day}${month}${year}`;
}

function bookingText(kind: DatevBookingKind, number: string, contactName: string): string {
  const label = kind === "invoice" ? "Rechnung" : "Gutschrift";
  const contact = contactName.trim().replace(/\s+/gu, " ").slice(0, 40);
  // Kontaktlose Belege sind produkt-legal (contact_id nullable) — dann trägt
  // der Buchungstext nur Typ + Nummer (Belegnummer bleibt eindeutig).
  const text = contact === "" ? `${label} ${number.trim()}` : `${label} ${number.trim()} - ${contact}`;
  return text.slice(0, 60);
}

function bookingTextForGroup(
  kind: DatevBookingKind,
  number: string,
  contactName: string,
  treatment: DatevTaxTreatment,
): string {
  const base = bookingText(kind, number, contactName);
  if (treatment !== "reverse_13b") return base;
  return `${base}${REVERSE_13B_SUFFIX}`;
}

function resolveTreatment(line: DatevBookingLineInput, bookingNumber: string): DatevTaxTreatment {
  // DB-gespeist: zur Laufzeit auch null/fremde Strings moeglich.
  const treatment: unknown = line.taxTreatment;
  if (treatment === undefined || treatment === null) {
    // 1900 bps ist CHECK-gekoppelt eindeutig standard_19 (F8-11-Pfad);
    // 0 bps ohne Behandlung ist mehrdeutig (zero_12_3 vs. reverse_13b).
    if (line.taxRateBps === 1900) return "standard_19";
    fail("booking", `Beleg ${bookingNumber}: 0-%-Zeile ohne Steuerbehandlung (zero_12_3/reverse_13b erforderlich)`);
  }
  if (treatment !== "standard_19" && treatment !== "zero_12_3" && treatment !== "reverse_13b") {
    fail("booking", `Beleg ${bookingNumber}: unbekannte Steuerbehandlung`);
  }
  const wantsZeroRate = treatment !== "standard_19";
  if ((line.taxRateBps === 0) !== wantsZeroRate || (line.taxRateBps !== 0 && line.taxRateBps !== 1900)) {
    fail("booking", `Beleg ${bookingNumber}: Steuerbehandlung passt nicht zum Steuersatz`);
  }
  return treatment;
}

type DatevTreatmentGroup = {
  treatment: DatevTaxTreatment;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

function groupBookingLines(booking: DatevBookingInput): DatevTreatmentGroup[] {
  const sums = new Map<DatevTaxTreatment, DatevTreatmentGroup>();
  for (const line of booking.lines) {
    const treatment = resolveTreatment(line, booking.number);
    const group = sums.get(treatment) ?? { treatment, netCents: 0, taxCents: 0, grossCents: 0 };
    group.netCents += line.netCents;
    group.taxCents += line.taxCents;
    group.grossCents += line.grossCents;
    sums.set(treatment, group);
  }
  return DATEV_TREATMENT_ORDER.filter((treatment) => sums.has(treatment))
    .map((treatment) => sums.get(treatment) as DatevTreatmentGroup);
}

function checkBooking(booking: DatevBookingInput): void {
  if (booking.kind !== "invoice" && booking.kind !== "credit_note") {
    fail("scope", "nur invoice/credit_note werden exportiert");
  }
  if (booking.currency !== "EUR") {
    fail("scope", `Beleg ${booking.number}: nur EUR wird exportiert`);
  }
  if (booking.number.trim() === "") fail("booking", "Belegnummer fehlt");
  if (!ISO_DATE.test(booking.issueDate)) fail("booking", `Beleg ${booking.number}: Ausstelldatum fehlt`);
  if (booking.lines.length === 0) fail("booking", `Beleg ${booking.number}: keine Positionen`);
  let net = 0;
  let tax = 0;
  for (const line of booking.lines) {
    const treatment = resolveTreatment(line, booking.number);
    for (const [field, value] of [["net", line.netCents], ["tax", line.taxCents], ["gross", line.grossCents]] as const) {
      if (!Number.isInteger(value) || value < 0) {
        fail("booking", `Beleg ${booking.number}: ${field} ungültig`);
      }
    }
    if (line.grossCents !== line.netCents + line.taxCents) {
      fail("sums", `Beleg ${booking.number}: Zeilensumme krumm`);
    }
    if (treatment !== "standard_19" && line.taxCents !== 0) {
      fail("sums", `Beleg ${booking.number}: 0-%-Zeile mit Steuerbetrag`);
    }
    net += line.netCents;
    tax += line.taxCents;
  }
  if (net !== booking.netCents || tax !== booking.taxCents) {
    fail("sums", `Beleg ${booking.number}: Kopf-Netto/Steuer passt nicht zu den Zeilen`);
  }
  if (booking.grossCents !== booking.netCents + booking.taxCents) {
    fail("sums", `Beleg ${booking.number}: Brutto ungleich Netto + Steuer`);
  }
  // Summenkranz je Gruppe + gesamt (DECIDED): die Gruppensummen muessen den
  // Kopf exakt ergeben — sonst kein Split, sondern fail-closed.
  const groups = groupBookingLines(booking);
  const groupNet = groups.reduce((sum, group) => sum + group.netCents, 0);
  const groupTax = groups.reduce((sum, group) => sum + group.taxCents, 0);
  const groupGross = groups.reduce((sum, group) => sum + group.grossCents, 0);
  if (groupNet !== booking.netCents || groupTax !== booking.taxCents || groupGross !== booking.grossCents) {
    fail("sums", `Beleg ${booking.number}: Behandlungsgruppen ergeben nicht den Kopf`);
  }
  for (const group of groups) {
    if (group.grossCents !== group.netCents + group.taxCents) {
      fail("sums", `Beleg ${booking.number}: Behandlungsgruppe krumm`);
    }
  }
}

function bookingRows(booking: DatevBookingInput, skr: DatevSkr): string[] {
  const accounts = DATEV_ACCOUNTS[skr];
  // Forderung an Erlös; Gutschrift = Haben-Seite (DATEV-Konvention,
  // positiver Betrag statt Minuszeichen).
  const sh = booking.kind === "invoice" ? "S" : "H";
  return groupBookingLines(booking).map((group) => {
    const posting = DATEV_TREATMENT_POSTINGS[group.treatment];
    return [
      euros(group.grossCents),
      sh,
      accounts.receivable,
      posting.revenue[skr],
      posting.buKey,
      belegDatum(booking.issueDate, `Beleg ${booking.number}`),
      booking.number,
      bookingTextForGroup(booking.kind, booking.number, booking.contactName, group.treatment),
    ].map(cell).join(";");
  });
}

const BOOKING_COLUMNS = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "Kontonummer",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegnummer",
  "Buchungstext",
];

function checkedOrderedBookings(input: DatevBatchInput): DatevBookingInput[] {
  if (!MONTH.test(input.month)) fail("scope", "Monat ungültig");
  if (input.skr !== "03" && input.skr !== "04") fail("scope", "SKR ungültig");
  for (const booking of input.bookings) checkBooking(booking);

  return [...input.bookings].sort((a, b) =>
    a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.number < b.number ? -1 : 1,
  );
}

export function buildDatevBatchCsv(input: DatevBatchInput): string {
  const ordered = checkedOrderedBookings(input);
  const [year, month] = input.month.split("-");
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const preamble = [
    "EXTF",
    "700",
    "21",
    "Buchungsstapel",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    `0101${year}`,
    "4",
    `01${month}`,
    `${String(lastDay).padStart(2, "0")}${month}`,
    `Energie-SaaS ${input.month}`,
    "",
    "1",
    "",
    "0",
    "EUR",
  ].join(";");

  const lines = [preamble, BOOKING_COLUMNS.map(cell).join(";")];
  for (const booking of ordered) lines.push(...bookingRows(booking, input.skr));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildDatevBatchDocuments(input: DatevBatchInput): DatevBatchDocument[] {
  const ordered = checkedOrderedBookings(input);
  return ordered.map((booking) => ({
    number: booking.number,
    kind: booking.kind,
    issueDate: booking.issueDate,
    grossCents: booking.grossCents,
    groups: groupBookingLines(booking).map((group) => ({
      taxTreatment: group.treatment,
      netCents: group.netCents,
      taxCents: group.taxCents,
      grossCents: group.grossCents,
      buKey: DATEV_TREATMENT_POSTINGS[group.treatment].buKey,
      revenueAccount: DATEV_TREATMENT_POSTINGS[group.treatment].revenue[input.skr],
    })),
  }));
}

export function datevBatchFileName(month: string, skr: DatevSkr): string {
  return `datev-buchungsstapel-${month}-skr${skr}.csv`;
}
