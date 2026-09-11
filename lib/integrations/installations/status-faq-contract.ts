import { z } from "zod";

// F10-09 Portal-FAQ je Installationsstand — client-sicherer Anteil
// (Konstanten + Zod; kein Server-Import, Muster status-label-contract).
// Service und UI teilen sich diese Quelle; das Portal zeigt ohne Mapping
// keinen FAQ-Block (kein Default-Text).
export const INSTALLATION_STATUS_FAQ_SCOPE = "installation" as const;

export const INSTALLATION_STATUS_FAQ_KEYS = ["active", "completed", "handover"] as const;

export type InstallationStatusFaqKey = (typeof INSTALLATION_STATUS_FAQ_KEYS)[number];

export type InstallationStatusFaq = {
  active: string | null;
  completed: string | null;
  handover: string | null;
};

export const INSTALLATION_STATUS_FAQ_MAX = 2000;

const faqSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .refine((value) => value.length >= 1 && value.length <= INSTALLATION_STATUS_FAQ_MAX, {
    message: "faq-Laenge",
  })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "faq-Steuerzeichen",
  });

export const installationStatusFaqCommandSchema = z.strictObject({
  key: z.enum(INSTALLATION_STATUS_FAQ_KEYS),
  faq: faqSchema,
});

export const installationStatusFaqKeySchema = z.strictObject({
  key: z.enum(INSTALLATION_STATUS_FAQ_KEYS),
});
