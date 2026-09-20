import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildMonatsZip,
  buildMonthSummaryCsv,
  MONATS_ZIP_CONTENT_TYPE,
  monatsZipFileName,
  MonatsZipError,
  parseMonatsZip,
  type MonthSummaryRowInput,
} from "@/lib/integrations/invoicing/monats-zip";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  exportMonatsZip,
  INVOICING_MONATS_ZIP_BATCH_VERSION,
  INVOICING_MONATS_ZIP_COMMAND_VERSION,
} from "@/modules/invoicing/month-zip-service";

function row(overrides: Partial<MonthSummaryRowInput> = {}): MonthSummaryRowInput {
  return {
    docId: "11111111-0000-4000-8000-000000000001",
    kind: "invoice",
    number: "RE-2026-000001",
    issueDate: "2026-11-15",
    contactName: "Muster Kundin",
    netCents: 950000,
    taxCents: 180500,
    grossCents: 1130500,
    pdfFile: "RE-2026-000001.pdf",
    pdfSha256: "a".repeat(64),
    ...overrides,
  };
}

function pdfBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${marker}\n${"0".repeat(120)}\n%%EOF\n`, "utf8");
}

describe("F8-20 Monats-ZIP Builder", () => {
  it("F820-U-01: Summary-Header, Spalten, Punkt-Beträge, CRLF", () => {
    const content = buildMonthSummaryCsv([row()]);
    const lines = content.split("\r\n");
    expect(lines[0]).toBe(
      "typ;nummer;ausstellungsdatum;kontakt;netto;steuer;brutto;pdf_datei;pdf_sha256",
    );
    expect(lines[1]).toBe(
      `invoice;RE-2026-000001;2026-11-15;Muster Kundin;9500.00;1805.00;11305.00;RE-2026-000001.pdf;${"a".repeat(64)}`,
    );
    expect(lines[2]).toBe("");
    expect(content.endsWith("\r\n")).toBe(true);
    expect(content).not.toContain("\n\n");
  });

  it("F820-U-02: Gutschrift-Typ und kontaktloser Beleg", () => {
    const content = buildMonthSummaryCsv([
      row({ kind: "credit_note", number: "GU-1", contactName: "", pdfFile: "", pdfSha256: "" }),
    ]);
    expect(content.split("\r\n")[1]).toBe(
      "credit_note;GU-1;2026-11-15;;9500.00;1805.00;11305.00;;",
    );
  });

  it("F820-U-03: Escaping (Trennzeichen, Quotes, Formel-Guard)", () => {
    const content = buildMonthSummaryCsv([
      row({ contactName: 'A"B;C & Sohn', number: "=RE-1", pdfFile: "", pdfSha256: "" }),
    ]);
    const data = content.split("\r\n")[1]!;
    // Führendes Formelzeichen bekommt den Guard, Quotes werden verdoppelt.
    expect(data).toContain("'=RE-1");
    expect(data).toContain('"A""B;C & Sohn"');
  });

  it("F820-U-04: Sortierung Ausstellungsdatum, dann Beleg-ID; Determinismus", () => {
    const late = row({ docId: "b", issueDate: "2026-11-20", number: "RE-2", pdfFile: "", pdfSha256: "" });
    const earlyB = row({ docId: "b", issueDate: "2026-11-01", number: "RE-1b", pdfFile: "", pdfSha256: "" });
    const earlyA = row({ docId: "a", issueDate: "2026-11-01", number: "RE-1a", pdfFile: "", pdfSha256: "" });
    const content = buildMonthSummaryCsv([late, earlyB, earlyA]);
    const numbers = content.split("\r\n").slice(1, 4).map((line) => line.split(";")[1]);
    expect(numbers).toEqual(["RE-1a", "RE-1b", "RE-2"]);
    expect(buildMonthSummaryCsv([late, earlyB, earlyA])).toBe(
      buildMonthSummaryCsv([earlyA, earlyB, late]),
    );
  });

  it("F820-U-05: leere pdf_*-Spalten nur gemeinsam; Reject-Pfade nennen den Beleg", () => {
    expect(() => buildMonthSummaryCsv([
      row({ pdfFile: "RE-2026-000001.pdf", pdfSha256: "" }),
    ])).toThrowError(/11111111-0000-4000-8000-000000000001/u);
    expect(() => buildMonthSummaryCsv([
      row({ kind: "letter" as "invoice" }),
    ])).toThrowError(MonatsZipError);
    expect(() => buildMonthSummaryCsv([row({ issueDate: "15.11.2026" })]))
      .toThrowError(MonatsZipError);
    expect(() => buildMonthSummaryCsv([row({ netCents: -1 })])).toThrowError(MonatsZipError);
    expect(() => buildMonthSummaryCsv([row({ pdfSha256: "kein-hash" })]))
      .toThrowError(MonatsZipError);
    expect(() => buildMonthSummaryCsv([row({ pdfFile: "../x.pdf" })]))
      .toThrowError(MonatsZipError);
    // Keine Steuer-Validierung: krumme Summen stellen aus, was `issued` ist.
    expect(() => buildMonthSummaryCsv([row({ grossCents: 1 })])).not.toThrow();
  });

  it("F820-U-06: ZIP-Layout summary.csv + pdfs/<Nummer>.pdf, Dateiname, MIME", () => {
    const summary = buildMonthSummaryCsv([row()]);
    const pdf = pdfBytes("F820");
    const bytes = buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [{ fileName: "RE-2026-000001.pdf", bytes: pdf }],
    });
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(monatsZipFileName("2026-11")).toBe("monatsunterlagen-2026-11.zip");
    expect(MONATS_ZIP_CONTENT_TYPE).toBe("application/zip");
    const entries = parseMonatsZip(bytes);
    expect(Object.keys(entries).sort()).toEqual([
      "pdfs/RE-2026-000001.pdf",
      "summary.csv",
    ]);
    expect(Buffer.from(entries["summary.csv"]!).toString("utf8")).toBe(summary);
    expect(Buffer.from(entries["pdfs/RE-2026-000001.pdf"]!)).toEqual(pdf);
  });

  it("F820-U-07: ZIP ist byte-deterministisch (feste mtime, stabile Ordnung)", () => {
    const summary = buildMonthSummaryCsv([
      row(),
      row({ docId: "b", number: "RE-2026-000002", pdfFile: "RE-2026-000002.pdf", pdfSha256: "b".repeat(64) }),
    ]);
    const a = pdfBytes("A");
    const b = pdfBytes("B");
    const first = buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [
        { fileName: "RE-2026-000002.pdf", bytes: b },
        { fileName: "RE-2026-000001.pdf", bytes: a },
      ],
    });
    const second = buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [
        { fileName: "RE-2026-000001.pdf", bytes: a },
        { fileName: "RE-2026-000002.pdf", bytes: b },
      ],
    });
    expect(first).toEqual(second);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });

  it("F820-U-08: leerer Monat ist ein gültiger ZIP mit Summary-Header allein", () => {
    const summary = buildMonthSummaryCsv([]);
    expect(summary).toBe(
      "typ;nummer;ausstellungsdatum;kontakt;netto;steuer;brutto;pdf_datei;pdf_sha256\r\n",
    );
    const entries = parseMonatsZip(buildMonatsZip({ month: "2026-11", summary, pdfs: [] }));
    expect(Object.keys(entries)).toEqual(["summary.csv"]);
  });

  it("F820-U-09: Schranken 500 Belege / 64 MB, doppelte und unsichere Namen", () => {
    const many = Array.from({ length: 501 }, (_, index) =>
      row({ docId: `doc-${index}`, pdfFile: "", pdfSha256: "" }));
    expect(() => buildMonthSummaryCsv(many)).toThrowError(MonatsZipError);
    const summary = buildMonthSummaryCsv([]);
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    expect(() => buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [{ fileName: "RE-1.pdf", bytes: big }],
    })).toThrowError(MonatsZipError);
    const pdf = pdfBytes("x");
    expect(() => buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [
        { fileName: "RE-1.pdf", bytes: pdf },
        { fileName: "RE-1.pdf", bytes: pdf },
      ],
    })).toThrowError(MonatsZipError);
    expect(() => buildMonatsZip({
      month: "2026-11",
      summary,
      pdfs: [{ fileName: "pdfs/RE-1.pdf", bytes: pdf }],
    })).toThrowError(MonatsZipError);
    expect(() => buildMonatsZip({ month: "11-2026", summary, pdfs: [] }))
      .toThrowError(MonatsZipError);
    expect(() => monatsZipFileName("11-2026")).toThrowError(MonatsZipError);
  });
});

const WORKSPACE_ID = randomUUID();
const ACTOR_ID = randomUUID();

function serviceCtx(input: Partial<ServiceCtx> = {}): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role: "editor",
    capabilities: { invoicing: true },
    featureFlags: {},
    ...input,
  };
}

function stubTx(documentRows: unknown[], jobRows: unknown[] = []) {
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: documentRows })
    .mockResolvedValue({ rows: jobRows });
  return { tx: { execute } as unknown as TenantTx, execute };
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: "invoice",
    number: "RE-2026-000001",
    issued_date: "2026-11-15",
    contact_name: "Muster Kundin",
    net_cents: 950000,
    tax_cents: 180500,
    gross_cents: 1130500,
    ...overrides,
  };
}

function jobRow(documentId: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    document_id: documentId,
    artifact_mime_type: "application/pdf",
    artifact_sha256_hex: createHash("sha256").update(bytes).digest("hex"),
    artifact_size_bytes: bytes.length,
    artifact_bytes: bytes,
    ...overrides,
  };
}

const COMMAND = {
  schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
  month: "2026-11",
} as const;

describe("F8-20 Monats-ZIP Service (Stub-DB)", () => {
  it("F820-S-01: bündelt Summary + integres PDF, Vertragskennung und Dateiname", async () => {
    const doc = documentRow();
    const pdf = pdfBytes("S-01");
    const { tx } = stubTx([doc], [jobRow(doc.id, pdf)]);

    const batch = await exportMonatsZip(tx, serviceCtx(), { ...COMMAND });

    expect(batch.schemaVersion).toBe(INVOICING_MONATS_ZIP_BATCH_VERSION);
    expect(batch.month).toBe("2026-11");
    expect(batch.fileName).toBe("monatsunterlagen-2026-11.zip");
    expect(batch.contentType).toBe("application/zip");
    expect(batch.documentCount).toBe(1);
    expect(batch.pdfCount).toBe(1);
    const entries = parseMonatsZip(batch.bytes);
    expect(Object.keys(entries).sort()).toEqual(["pdfs/RE-2026-000001.pdf", "summary.csv"]);
    const summary = Buffer.from(entries["summary.csv"]!).toString("utf8");
    expect(summary).toContain("RE-2026-000001");
    expect(summary).toContain(createHash("sha256").update(pdf).digest("hex"));
    expect(Buffer.from(entries["pdfs/RE-2026-000001.pdf"]!)).toEqual(pdf);
  });

  it("F820-S-02: fehlender Job → Zeile mit leeren pdf_*-Spalten statt Abbruch", async () => {
    const { tx } = stubTx([documentRow()], []);

    const batch = await exportMonatsZip(tx, serviceCtx(), { ...COMMAND });

    expect(batch.documentCount).toBe(1);
    expect(batch.pdfCount).toBe(0);
    const entries = parseMonatsZip(batch.bytes);
    expect(Object.keys(entries)).toEqual(["summary.csv"]);
    expect(Buffer.from(entries["summary.csv"]!).toString("utf8")).toContain(
      "invoice;RE-2026-000001;2026-11-15;Muster Kundin;9500.00;1805.00;11305.00;;",
    );
  });

  it("F820-S-03: korrupte Artefakte (Hash/MIME/Größe/Nummer) → leere Spalten, Rest intakt", async () => {
    const good = documentRow({ number: "RE-2026-000009" });
    const goodPdf = pdfBytes("S-03-gut");
    const badHash = documentRow({ number: "RE-2026-000001" });
    const badHashPdf = pdfBytes("S-03-hash");
    const badMime = documentRow({ number: "RE-2026-000002" });
    const badNumber = documentRow({ number: "../etc/passwd" });
    const badNumberPdf = pdfBytes("S-03-nummer");
    const tiny = documentRow({ number: "RE-2026-000003" });
    const { tx } = stubTx(
      [good, badHash, badMime, badNumber, tiny],
      [
        jobRow(good.id, goodPdf),
        jobRow(badHash.id, badHashPdf, { artifact_sha256_hex: "0".repeat(64) }),
        jobRow(badMime.id, pdfBytes("S-03-mime"), { artifact_mime_type: "text/plain" }),
        jobRow(badNumber.id, badNumberPdf),
        jobRow(tiny.id, Buffer.from("%PDF-winzig", "utf8")),
      ],
    );

    const batch = await exportMonatsZip(tx, serviceCtx(), { ...COMMAND });

    expect(batch.documentCount).toBe(5);
    expect(batch.pdfCount).toBe(1);
    const entries = parseMonatsZip(batch.bytes);
    expect(Object.keys(entries).sort()).toEqual(["pdfs/RE-2026-000009.pdf", "summary.csv"]);
    const summary = Buffer.from(entries["summary.csv"]!).toString("utf8");
    for (const number of ["RE-2026-000001", "RE-2026-000002", "RE-2026-000003", "../etc/passwd"]) {
      const line = summary.split("\r\n").find((candidate) => candidate.includes(number));
      expect(line, `Zeile für ${number}`).toBeDefined();
      expect(line!.endsWith(";;")).toBe(true);
    }
  });

  it("F820-S-04: verlangt issuing_details.write (Viewer/ohne Capability → 403-Signal)", async () => {
    const { tx, execute } = stubTx([]);
    await expect(exportMonatsZip(tx, serviceCtx({ role: "viewer" }), { ...COMMAND }))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "invoicing.issuing_details.write" });
    await expect(exportMonatsZip(tx, serviceCtx({ capabilities: {} }), { ...COMMAND }))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "invoicing.issuing_details.write" });
    await expect(exportMonatsZip(tx, serviceCtx({ capabilities: { invoicing: true, external_only: true } }), { ...COMMAND }))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "invoicing.issuing_details.write" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("F820-S-05: ungültiges Kommando und leere Monate", async () => {
    const { tx } = stubTx([]);
    await expect(exportMonatsZip(tx, serviceCtx(), { ...COMMAND, month: "11-2026" }))
      .rejects.toMatchObject({ name: "InvoicingValidationError" });
    await expect(exportMonatsZip(tx, serviceCtx(), { ...COMMAND, schemaVersion: "falsch" as typeof COMMAND.schemaVersion }))
      .rejects.toMatchObject({ name: "InvoicingValidationError" });

    const empty = await exportMonatsZip(stubTx([]).tx, serviceCtx(), { ...COMMAND });
    expect(empty.documentCount).toBe(0);
    expect(empty.pdfCount).toBe(0);
    expect(Object.keys(parseMonatsZip(empty.bytes))).toEqual(["summary.csv"]);
  });

  it("F820-S-06: mehr als 500 Belege → Validierungsfehler (ehrliche Schranke)", async () => {
    const docs = Array.from({ length: 501 }, (_, index) =>
      documentRow({ id: randomUUID(), number: `RE-2026-${String(index).padStart(6, "0")}` }));
    await expect(exportMonatsZip(stubTx(docs).tx, serviceCtx(), { ...COMMAND }))
      .rejects.toMatchObject({ name: "InvoicingValidationError" });
  });
});
