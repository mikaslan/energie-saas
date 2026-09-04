import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { OfferPdfDraftInputV1 } from "../lib/integrations/offers/pdf-contract";
import type {
  OfferReleaseCandidateInputV1,
} from "../lib/integrations/offers/release-contract";
import {
  buildOfferIssuanceInput,
  type OfferIssuanceInputV1,
} from "../lib/integrations/offers/issuance-contract";
import {
  renderOfferIssuanceHtml,
} from "../lib/integrations/offers/issuance-template";
import {
  renderOfferReleaseCandidateHtml,
} from "../lib/integrations/offers/release-template";
import {
  MAX_OFFER_PDF_BYTES,
  OfferPdfRenderError,
  createPlaywrightOfferPdfRenderer,
} from "../worker/offer-pdf-renderer";
import {
  createPlaywrightOfferReleaseCandidateRenderer,
} from "../worker/offer-release-candidate-renderer";
import {
  createPlaywrightOfferIssuanceRenderer,
} from "../worker/offer-issuance-renderer";

const EXPECTED_PLAYWRIGHT_VERSION = "1.62.1";
const CANDIDATE_STATUS =
  "Freigabekandidat · nicht ausgestellt · nicht versendet";
type SmokeContract =
  | "M202-RENDER-01"
  | "M203A-RENDER-01"
  | "M203B1-RENDER-01";
let activeContract: SmokeContract = "M202-RENDER-01";

function m202Fixture(): OfferPdfDraftInputV1 {
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
    commercialTerms: { globalDiscountBps: 250, globalFixDiscountCents: null, customDealNetCents: null },
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

function syntheticLegalText(label: string): string {
  return Array.from({ length: 48 }, (_unused, index) =>
    `${label} – synthetischer Prüfabsatz ${String(index + 1).padStart(2, "0")}. `
    + "Dieser ausschließlich künstliche Inhalt prüft Zeilenumbrüche, Seitenwechsel "
    + "und wiederholte Statuskennzeichnung ohne reale Firmen-, Kunden- oder Rechtsdaten.")
    .join("\n\n");
}

function m203aFixture(): OfferReleaseCandidateInputV1 {
  return {
    schemaVersion: "offer-release-candidate-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-release-candidate-template.v1",
    rendererRecipeVersion: "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-900001",
    profile: {
      name: "Synthetisches Container-Prüfprofil",
      revision: 1,
    },
    sender: {
      legalName: "Synthetische Energie Testgesellschaft mbH",
      tradingName: "Synthetik Solar",
      representedBy: "Synthetische Testvertretung",
      address: {
        street: "Testweg",
        houseNumber: "1",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "container-pruefung@example.invalid",
      contactPhone: "+490000000000",
      website: "https://container-pruefung.example.invalid",
      registerCourt: "Synthetisches Testregister",
      registerNumber: "SYNTHETISCH-0001",
      vatId: "DE000000000",
    },
    recipient: {
      displayName: "Synthetischer Prüffall",
      company: null,
      billingAddress: {
        street: "Prüfstraße",
        houseNumber: "2",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Prüfstraße 2, 10117 Berlin",
      },
    },
    installationSite: {
      formattedAddress: "Testallee 3, 10119 Berlin",
    },
    variant: {
      name: "Synthetische PV-Variante",
      revision: 1,
    },
    commercialTerms: {
      globalDiscountBps: 0,
      globalFixDiscountCents: null,
      customDealNetCents: null,
    },
    sections: [{
      position: 1,
      title: "Synthetische Leistungen",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Synthetische Prüfposition",
        description: "Ausschließlich künstliche Renderdaten.",
        quantityMilli: 1_000,
        unit: "set",
        positionType: "required",
        salesUnitNetCents: 100_000,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100_000,
        taxCents: 19_000,
        grossCents: 119_000,
      }],
    }],
    totals: {
      basisNetCents: 100_000,
      basisTaxCents: 19_000,
      basisGrossCents: 119_000,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    legalDocuments: {
      terms: {
        title: "Synthetische Testbedingungen",
        plainText: syntheticLegalText("Testbedingungen"),
      },
      withdrawalInformation: {
        title: "Synthetische Widerrufsinformation",
        plainText: syntheticLegalText("Widerrufsinformation"),
      },
      privacyNotice: {
        title: "Synthetische Datenschutzhinweise",
        plainText: syntheticLegalText("Datenschutzhinweis"),
      },
    },
  };
}

function m203b1Fixture(
  candidateInput: OfferReleaseCandidateInputV1,
  candidateArtifactSha256: string,
  candidateArtifactSizeBytes: number,
): OfferIssuanceInputV1 {
  return buildOfferIssuanceInput({
    issuanceId: "77777777-7777-4777-8777-777777777777",
    preparedAt: "2026-08-30T11:31:00.000Z",
    sourceBinding: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      offerId: "33333333-3333-4333-8333-333333333333",
      candidateId: "44444444-4444-4444-8444-444444444444",
      candidateApprovalId: "55555555-5555-4555-8555-555555555555",
      candidateApprovedAt: "2026-08-30T11:30:00.000Z",
      candidateArtifactVersion: "66666666-6666-4666-8666-666666666666",
      candidateArtifactSha256,
      candidateArtifactSizeBytes,
      variantId: "88888888-8888-4888-8888-888888888888",
      variantRevisionId: "99999999-9999-4999-8999-999999999999",
      variantRevision: candidateInput.variant.revision,
      variantSnapshotSha256: "2".repeat(64),
      profileActivationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      profileRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      profileRevision: candidateInput.profile.revision,
      profileSnapshotSha256: "3".repeat(64),
      recipientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      recipientRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      recipientRevision: 1,
      recipientSnapshotSha256: "4".repeat(64),
    },
    candidateInput,
  });
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function countPdfPages(pdfText: string): number {
  return pdfText.match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
}

function verifyA4MediaBoxes(pdfText: string): number {
  const coordinate = "([+-]?[0-9]+(?:\\.[0-9]+)?)";
  const mediaBoxPattern = new RegExp(
    `/MediaBox\\s*\\[\\s*${coordinate}\\s+${coordinate}\\s+${coordinate}\\s+${coordinate}\\s*\\]`,
    "gu",
  );
  const mediaBoxes = [...pdfText.matchAll(mediaBoxPattern)];
  invariant(mediaBoxes.length > 0, "candidate PDF has no MediaBox");
  for (const mediaBox of mediaBoxes) {
    const left = Number(mediaBox[1]);
    const bottom = Number(mediaBox[2]);
    const right = Number(mediaBox[3]);
    const top = Number(mediaBox[4]);
    const width = Math.abs(right - left);
    const height = Math.abs(top - bottom);
    invariant(
      Math.abs(width - 595.28) <= 2 && Math.abs(height - 841.89) <= 2,
      `candidate PDF MediaBox is not A4: ${width}x${height}`,
    );
  }
  return mediaBoxes.length;
}

function normalizeExtractedPdfText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s*·\s*/gu, " · ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function extractPdfPageTexts(pdfBytes: Buffer): Promise<string[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pageTexts.push(normalizeExtractedPdfText(content.items
          .map((item) => "str" in item && typeof item.str === "string" ? item.str : "")
          .join(" ")));
      } finally {
        page.cleanup();
      }
    }
    return pageTexts;
  } finally {
    await loadingTask.destroy();
  }
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

  const input = m202Fixture();
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

  const m202Evidence = {
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
  };

  activeContract = "M203A-RENDER-01";
  const candidateInput = m203aFixture();
  const candidateHtml = renderOfferReleaseCandidateHtml(candidateInput);
  const visibleStatusOccurrences = candidateHtml.split(CANDIDATE_STATUS).length - 1;
  invariant(
    visibleStatusOccurrences >= 3,
    "candidate status is not repeated in visible document regions",
  );
  invariant(
    candidateHtml.includes(`role="status">${CANDIDATE_STATUS}</p>`),
    "candidate status has no visible semantic status region",
  );

  const candidateRenderer = createPlaywrightOfferReleaseCandidateRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
  });
  const candidateFirst = await candidateRenderer.render(candidateInput);
  const candidateSecond = await candidateRenderer.render(structuredClone(candidateInput));
  invariant(
    candidateFirst.bytes.equals(candidateSecond.bytes),
    "two candidate renders differ byte-for-byte",
  );
  invariant(
    candidateFirst.sha256 === candidateSecond.sha256,
    "two candidate render hashes differ",
  );
  invariant(
    candidateFirst.sizeBytes === candidateSecond.sizeBytes,
    "two candidate render sizes differ",
  );
  invariant(
    candidateFirst.sizeBytes === candidateFirst.bytes.length,
    "reported candidate render size differs",
  );
  invariant(
    candidateFirst.sizeBytes <= MAX_OFFER_PDF_BYTES,
    "candidate render exceeds hard size limit",
  );
  invariant(
    candidateFirst.bytes.subarray(0, 5).toString("latin1") === "%PDF-",
    "candidate PDF header missing",
  );
  const candidatePdfText = candidateFirst.bytes.toString("latin1");
  invariant(/%%EOF[\t\r\n ]*$/u.test(candidatePdfText), "candidate strict PDF EOF missing");
  invariant(candidatePdfText.includes("/StructTreeRoot"), "candidate tagged structure missing");
  invariant(candidatePdfText.includes("/MarkInfo"), "candidate tagged mark information missing");
  invariant(candidatePdfText.includes("/Outlines"), "candidate PDF outline missing");
  const candidatePageCount = countPdfPages(candidatePdfText);
  invariant(
    candidatePageCount >= 6,
    "synthetic legal documents did not create a multi-page candidate PDF",
  );
  const candidateA4MediaBoxes = verifyA4MediaBoxes(candidatePdfText);
  const candidatePageTexts = await extractPdfPageTexts(candidateFirst.bytes);
  invariant(
    candidatePageTexts.length === candidatePageCount,
    "PDF text extractor and structural page count differ",
  );
  const normalizedCandidateStatus = normalizeExtractedPdfText(CANDIDATE_STATUS);
  const statusVerifiedPages = candidatePageTexts.filter((pageText) =>
    pageText.includes(normalizedCandidateStatus)).length;
  invariant(
    statusVerifiedPages === candidatePageCount,
    `candidate status is missing from ${candidatePageCount - statusVerifiedPages} rendered PDF page(s)`,
  );
  invariant(
    candidateFirst.sha256
      === createHash("sha256").update(candidateFirst.bytes).digest("hex"),
    "reported candidate render hash differs",
  );

  await expectRenderFailure(
    () => candidateRenderer.render({ ...candidateInput, offerNumber: "invalid" }),
    "invalid_input",
  );

  const candidateNetworkProbe = createPlaywrightOfferReleaseCandidateRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>",
      "<img src=\"https://candidate.invalid/renderer-network-probe.png\" alt=\"\">",
      "</body></html>",
    ].join(""),
  });
  await expectRenderFailure(
    () => candidateNetworkProbe.render(candidateInput),
    "network_attempted",
  );
  const candidatePrintNetworkProbe = createPlaywrightOfferReleaseCandidateRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
      "@media print { body { background-image: url(\"https://candidate-print.invalid/probe.png\"); } }",
      "</style></head><body>candidate print network probe</body></html>",
    ].join(""),
  });
  await expectRenderFailure(
    () => candidatePrintNetworkProbe.render(candidateInput),
    "network_attempted",
  );

  const legalTextCharacters = Object.values(candidateInput.legalDocuments)
    .reduce((sum, document) => sum + document.plainText.length, 0);
  const m203aEvidence = {
    ok: true,
    contract: "M203A-RENDER-01",
    playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
    deterministicRenders: 2,
    byteEqualityVerified: true,
    hashEqualityVerified: true,
    sizeEqualityVerified: true,
    taggedPdfVerified: true,
    outlineVerified: true,
    a4Verified: true,
    multiPageLegalDocumentsVerified: true,
    documentStatusTextOnEveryPageVerified: statusVerifiedPages === candidatePageCount,
    statusVerifiedPages,
    documentStatusText: "nicht ausgestellt · nicht versendet",
    networkFailClosed: true,
    printNetworkFailClosed: true,
    invalidInputFailClosed: true,
    syntheticFixture: true,
    containerHardeningVerified,
    sameUidProcessIsolationVerified,
    pinnedRuntimeVerified,
    runtime: `${process.platform}/${process.arch}`,
    fixtureLines: 1,
    legalTextCharacters,
    pageCount: candidatePageCount,
    a4MediaBoxes: candidateA4MediaBoxes,
    sizeBytes: candidateFirst.sizeBytes,
    sha256: candidateFirst.sha256,
  };

  activeContract = "M203B1-RENDER-01";
  const issuanceInput = m203b1Fixture(
    candidateInput,
    candidateFirst.sha256,
    candidateFirst.sizeBytes,
  );
  const issuanceHtml = renderOfferIssuanceHtml(issuanceInput);
  const provisionalMarkers = [
    "Freigabekandidat",
    "nicht ausgestellt",
    "nicht versendet",
  ];
  invariant(
    provisionalMarkers.every((marker) => !issuanceHtml.includes(marker)),
    "final issuance HTML contains a provisional marker",
  );

  const issuanceRenderer = createPlaywrightOfferIssuanceRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
  });
  const issuanceFirst = await issuanceRenderer.render(issuanceInput);
  const issuanceSecond = await issuanceRenderer.render(structuredClone(issuanceInput));
  invariant(
    issuanceFirst.bytes.equals(issuanceSecond.bytes),
    "two issuance renders differ byte-for-byte",
  );
  invariant(
    issuanceFirst.sha256 === issuanceSecond.sha256,
    "two issuance render hashes differ",
  );
  invariant(
    issuanceFirst.sizeBytes === issuanceSecond.sizeBytes,
    "two issuance render sizes differ",
  );
  invariant(
    !issuanceFirst.bytes.equals(candidateFirst.bytes),
    "candidate bytes were promoted as issuance bytes",
  );
  invariant(
    issuanceFirst.sha256 !== candidateFirst.sha256,
    "candidate hash was promoted as issuance hash",
  );
  invariant(
    issuanceFirst.sizeBytes === issuanceFirst.bytes.length,
    "reported issuance render size differs",
  );
  invariant(
    issuanceFirst.sizeBytes <= MAX_OFFER_PDF_BYTES,
    "issuance render exceeds hard size limit",
  );
  invariant(
    issuanceFirst.bytes.subarray(0, 5).toString("latin1") === "%PDF-",
    "issuance PDF header missing",
  );
  const issuancePdfText = issuanceFirst.bytes.toString("latin1");
  invariant(/%%EOF[\t\r\n ]*$/u.test(issuancePdfText), "issuance strict PDF EOF missing");
  invariant(issuancePdfText.includes("/StructTreeRoot"), "issuance tagged structure missing");
  invariant(issuancePdfText.includes("/MarkInfo"), "issuance tagged mark information missing");
  invariant(issuancePdfText.includes("/Outlines"), "issuance PDF outline missing");
  const issuancePageCount = countPdfPages(issuancePdfText);
  invariant(
    issuancePageCount >= 6,
    "synthetic legal documents did not create a multi-page issuance PDF",
  );
  const issuanceA4MediaBoxes = verifyA4MediaBoxes(issuancePdfText);
  const issuancePageTexts = await extractPdfPageTexts(issuanceFirst.bytes);
  invariant(
    issuancePageTexts.length === issuancePageCount,
    "issuance text extractor and structural page count differ",
  );
  invariant(
    issuancePageTexts.every((pageText) => provisionalMarkers.every((marker) =>
      !pageText.includes(normalizeExtractedPdfText(marker)))),
    "final issuance PDF contains a provisional marker",
  );
  invariant(
    issuanceFirst.sha256
      === createHash("sha256").update(issuanceFirst.bytes).digest("hex"),
    "reported issuance render hash differs",
  );

  const invalidIssuanceInput = Object.assign({}, issuanceInput, {
    archiveBucket: "forbidden",
  });
  await expectRenderFailure(
    () => issuanceRenderer.render(invalidIssuanceInput),
    "invalid_input",
  );
  const issuanceNetworkProbe = createPlaywrightOfferIssuanceRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>",
      "<img src=\"https://issuance.invalid/renderer-network-probe.png\" alt=\"\">",
      "</body></html>",
    ].join(""),
  });
  await expectRenderFailure(
    () => issuanceNetworkProbe.render(issuanceInput),
    "network_attempted",
  );
  const issuancePrintNetworkProbe = createPlaywrightOfferIssuanceRenderer({
    allowUnpinnedRuntimeForVerification: !pinnedRuntimeVerified,
    htmlRenderer: () => [
      "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
      "@media print { body { background-image: url(\"https://issuance-print.invalid/probe.png\"); } }",
      "</style></head><body>issuance print network probe</body></html>",
    ].join(""),
  });
  await expectRenderFailure(
    () => issuancePrintNetworkProbe.render(issuanceInput),
    "network_attempted",
  );

  const m203b1Evidence = {
    ok: true,
    contract: "M203B1-RENDER-01",
    playwrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
    deterministicRenders: 2,
    byteEqualityVerified: true,
    hashEqualityVerified: true,
    sizeEqualityVerified: true,
    taggedPdfVerified: true,
    outlineVerified: true,
    a4Verified: true,
    multiPageLegalDocumentsVerified: true,
    provisionalMarkersAbsent: true,
    candidateBytesNotPromoted: true,
    networkFailClosed: true,
    printNetworkFailClosed: true,
    invalidInputFailClosed: true,
    syntheticFixture: true,
    containerHardeningVerified,
    sameUidProcessIsolationVerified,
    pinnedRuntimeVerified,
    runtime: `${process.platform}/${process.arch}`,
    fixtureLines: 1,
    legalTextCharacters,
    pageCount: issuancePageCount,
    a4MediaBoxes: issuanceA4MediaBoxes,
    sizeBytes: issuanceFirst.sizeBytes,
    sha256: issuanceFirst.sha256,
  };

  process.stdout.write([
    JSON.stringify(m202Evidence),
    JSON.stringify(m203aEvidence),
    JSON.stringify(m203b1Evidence),
  ].join("\n") + "\n");
}

main().catch((error: unknown) => {
  const code = error instanceof OfferPdfRenderError ? error.code : "verification_failed";
  process.stderr.write(`${activeContract} failed: ${code}\n`);
  process.exitCode = 1;
});
