import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  OFFER_ISSUANCE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";

describe("M2-03b1 issuance worker integration", () => {
  it("pins a dedicated technical queue without widening the payload", async () => {
    expect(OFFER_ISSUANCE_QUEUE_OPTIONS).toEqual({
      policy: "exclusive",
      retryLimit: 10,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 180,
    });
    expect(Object.isFrozen(OFFER_ISSUANCE_QUEUE_OPTIONS)).toBe(true);

    const source = await readFile("scripts/pgboss-bootstrap.mts", "utf8");
    expect(source).toContain(
      'const OFFER_ISSUANCE_QUEUE_NAME = "offer-issuance.render.v1"',
    );
    expect(source).toContain(
      "await boss.createQueue(OFFER_ISSUANCE_QUEUE_NAME, OFFER_ISSUANCE_QUEUE_OPTIONS)",
    );
  });

  it("starts, recovers and drains the isolated issuance worker", async () => {
    const source = await readFile("worker/index.ts", "utf8");

    expect(source).toContain(
      'const OFFER_ISSUANCE_QUEUE = "offer-issuance.render.v1"',
    );
    expect(source).toContain("createOfferIssuanceDatabaseGateway(");
    expect(source).toContain("createOfferIssuanceRenderHandler({");
    expect(source).toContain("createPlaywrightOfferIssuanceRenderer()");
    expect(source).toContain('reportFatalWorkerError("offer-issuance-integrity"');
    expect(source).toContain("startOfferIssuanceRecoverySweep({");
    expect(source).toContain('reportFatalWorkerError("offer-issuance-recovery"');
    expect(source).toContain("offerIssuanceRecovery?.stop()");
    expect(source).toContain("await offerIssuanceGateway.probe()");
    expect(source).toContain("offerIssuanceGateway.close()");
    expect(source).toMatch(/await boss\.work\(\s+OFFER_ISSUANCE_QUEUE,/u);
    expect(source).not.toMatch(/S3_(?:ARCHIVE|ISSUANCE)/u);
  });

  it("smokes deterministic final issuance bytes without provisional markers", async () => {
    const source = await readFile("scripts/verify-offer-pdf-renderer.mts", "utf8");

    expect(source).toContain("createPlaywrightOfferIssuanceRenderer");
    expect(source).toContain("renderOfferIssuanceHtml");
    expect(source).toContain('contract: "M203B1-RENDER-01"');
    expect(source).toContain("issuanceFirst.bytes.equals(issuanceSecond.bytes)");
    expect(source).toContain("provisionalMarkersAbsent: true");
    expect(source).toContain("candidateBytesNotPromoted: true");
    expect(source).toContain("networkFailClosed: true");
    expect(source).toContain("printNetworkFailClosed: true");
    expect(source).toContain("syntheticFixture: true");
  });

  it("documents the local approval boundary without archive credentials", async () => {
    const runbook = await readFile("docs/runbooks/worker.md", "utf8");

    expect(runbook).toContain("offer-issuance.render.v1");
    expect(runbook).toContain("approved_for_archive_not_issued");
    expect(runbook).toMatch(/keine\s+Archiv-\/Storage-Credentials/u);
    expect(runbook).toContain("M203B1-RENDER-01");
  });
});
