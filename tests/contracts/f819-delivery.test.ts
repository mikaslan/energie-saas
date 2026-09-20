import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
  DELIVERY_CHANNELS,
  getDocumentDelivery,
  markSentWithDelivery,
} from "@/modules/invoicing/delivery-service";
import {
  InvoicingConflictError,
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "@/modules/invoicing/errors";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_JOB_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_JOB_ID = "55555555-5555-4555-8555-555555555555";
const INVOICE_SHA = "ab".repeat(32);
const PAYMENT_SHA = "cd".repeat(32);
const SENT_AT = "2026-09-19T10:00:00.000Z";

type ExecuteResponse = { rows: unknown[] } | Error;
type InsertValue = Record<string, unknown>;

function context(
  role: ServiceCtx["role"] = "admin",
  capabilities: ServiceCtx["capabilities"] = {},
): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities,
    featureFlags: {},
  };
}

const editor = () => context("editor", { invoicing: true });

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const inserts: InsertValue[] = [];
  const queries: unknown[] = [];
  const execute = vi.fn(async (query: unknown) => {
    queries.push(query);
    const response = responses[index++] ?? { rows: [] };
    if (response instanceof Error) throw response;
    return response;
  });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: InsertValue) => { inserts.push(entry); },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts, queries };
}

function sqlText(query: unknown): string {
  return JSON.stringify(query).toLowerCase();
}

function uniqueViolation(): Error {
  return new Error("duplicate key value", { cause: { code: "23505" } });
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
    documentId: DOCUMENT_ID,
    channel: "manual",
    ...overrides,
  } as Parameters<typeof markSentWithDelivery>[2];
}

function issuedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      id: DOCUMENT_ID,
      type: "invoice",
      status: "issued",
      sent_at: null,
      gross_cents: 119_000,
      paid_cents: 0,
      ...overrides,
    }],
  };
}

function invoiceJob(overrides: Record<string, unknown> = {}) {
  return { rows: [{ id: INVOICE_JOB_ID, artifact_sha256_hex: INVOICE_SHA, ...overrides }] };
}

function paymentJob(overrides: Record<string, unknown> = {}) {
  return { rows: [{ id: PAYMENT_JOB_ID, artifact_sha256_hex: PAYMENT_SHA, ...overrides }] };
}

function sentUpdate() {
  return { rows: [{ sent_at: new Date(SENT_AT) }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("F8-19 delivery command contract", () => {
  it("F819-CT-01: Kommando-Version und Kanal sind gepinnt (v1 nur manual)", () => {
    expect(COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION)
      .toBe("commercial-document-delivery-command.v1");
    expect([...DELIVERY_CHANNELS]).toEqual(["manual"]);
  });

  it.each([
    ["falsche Schema-Version", { schemaVersion: "commercial-document-sent-command.v1" }],
    ["Extra-Feld", { templateVersion: "attacker-choice" }],
    ["fehlender Kanal", { channel: undefined }],
    ["reservierter Kanal email", { channel: "email" }],
    ["reservierter Kanal post", { channel: "post" }],
    ["ungueltige Document-ID", { documentId: "kein-uuid" }],
  ])("F819-CT-01: striktes Kommando weist %s ohne DB-Zugriff ab", async (_label, overrides) => {
    const stub = transaction([]);
    await expect(markSentWithDelivery(stub.tx, editor(), command(overrides)))
      .rejects.toBeInstanceOf(InvoicingValidationError);
    expect(stub.execute).not.toHaveBeenCalled();
  });

  it("F819-CT-01: Viewer, Unberechtigte und Externe scheitern fail-closed ohne DB-Zugriff", async () => {
    for (const ctx of [
      context("viewer", { invoicing: true }),
      context("editor", {}),
      context("editor", { invoicing: true, external_only: true }),
    ]) {
      const stub = transaction([]);
      await expect(markSentWithDelivery(stub.tx, ctx, command()))
        .rejects.toBeInstanceOf(PermissionDeniedError);
      expect(stub.execute).not.toHaveBeenCalled();
    }
  });
});

describe("F8-19 delivery gating (F819-CT-01)", () => {
  it("F819-CT-01: nur issued + sent_at NULL + succeeded-Invoice-Job; sonst not_found/conflict", async () => {
    // Unbekanntes Dokument → not_found.
    const missing = transaction([{ rows: [] }]);
    await expect(markSentWithDelivery(missing.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingNotFoundError);

    // Entwurf, Storno, bereits versendet → conflict.
    for (const overrides of [
      { status: "draft" },
      { status: "voided" },
      { sent_at: new Date(SENT_AT) },
    ]) {
      const stub = transaction([issuedInvoice(overrides)]);
      await expect(markSentWithDelivery(stub.tx, editor(), command()))
        .rejects.toBeInstanceOf(InvoicingConflictError);
      expect(stub.execute).toHaveBeenCalledTimes(1);
    }

    // Ausgestellt, aber kein succeeded-Invoice-Job → conflict (kein
    // Versand ohne unveraenderliche Bytes).
    const noJob = transaction([issuedInvoice(), { rows: [] }]);
    await expect(markSentWithDelivery(noJob.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingConflictError);
    expect(noJob.execute).toHaveBeenCalledTimes(2);
  });

  it("F819-CT-01: korrupte Job-/Gelddaten sind unavailable statt still", async () => {
    const badSha = transaction([issuedInvoice(), invoiceJob({ artifact_sha256_hex: "zz" })]);
    await expect(markSentWithDelivery(badSha.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingIntegrityError);

    const badMoney = transaction([issuedInvoice({ paid_cents: "kein-geld" }), invoiceJob()]);
    await expect(markSentWithDelivery(badMoney.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingIntegrityError);
  });

  it("F819-CT-01: bigint-Geld als String wird koerziert, Race beim Sent-Gate ist conflict", async () => {
    // Paralleler Versandversuch: Update trifft keine Zeile mehr → conflict,
    // kein Delivery-Insert.
    const race = transaction([
      issuedInvoice({ gross_cents: "119000", paid_cents: "0" }),
      invoiceJob(),
      { rows: [] },
      { rows: [] },
    ]);
    await expect(markSentWithDelivery(race.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingConflictError);
    expect(race.execute).toHaveBeenCalledTimes(4);
    expect(race.inserts).toHaveLength(0);
  });
});

describe("F8-19 delivery record (F819-CT-02)", () => {
  function successStub() {
    return transaction([
      issuedInvoice(),
      invoiceJob(),
      paymentJob(),
      sentUpdate(),
      { rows: [] },
    ]);
  }

  it("F819-CT-02: versendet issued→sent, schreibt append-only Delivery-Zeile und belegt Jobs + SHAs", async () => {
    const stub = successStub();
    const result = await markSentWithDelivery(stub.tx, editor(), command());

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      type: "invoice",
      channel: "manual",
      sentAt: SENT_AT,
      invoiceJobId: INVOICE_JOB_ID,
      invoiceArtifactSha256: INVOICE_SHA,
      paymentJobId: PAYMENT_JOB_ID,
      paymentArtifactSha256: PAYMENT_SHA,
    });

    const texts = stub.queries.map(sqlText);
    // Sent-Gate: atomares Update nur auf issued + sent_at NULL, Status
    // bleibt `issued` (boolesche Achse).
    const update = texts.find((text) => text.includes("update")
      && text.includes("commercial_document")
      && !text.includes("commercial_document_delivery")
      && !text.includes("commercial_document_render_job"));
    expect(update).toContain("sent_at");
    expect(update).toContain("status = 'issued'");
    expect(update).toContain("sent_at is null");

    // Delivery-Insert mit Kanal manual; kein Update-Pfad (append-only).
    const deliveryQueries = texts.filter((text) => text.includes("commercial_document_delivery"));
    expect(deliveryQueries).toHaveLength(1);
    expect(deliveryQueries[0]).toContain("insert");
    expect(deliveryQueries[0]).toContain("manual");
    expect(texts.some((text) => text.includes("update")
      && text.includes("commercial_document_delivery"))).toBe(false);
  });

  it("F819-CT-02: parallele Delivery-Inserts (UNIQUE) sind conflict", async () => {
    const stub = transaction([
      issuedInvoice(),
      invoiceJob(),
      paymentJob(),
      sentUpdate(),
      uniqueViolation(),
    ]);
    await expect(markSentWithDelivery(stub.tx, editor(), command()))
      .rejects.toBeInstanceOf(InvoicingConflictError);
    expect(stub.inserts).toHaveLength(0);
  });

  it("F819-CT-04: Event commercial_document.sent + Audit document.send tragen Job-/SHA-Nachweis", async () => {
    const stub = successStub();
    await markSentWithDelivery(stub.tx, editor(), command());

    const evidence = {
      documentId: DOCUMENT_ID,
      channel: "manual",
      invoiceJobId: INVOICE_JOB_ID,
      paymentJobId: PAYMENT_JOB_ID,
      invoiceArtifactSha256: INVOICE_SHA,
      paymentArtifactSha256: PAYMENT_SHA,
    };
    expect(stub.inserts).toHaveLength(2);
    expect(stub.inserts[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      aggregateType: "commercial_document",
      aggregateId: DOCUMENT_ID,
      eventType: "commercial_document.sent",
      actor: ACTOR_ID,
      payload: evidence,
    });
    expect(stub.inserts[1]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actor: ACTOR_ID,
      action: "document.send",
      resource: "commercial_document",
      allowed: true,
      details: evidence,
    });
  });
});

describe("F8-19 payment reference (F819-CT-03)", () => {
  it("F819-CT-03: offener Rest > 0 ohne vorhandenen Beleg → Rechnung-ohne-Beleg", async () => {
    const stub = transaction([
      issuedInvoice(),
      invoiceJob(),
      { rows: [] },
      sentUpdate(),
      { rows: [] },
    ]);
    const result = await markSentWithDelivery(stub.tx, editor(), command());
    expect(result.paymentJobId).toBeNull();
    expect(result.paymentArtifactSha256).toBeNull();
    expect(stub.inserts[0]).toMatchObject({
      payload: expect.objectContaining({ paymentJobId: null, paymentArtifactSha256: null }),
    });
  });

  it("F819-CT-03: ausgeglichene Rechnung referenziert keinen Beleg (kein Lookup)", async () => {
    const stub = transaction([
      issuedInvoice({ gross_cents: 119_000, paid_cents: 119_000 }),
      invoiceJob(),
      sentUpdate(),
      { rows: [] },
    ]);
    const result = await markSentWithDelivery(stub.tx, editor(), command());
    expect(result.paymentJobId).toBeNull();
    // Dokument, Invoice-Job, Sent-Update, Delivery-Insert — kein Payment-Lookup.
    expect(stub.execute).toHaveBeenCalledTimes(4);
  });

  it("F819-CT-03: Gutschrift referenziert nie einen Zahlungsbeleg", async () => {
    const stub = transaction([
      issuedInvoice({ type: "credit_note" }),
      invoiceJob(),
      sentUpdate(),
      { rows: [] },
    ]);
    const result = await markSentWithDelivery(stub.tx, editor(), command());
    expect(result.type).toBe("credit_note");
    expect(result.paymentJobId).toBeNull();
    expect(stub.execute).toHaveBeenCalledTimes(4);
  });
});

describe("F8-19 getDocumentDelivery", () => {
  const key = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID };

  function deliveryRow(overrides: Record<string, unknown> = {}) {
    return {
      rows: [{
        document_id: DOCUMENT_ID,
        channel: "manual",
        sent_at: new Date(SENT_AT),
        sent_by: ACTOR_ID,
        invoice_job_id: INVOICE_JOB_ID,
        invoice_sha: INVOICE_SHA,
        payment_job_id: PAYMENT_JOB_ID,
        payment_sha: PAYMENT_SHA,
        ...overrides,
      }],
    };
  }

  it("F819-CT-02: liefert den Nachweis oder null, 404 ohne Orakel", async () => {
    const found = transaction([{ rows: [{ id: DOCUMENT_ID }] }, deliveryRow()]);
    await expect(getDocumentDelivery(found.tx, editor(), key)).resolves.toEqual({
      documentId: DOCUMENT_ID,
      channel: "manual",
      sentAt: SENT_AT,
      sentBy: ACTOR_ID,
      invoiceJobId: INVOICE_JOB_ID,
      invoiceArtifactSha256: INVOICE_SHA,
      paymentJobId: PAYMENT_JOB_ID,
      paymentArtifactSha256: PAYMENT_SHA,
    });

    const none = transaction([{ rows: [{ id: DOCUMENT_ID }] }, { rows: [] }]);
    await expect(getDocumentDelivery(none.tx, editor(), key)).resolves.toBeNull();

    const missing = transaction([{ rows: [] }]);
    await expect(getDocumentDelivery(missing.tx, editor(), key))
      .rejects.toBeInstanceOf(InvoicingNotFoundError);

    const foreign = transaction([]);
    await expect(getDocumentDelivery(
      foreign.tx,
      editor(),
      { workspaceId: ACTOR_ID, documentId: DOCUMENT_ID },
    )).rejects.toBeInstanceOf(InvoicingNotFoundError);
    expect(foreign.execute).not.toHaveBeenCalled();
  });

  it("F819-CT-02: Viewer/External fail-closed, Schluessel strikt", async () => {
    for (const ctx of [
      context("viewer", { invoicing: true }),
      context("editor", { invoicing: true, external_only: true }),
    ]) {
      const stub = transaction([]);
      await expect(getDocumentDelivery(stub.tx, ctx, key))
        .rejects.toBeInstanceOf(PermissionDeniedError);
      expect(stub.execute).not.toHaveBeenCalled();
    }
    for (const bad of [{}, { workspaceId: "x", documentId: DOCUMENT_ID }, null]) {
      const stub = transaction([]);
      await expect(getDocumentDelivery(stub.tx, editor(), bad))
        .rejects.toBeInstanceOf(InvoicingValidationError);
      expect(stub.execute).not.toHaveBeenCalled();
    }
  });

  it("F819-CT-02: korrupte Nachweis-Zeilen sind unavailable", async () => {
    for (const overrides of [
      { channel: "email" },
      { invoice_sha: "zz" },
      { payment_job_id: PAYMENT_JOB_ID, payment_sha: null },
      { sent_by: "kein-uuid" },
    ]) {
      const stub = transaction([{ rows: [{ id: DOCUMENT_ID }] }, deliveryRow(overrides)]);
      await expect(getDocumentDelivery(stub.tx, editor(), key))
        .rejects.toBeInstanceOf(InvoicingIntegrityError);
    }
  });
});
