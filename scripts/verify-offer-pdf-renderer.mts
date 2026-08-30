import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";

import type { OfferPdfDraftInputV1 } from "../lib/integrations/offers/pdf-contract";
import {
  MAX_OFFER_PDF_BYTES,
  OfferPdfRenderError,
  createPlaywrightOfferPdfRenderer,
} from "../worker/offer-pdf-renderer";

const EXPECTED_PLAYWRIGHT_VERSION = "1.62.1";

function fixture(): OfferPdfDraftInputV1 {
  const basisLines: OfferPdfDraftInputV1["sections"][number]["lines"] = Array.from(
    { length: 499 },
    (_unused, index) => ({
      position: index + 1,
      title: `PV-Position ${String(index + 1).padStart(3, "0")}`,
      description: index === 0 ? "Planung und Montage" : null,
      quantityMilli: 1_000,
      unit: "set",
      positionType: "required",
      isHidden: index === 498,
      salesUnitNetCents: 1_000,
      lineDiscountBps: 0,
      taxRateBps: 1_900,
      finalNetCents: 1_000,
      taxCents: 190,
      grossCents: 1_190,
    }),
  );
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T10:11:12.000Z",
    recipient: { displayName: "Erika Muster" },
    installationSite: { formattedAddress: "Musterweg 42, 10115 Berlin" },
    variant: {
      name: "PV und Speicher",
      revision: 7,
    },
    commercialTerms: { globalDiscountBps: 250, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Photovoltaik",
      discountBps: 0,
      lines: [
        ...basisLines,
        {
          position: 500,
          title: "Speicheroption",
          description: null,
          quantityMilli: 1_000,
          unit: "piece",
          positionType: "optional",
          isHidden: false,
          salesUnitNetCents: 50_000,
          lineDiscountBps: 0,
          taxRateBps: 0,
          finalNetCents: 50_000,
          taxCents: 0,
          grossCents: 50_000,
        },
      ],
    }],
    totals: {
      basisNetCents: 499_000,
      basisTaxCents: 94_810,
      basisGrossCents: 593_810,
      optionalNetCents: 50_000,
      optionalTaxCents: 0,
      optionalGrossCents: 50_000,
    },
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyContainerHardening(): Promise<boolean> {
  if (process.env.OFFER_PDF_VERIFY_CONTAINER_HARDENING !== "1") return false;
  invariant(process.platform === "linux", "container hardening probe requires Linux");
  invariant(process.arch === "x64", "container hardening probe requires pinned x64");
  invariant(process.getuid?.() !== 0, "container hardening probe requires non-root");

  const status = await readFile("/proc/self/status", "utf8");
  invariant(/^CapEff:\s+0+$/mu.test(status), "container retains effective capabilities");
  invariant(/^NoNewPrivs:\s+1$/mu.test(status), "no-new-privileges is inactive");
  invariant(/^Seccomp:\s+2$/mu.test(status), "seccomp filter is inactive");
  const preload = await stat("/usr/local/lib/worker-nodump.so");
  invariant(preload.isFile(), "worker non-dump preload is not a regular file");
  invariant(preload.uid === 0 && preload.gid === 0, "worker non-dump preload is not root-owned");
  invariant((preload.mode & 0o022) === 0, "worker non-dump preload is group/world writable");

  const readOnlyProbe = "/app/.m202-renderer-read-only-probe";
  try {
    await writeFile(readOnlyProbe, "must-not-be-written", { flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    invariant(code === "EROFS" || code === "EACCES", "unexpected read-only probe failure");
    return true;
  }
  await unlink(readOnlyProbe).catch(() => undefined);
  throw new Error("container root filesystem is writable");
}

function verifySameUidProcessIsolation(): boolean {
  if (process.env.OFFER_PDF_VERIFY_CONTAINER_HARDENING !== "1") return false;
  const sentinel = process.env.WORKER_ISOLATION_SENTINEL;
  invariant(sentinel === "synthetic-container-isolation-probe", "isolation sentinel missing");
  invariant(
    process.env.LD_PRELOAD === "/usr/local/lib/worker-nodump.so",
    "worker non-dump preload is inactive",
  );
  const openFilePath = `/tmp/m202-worker-isolation-${process.pid}`;
  const openFileDescriptor = openSync(openFilePath, "wx+", 0o600);
  try {
    writeSync(openFileDescriptor, sentinel, undefined, "utf8");
    unlinkSync(openFilePath);
    const probe = spawnSync(process.execPath, [
      "-e",
      [
        "const fs = require('node:fs');",
        "const blocked = (operation) => {",
        "  try { operation(); return false; }",
        "  catch (error) { return Boolean(error && (error.code === 'EACCES' || error.code === 'EPERM')); }",
        "};",
        "const pid = process.argv[1];",
        "if (!blocked(() => fs.readFileSync('/proc/' + pid + '/environ'))) process.exit(42);",
        "if (!blocked(() => fs.readFileSync('/proc/' + pid + '/fd/' + process.argv[2]))) process.exit(43);",
        "process.exit(0);",
      ].join("\n"),
      String(process.pid),
      String(openFileDescriptor),
    ], {
      env: {
        LANG: "C.UTF-8",
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp",
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    invariant(
      probe.status === 0 && probe.signal === null,
      `same-UID child accessed parent process data (status ${String(probe.status)})`,
    );
  } finally {
    closeSync(openFileDescriptor);
    try { unlinkSync(openFilePath); } catch { /* already unlinked */ }
  }
  return true;
}

async function expectRenderFailure(
  operation: () => Promise<unknown>,
  expectedCode: OfferPdfRenderError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    invariant(error instanceof OfferPdfRenderError, "unexpected renderer error type");
    invariant(error.code === expectedCode, `unexpected renderer error code: ${error.code}`);
    invariant(error.message === "offer PDF render failed", "renderer error was not redacted");
    return;
  }
  throw new Error(`renderer unexpectedly accepted ${expectedCode} scenario`);
}

async function main(): Promise<void> {
  const containerHardeningVerified = await verifyContainerHardening();
  const sameUidProcessIsolationVerified = verifySameUidProcessIsolation();
  const pinnedRuntimeVerified = process.platform === "linux" && process.arch === "x64";
  invariant(
    !containerHardeningVerified || pinnedRuntimeVerified,
    "container smoke is not running on the pinned renderer runtime",
  );
  const playwrightPackage = JSON.parse(await readFile(
    new URL("../node_modules/playwright/package.json", import.meta.url),
    "utf8",
  )) as { version?: unknown };
  invariant(
    playwrightPackage.version === EXPECTED_PLAYWRIGHT_VERSION,
    `Playwright package must be ${EXPECTED_PLAYWRIGHT_VERSION}`,
  );

  const input = fixture();
  const renderer = createPlaywrightOfferPdfRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
  });
  const first = await renderer.render(input);
  const second = await renderer.render(input);

  invariant(first.bytes.equals(second.bytes), "two sealed renders differ byte-for-byte");
  invariant(first.sha256 === second.sha256, "two sealed render hashes differ");
  invariant(first.sizeBytes === second.sizeBytes, "two sealed render sizes differ");
  invariant(first.sizeBytes === first.bytes.length, "reported render size differs");
  invariant(first.sizeBytes <= MAX_OFFER_PDF_BYTES, "render exceeds hard size limit");
  invariant(first.bytes.subarray(0, 5).toString("latin1") === "%PDF-", "PDF header missing");
  const pdfText = first.bytes.toString("latin1");
  invariant(/%%EOF[\t\r\n ]*$/u.test(pdfText), "strict PDF EOF missing");
  invariant(pdfText.includes("/StructTreeRoot"), "tagged PDF structure is missing");
  invariant(pdfText.includes("/MarkInfo"), "tagged PDF mark information is missing");
  invariant(pdfText.includes("/Outlines"), "PDF outline is missing");
  invariant(
    (pdfText.match(/\/Type\s*\/Page\b/gu)?.length ?? 0) > 1,
    "500-line renderer fixture did not create multiple pages",
  );
  invariant(
    first.sha256 === createHash("sha256").update(first.bytes).digest("hex"),
    "reported render hash differs",
  );

  await expectRenderFailure(
    () => renderer.render({ ...input, offerNumber: "invalid" }),
    "invalid_input",
  );

  const networkProbe = createPlaywrightOfferPdfRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>",
      "<img src=\"https://example.invalid/renderer-network-probe.png\" alt=\"\">",
      "</body></html>",
    ].join(""),
  });
  await expectRenderFailure(() => networkProbe.render(input), "network_attempted");
  const printNetworkProbe = createPlaywrightOfferPdfRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
      "@media print { body { background-image: url(\"https://print-only.invalid/probe.png\"); } }",
      "</style></head><body>print network probe</body></html>",
    ].join(""),
  });
  await expectRenderFailure(() => printNetworkProbe.render(input), "network_attempted");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    contract: "M202-RENDER-01",
    playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
    deterministicRenders: 2,
    networkFailClosed: true,
    printNetworkFailClosed: true,
    invalidInputFailClosed: true,
    containerHardeningVerified,
    sameUidProcessIsolationVerified,
    pinnedRuntimeVerified,
    runtime: `${process.platform}/${process.arch}`,
    fixtureLines: 500,
    sizeBytes: first.sizeBytes,
    sha256: first.sha256,
  })}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof OfferPdfRenderError ? error.code : "verification_failed";
  process.stderr.write(`M202-RENDER-01 failed: ${code}\n`);
  process.exitCode = 1;
});
