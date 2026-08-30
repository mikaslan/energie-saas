import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { m203b1IssuanceInput } from "@/tests/helpers/m203b1-offer-issuance-fixture";
import { OfferPdfRenderError } from "@/worker/offer-pdf-renderer";
import {
  createPlaywrightOfferIssuanceRenderer,
} from "@/worker/offer-issuance-renderer";

describe("M2-03b1 offer issuance renderer", () => {
  it("rejects unknown input and a non-issuance recipe before Chromium", async () => {
    const renderer = createPlaywrightOfferIssuanceRenderer();
    const input = m203b1IssuanceInput();
    for (const invalid of [
      { ...input, archiveBucket: "private" },
      { ...input, rendererRecipeVersion: input.source.candidateRendererRecipeVersion },
    ]) await expect(renderer.render(invalid as typeof input)).rejects.toMatchObject({
      name: "OfferPdfRenderError",
      code: "invalid_input",
      retryable: false,
    });
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")(
    "rejects production rendering outside the pinned linux/amd64 recipe",
    async () => {
      await expect(createPlaywrightOfferIssuanceRenderer().render(
        m203b1IssuanceInput(),
      )).rejects.toMatchObject({ code: "browser_unavailable", retryable: true });
    },
  );

  it("renders deterministic tagged A4 final bytes under the issuance timestamp", async () => {
    const renderer = createPlaywrightOfferIssuanceRenderer({
      allowUnpinnedRuntimeForVerification: true,
    });
    const input = m203b1IssuanceInput();
    const first = await renderer.render(input);
    const second = await renderer.render(structuredClone(input));
    const latin1 = first.bytes.toString("latin1");

    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(first.mimeType).toBe("application/pdf");
    expect(first.sizeBytes).toBe(first.bytes.length);
    expect(first.sizeBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(latin1).toContain("/CreationDate (D:20260830103100+00'00')");
    expect(latin1).toContain("/StructTreeRoot");
    expect(latin1).toContain("/MarkInfo");
    expect(latin1).toContain("/Outlines");
    expect(first.sha256).toBe(createHash("sha256").update(first.bytes).digest("hex"));
  }, 60_000);

  it("keeps JavaScript disabled, blocks all network and sanitizes template errors", async () => {
    const script = createPlaywrightOfferIssuanceRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => "<html><body><script>fetch('https://private.invalid')</script></body></html>",
    });
    await expect(script.render(m203b1IssuanceInput())).resolves.toMatchObject({
      mimeType: "application/pdf",
    });

    const network = createPlaywrightOfferIssuanceRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => "<html><body><img src='https://private.invalid/a.png'></body></html>",
    });
    await expect(network.render(m203b1IssuanceInput())).rejects.toMatchObject({
      code: "network_attempted",
      retryable: false,
    });

    const marker = "PRIVATE_RECIPIENT_SENTINEL";
    const failure = createPlaywrightOfferIssuanceRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => { throw new Error(marker); },
    });
    try {
      await failure.render(m203b1IssuanceInput());
      throw new Error("expected renderer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OfferPdfRenderError);
      expect((error as Error).message).toBe("offer PDF render failed");
      expect(String(error)).not.toContain(marker);
    }
  }, 60_000);
});
