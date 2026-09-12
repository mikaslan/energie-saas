// F8-11 DATEV-EXTF Buchungsstapel (reiner, deterministischer Builder).
// ESTIMATE-Subset des öffentlichen DATEV-ASCII-Formats: Vorspann mit
// EXTF-Kennung, Spaltenköpfe, eine Buchungszeile je Beleg. Berater-/
// Mandantennummer bleiben leer (beim DATEV-Import zu setzen); nur
// 19-%-Standardfall über Automatikkonto, alles andere fail-closed.

export type DatevSkr = "03" | "04";
export type DatevBookingKind = "invoice" | "credit_note";

export type DatevBookingLineInput = {
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
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
  return `${label} ${number.trim()} - ${contact}`.slice(0, 60);
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
  if (booking.contactName.trim() === "") fail("booking", `Beleg ${booking.number}: Kontakt fehlt`);
  if (booking.lines.length === 0) fail("booking", `Beleg ${booking.number}: keine Positionen`);
  let net = 0;
  let tax = 0;
  for (const line of booking.lines) {
    if (line.taxRateBps !== 1900) {
      fail("booking", `Beleg ${booking.number}: nur 19-%-Zeilen (kein 0-%/§13b)`);
    }
    for (const [field, value] of [["net", line.netCents], ["tax", line.taxCents], ["gross", line.grossCents]] as const) {
      if (!Number.isInteger(value) || value < 0) {
        fail("booking", `Beleg ${booking.number}: ${field} ungültig`);
      }
    }
    if (line.grossCents !== line.netCents + line.taxCents) {
      fail("sums", `Beleg ${booking.number}: Zeilensumme krumm`);
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
}

function bookingRow(booking: DatevBookingInput, skr: DatevSkr): string {
  const accounts = DATEV_ACCOUNTS[skr];
  // Forderung an Erlös; Gutschrift = Haben-Seite (DATEV-Konvention,
  // positiver Betrag statt Minuszeichen).
  const sh = booking.kind === "invoice" ? "S" : "H";
  return [
    euros(booking.grossCents),
    sh,
    accounts.receivable,
    accounts.revenue,
    "",
    belegDatum(booking.issueDate, `Beleg ${booking.number}`),
    booking.number,
    bookingText(booking.kind, booking.number, booking.contactName),
  ].map(cell).join(";");
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

export function buildDatevBatchCsv(input: DatevBatchInput): string {
  if (!MONTH.test(input.month)) fail("scope", "Monat ungültig");
  if (input.skr !== "03" && input.skr !== "04") fail("scope", "SKR ungültig");
  for (const booking of input.bookings) checkBooking(booking);

  const ordered = [...input.bookings].sort((a, b) =>
    a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.number < b.number ? -1 : 1,
  );
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
  for (const booking of ordered) lines.push(bookingRow(booking, input.skr));
  return `${lines.join("\r\n")}\r\n`;
}

export function datevBatchFileName(month: string, skr: DatevSkr): string {
  return `datev-buchungsstapel-${month}-skr${skr}.csv`;
}
