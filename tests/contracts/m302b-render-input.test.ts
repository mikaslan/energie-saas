import { describe, expect, it } from "vitest";
import {
  buildInvoicePdfInput,
  canonicalizeInvoiceJson,
  hashInvoicePdfInput,
  INVOICE_PDF_INPUT_VERSION,
  invoicePdfInputV1Schema,
  validateInvoicePdfInput,
} from "@/lib/integrations/invoicing/pdf-contract";

const RECIPIENT = {
  displayName: "Muster GmbH",
  street: "Musterstrasse",
  houseNumber: "12a",
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
};

const SENDER = {
  companyName: "Energie Saas AG",
  companyEmail: "rechnung@beispiel.de",
  companyAuthority: null,
  companyRegisterNumber: null,
  companyTaxId: "DE123456789",
  companyAddressLine1: "Werftstrasse 1",
  companyAddressLine2: null,
  companyPostalCode: "20457",
  companyCity: "Hamburg",
  companyCountry: "DE",
  paymentAccountHolder: "Energie Saas AG",
  paymentIban: "DE75512108001245126199",
  paymentBic: "BELADEBEXXX",
  settingsRevision: 3,
};

const DOCUMENT = {
  type: "invoice",
  invoiceKind: "schlussrechnung",
  creditNoteType: null,
  number: "RE-2026-000001",
  numberYear: 2026,
  numberSequence: 1,
  issuedAt: "2026-09-10T08:00:00Z",
  dueDate: "2026-09-24",
  serviceDate: "2026-09-01",
  skontoPercentBps: 200,
  skontoDays: 14,
};

const LINES = [
  {
    position: 1,
    title: "PV-Module",
    quantityMilli: 10_000,
    unit: "piece",
    netCents: 100_000,
    taxCents: 19_000,
    grossCents: 119_000,
    taxRateBps: 1900,
  },
];

function validOptions() {
  return {
    document: { ...DOCUMENT },
    recipient: { ...RECIPIENT },
    sender: { ...SENDER },
    lines: LINES.map((line) => ({ ...line })),
    headTotals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
    preparedAt: "2026-09-17T10:00:00Z",
  };
}

describe("M302B-CT-05/06: Render-Input-Vertrag (rein)", () => {
  it("M302B-CT-05a: baut einen strikt erlaubten Input ohne Leak-Felder", () => {
    const built = buildInvoicePdfInput(validOptions());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const raw = built.value as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(INVOICE_PDF_INPUT_VERSION);
    // Allowlist auf oberster Ebene.
    expect(Object.keys(raw).sort()).toEqual(
      [
        "canonicalizationVersion",
        "document",
        "lines",
        "preparedAt",
        "recipient",
        "rendererRecipeVersion",
        "schemaVersion",
        "sender",
        "templateVersion",
        "totals",
      ].sort(),
    );
    // Keine Leak-Felder nirgends im serialisierten Input.
    const serialized = JSON.stringify(raw);
    for (const leak of [
      "contactId",
      "workspaceId",
      "documentId",
      "projectId",
      "paidCents",
      "paymentStatus",
      "createdBy",
      "issuedBy",
      "actor",
      "audit",
      "eventId",
      "accountingMethod",
      "goebdRetentionDefaultDays",
      "margin",
      "catalog",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("M302B-CT-05b: striktes Schema weist unbekannte Felder zurueck", () => {
    const polluted = {
      ...validOptions(),
      extraField: "leak",
    };
    const built = buildInvoicePdfInput(polluted as never);
    expect(built.ok).toBe(false);
  });

  it("M302B-CT-06a: Aufbau ist deterministisch (Byte-identisch)", () => {
    const first = buildInvoicePdfInput(validOptions());
    const second = buildInvoicePdfInput(validOptions());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(hashInvoicePdfInput(first.value)).toBe(hashInvoicePdfInput(second.value));
    expect(hashInvoicePdfInput(first.value)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("M302B-CT-06b: jede Input-Mutation aendert den Hash", () => {
    const base = buildInvoicePdfInput(validOptions());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const mutated = buildInvoicePdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, netCents: line.netCents + 1 })),
    });
    // Summenbruch ist bereits ein Build-Fehler (M302B-CT-03);
    // ein gueltiger anderer Input muss anders hashen.
    const other = buildInvoicePdfInput({
      ...validOptions(),
      preparedAt: "2026-09-17T10:00:01Z",
    });
    expect(mutated.ok).toBe(false);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(hashInvoicePdfInput(other.value)).not.toBe(hashInvoicePdfInput(base.value));
  });

  it("M302B-CT-03a: Summenbruch Zeile (gross != net + tax) scheitert", () => {
    const broken = buildInvoicePdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, grossCents: line.grossCents + 1 })),
    });
    expect(broken.ok).toBe(false);
  });

  it("M302B-CT-03b: Summenbruch Kopf (Sigma Zeilen != Kopf) scheitert", () => {
    const broken = buildInvoicePdfInput({
      ...validOptions(),
      lines: [
        ...LINES.map((line) => ({ ...line })),
        {
          position: 2,
          title: "Montage",
          quantityMilli: 1_000,
          unit: "set",
          netCents: 50_000,
          taxCents: 9_500,
          grossCents: 59_500,
          taxRateBps: 1900,
        },
      ],
      // Kopf bleibt implizit Ein-Zeilen-Summe: Builder muss Head-Totals aus
      // uebergebenen Kopfwerten pruefen, nicht nachrechnen.
      headTotals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
    } as never);
    expect(broken.ok).toBe(false);
  });

  it("M302B-CT-03c: lueckenhafte/unsortierte Positionen scheitern", () => {
    const gap = buildInvoicePdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, position: 2 })),
    });
    expect(gap.ok).toBe(false);
  });

  it("M302B-CT-02a: Brief-Typ wird zurueckgewiesen", () => {
    const letter = buildInvoicePdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, type: "letter", invoiceKind: null },
    } as never);
    expect(letter.ok).toBe(false);
  });

  it("M302B-CT-02b: ungueltiger Empfaenger-Snapshot wird zurueckgewiesen", () => {
    const badRecipient = buildInvoicePdfInput({
      ...validOptions(),
      recipient: { ...RECIPIENT, displayName: "   " },
    });
    expect(badRecipient.ok).toBe(false);
  });

  it("M302B-CT-06c: validate akzeptiert nur kanonisch valide Inputs", () => {
    const built = buildInvoicePdfInput(validOptions());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateInvoicePdfInput(built.value).ok).toBe(true);
    expect(validateInvoicePdfInput({}).ok).toBe(false);
    expect(validateInvoicePdfInput(null).ok).toBe(false);
    const parsed = invoicePdfInputV1Schema.safeParse(built.value);
    expect(parsed.success).toBe(true);
  });

  it("M302B-CT-05c: Fremdschluessel in jedem Block scheitern (nested strikt)", () => {
    const base = validOptions();
    const variants = [
      { ...base, document: { ...DOCUMENT, foo: 1 } },
      { ...base, recipient: { ...RECIPIENT, contactId: "x" } },
      { ...base, sender: { ...SENDER, accountingMethod: "accrual" } },
      {
        ...base,
        lines: [{ ...LINES[0], margin: 5 }],
      },
    ] as never[];
    for (const options of variants) {
      expect(buildInvoicePdfInput(options).ok).toBe(false);
    }
    // Totals-Block: Fremdschluessel via validate (Builder nimmt headTotals).
    const built = buildInvoicePdfInput(base);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const polluted = {
      ...built.value,
      totals: { ...built.value.totals, extra: 1 },
    };
    expect(validateInvoicePdfInput(polluted).ok).toBe(false);
  });

  it("M302B-CT-03d: falscher Steuersatz scheitert, 0 % gelingt", () => {
    const badRate = buildInvoicePdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, taxRateBps: 700 })),
    });
    expect(badRate.ok).toBe(false);
    const zeroRate = buildInvoicePdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({
        ...line,
        taxCents: 0,
        grossCents: line.netCents,
        taxRateBps: 0,
      })),
      headTotals: { netCents: 100_000, taxCents: 0, grossCents: 100_000 },
    });
    expect(zeroRate.ok).toBe(true);
  });

  it("M302B-CT-06d: NFD vs NFC hashen identisch (Kanonisierung)", () => {
    const nfc = buildInvoicePdfInput({
      ...validOptions(),
      recipient: { ...RECIPIENT, displayName: "Müller GmbH" },
    });
    const nfd = buildInvoicePdfInput({
      ...validOptions(),
      recipient: { ...RECIPIENT, displayName: "Mu\u0308ller GmbH" },
    });
    expect(nfc.ok).toBe(true);
    expect(nfd.ok).toBe(true);
    if (!nfc.ok || !nfd.ok) return;
    expect(hashInvoicePdfInput(nfd.value)).toBe(hashInvoicePdfInput(nfc.value));
  });

  it("M302B-CT-06e: Kanonisierung sortiert Schluessel, wirft bei Zyklus/Kollision/Unsicher", () => {
    expect(canonicalizeInvoiceJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeInvoiceJson({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalizeInvoiceJson({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalizeInvoiceJson({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(() => canonicalizeInvoiceJson({ x: 1.5 })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeInvoiceJson(cyclic)).toThrow(TypeError);
    expect(() => canonicalizeInvoiceJson({ "\u00e9": 1, "e\u0301": 2 })).toThrow(TypeError);
  });

  it("M302B-CT-05d: leere Optionals koerzieren zu null (M3-02a-Semantik)", () => {
    const built = buildInvoicePdfInput({
      ...validOptions(),
      recipient: { ...RECIPIENT, street: "   " },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.recipient.street).toBeNull();
  });

  it("M302B-CT-05e: eigener Optional-Pfad koerziert (Sender, nicht nur Snapshot)", () => {
    const built = buildInvoicePdfInput({
      ...validOptions(),
      sender: { ...SENDER, companyAuthority: "   " },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.sender.companyAuthority).toBeNull();
  });

  it("M302B-CT-06f: Kanonisierer normalisiert NFD direkt (ohne Schema)", () => {
    expect(canonicalizeInvoiceJson({ name: "Mu\u0308ller" })).toBe(
      canonicalizeInvoiceJson({ name: "M\u00fcller" }),
    );
  });

  it("M302B-CT-02c: Art-/Typ-Kreuzung scheitert (Refinement)", () => {
    const invoiceWithCreditType = buildInvoicePdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, creditNoteType: "minderleistung" },
    });
    expect(invoiceWithCreditType.ok).toBe(false);
    const creditWithKind = buildInvoicePdfInput({
      ...validOptions(),
      document: {
        ...DOCUMENT,
        type: "credit_note",
        invoiceKind: "schlussrechnung",
        creditNoteType: null,
      },
    } as never);
    expect(creditWithKind.ok).toBe(false);
  });

  it("M302B-DECIDED: keine Neu-Ablehnung von Bestandsbelegen", () => {
    // Skonto-Halbpaar, fehlende Faelligkeit, typ-lose Gutschrift:
    // M3-01-Gates werden am Render-Input bewusst NICHT erneut erzwungen.
    const halfSkonto = buildInvoicePdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, skontoPercentBps: 200, skontoDays: null },
    });
    expect(halfSkonto.ok).toBe(true);
    const noDue = buildInvoicePdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, dueDate: null },
    });
    expect(noDue.ok).toBe(true);
    const typelessCredit = buildInvoicePdfInput({
      ...validOptions(),
      document: {
        ...DOCUMENT,
        type: "credit_note",
        invoiceKind: null,
        creditNoteType: null,
      },
    } as never);
    expect(typelessCredit.ok).toBe(true);
  });
});
