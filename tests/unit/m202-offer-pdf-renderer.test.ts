import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import type { OfferPdfDraftInputV1 } from "@/lib/integrations/offers/pdf-contract";
import {
  MAX_OFFER_PDF_BYTES,
  OfferPdfRenderError,
  createPlaywrightOfferPdfRenderer,
  normalizeChromiumPdfMetadata,
  validateRenderedOfferPdf,
} from "@/worker/offer-pdf-renderer";

const PREPARED_AT = "2026-08-30T10:11:12.000Z";

function validInput(): OfferPdfDraftInputV1 {
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: PREPARED_AT,
    recipient: { displayName: "Erika Muster" },
    installationSite: { formattedAddress: "Musterweg 42, 10115 Berlin" },
    variant: { name: "PV und Speicher", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalDiscountCapCents: null, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Photovoltaik",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "PV-Anlage",
        description: null,
        quantityMilli: 1_000,
        unit: "set",
        positionType: "required",
        isHidden: false,
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
  };
}

function syntheticChromiumPdf(options?: {
  header?: string;
  eof?: string;
  metadata?: string;
  trailing?: string;
}): Buffer {
  const body = [
    options?.header ?? "%PDF-1.7",
    options?.metadata
      ?? "/CreationDate (D:20260101010203+00'00')\n/ModDate (D:20260101010204+00'00')",
    "0".repeat(160),
    options?.eof ?? "%%EOF",
    options?.trailing ?? "",
  ].join("\n");
  return Buffer.from(`${body}\n`, "latin1");
}

function expectRenderError(
  operation: () => unknown,
  code: OfferPdfRenderError["code"],
): void {
  try {
    operation();
    throw new Error("expected renderer failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OfferPdfRenderError);
    expect((error as OfferPdfRenderError).code).toBe(code);
    expect((error as OfferPdfRenderError).message).toBe("offer PDF render failed");
  }
}

describe("M2-02 offer PDF renderer envelope", () => {
  it("normalizes Chromium dates to the sealed preparation time without moving xref offsets", () => {
    const source = syntheticChromiumPdf();
    const normalized = normalizeChromiumPdfMetadata(source, PREPARED_AT);

    expect(normalized).not.toBe(source);
    expect(normalized.length).toBe(source.length);
    expect(normalized.toString("latin1")).toContain(
      "/CreationDate (D:20260830101112+00'00')",
    );
    expect(normalized.toString("latin1")).toContain(
      "/ModDate (D:20260830101112+00'00')",
    );
    expect(source.toString("latin1")).toContain("D:20260101010203+00'00'");
  });

  it("rejects absent metadata and invalid sealed timestamps", () => {
    expectRenderError(
      () => normalizeChromiumPdfMetadata(
        syntheticChromiumPdf({ metadata: "/Producer (Chromium)" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => normalizeChromiumPdfMetadata(syntheticChromiumPdf(), "not-a-date"),
      "invalid_input",
    );
  });

  it("accepts one strict PDF envelope and derives its bytes, size and hash together", () => {
    const result = validateRenderedOfferPdf(syntheticChromiumPdf(), PREPARED_AT);

    expect(result.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7");
    expect(result.bytes.toString("latin1")).toMatch(/%%EOF\s*$/u);
    expect(result.sizeBytes).toBe(result.bytes.length);
    expect(result.sizeBytes).toBeLessThanOrEqual(MAX_OFFER_PDF_BYTES);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex"),
    );
  });

  it("rejects malformed headers, missing/fake EOF markers and oversized output", () => {
    expectRenderError(
      () => validateRenderedOfferPdf(
        syntheticChromiumPdf({ header: "%PNG-1.7" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedOfferPdf(
        syntheticChromiumPdf({ eof: "not-an-eof" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedOfferPdf(
        syntheticChromiumPdf({ trailing: "untrusted trailing bytes" }),
        PREPARED_AT,
      ),
      "invalid_pdf",
    );
    expectRenderError(
      () => validateRenderedOfferPdf(
        Buffer.concat([
          syntheticChromiumPdf(),
          Buffer.alloc(MAX_OFFER_PDF_BYTES),
        ]),
        PREPARED_AT,
      ),
      "pdf_too_large",
    );
  });

  it("fails invalid document input before a browser is needed", async () => {
    const renderer = createPlaywrightOfferPdfRenderer();
    const invalid = { ...validInput(), offerNumber: "<invalid>" };

    await expect(renderer.render(invalid)).rejects.toMatchObject({
      name: "OfferPdfRenderError",
      message: "offer PDF render failed",
      code: "invalid_input",
      retryable: false,
    });
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")(
    "rejects a production render outside the pinned linux/amd64 recipe",
    async () => {
      await expect(createPlaywrightOfferPdfRenderer().render(validInput()))
        .rejects.toMatchObject({
          name: "OfferPdfRenderError",
          message: "offer PDF render failed",
          code: "browser_unavailable",
          retryable: true,
        });
    },
  );

  it("fails closed when print-only CSS attempts a request during page.pdf", async () => {
    const renderer = createPlaywrightOfferPdfRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => `<!doctype html>
<html><head><style>
@media print { body { background-image: url("https://print-only.invalid/pixel.png"); } }
</style></head><body>Print-only network probe</body></html>`,
    });

    await expect(renderer.render(validInput())).rejects.toMatchObject({
      name: "OfferPdfRenderError",
      message: "offer PDF render failed",
      code: "network_attempted",
      retryable: false,
    });
  }, 60_000);
});

describe("M2-02 Chromium container sandbox contract", () => {
  it("extends the default-deny seccomp contract only for Playwright user namespaces", async () => {
    const profile = JSON.parse(await readFile(
      "worker/chromium-seccomp.json",
      "utf8",
    )) as {
      defaultAction?: unknown;
      syscalls?: Array<{
        comment?: unknown;
        names?: unknown;
        action?: unknown;
        args?: unknown;
        includes?: unknown;
        excludes?: unknown;
      }>;
    };

    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const userNamespaceRule = profile.syscalls?.find(
      (rule) => rule.comment === "Allow create user namespaces",
    );
    expect(userNamespaceRule).toEqual({
      comment: "Allow create user namespaces",
      names: ["clone", "setns", "unshare"],
      action: "SCMP_ACT_ALLOW",
      args: [],
      includes: {},
      excludes: {},
    });
    const sandboxChrootRule = profile.syscalls?.find(
      (rule) => rule.comment === "Allow Chromium sandbox chroot inside its user namespace",
    );
    expect(sandboxChrootRule).toEqual({
      comment: "Allow Chromium sandbox chroot inside its user namespace",
      names: ["chroot"],
      action: "SCMP_ACT_ALLOW",
      args: [],
      includes: {},
      excludes: {},
    });
  });

  it("applies that profile without broad privilege fallbacks to worker and smoke", async () => {
    const compose = parseYaml(await readFile("worker/compose.yaml", "utf8")) as {
      services?: Record<string, {
        read_only?: unknown;
        cap_drop?: unknown;
        cap_add?: unknown;
        security_opt?: unknown;
        network_mode?: unknown;
        platform?: unknown;
      }>;
    };

    for (const serviceName of ["worker", "renderer-smoke"]) {
      const service = compose.services?.[serviceName];
      expect(service?.read_only).toBe(true);
      expect(service?.cap_drop).toEqual(["ALL"]);
      expect(service?.cap_add).toBeUndefined();
      expect(service?.security_opt).toEqual([
        "no-new-privileges:true",
        "seccomp=./chromium-seccomp.json",
      ]);
      expect(service?.platform).toBe("linux/amd64");
    }
    expect(compose.services?.["renderer-smoke"]?.network_mode).toBe("none");

    const raw = await readFile("worker/compose.yaml", "utf8");
    expect(raw).not.toMatch(/seccomp\s*[:=]\s*unconfined/iu);
    expect(raw).not.toContain("SYS_ADMIN");

    const rendererSource = await readFile("worker/offer-pdf-renderer.ts", "utf8");
    expect(rendererSource).not.toMatch(/\bHOME\s*:/u);

    const processIsolationSource = await readFile("worker/process-isolation.c", "utf8");
    expect(processIsolationSource).toContain("PR_SET_DUMPABLE, 0");
    expect(processIsolationSource).toContain("_exit(127)");
  });
});
