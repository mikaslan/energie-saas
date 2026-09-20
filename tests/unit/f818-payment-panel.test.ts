import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class InvoicingValidationError extends Error {}
  class InvoicingNotFoundError extends Error {}
  class InvoicingIntegrityError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    InvoicingValidationError,
    InvoicingNotFoundError,
    InvoicingIntegrityError,
    authorizedAction: vi.fn(),
    requestInvoicePaymentInput: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/invoicing", () => ({
  requestInvoicePaymentInput: deps.requestInvoicePaymentInput,
  InvoicingValidationError: deps.InvoicingValidationError,
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingIntegrityError: deps.InvoicingIntegrityError,
}));

import { InvoicePaymentPanel } from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/invoice-payment-panel";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_ID = "30000000-0000-4000-8000-000000000003";

const DETAIL_ROUTE = "app/w/[workspaceId]/rechnungen/[type]/[documentId]";

describe("F8-18 invoice payment panel", () => {
  const jobs = [{
    jobId: JOB_ID,
    state: "succeeded" as const,
    attemptCount: 1,
    nextAttemptAt: "2026-09-17T12:00:00.000Z",
    createdAt: "2026-09-17T11:59:00.000Z",
    startedAt: "2026-09-17T11:59:01.000Z",
    finishedAt: "2026-09-17T11:59:02.000Z",
    errorCode: null,
    canDownload: true,
  }, {
    jobId: "40000000-0000-4000-8000-000000000004",
    state: "failed_final" as const,
    attemptCount: 3,
    nextAttemptAt: "2026-09-17T11:00:00.000Z",
    createdAt: "2026-09-17T10:59:00.000Z",
    startedAt: "2026-09-17T10:59:01.000Z",
    finishedAt: "2026-09-17T10:59:02.000Z",
    errorCode: "PRIVATE_WORKER_SENTINEL",
    canDownload: false,
  }, {
    jobId: "50000000-0000-4000-8000-000000000005",
    state: "running" as const,
    attemptCount: 1,
    nextAttemptAt: "2026-09-17T12:00:00.000Z",
    createdAt: "2026-09-17T11:59:00.000Z",
    startedAt: "2026-09-17T11:59:01.000Z",
    finishedAt: null,
    errorCode: null,
    canDownload: true,
  }];

  function renderPanel(options: {
    canGenerate: boolean;
    openCents?: number;
    hasBankDetails?: boolean;
  }): string {
    return renderToStaticMarkup(createElement(InvoicePaymentPanel, {
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      canGenerate: options.canGenerate,
      openCents: options.openCents ?? 119000,
      hasBankDetails: options.hasBankDetails ?? true,
      jobs,
    }));
  }

  it("F818-CT-04: laesst Leser nur echte fertige Zahlungsbelege laden und redigiert Workerfehler", () => {
    const html = renderPanel({ canGenerate: false });

    expect(html).toContain('id="invoice-payment"');
    expect(html).toContain("Zahlungsbeleg");
    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Zahlungsbeleg erzeugen</button>");
    expect(html).toContain(`/rechnungen/invoice/${DOCUMENT_ID}/pdf/${JOB_ID}`);
    expect(html).toContain("Zahlungsbeleg ist bereit");
    expect(html).toContain("Zahlungsbeleg-Erstellung endgültig fehlgeschlagen");
    expect(html).toContain("Zahlungsbeleg laden");
    expect(html).toContain("Versuche:");
    expect(html).not.toContain("PRIVATE_WORKER_SENTINEL");
    expect(html).not.toContain("/pdf/40000000-0000-4000-8000-000000000004");
    expect(html).not.toContain("/pdf/50000000-0000-4000-8000-000000000005");
  });

  it("F818-CT-04: gibt Editoren ein semantisches Formular mit drei kanonischen Feldern", () => {
    const html = renderPanel({ canGenerate: true });

    expect(html).toContain("<form");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('name="type"');
    expect(html).toContain('name="documentId"');
    expect(html).toContain("Zahlungsbeleg erzeugen");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("F818-CT-04: gatet vollbezahlte Belege mit Hinweis statt Button", () => {
    const html = renderPanel({ canGenerate: false, openCents: 0 });

    expect(html).toContain("Kein offener Betrag — kein Zahlungsbeleg nötig.");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Zahlungsbeleg erzeugen</button>");
  });

  it("F818-CT-04: gatet fehlende Bankverbindung mit Hinweis statt Button", () => {
    const html = renderPanel({ canGenerate: false, hasBankDetails: false });

    expect(html).toContain("Keine Bankverbindung hinterlegt —");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Zahlungsbeleg erzeugen</button>");
  });

  it("F818-CT-04: zeigt einen Leerstand ohne Jobs, aber mit Gating", () => {
    const html = renderToStaticMarkup(createElement(InvoicePaymentPanel, {
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      canGenerate: true,
      openCents: 119000,
      hasBankDetails: true,
      jobs: [],
    }));

    expect(html).toContain("Noch kein Zahlungsbeleg vorhanden.");
    expect(html).toContain("Zahlungsbeleg erzeugen");
  });
});

describe("F8-18 payment UI source contract", () => {
  it("F818-CT-04: haelt das Payment-Panel clientseitig, redigiert und aktionsgebunden", async () => {
    const panel = await readFile(`${DETAIL_ROUTE}/invoice-payment-panel.tsx`, "utf8");

    expect(panel).toMatch(/^\s*["']use client["']/u);
    expect(panel).toContain("useActionState");
    expect(panel).toContain("requestInvoicePaymentAction");
    expect(panel).toContain('id="invoice-payment"');
    expect(panel).toContain("Zahlungsbeleg");
    expect(panel).toContain("canGenerate");
    expect(panel).toContain("openCents");
    expect(panel).toContain("hasBankDetails");
    expect(panel).toContain("Kein offener Betrag — kein Zahlungsbeleg nötig.");
    expect(panel).toContain("Keine Bankverbindung hinterlegt —");
    expect(panel).toContain("Nur Lesezugriff");
    expect(panel).toContain('role={feedbackIsError ? "alert" : "status"}');
    expect(panel).toContain('aria-live={feedbackIsError ? "assertive" : "polite"}');
    for (const state of [
      "requested",
      "queued",
      "running",
      "retry_wait",
      "succeeded",
      "failed_final",
    ]) {
      expect(panel).toContain(`"${state}"`);
    }
    expect(panel).toContain("attemptCount");
    expect(panel).toContain("canDownload");
    expect(panel).toContain("jobId");
    expect(panel).not.toContain("Rechnung versenden");
    expect(panel).not.toContain("Öffentlicher Link");
    expect(panel).not.toContain("Signatur starten");
    expect(panel).not.toContain("artifactSha256");
  });

  it("F818-CT-05: Page partitioniert Invoice/Payment, gatet Panel und bindet canGenerate an Rest > 0", async () => {
    const page = await readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8");

    expect(page).toContain("InvoicePaymentPanel");
    expect(page).toContain("INVOICE_PDF_TEMPLATE_VERSION");
    expect(page).toContain("INVOICE_PAYMENT_TEMPLATE_VERSION");
    expect(page).toContain("invoicePdfJobs");
    expect(page).toContain("paymentPdfJobs");
    expect(page).toContain("jobs={invoicePdfJobs}");
    expect(page).toContain("jobs={paymentPdfJobs}");
    expect(page).toContain("canRequestPayment");
    expect(page).toContain("openCents > 0");
    expect(page).toContain("hasBankDetails");
    expect(page).toContain("getInvoicingSettings");
    expect(page).toContain("paymentAccountHolder");
    expect(page).not.toContain("paymentIban");
    expect(page).toContain('type === "invoice" && document.status === "issued"');
  });
});
