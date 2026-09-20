import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DRAFT_PDF_QUEUE_OPTIONS,
  OVERDUE_SWEEP_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";

describe("F8-24 worker integration (sweep + draft)", () => {
  it("pins dedicated technical queues without widening payloads", async () => {
    expect(DRAFT_PDF_QUEUE_OPTIONS).toEqual({
      policy: "exclusive",
      retryLimit: 10,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 180,
    });
    expect(Object.isFrozen(DRAFT_PDF_QUEUE_OPTIONS)).toBe(true);
    expect(OVERDUE_SWEEP_QUEUE_OPTIONS).toEqual({
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 900,
    });
    expect(Object.isFrozen(OVERDUE_SWEEP_QUEUE_OPTIONS)).toBe(true);

    const source = await readFile("scripts/pgboss-bootstrap.mts", "utf8");
    expect(source).toContain(
      'const DRAFT_PDF_QUEUE_NAME = "draft-pdf.render"',
    );
    expect(source).toContain(
      "await boss.createQueue(DRAFT_PDF_QUEUE_NAME, DRAFT_PDF_QUEUE_OPTIONS)",
    );
    expect(source).toContain(
      'const OVERDUE_SWEEP_QUEUE_NAME = "overdue.sweep"',
    );
    expect(source).toContain(
      "await boss.createQueue(OVERDUE_SWEEP_QUEUE_NAME, OVERDUE_SWEEP_QUEUE_OPTIONS)",
    );
  });

  it("starts, schedules and drains sweep and draft workers", async () => {
    const source = await readFile("worker/index.ts", "utf8");

    expect(source).toContain("createOverdueSweepDatabaseGateway(");
    expect(source).toContain("createOverdueSweepHandler({");
    expect(source).toContain("await overdueSweepGateway.probe()");
    expect(source).toContain("overdueSweepGateway.close()");
    expect(source).toMatch(/await boss\.work\(\s+OVERDUE_SWEEP_QUEUE,/u);
    expect(source).toMatch(
      /await boss\.schedule\(\s+OVERDUE_SWEEP_QUEUE,\s+OVERDUE_SWEEP_SCHEDULE_CRON,/u,
    );
    expect(source).toContain("createDraftPdfDatabaseGateway(");
    expect(source).toContain("createDraftPdfRenderHandler({");
    expect(source).toContain("createPlaywrightDraftPdfRenderer()");
    expect(source).toContain('reportFatalWorkerError("draft-pdf-integrity"');
    expect(source).toContain("await draftPdfGateway.probe()");
    expect(source).toContain("draftPdfGateway.close()");
    expect(source).toMatch(/await boss\.work\(\s+DRAFT_PDF_QUEUE,/u);
    expect(source).not.toMatch(/S3_(?:ARCHIVE|INVOICE)/u);
  });

  it("documents both queues without archive credentials", async () => {
    const runbook = await readFile("docs/runbooks/worker.md", "utf8");

    expect(runbook).toContain("draft-pdf.render");
    expect(runbook).toContain("overdue.sweep");
    expect(runbook).toContain("neun aktuelle Queueverträge");
  });
});
