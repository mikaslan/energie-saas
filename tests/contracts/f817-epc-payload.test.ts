import { describe, expect, it } from "vitest";

import {
  EPC_PAYLOAD_VERSION,
  buildEpcPayload,
  validateEpcPayload,
} from "@/lib/integrations/invoicing/epc-contract";

const VALID_INPUT = {
  creditorName: "Solarwerk GmbH",
  creditorIban: "DE89370400440532013000",
  creditorBic: "MARKDEF1100",
  amountCents: 11900,
  documentNumber: "RE-2026-000001",
} as const;

describe("F8-17 EPC-QR-Payload-Vertrag", () => {
  it("F817-CT-01: pinnt die Payload-Version", () => {
    expect(EPC_PAYLOAD_VERSION).toBe("epc-payload.v1");
  });

  it("F817-CT-01: baut exakt 10 EPC069-12-Zeilen mit RF-Referenz", () => {
    const payload = buildEpcPayload({ ...VALID_INPUT });

    const lines = payload.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("BCD");
    expect(lines[1]).toBe("002");
    expect(lines[2]).toBe("1");
    expect(lines[3]).toBe("SCT");
    expect(lines[4]).toBe("MARKDEF1100");
    expect(lines[5]).toBe("Solarwerk GmbH");
    expect(lines[6]).toBe("DE89370400440532013000");
    expect(lines[7]).toBe("EUR119.00");
    expect(lines[8]).toBe("");
    // Strukturierte RF-Referenz aus der Dokumentnummer (ISO 11649).
    expect(lines[9]).toMatch(/^RF[0-9]{2}[A-Z0-9]{1,21}$/u);
    expect(validateEpcPayload(payload).ok).toBe(true);
  });

  it("F817-CT-01: RF-Pruefziffern sind gueltig (ISO-11649-Vektor)", () => {
    // Kanonischer Vektor: RF18 5390 0754 7034.
    const payload = buildEpcPayload({
      ...VALID_INPUT,
      creditorName: "Muster GmbH",
      creditorIban: "DE75512108001245126199",
      creditorBic: "",
      amountCents: 1,
      documentNumber: "539007547034",
    });
    const reference = payload.split("\n")[9] ?? "";
    expect(reference).toBe("RF18539007547034");
  });

  it("F817-CT-01: leere BIC ist zulaessig (EPC-002), Name bis 70 Zeichen", () => {
    const payload = buildEpcPayload({ ...VALID_INPUT, creditorBic: "" });
    expect(payload.split("\n")[4]).toBe("");
    const longName = "A".repeat(70);
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorName: longName })).not.toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorName: `${longName}X` })).toThrow();
  });

  it("F817-CT-01: Cent-Betraege werden exakt mit 2 Dezimalstellen kodiert", () => {
    expect(buildEpcPayload({ ...VALID_INPUT, amountCents: 1 }).split("\n")[7]).toBe("EUR0.01");
    expect(buildEpcPayload({ ...VALID_INPUT, amountCents: 100 }).split("\n")[7]).toBe("EUR1.00");
    expect(buildEpcPayload({ ...VALID_INPUT, amountCents: 99999999999 }).split("\n")[7])
      .toBe("EUR999999999.99");
  });

  it("F817-CT-01: fail-closed bei IBAN/BIC/Betrag/Steuerzeichen-Fehlern", () => {
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorIban: "DE00370400440532013000" }))
      .toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorIban: "DE89 3704 0044 0532 0130 00" }))
      .toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorBic: "TOOLONG12345" })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorBic: "markdef1100" })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, amountCents: 0 })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, amountCents: -5 })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, amountCents: 100000000000 })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, amountCents: 10.5 })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorName: "Zeile\nUmbruch" })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, creditorName: "" })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, documentNumber: "" })).toThrow();
    expect(() => buildEpcPayload({ ...VALID_INPUT, documentNumber: "!!!" })).toThrow();
  });

  it("F817-CT-01: validateEpcPayload prueft Parsen + RF-Checksumme", () => {
    const payload = buildEpcPayload({ ...VALID_INPUT });
    expect(validateEpcPayload(payload)).toEqual({ ok: true, value: payload });
    const tampered = payload.replace(/^RF..(?=RE)/mu, "RF00");
    expect(validateEpcPayload(tampered).ok).toBe(false);
    expect(validateEpcPayload("BCD\n002").ok).toBe(false);
    expect(validateEpcPayload("")).toEqual({ ok: false, errors: expect.any(Array) });
    expect(validateEpcPayload(null).ok).toBe(false);
  });
});
