import { describe, expect, it } from "vitest";
import {
  DOCUMENT_NUMBER_FORMAT_DEFAULTS,
  invoicingSettingsCommandV1Schema,
  invoicingSettingsInputV1Schema,
  numberFormatCommandV1Schema,
  numberFormatTemplateSchema,
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";

const DE_IBAN = "DE89370400440532013000";

function settingsCommand(baseRevision: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      companyName: "Sonnige Energie GmbH",
      companyEmail: "office@sonnige-energie.example",
      companyAuthority: null,
      companyRegisterNumber: null,
      companyTaxId: null,
      companyAddressLine1: "Musterstraße 8",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      accountingMethod: "accrual",
      paymentAccountHolder: null,
      paymentIban: null,
      paymentBic: null,
      goebdRetentionDefaultDays: 3650,
      ...overrides,
    },
  };
}

describe("M3-00 Invoicing-Vertrag", () => {
  it("akzeptiert vollständige Settings mit Zahlungsdaten (MOD-97-IBAN, BIC 8/11)", () => {
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      paymentAccountHolder: "Sonnige Energie GmbH",
      paymentIban: DE_IBAN,
      paymentBic: "DEUTDEBB",
    })).success).toBe(true);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      paymentAccountHolder: "Sonnige Energie GmbH",
      paymentIban: DE_IBAN,
      paymentBic: "DEUTDEBBXXX",
    })).success).toBe(true);
  });

  it("lehnt ungültigen IBAN (MOD-97), BIC-Länge und unvollständige Zahlungsdaten ab", () => {
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      paymentAccountHolder: "X",
      paymentIban: "DE89370400440532013001", // falsche Prüfziffer
      paymentBic: "DEUTDEBB",
    })).success).toBe(false);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      paymentAccountHolder: "X",
      paymentIban: DE_IBAN,
      paymentBic: "DEUTDEBBX", // 9 Zeichen
    })).success).toBe(false);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      paymentAccountHolder: "X",
      paymentIban: DE_IBAN,
      paymentBic: null, // unvollständig
    })).success).toBe(false);
  });

  it("validiert Land-Enum, Buchhaltungsmethode und GoBD-Bereich", () => {
    for (const country of ["DE", "AT", "CH", "FR", "UK", "JE"]) {
      expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
        companyCountry: country,
      })).success).toBe(true);
    }
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      companyCountry: "US",
    })).success).toBe(false);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      accountingMethod: "cash",
    })).success).toBe(true);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      accountingMethod: "hybrid",
    })).success).toBe(false);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      goebdRetentionDefaultDays: 0,
    })).success).toBe(false);
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      goebdRetentionDefaultDays: 36501,
    })).success).toBe(false);
  });

  it("validiert E-Mail und Pflichtfelder", () => {
    expect(invoicingSettingsCommandV1Schema.safeParse(settingsCommand(0, {
      companyEmail: "keine-email",
    })).success).toBe(false);
    expect(invoicingSettingsInputV1Schema.safeParse({
      ...settingsCommand(0).input,
      companyName: "   ",
    }).success).toBe(false);
  });

  it("validiert das Format-Template (Platzhalter-Regeln)", () => {
    const base = {
      schemaVersion: WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
      type: "invoice",
    };
    expect(numberFormatCommandV1Schema.safeParse({
      ...base,
      formatTemplate: "Rechnung-{YEAR}-{MONTH}-{NUMBER}",
    }).success).toBe(true);
    expect(numberFormatCommandV1Schema.safeParse({
      ...base,
      formatTemplate: "R-{NUMBER}",
    }).success).toBe(true);
    expect(numberFormatCommandV1Schema.safeParse({
      ...base,
      formatTemplate: "R-{YEAR}", // {NUMBER} fehlt
    }).success).toBe(false);
    expect(numberFormatCommandV1Schema.safeParse({
      ...base,
      formatTemplate: "R-{FOO}-{NUMBER}", // unbekannter Platzhalter
    }).success).toBe(false);
    expect(numberFormatCommandV1Schema.safeParse({
      ...base,
      formatTemplate: "R-{YEAR}-{YEAR}-{NUMBER}", // doppelter Datums-Platzhalter
    }).success).toBe(false);
    expect(numberFormatTemplateSchema.safeParse("x".repeat(121)).success).toBe(false);
  });

  it("liefert die OBSERVED-Defaults für alle 6 Typen", () => {
    expect(Object.keys(DOCUMENT_NUMBER_FORMAT_DEFAULTS).sort()).toEqual([
      "credit_note",
      "delivery_note",
      "invoice",
      "letter",
      "order_confirmation",
      "purchase_order",
    ]);
    expect(DOCUMENT_NUMBER_FORMAT_DEFAULTS.invoice).toBe("Rechnung-{YEAR}-{MONTH}-{NUMBER}");
    expect(DOCUMENT_NUMBER_FORMAT_DEFAULTS.letter).toBe("LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}");
  });
});
