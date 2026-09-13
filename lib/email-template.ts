// F16-10 E-Mail-Vorlagen: reiner Client-/Server-Vertrag
// (DTO-Form, Command-Schemas, Standardfassungen, Render — keine Imports
// außer zod, kein I/O). Muster lib/file-request-template.ts: Sektion
// (Client) und Service (Server) teilen sich diese Datei, ohne
// Server-Code ins Client-Bundle zu ziehen.
import { z } from "zod";

export const EMAIL_TEMPLATE_SCHEMA_VERSION = 1;

export const EMAIL_TEMPLATE_SUBJECT_MAX = 200;
export const EMAIL_TEMPLATE_BODY_MAX = 10_000;

// F16.3/Katalog: 8 fixe Kunden-Mail-Automatiken — editierbar, mit
// Variablen, nur 1 Sprachset (DE, ESTIMATE).
export const EMAIL_TEMPLATE_KEYS = [
  "new_lead",
  "need_information",
  "new_proposal",
  "edited_proposal",
  "file_request",
  "signature_completed",
  "portal_link",
  "cannot_fulfil",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export const EMAIL_TEMPLATE_LABELS: Record<EmailTemplateKey, string> = {
  new_lead: "Neue Anfrage",
  need_information: "Informationen benötigt",
  new_proposal: "Neues Angebot",
  edited_proposal: "Angebot überarbeitet",
  file_request: "Datei-Anfrage",
  signature_completed: "Signatur abgeschlossen",
  portal_link: "Portal-Link",
  cannot_fulfil: "Absage (nicht erfüllbar)",
};

// ESTIMATE-Allowlist der Variablen (Katalog: „Variablen"). Der Versand
// ist kein Teil dieses Slices; Render dient nur der Vorschau.
export const EMAIL_TEMPLATE_VARIABLES = [
  "customer_name",
  "project_name",
  "portal_link",
  "company_name",
] as const;
export type EmailTemplateVariable = (typeof EMAIL_TEMPLATE_VARIABLES)[number];

export const EMAIL_TEMPLATE_PREVIEW_SAMPLE: Record<EmailTemplateVariable, string> = {
  customer_name: "Max Mustermann",
  project_name: "PV-Anlage Musterstraße 1",
  portal_link: "https://portal.example/einladung/BEISPIEL",
  company_name: "WMEE",
};

export const EMAIL_TEMPLATE_DEFAULTS: Record<EmailTemplateKey, { subject: string; body: string }> = {
  new_lead: {
    subject: "Ihre Anfrage bei {{company_name}} ist eingegangen",
    body: "Hallo {{customer_name}},\nvielen Dank für Ihre Anfrage zu {{project_name}}. Wir melden uns in Kürze mit den nächsten Schritten.\n\nIhre {{company_name}}",
  },
  need_information: {
    subject: "Noch Angaben nötig für {{project_name}}",
    body: "Hallo {{customer_name}},\nfür {{project_name}} fehlen uns noch Angaben. Bitte ergänzen Sie diese, damit wir fortfahren können.\n\nIhre {{company_name}}",
  },
  new_proposal: {
    subject: "Ihr Angebot für {{project_name}} ist da",
    body: "Hallo {{customer_name}},\nIhr Angebot für {{project_name}} liegt vor. Sie finden es in Ihrem Kundenbereich: {{portal_link}}\n\nIhre {{company_name}}",
  },
  edited_proposal: {
    subject: "Ihr Angebot für {{project_name}} wurde überarbeitet",
    body: "Hallo {{customer_name}},\nIhr Angebot für {{project_name}} wurde überarbeitet. Die aktuelle Fassung finden Sie hier: {{portal_link}}\n\nIhre {{company_name}}",
  },
  file_request: {
    subject: "Bitte Datei bereitstellen für {{project_name}}",
    body: "Hallo {{customer_name}},\nfür {{project_name}} benötigen wir noch eine Datei von Ihnen. Bitte laden Sie sie hier hoch: {{portal_link}}\n\nIhre {{company_name}}",
  },
  signature_completed: {
    subject: "Signatur abgeschlossen für {{project_name}}",
    body: "Hallo {{customer_name}},\ndie Signatur für {{project_name}} ist abgeschlossen. Vielen Dank!\n\nIhre {{company_name}}",
  },
  portal_link: {
    subject: "Ihr Kundenbereich für {{project_name}}",
    body: "Hallo {{customer_name}},\nhier erreichen Sie Ihren Kundenbereich zu {{project_name}}: {{portal_link}}\n\nIhre {{company_name}}",
  },
  cannot_fulfil: {
    subject: "Ihre Anfrage zu {{project_name}}",
    body: "Hallo {{customer_name}},\nleider können wir Ihre Anfrage zu {{project_name}} nicht erfüllen. Bei Fragen melden Sie sich gern.\n\nIhre {{company_name}}",
  },
};

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

// Vorschau-Render (rein): ersetzt {{variable}} strikt aus der Map.
// Unbekannte Platzhalter bleiben literal stehen — bewusst, weil kein
// Versandpfad existiert, der sie auflösen müsste.
export function renderEmailTemplate(
  template: string,
  variables: Partial<Record<EmailTemplateVariable, string>>,
): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, (match, name: string) => {
    if ((EMAIL_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      const value = variables[name as EmailTemplateVariable];
      return typeof value === "string" ? value : match;
    }
    return match;
  });
}

const cleanSubject = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .refine((v) => v.length >= 1 && v.length <= EMAIL_TEMPLATE_SUBJECT_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

// Mehrzeilig: \n und \t sind erlaubt (Textarea), alle übrigen
// Steuer-/Formatzeichen fail-closed. Browser liefern CRLF — wird zu LF
// normalisiert, bevor validiert wird.
const cleanBody = z
  .string()
  .transform((v) => v.normalize("NFKC").replace(/\r\n?/gu, "\n").trim())
  .refine((v) => v.length >= 1 && v.length <= EMAIL_TEMPLATE_BODY_MAX, { message: "ungültige Länge" })
  .refine((v) => !/[^\P{Cc}\n\t]/u.test(v) && !/[\p{Cf}]/u.test(v), { message: "Steuerzeichen" });

export const emailTemplateDtoSchema = z.object({
  schemaVersion: z.literal(EMAIL_TEMPLATE_SCHEMA_VERSION),
  id: z.string().uuid(),
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  label: z.string(),
  subject: z.string(),
  body: z.string(),
  active: z.boolean(),
  updatedAt: z.string(),
  permissions: z.object({ canWrite: z.boolean() }),
});
export type EmailTemplateDto = z.infer<typeof emailTemplateDtoSchema>;

// Aktualisieren v1: nur Betreff/Text je fixem Schlüssel (kein Create,
// kein Delete — genau eine Zeile je Schlüssel je Workspace).
export const updateEmailTemplateCommandSchema = z.object({
  schemaVersion: z.literal(EMAIL_TEMPLATE_SCHEMA_VERSION),
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  subject: cleanSubject,
  body: cleanBody,
});
export type UpdateEmailTemplateCommand = z.infer<typeof updateEmailTemplateCommandSchema>;

export const archiveEmailTemplateCommandSchema = z.object({
  schemaVersion: z.literal(EMAIL_TEMPLATE_SCHEMA_VERSION),
  key: z.enum(EMAIL_TEMPLATE_KEYS),
  active: z.boolean(),
});
export type ArchiveEmailTemplateCommand = z.infer<typeof archiveEmailTemplateCommandSchema>;
