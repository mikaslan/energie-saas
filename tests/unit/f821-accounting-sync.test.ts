import { describe, expect, it } from "vitest";

import {
  ACCOUNTING_CANONICALIZATION_VERSION,
  ACCOUNTING_EXPORT_VERSION,
  ACCOUNTING_SYNC_TRANSITIONS,
  accountingExportPayloadV1Schema,
  accountingVendors,
  assertAccountingSyncTransition,
  buildAccountingExportPayload,
  canonicalizeAccountingJson,
  hashAccountingExportPayload,
  isAccountingPayloadDrifted,
  toBexioEntry,
  toLexofficeVoucher,
  toSevDeskVoucher,
  toVendorPayload,
  AccountingExportError,
  AccountingSyncTransitionError,
  type AccountingDocumentInput,
} from "@/lib/integrations/invoicing/accounting-contract";
import {
  AccountingProviderError,
  FakeAccountingProvider,
} from "@/lib/integrations/invoicing/accounting-provider";

function doc(overrides: Partial<AccountingDocumentInput> = {}): AccountingDocumentInput {
  return {
    kind: "invoice",
    status: "issued",
    number: "RE-2026-000001",
    issueDate: "2026-11-15",
    contactName: "Muster Kundin",
    currency: "EUR",
    lines: [
      { taxRateBps: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 },
      { taxRateBps: 1900, netCents: 5000, taxCents: 950, grossCents: 5950 },
    ],
    netCents: 15000,
    taxCents: 2850,
    grossCents: 17850,
    ...overrides,
  };
}

describe("F8-21 Accounting-Sync Neutral-Payload (F821-CT-01)", () => {
  it("pinnt Version + exaktes v1-Format", () => {
    expect(ACCOUNTING_EXPORT_VERSION).toBe("accounting-export.v1");
    expect(ACCOUNTING_CANONICALIZATION_VERSION).toBe("accounting-jcs.v1");
    const payload = buildAccountingExportPayload(doc());
    expect(accountingExportPayloadV1Schema.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({
      schemaVersion: "accounting-export.v1",
      canonicalizationVersion: "accounting-jcs.v1",
      kind: "invoice",
      number: "RE-2026-000001",
      issueDate: "2026-11-15",
      contactName: "Muster Kundin",
      currency: "EUR",
      lines: [
        { position: 1, taxRateBps: 1900, zeroRated: false, netCents: 10000, taxCents: 1900, grossCents: 11900 },
        { position: 2, taxRateBps: 1900, zeroRated: false, netCents: 5000, taxCents: 950, grossCents: 5950 },
      ],
      totals: { netCents: 15000, taxCents: 2850, grossCents: 17850 },
    });
  });

  it("verweigert Scope fail-closed (Status, Typ, Währung)", () => {
    expect(() => buildAccountingExportPayload(doc({ status: "draft" }))).toThrowError(AccountingExportError);
    expect(() => buildAccountingExportPayload(doc({ status: "voided" }))).toThrowError(/RE-2026-000001/u);
    expect(() => buildAccountingExportPayload(doc({ kind: "delivery_note" }))).toThrowError(
      /nur invoice\/credit_note/u,
    );
    expect(() => buildAccountingExportPayload(doc({ currency: "USD" }))).toThrowError(/nur EUR/u);
    expect(() => buildAccountingExportPayload(doc({ kind: "credit_note" }))).not.toThrow();
  });

  it("verweigert Belegfehler fail-closed (Nummer, Datum, Steuer, Beträge)", () => {
    expect(() => buildAccountingExportPayload(doc({ number: "   " }))).toThrowError(/Belegnummer/u);
    expect(() => buildAccountingExportPayload(doc({ issueDate: "15.11.2026" }))).toThrowError(
      /RE-2026-000001/u,
    );
    expect(() => buildAccountingExportPayload(doc({
      lines: [{ taxRateBps: 700, netCents: 100, taxCents: 7, grossCents: 107 }],
      netCents: 100, taxCents: 7, grossCents: 107,
    }))).toThrowError(/0-%\/19-%/u);
    expect(() => buildAccountingExportPayload(doc({
      lines: [{ taxRateBps: 1900, netCents: -5, taxCents: 0, grossCents: 0 }],
      netCents: -5, taxCents: 0, grossCents: 0,
    }))).toThrowError(/RE-2026-000001/u);
  });

  it("verweigert krumme Summen mit Belegnennung (Summenkranz)", () => {
    expect(() => buildAccountingExportPayload(doc({
      lines: [{ taxRateBps: 1900, netCents: 10000, taxCents: 1900, grossCents: 11901 }],
      netCents: 10000, taxCents: 1900, grossCents: 11901,
    }))).toThrowError(/Zeilensumme krumm/u);
    expect(() => buildAccountingExportPayload(doc({ netCents: 15001 }))).toThrowError(
      /RE-2026-000001/u,
    );
    expect(() => buildAccountingExportPayload(doc({ grossCents: 17851 }))).toThrowError(
      /Brutto ungleich/u,
    );
  });

  it("erlaubt 0-%-Zeilen explizit markiert (DECIDED)", () => {
    const payload = buildAccountingExportPayload(doc({
      lines: [{ taxRateBps: 0, netCents: 20000, taxCents: 0, grossCents: 20000 }],
      netCents: 20000, taxCents: 0, grossCents: 20000,
    }));
    expect(payload.lines).toEqual([
      { position: 1, taxRateBps: 0, zeroRated: true, netCents: 20000, taxCents: 0, grossCents: 20000 },
    ]);
    const mixed = buildAccountingExportPayload(doc({
      lines: [
        { taxRateBps: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 },
        { taxRateBps: 0, netCents: 3000, taxCents: 0, grossCents: 3000 },
      ],
      netCents: 13000, taxCents: 1900, grossCents: 14900,
    }));
    expect(mixed.lines.map((line) => line.zeroRated)).toEqual([false, true]);
  });

  it("Kopf-only wie F8-11: exakt-19-%-Kopf wird eine Zeile, sonst Fehler", () => {
    const payload = buildAccountingExportPayload(doc({
      lines: [], netCents: 10000, taxCents: 1900, grossCents: 11900,
    }));
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({ taxRateBps: 1900, netCents: 10000 });
    expect(() => buildAccountingExportPayload(doc({
      lines: [], netCents: 10000, taxCents: 1000, grossCents: 11000,
    }))).toThrowError(/RE-2026-000001/u);
    expect(() => buildAccountingExportPayload(doc({
      lines: [], netCents: 0, taxCents: 0, grossCents: 0,
    }))).toThrowError(/kein exakt-19-%-Kopf/u);
  });

  it("kontaktloser Beleg trägt leeren Kontakt, Nummer bleibt Referenz", () => {
    const payload = buildAccountingExportPayload(doc({ contactName: "   " }));
    expect(payload.contactName).toBe("");
    expect(payload.number).toBe("RE-2026-000001");
  });

  it("ist deterministisch (Bau + Seal stabil)", () => {
    const first = buildAccountingExportPayload(doc());
    const second = buildAccountingExportPayload(doc());
    expect(second).toEqual(first);
    expect(hashAccountingExportPayload(second)).toBe(hashAccountingExportPayload(first));
    expect(canonicalizeAccountingJson({ b: 1, a: 2 })).toBe(
      canonicalizeAccountingJson({ a: 2, b: 1 }),
    );
  });

  it("Seal/Drift: stabiler Hash, Drift erkannt, Ungültiges nicht hashbar", () => {
    const payload = buildAccountingExportPayload(doc());
    const hash = hashAccountingExportPayload(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(isAccountingPayloadDrifted(hash, payload)).toBe(false);
    const changed = buildAccountingExportPayload(doc({ number: "RE-2026-000002" }));
    expect(isAccountingPayloadDrifted(hash, changed)).toBe(true);
    // Ungültige Stände sind nicht vergleichbar und verweigern fail-closed.
    const tampered = { ...payload, totals: { ...payload.totals, grossCents: 999 } };
    expect(() => isAccountingPayloadDrifted(hash, tampered)).toThrow(TypeError);
    expect(() => hashAccountingExportPayload(tampered)).toThrow(TypeError);
    expect(() => hashAccountingExportPayload({})).toThrow(TypeError);
  });
});

describe("F8-21 Vendor-Mapper (F821-CT-02)", () => {
  it("kennt genau drei Vendoren", () => {
    expect([...accountingVendors]).toEqual(["lexoffice", "sevdesk", "bexio"]);
  });

  it("lexoffice: Typ, Nummer, Datum, Kontakt, Steuerabbildung 0/19", () => {
    const voucher = toLexofficeVoucher(buildAccountingExportPayload(doc()));
    expect(voucher.voucherType).toBe("salesinvoice");
    expect(voucher.voucherNumber).toBe("RE-2026-000001");
    expect(voucher.voucherDate).toBe("2026-11-15");
    expect(voucher.contactName).toBe("Muster Kundin");
    expect(voucher.lineItems.map((item) => item.taxRatePercent)).toEqual([19, 19]);
    expect(voucher.lineItems[0]?.net).toEqual({ cents: 10000, euros: "100.00" });
    expect(voucher.totalGross).toEqual({ cents: 17850, euros: "178.50" });
    const credit = toLexofficeVoucher(buildAccountingExportPayload(doc({ kind: "credit_note" })));
    expect(credit.voucherType).toBe("salescreditnote");
    const zero = toLexofficeVoucher(buildAccountingExportPayload(doc({
      lines: [{ taxRateBps: 0, netCents: 500, taxCents: 0, grossCents: 500 }],
      netCents: 500, taxCents: 0, grossCents: 500,
    })));
    expect(zero.lineItems[0]?.taxRatePercent).toBe(0);
  });

  it("sevdesk: RE/CN-Typen, Positionen, Betrags-Tupel", () => {
    const voucher = toSevDeskVoucher(buildAccountingExportPayload(doc()));
    expect(voucher.objectName).toBe("Invoice");
    expect(voucher.invoiceType).toBe("RE");
    expect(voucher.invoiceNumber).toBe("RE-2026-000001");
    expect(voucher.positions).toHaveLength(2);
    expect(voucher.positions[1]?.gross).toEqual({ cents: 5950, euros: "59.50" });
    const credit = toSevDeskVoucher(buildAccountingExportPayload(doc({ kind: "credit_note" })));
    expect(credit.invoiceType).toBe("CN");
  });

  it("bexio: Titel aus Belegart + Nummer, Positionen, Summen", () => {
    const entry = toBexioEntry(buildAccountingExportPayload(doc()));
    expect(entry.title).toBe("Rechnung RE-2026-000001");
    expect(entry.documentNumber).toBe("RE-2026-000001");
    expect(entry.positions.map((position) => position.taxRatePercent)).toEqual([19, 19]);
    expect(entry.totalNet).toEqual({ cents: 15000, euros: "150.00" });
    const credit = toBexioEntry(buildAccountingExportPayload(doc({ kind: "credit_note" })));
    expect(credit.title).toBe("Gutschrift RE-2026-000001");
  });

  it("Mapper sind deterministisch und kontakt-tolerant", () => {
    const payload = buildAccountingExportPayload(doc({ contactName: "  " }));
    expect(toLexofficeVoucher(payload)).toEqual(toLexofficeVoucher(payload));
    expect(toSevDeskVoucher(payload).contactName).toBe("");
    expect(toBexioEntry(payload).contactName).toBe("");
    expect(toVendorPayload("lexoffice", payload)).toEqual(toLexofficeVoucher(payload));
    expect(toVendorPayload("sevdesk", payload)).toEqual(toSevDeskVoucher(payload));
    expect(toVendorPayload("bexio", payload)).toEqual(toBexioEntry(payload));
  });

  it("unbekannter Vendor und tamperierte Payload fail-closed", () => {
    const payload = buildAccountingExportPayload(doc());
    expect(() => toVendorPayload("datev", payload)).toThrowError(/unbekannter Vendor/u);
    expect(() => toVendorPayload("", payload)).toThrowError(AccountingExportError);
    expect(() => toLexofficeVoucher({ ...payload, currency: "USD" })).toThrowError(
      /valider Neutral-Payload/u,
    );
    expect(() => toSevDeskVoucher(null)).toThrowError(AccountingExportError);
    expect(() => toBexioEntry({})).toThrowError(AccountingExportError);
  });
});

describe("F8-21 Sync-State-Machine (F821-CT-03)", () => {
  it("erlaubt nur Vorwärts-Übergänge, acknowledged terminal", () => {
    expect(ACCOUNTING_SYNC_TRANSITIONS).toEqual({
      queued: ["exported", "failed"],
      exported: ["acknowledged", "failed"],
      failed: ["queued"],
      acknowledged: [],
    });
    expect(() => assertAccountingSyncTransition("queued", "exported")).not.toThrow();
    expect(() => assertAccountingSyncTransition("queued", "failed")).not.toThrow();
    expect(() => assertAccountingSyncTransition("exported", "acknowledged")).not.toThrow();
    expect(() => assertAccountingSyncTransition("exported", "failed")).not.toThrow();
    expect(() => assertAccountingSyncTransition("failed", "queued")).not.toThrow();
  });

  it("verweigert Sprünge, Rückschritte und terminale Abgänge", () => {
    for (const [from, to] of [
      ["queued", "acknowledged"],
      ["queued", "queued"],
      ["exported", "queued"],
      ["exported", "exported"],
      ["failed", "exported"],
      ["failed", "acknowledged"],
      ["failed", "failed"],
      ["acknowledged", "queued"],
      ["acknowledged", "exported"],
      ["acknowledged", "failed"],
    ] as const) {
      expect(() => assertAccountingSyncTransition(from, to)).toThrowError(
        AccountingSyncTransitionError,
      );
    }
  });
});

describe("F8-21 Fake-Transport (F821-CT-06/07)", () => {
  it("exportiert deterministisch mit fortlaufender external_id", async () => {
    const provider = new FakeAccountingProvider("lexoffice");
    const payload = buildAccountingExportPayload(doc());
    const first = await provider.exportVoucher(payload);
    const second = await provider.exportVoucher(payload);
    expect(first).toEqual({ externalId: "fake-lexoffice-000001", rawStatus: "accepted" });
    expect(second.externalId).toBe("fake-lexoffice-000002");
    expect(provider.sent).toHaveLength(2);
    expect(provider.attempts).toBe(2);
  });

  it("programmierbare Fehler werfen vendor-benannte Provider-Fehler", async () => {
    const provider = new FakeAccountingProvider("bexio");
    const payload = buildAccountingExportPayload(doc());
    provider.failNext("timeout");
    await expect(provider.exportVoucher(payload)).rejects.toThrowError(AccountingProviderError);
    await expect(provider.exportVoucher(payload)).resolves.toMatchObject({
      externalId: "fake-bexio-000001",
    });
    provider.failNext("kaputt");
    await expect(provider.exportVoucher(payload)).rejects.toThrowError(/bexio.*kaputt/u);
    const always = new FakeAccountingProvider("sevdesk");
    always.failAlways("offline");
    await expect(always.exportVoucher(payload)).rejects.toThrowError(/offline/u);
    await expect(always.exportVoucher(payload)).rejects.toThrowError(/offline/u);
    always.recover();
    await expect(always.exportVoucher(payload)).resolves.toMatchObject({
      externalId: "fake-sevdesk-000001",
    });
    expect(always.attempts).toBe(3);
  });

  it("keine Secrets in Payload/Mapper/Provider-Oberfläche (F821-CT-07)", () => {
    const payload = buildAccountingExportPayload(doc());
    const serialized = JSON.stringify({
      payload,
      lexoffice: toLexofficeVoucher(payload),
      sevdesk: toSevDeskVoucher(payload),
      bexio: toBexioEntry(payload),
      providerKeys: Object.getOwnPropertyNames(FakeAccountingProvider.prototype),
    }).toLowerCase();
    for (const secret of ["token", "secret", "password", "credential", "api_key", "apikey", "bearer", "private_key"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
