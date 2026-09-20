import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import {
  INVOICE_PDF_INPUT_VERSION,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
  hashInvoicePdfInput,
  invoicePdfInputV1Schema,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  INVOICE_PDF_LEASE_MS,
  INVOICE_PDF_MAX_ATTEMPTS,
  InvoicePdfWorkerError,
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderFailure,
  finalizeInvoicePdfRenderSuccess,
} from "@/worker/invoice-pdf-database";
import {
  createInvoicePdfRenderHandler,
  parseInvoicePdfDispatchPayload,
  type InvoicePdfClaim,
} from "@/worker/invoice-pdf";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_TOKEN = "77777777-7777-4777-8777-777777777777";
const DB_NOW = "2026-09-17T12:00:00.000Z";

function inputFixture() {
  return invoicePdfInputV1Schema.parse({
    schemaVersion: INVOICE_PDF_INPUT_VERSION,
    canonicalizationVersion: "invoice-pdf-jcs.v1",
    templateVersion: INVOICE_PDF_TEMPLATE_VERSION,
    rendererRecipeVersion: INVOICE_PDF_RENDERER_RECIPE_VERSION,
    preparedAt: "2026-09-17T10:00:00.000Z",
    document: {
      type: "invoice",
      invoiceKind: "schlussrechnung",
      creditNoteType: null,
      number: "RE-2026-000001",
      numberYear: 2026,
      numberSequence: 1,
      issuedAt: "2026-09-10T08:00:00.000Z",
      dueDate: "2026-09-24",
      serviceDate: "2026-09-01",
      skontoPercentBps: 200,
      skontoDays: 14,
    },
    recipient: {
      displayName: "Mia Muster",
      street: "Musterstrasse",
      houseNumber: "12a",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    sender: {
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
    },
    lines: [{
      position: 1,
      title: "PV-Module",
      quantityMilli: 10_000,
      unit: "piece",
      netCents: 100_000,
      taxCents: 19_000,
      grossCents: 119_000,
      taxRateBps: 1900,
    }],
    totals: { netCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
  });
}

function row(overrides: Record<string, unknown> = {}) {
  const input = inputFixture();
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    document_id: DOCUMENT_ID,
    template_version: INVOICE_PDF_TEMPLATE_VERSION,
    renderer_recipe: INVOICE_PDF_RENDERER_RECIPE_VERSION,
    input_json: input,
    input_sha256_hex: hashInvoicePdfInput(input),
    status: "queued",
    attempt_count: 0,
    next_attempt_at: DB_NOW,
    lease_token: null,
    lease_expires_at: null,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_retryable: null,
    artifact_mime_type: null,
    artifact_sha256_hex: null,
    artifact_size_bytes: null,
    artifact_bytes: null,
    created_by: ACTOR_ID,
    db_now: DB_NOW,
    ...overrides,
  };
}

function transaction(responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  const inserts: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => responses[index++] ?? { rows: [] });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: Record<string, unknown>) => {
        inserts.push(entry);
      },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function dispatchGate() {
  return {
    rows: [{
      dispatch_signature: "pgboss.enqueue_invoice_pdf_render(uuid,uuid)",
      current_role: "app_worker",
      session_role: "app_worker",
      database_name: "energie_saas",
    }],
  };
}

function artifact(fill = 0x61) {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(128, fill),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    mimeType: "application/pdf" as const,
  };
}

describe("M3-02c invoice PDF worker database contract", () => {
  it("pins the business lease and attempt budget", () => {
    expect(INVOICE_PDF_MAX_ATTEMPTS).toBe(3);
    expect(INVOICE_PDF_LEASE_MS).toBe(2 * 60_000);
  });

  it("claims a due job using DB time, attempt CAS, a two-minute lease, and a recovery dispatch", async () => {
    const claimed = row({
      status: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [row()] },
      { rows: [claimed] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    const result = await claimInvoicePdfRenderJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    });

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputSha256: claimed.input_sha256_hex,
      input: claimed.input_json,
    });
    expect(harness.execute).toHaveBeenCalledTimes(4);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("clock_timestamp");
    expect(sqlArguments).toContain(String(INVOICE_PDF_LEASE_MS));
    expect(sqlArguments).toContain("attempt_count <");
    expect(sqlArguments).toContain("pgboss.enqueue_invoice_pdf_render");
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("running");
    expect(metadata).not.toContain(claimed.input_sha256_hex);
    expect(metadata).not.toContain("Mia Muster");
    expect(metadata).not.toContain(LEASE_TOKEN);
  });

  it("claims corrupt due input and then records a final sanitized integrity failure", async () => {
    const corrupt = row({
      input_json: { tampered: true },
      status: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [row({ input_json: { tampered: true } })] },
      { rows: [corrupt] },
      { rows: [{}] },
    ]);

    const result = await claimInvoicePdfRenderJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    });

    expect(result).toBeNull();
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("failed_final");
    expect(sqlArguments).not.toContain("pgboss.enqueue_invoice_pdf_render");
  });

  it("moves a retryable failure to retry_wait with exponential DB-time backoff and dispatch", async () => {
    const running = row({
      status: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [running] },
      { rows: [{ ...running, status: "retry_wait" }] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await finalizeInvoicePdfRenderFailure(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    });

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("retry_wait");
    expect(sqlArguments).toContain("pgboss.enqueue_invoice_pdf_render");
  });

  it("finalizes the third attempt as failed_final without another dispatch", async () => {
    const running = row({
      status: "running",
      attempt_count: 3,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [running] },
      { rows: [{ ...running, status: "failed_final" }] },
    ]);

    await finalizeInvoicePdfRenderFailure(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 3,
      errorCode: "browser_unavailable",
      retryable: true,
    });

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("failed_final");
    expect(sqlArguments).not.toContain("pgboss.enqueue_invoice_pdf_render");
  });

  it("rejects a stale completion token and a forged retryability classification", async () => {
    const running = row({
      status: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const stale = transaction([{ rows: [running] }]);
    await expect(finalizeInvoicePdfRenderSuccess(stale.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: "00000000-0000-4000-8000-000000000000",
      attemptCount: 1,
      artifact: artifact(),
    })).rejects.toBeInstanceOf(InvoicePdfWorkerError);

    const forged = transaction([{ rows: [running] }]);
    await expect(finalizeInvoicePdfRenderFailure(forged.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_pdf",
      retryable: true,
    })).rejects.toBeInstanceOf(InvoicePdfWorkerError);
  });

  it("atomically commits verified PDF bytes without touching the document or leaking hash/bytes", async () => {
    const running = row({
      status: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-09-17T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const art = artifact();
    const harness = transaction([
      { rows: [running] },
      { rows: [{ ...running, status: "succeeded" }] },
    ]);

    await finalizeInvoicePdfRenderSuccess(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: art,
    });

    expect(harness.execute).toHaveBeenCalledTimes(2);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("succeeded");
    expect(sqlArguments).not.toContain("commercial_document\n");
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).not.toContain(art.sha256);
  });
});

describe("M3-02c invoice-pdf.render orchestration", () => {
  it("accepts only the strict ID-only dispatch before touching the database", async () => {
    const parsed = parseInvoicePdfDispatchPayload({
      schemaVersion: "invoice-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    });
    expect(parsed).toEqual({
      schemaVersion: "invoice-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    });
    expect(() => parseInvoicePdfDispatchPayload({})).toThrow();
    expect(() => parseInvoicePdfDispatchPayload(null)).toThrow();
    expect(() => parseInvoicePdfDispatchPayload({
      schemaVersion: "invoice-pdf-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      extra: true,
    })).toThrow();
  });

  it("renders only the reloaded sealed claim and finalizes with lease/attempt CAS", async () => {
    const input = inputFixture();
    const art = artifact();
    const claim: InvoicePdfClaim = {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputVersion: INVOICE_PDF_INPUT_VERSION,
      templateVersion: INVOICE_PDF_TEMPLATE_VERSION,
      rendererRecipeVersion: INVOICE_PDF_RENDERER_RECIPE_VERSION,
      inputSha256: hashInvoicePdfInput(input),
      input: structuredClone(input),
    };
    const gateway = {
      claim: vi.fn(async () => claim),
      finalizeSuccess: vi.fn(async () => undefined),
      finalizeFailure: vi.fn(async () => undefined),
    };
    const renderer = {
      render: vi.fn(async () => art),
    };
    const handler = createInvoicePdfRenderHandler({
      database: gateway as never,
      renderer: renderer as never,
      onIntegrityIncident: () => undefined,
    });

    await handler([{
      data: {
        schemaVersion: "invoice-pdf-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }]);

    expect(gateway.claim).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith(claim.input);
    expect(gateway.finalizeSuccess).toHaveBeenCalledTimes(1);
    expect(gateway.finalizeFailure).not.toHaveBeenCalled();
  });

  it("maps renderer errors to closed retry/final classifications without raw details", async () => {
    const input = inputFixture();
    const claim: InvoicePdfClaim = {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputVersion: INVOICE_PDF_INPUT_VERSION,
      templateVersion: INVOICE_PDF_TEMPLATE_VERSION,
      rendererRecipeVersion: INVOICE_PDF_RENDERER_RECIPE_VERSION,
      inputSha256: hashInvoicePdfInput(input),
      input: structuredClone(input),
    };
    const gateway = {
      claim: vi.fn(async () => claim),
      finalizeSuccess: vi.fn(async () => undefined),
      finalizeFailure: vi.fn(async () => undefined),
    };
    const { InvoicePdfRenderError } = await import("@/worker/invoice-pdf-renderer");
    const renderer = {
      render: vi.fn(async () => {
        throw new InvoicePdfRenderError("invalid_pdf", false);
      }),
    };
    const handler = createInvoicePdfRenderHandler({
      database: gateway as never,
      renderer: renderer as never,
      onIntegrityIncident: () => undefined,
    });

    await handler([{
      data: {
        schemaVersion: "invoice-pdf-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }]);

    expect(gateway.finalizeSuccess).not.toHaveBeenCalled();
    expect(gateway.finalizeFailure).toHaveBeenCalledTimes(1);
    expect(gateway.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "invalid_pdf" }),
    );
  });
});
