import { describe, expect, it } from "vitest";
import {
  buildDraftPdfInput,
  canonicalizeInvoiceJson,
  DRAFT_PDF_INPUT_VERSION,
  DRAFT_PDF_RENDERER_RECIPE_VERSION,
  DRAFT_PDF_TEMPLATE_VERSION,
  draftPdfInputV1Schema,
  hashDraftPdfInput,
  validateDraftPdfInput,
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
  paymentAccountHolder: null,
  paymentIban: null,
  paymentBic: null,
  settingsRevision: 3,
};

const DOCUMENT = {
  type: "invoice",
  name: "F824C-Draft",
  invoiceKind: "schlussrechnung",
  creditNoteType: null,
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

describe("F824C-CT-01: Draft-Render-Input-Vertrag (rein)", () => {
  it("F824C-CT-01a: Template-Paar ist gepinnt (drittes Render-Paar)", () => {
    expect(DRAFT_PDF_INPUT_VERSION).toBe("draft-pdf-input.v1");
    expect(DRAFT_PDF_TEMPLATE_VERSION).toBe("draft-pdf-template.v1");
    expect(DRAFT_PDF_RENDERER_RECIPE_VERSION).toBe("draft-pdf-renderer-recipe.v1");
  });

  it("F824C-CT-01b: baut strikt erlaubten Input ohne Leak-Felder", () => {
    const built = buildDraftPdfInput(validOptions());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const raw = built.value as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(DRAFT_PDF_INPUT_VERSION);
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
      "issuedAt",
      "numberYear",
      "numberSequence",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("F824C-CT-01c: striktes Schema weist unbekannte Felder zurueck", () => {
    const polluted = { ...validOptions(), extraField: "leak" };
    expect(buildDraftPdfInput(polluted as never).ok).toBe(false);
    const built = buildDraftPdfInput(validOptions());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateDraftPdfInput({ ...built.value, totals: { ...built.value.totals, extra: 1 } }).ok).toBe(false);
  });

  it("F824C-CT-01d: Letter-Typ fail-closed, nur invoice/credit_note", () => {
    const letter = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, type: "letter", invoiceKind: null },
    } as never);
    expect(letter.ok).toBe(false);
    const credit = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, type: "credit_note", invoiceKind: null, creditNoteType: "minderleistung" },
    } as never);
    expect(credit.ok).toBe(true);
  });

  it("F824C-CT-01e: Draft-Luecken erlaubt — null-Empfaenger, leere Zeilen, null-Daten", () => {
    const gaps = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, dueDate: null, serviceDate: null, skontoPercentBps: null, skontoDays: null },
      recipient: null,
      lines: [],
      headTotals: { netCents: 0, taxCents: 0, grossCents: 0 },
    });
    expect(gaps.ok).toBe(true);
  });

  it("F824C-CT-01f: Summenbruch (Zeile/Kopf) und Positionsluecken scheitern", () => {
    const brokenLine = buildDraftPdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, grossCents: line.grossCents + 1 })),
    });
    expect(brokenLine.ok).toBe(false);
    const brokenHead = buildDraftPdfInput({
      ...validOptions(),
      headTotals: { netCents: 1, taxCents: 19_000, grossCents: 119_000 },
    });
    expect(brokenHead.ok).toBe(false);
    const gap = buildDraftPdfInput({
      ...validOptions(),
      lines: LINES.map((line) => ({ ...line, position: 2 })),
    });
    expect(gap.ok).toBe(false);
  });

  it("F824C-CT-01g: Art-/Typ-Kreuzung scheitert (Refinement wie Invoice)", () => {
    const invoiceWithCreditType = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, creditNoteType: "minderleistung" },
    });
    expect(invoiceWithCreditType.ok).toBe(false);
    const creditWithKind = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, type: "credit_note", creditNoteType: null },
    } as never);
    expect(creditWithKind.ok).toBe(false);
  });

  it("F824C-CT-01h: Aufbau ist deterministisch, Hash stabil und Mutation-sensitiv", () => {
    const first = buildDraftPdfInput(validOptions());
    const second = buildDraftPdfInput(validOptions());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(hashDraftPdfInput(first.value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashDraftPdfInput(second.value)).toBe(hashDraftPdfInput(first.value));
    const other = buildDraftPdfInput({ ...validOptions(), preparedAt: "2026-09-17T10:00:01Z" });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(hashDraftPdfInput(other.value)).not.toBe(hashDraftPdfInput(first.value));
  });

  it("F824C-CT-01i: NFD vs NFC hashen identisch (Kanonisierung)", () => {
    const nfc = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, name: "Müller-Entwurf" },
    });
    const nfd = buildDraftPdfInput({
      ...validOptions(),
      document: { ...DOCUMENT, name: "Mu\u0308ller-Entwurf" },
    });
    expect(nfc.ok).toBe(true);
    expect(nfd.ok).toBe(true);
    if (!nfc.ok || !nfd.ok) return;
    expect(hashDraftPdfInput(nfd.value)).toBe(hashDraftPdfInput(nfc.value));
    expect(canonicalizeInvoiceJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("F824C-CT-01j: validate akzeptiert nur kanonisch valide Inputs", () => {
    const built = buildDraftPdfInput(validOptions());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateDraftPdfInput(built.value).ok).toBe(true);
    expect(validateDraftPdfInput({}).ok).toBe(false);
    expect(validateDraftPdfInput(null).ok).toBe(false);
    expect(draftPdfInputV1Schema.safeParse(built.value).success).toBe(true);
  });
});
