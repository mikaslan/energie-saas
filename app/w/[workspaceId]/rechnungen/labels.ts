// Gemeinsame Anzeige-Konstanten für den Bereich „Rechnungen & Dokumente".
// DECIDED: eigene, generische Fachbegriffe (Clean-Room — keine Textübernahme).

import type { CommercialDocumentType } from "@/lib/integrations/invoicing/contract";

export const DOCUMENT_TYPE_LABELS: Record<CommercialDocumentType, string> = {
  invoice: "Rechnungen",
  credit_note: "Gutschriften",
  order_confirmation: "Auftragsbestätigungen",
  purchase_order: "Bestellungen",
  delivery_note: "Lieferscheine",
  letter: "Briefe",
};

export const DOCUMENT_TYPE_SINGULAR_LABELS: Record<CommercialDocumentType, string> = {
  invoice: "Rechnung",
  credit_note: "Gutschrift",
  order_confirmation: "Auftragsbestätigung",
  purchase_order: "Bestellung",
  delivery_note: "Lieferschein",
  letter: "Brief",
};

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Entwurf",
  issued: "Ausgestellt",
  voided: "Storniert",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Offen",
  partially_paid: "Teilweise bezahlt",
  paid: "Bezahlt",
  overdue: "Überfällig",
  uncollectable: "Uneinbringlich",
};

export const VOID_REASON_LABELS: Record<string, string> = {
  created_in_error: "Versehentlich angelegt",
  duplicate: "Duplikat",
  superseded: "Ersetzt",
  cancelled: "Aufgehoben",
  other: "Sonstiges",
};

export const CREDIT_NOTE_TYPE_LABELS: Record<string, string> = {
  minderleistung: "Minderleistung",
  empfehlungspraemie: "Empfehlungsprämie",
};

// Berlin-Datumsanzeige für ISO-Zeitstempel (Kimi-P3-2: nie Server-TZ).
export function formatBerlinDate(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// Reines Kalenderdatum "YYYY-MM-DD" (Berlin-native date-Spalten).
export function formatDateOnly(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatEuro(cents: number): string {
  const euros = cents / 100;
  return `${euros.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}
