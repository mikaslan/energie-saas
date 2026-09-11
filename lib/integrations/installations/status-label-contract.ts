import { z } from "zod";

// F10-05 Portal-Statusmapping (Installation-Umfang) — client-sicherer
// Anteil (Konstanten + Zod; kein Server-Import, Muster
// tasks/template-contract). Service und UI teilen sich diese Quelle;
// das Portal fällt bei fehlendem Mapping auf die Defaults.
export const INSTALLATION_STATUS_LABEL_SCOPE = "installation" as const;

export const INSTALLATION_STATUS_LABEL_KEYS = ["active", "completed", "handover"] as const;

export type InstallationStatusLabelKey = (typeof INSTALLATION_STATUS_LABEL_KEYS)[number];

export type InstallationStatusLabels = {
  active: string | null;
  completed: string | null;
  handover: string | null;
};

// Standardtexte bei fehlendem Mapping (eine Quelle für
// Einstellungen-Hinweis und Portal-Fallback).
export const INSTALLATION_STATUS_LABEL_DEFAULTS: Record<InstallationStatusLabelKey, string> = {
  active: "In Ausführung",
  completed: "Abgeschlossen",
  handover: "Abgenommen",
};

export const INSTALLATION_STATUS_LABEL_MAX = 80;

const labelSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .refine((value) => value.length >= 1 && value.length <= INSTALLATION_STATUS_LABEL_MAX, {
    message: "label-Laenge",
  })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "label-Steuerzeichen",
  });

export const installationStatusLabelCommandSchema = z.strictObject({
  key: z.enum(INSTALLATION_STATUS_LABEL_KEYS),
  label: labelSchema,
});

export const installationStatusLabelKeySchema = z.strictObject({
  key: z.enum(INSTALLATION_STATUS_LABEL_KEYS),
});
