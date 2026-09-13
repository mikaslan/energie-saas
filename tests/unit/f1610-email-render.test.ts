import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_PREVIEW_SAMPLE,
  renderEmailTemplate,
  updateEmailTemplateCommandSchema,
} from "@/lib/email-template";

describe("F16-10 renderEmailTemplate (rein, Vorschau)", () => {
  it("F1610-U-01: ersetzt Allowlist-Variablen, auch mehrfach", () => {
    const out = renderEmailTemplate("Hallo {{customer_name}}, {{project_name}} ({{customer_name}})", {
      customer_name: "A",
      project_name: "B",
    });
    expect(out).toBe("Hallo A, B (A)");
  });

  it("F1610-U-02: unbekannte Platzhalter und fehlende Werte bleiben literal", () => {
    expect(renderEmailTemplate("Hallo {{unknown_key}}!", { customer_name: "A" })).toBe(
      "Hallo {{unknown_key}}!",
    );
    expect(renderEmailTemplate("Hallo {{customer_name}}!", {})).toBe("Hallo {{customer_name}}!");
  });

  it("F1610-U-04: Command-Schema normalisiert Browser-CRLF zu LF (Textarea)", () => {
    const parsed = updateEmailTemplateCommandSchema.safeParse({
      schemaVersion: 1,
      key: "portal_link",
      subject: "Betreff",
      body: "Zeile eins\r\nZeile zwei\rZeile drei",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toBe("Zeile eins\nZeile zwei\nZeile drei");
    }
  });

  it("F1610-U-03: alle 8 Standardfassungen rendern mit Beispielwerten ohne Rest-Platzhalter der Allowlist", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const subject = renderEmailTemplate(EMAIL_TEMPLATE_DEFAULTS[key].subject, EMAIL_TEMPLATE_PREVIEW_SAMPLE);
      const body = renderEmailTemplate(EMAIL_TEMPLATE_DEFAULTS[key].body, EMAIL_TEMPLATE_PREVIEW_SAMPLE);
      expect(subject).not.toMatch(/\{\{\s*(customer_name|project_name|portal_link|company_name)\s*\}\}/u);
      expect(body).not.toMatch(/\{\{\s*(customer_name|project_name|portal_link|company_name)\s*\}\}/u);
      expect(body).toContain("Max Mustermann");
    }
  });
});
