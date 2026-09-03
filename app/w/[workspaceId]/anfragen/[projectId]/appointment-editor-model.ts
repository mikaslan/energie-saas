import type { AppointmentType } from "@/lib/integrations/calendar/contract";

export const APPOINTMENT_TYPE_OPTIONS: ReadonlyArray<{
  value: AppointmentType;
  label: string;
}> = [
  { value: "on_site", label: "Vor Ort" },
  { value: "phone", label: "Telefonat" },
  { value: "installation", label: "Installation" },
  { value: "maintenance", label: "Wartung" },
  { value: "consultation", label: "Beratung" },
  { value: "other", label: "Sonstiges" },
];

export const APPOINTMENT_TYPE_LABELS = Object.fromEntries(
  APPOINTMENT_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<AppointmentType, string>;

// Feste WMEE-Farbzuordnung (ADR 0021 E3). Nie Farbsignal-only: Icon/Text bleibt
// immer zusätzlich sichtbar. Kein erfundener Produkt-/Preiswert.
export const APPOINTMENT_TYPE_COLORS: Record<AppointmentType, string> = {
  on_site: "#1d4ed8",
  phone: "#0f766e",
  installation: "#b45309",
  maintenance: "#7c3aed",
  consultation: "#be185d",
  other: "#475569",
};

export function toBerlinDateTimeValue(value: string): string {
  // value kommt als Berlin-Wanduhr "YYYY-MM-DDTHH:mm:ss.sss" — für
  // <input type="datetime-local"> reicht "YYYY-MM-DDTHH:mm".
  return value.slice(0, 16);
}

export function toBerlinDateValue(value: string): string {
  return value.slice(0, 10);
}

export function fromDateTimeInput(value: string): string {
  // <input type="datetime-local"> liefert "YYYY-MM-DDTHH:mm".
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/u.test(value)) return value;
  return `${value}:00`;
}

export function fromDateInput(value: string): string {
  return `${value}T00:00:00`;
}

export function fromTimeInput(value: string): string {
  if (/^\d{2}:\d{2}$/u.test(value)) return `2000-01-01T${value}:00`;
  return value;
}
