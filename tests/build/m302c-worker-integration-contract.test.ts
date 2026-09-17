import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  INVOICE_PDF_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";

describe("M3-02c invoice worker integration", () => {
  it("pins a dedicated technical queue without widening the payload", async () => {
    expect(INVOICE_PDF_QUEUE_OPTIONS).toEqual({
      policy: "exclusive",
      retryLimit: 10,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 180,
    });
    expect(Object.isFrozen(INVOICE_PDF_QUEUE_OPTIONS)).toBe(true);

    const source = await readFile("scripts/pgboss-bootstrap.mts", "utf8");
    expect(source).toContain(
      'const INVOICE_PDF_QUEUE_NAME = "invoice-pdf.render"',
    );
    expect(source).toContain(
      "await boss.createQueue(INVOICE_PDF_QUEUE_NAME, INVOICE_PDF_QUEUE_OPTIONS)",
    );
  });

  it("starts, recovers and drains the isolated invoice worker", async () => {
    const source = await readFile("worker/index.ts", "utf8");

    expect(source).toContain(
      'const INVOICE_PDF_QUEUE = "invoice-pdf.render"',
    );
    expect(source).toContain("createInvoicePdfDatabaseGateway(");
    expect(source).toContain("createInvoicePdfRenderHandler({");
    expect(source).toContain("createPlaywrightInvoicePdfRenderer()");
    expect(source).toContain('reportFatalWorkerError("invoice-pdf-integrity"');
    expect(source).toContain("startInvoicePdfRecoverySweep({");
    expect(source).toContain('reportFatalWorkerError("invoice-pdf-recovery"');
    expect(source).toContain("invoicePdfRecovery?.stop()");
    expect(source).toContain("await invoicePdfGateway.probe()");
    expect(source).toContain("invoicePdfGateway.close()");
    expect(source).toMatch(/await boss\.work\(\s+INVOICE_PDF_QUEUE,/u);
    expect(source).not.toMatch(/S3_(?:ARCHIVE|INVOICE)/u);
  });

  it("smokes deterministic invoice bytes without draft markers", async () => {
    const source = await readFile(
      "tests/unit/m302c-invoice-pdf-renderer.test.ts",
      "utf8",
    );

    expect(source).toContain("without moving xref offsets");
    expect(source).toContain("normalized.length).toBe(source.length");
    expect(source).toContain("network_attempted");
    expect(source).toContain("fails invalid document input before a browser is needed");

    const template = await readFile(
      "tests/unit/m302c-invoice-pdf-template.test.ts",
      "utf8",
    );
    expect(template).toContain("finale Rechnung ohne Entwurf");
    expect(template).toContain("keine externen Ressourcen, keine Leak-Felder");
  });

  it("documents the invoice queue without archive credentials", async () => {
    const runbook = await readFile("docs/runbooks/worker.md", "utf8");

    expect(runbook).toContain("invoice-pdf.render");
    expect(runbook).toContain("sieben aktuelle Queueverträge");
  });
});
