import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import {
  OfferPdfRenderError,
} from "@/worker/offer-pdf-renderer";
import {
  createPlaywrightOfferReleaseCandidateRenderer,
} from "@/worker/offer-release-candidate-renderer";

const PREPARED_AT = "2026-08-30T11:22:33.000Z";

function syntheticLegalText(label: string): string {
  return Array.from({ length: 48 }, (_unused, index) =>
    `${label} – synthetischer Prüfabsatz ${String(index + 1).padStart(2, "0")}. `
    + "Dieser ausschließlich künstliche Inhalt prüft Zeilenumbrüche, Seitenwechsel "
    + "und wiederholte Statuskennzeichnung ohne reale Firmen-, Kunden- oder Rechtsdaten.")
    .join("\n\n");
}

function validInput(): OfferReleaseCandidateInputV1 {
  return {
    schemaVersion: "offer-release-candidate-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-release-candidate-template.v1",
    rendererRecipeVersion: "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    documentStatus: "not_issued",
    preparedAt: PREPARED_AT,
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: {
      name: "Synthetisches Angebotsprofil",
      revision: 4,
    },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: "Beispiel Energie",
      representedBy: "Erika Beispiel",
      address: {
        street: "Sonnenstrasse",
        houseNumber: "12",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "angebot@beispiel.invalid",
      contactPhone: "+49301234567",
      website: "https://angebot.beispiel.invalid",
      registerCourt: "Amtsgericht Berlin-Charlottenburg",
      registerNumber: "HRB 123456 B",
      vatId: "DE123456789",
    },
    recipient: {
      displayName: "Mia Muster",
      company: null,
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "7",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Rechnungsweg 7, 10117 Berlin",
      },
    },
    installationSite: {
      formattedAddress: "Solarweg 8, 10115 Berlin",
    },
    variant: {
      name: "Komfort und Autarkie",
      revision: 7,
    },
    commercialTerms: {
      globalDiscountBps: 0,
      globalFixDiscountCents: null,
      customDealNetCents: null,
    },
    sections: [{
      position: 1,
      title: "Photovoltaik",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "PV-Anlage und Montage",
        description: "Montage und Inbetriebnahme",
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
        title: "Allgemeine Geschaeftsbedingungen",
        plainText: "Testbedingungen fuer den Freigabekandidaten.",
      },
      withdrawalInformation: {
        title: "Widerrufsinformation",
        plainText: "Testinformation zum Widerruf.",
      },
      privacyNotice: {
        title: "Datenschutzhinweise",
        plainText: "Testinformation zum Datenschutz.",
      },
    },
  };
}

describe("M2-03a offer release candidate renderer", () => {
  it("rejects unknown fields and a non-release recipe before Chromium is needed", async () => {
    const renderer = createPlaywrightOfferReleaseCandidateRenderer();
    const unknownField = { ...validInput(), workspaceId: "private" };
    const wrongRecipe = {
      ...validInput(),
      rendererRecipeVersion:
        "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    };

    for (const invalid of [unknownField, wrongRecipe]) {
      await expect(renderer.render(invalid as OfferReleaseCandidateInputV1))
        .rejects.toMatchObject({
          name: "OfferPdfRenderError",
          message: "offer PDF render failed",
          code: "invalid_input",
          retryable: false,
        });
    }
  });

  it.skipIf(process.platform === "linux" && process.arch === "x64")(
    "rejects a production render outside the exact linux/amd64 recipe",
    async () => {
      await expect(createPlaywrightOfferReleaseCandidateRenderer().render(validInput()))
        .rejects.toMatchObject({
          name: "OfferPdfRenderError",
          message: "offer PDF render failed",
          code: "browser_unavailable",
          retryable: true,
        });
    },
  );

  it("renders the sealed release template as tagged, outlined A4 PDF and seals its envelope", async () => {
    const renderer = createPlaywrightOfferReleaseCandidateRenderer({
      allowUnpinnedRuntimeForVerification: true,
    });

    const input = validInput();
    input.legalDocuments.terms.plainText = syntheticLegalText("Testbedingungen");
    input.legalDocuments.withdrawalInformation.plainText = syntheticLegalText(
      "Widerrufsinformation",
    );
    input.legalDocuments.privacyNotice.plainText = syntheticLegalText(
      "Datenschutzhinweis",
    );
    const result = await renderer.render(input);
    const repeated = await renderer.render(structuredClone(input));
    const latin1 = result.bytes.toString("latin1");

    expect(repeated.bytes.equals(result.bytes)).toBe(true);
    expect(repeated.sha256).toBe(result.sha256);
    expect(repeated.sizeBytes).toBe(result.sizeBytes);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(result.bytes.length);
    expect(result.sizeBytes).toBeGreaterThanOrEqual(100);
    expect(result.sizeBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(latin1).toMatch(/%%EOF[\t\r\n ]*$/u);
    expect(latin1).toContain("/CreationDate (D:20260830112233+00'00')");
    expect(latin1).toContain("/ModDate (D:20260830112233+00'00')");
    expect(latin1).toContain("/StructTreeRoot");
    expect(latin1).toContain("/MarkInfo");
    expect(latin1).toContain("/Outlines");
    expect(latin1.match(/\/Type\s*\/Page\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(6);
    const coordinate = "([+-]?[0-9]+(?:\\.[0-9]+)?)";
    const mediaBoxPattern = new RegExp(
      `/MediaBox\\s*\\[\\s*${coordinate}\\s+${coordinate}\\s+${coordinate}\\s+${coordinate}\\s*\\]`,
      "gu",
    );
    const mediaBoxes = [...latin1.matchAll(mediaBoxPattern)];
    expect(mediaBoxes.length).toBeGreaterThan(0);
    for (const mediaBox of mediaBoxes) {
      const width = Math.abs(Number(mediaBox[3]) - Number(mediaBox[1]));
      const height = Math.abs(Number(mediaBox[4]) - Number(mediaBox[2]));
      expect(Math.abs(width - 595.28)).toBeLessThanOrEqual(2);
      expect(Math.abs(height - 841.89)).toBeLessThanOrEqual(2);
    }
    expect(result.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex"),
    );
  }, 60_000);

  it("keeps JavaScript disabled and fails closed on direct and print-only network attempts", async () => {
    const scriptProbe = createPlaywrightOfferReleaseCandidateRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => `<!doctype html><html><body>
<h1>JavaScript probe</h1>
<script>fetch("https://script.invalid/probe")</script>
</body></html>`,
    });
    const networkProbe = createPlaywrightOfferReleaseCandidateRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => `<!doctype html><html><body>
<img src="https://candidate.invalid/probe.png" alt="">
</body></html>`,
    });
    const printProbe = createPlaywrightOfferReleaseCandidateRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => `<!doctype html><html><head><style>
@media print { body { background-image: url("https://print.invalid/probe.png"); } }
</style></head><body><h1>Print probe</h1></body></html>`,
    });

    await expect(scriptProbe.render(validInput())).resolves.toMatchObject({
      mimeType: "application/pdf",
    });
    await expect(networkProbe.render(validInput())).rejects.toMatchObject({
      name: "OfferPdfRenderError",
      message: "offer PDF render failed",
      code: "network_attempted",
      retryable: false,
    });
    await expect(printProbe.render(validInput())).rejects.toMatchObject({
      name: "OfferPdfRenderError",
      message: "offer PDF render failed",
      code: "network_attempted",
      retryable: false,
    });
  }, 60_000);

  it("never exposes document input through renderer errors", async () => {
    const marker = "PRIVATE-CUSTOMER-MARKER";
    const renderer = createPlaywrightOfferReleaseCandidateRenderer({
      allowUnpinnedRuntimeForVerification: true,
      htmlRenderer: () => {
        throw new Error(marker);
      },
    });

    try {
      await renderer.render(validInput());
      throw new Error("expected renderer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OfferPdfRenderError);
      expect((error as Error).message).toBe("offer PDF render failed");
      expect(String(error)).not.toContain(marker);
      expect((error as OfferPdfRenderError).code).toBe("invalid_input");
    }
  });
});
