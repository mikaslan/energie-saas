import { describe, expect, it } from "vitest";

import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import {
  buildOfferIssuanceInput,
  type OfferIssuanceInputV1,
} from "@/lib/integrations/offers/issuance-contract";
import { renderOfferIssuanceHtml } from "@/lib/integrations/offers/issuance-template";

const sha = (digit: string) => digit.repeat(64);

function candidateInputFixture(lineCount = 3): OfferReleaseCandidateInputV1 {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    position: index + 1,
    title: index === 0
      ? "Montage <script>alert('x')</script> & Inbetriebnahme"
      : `Sehr lange Position ${index + 1} ${"Wort".repeat(index === lineCount - 1 ? 25 : 1)}`,
    description: index === 0
      ? "Nur Text: <img src=https://evil.invalid/x onerror=alert(1)> & url(https://evil.invalid)"
      : null,
    quantityMilli: index === 1 ? 2_500 : 1_000,
    unit: index === 1 ? "meter" as const : "piece" as const,
    positionType: index === 2
      ? "optional" as const
      : index === 1
        ? "additional" as const
        : "required" as const,
    salesUnitNetCents: index === 2 ? 20_000 : 10_000,
    lineDiscountBps: index === 0 ? 500 : 0,
    taxRateBps: index === 1 ? 0 as const : 1_900 as const,
    finalNetCents: index === 2 ? 20_000 : 10_000,
    taxCents: index === 1 ? 0 : index === 2 ? 3_800 : 1_900,
    grossCents: index === 1 ? 10_000 : index === 2 ? 23_800 : 11_900,
  }));
  const basisLines = lines.filter((line) => line.positionType !== "optional");
  const optionalLines = lines.filter((line) => line.positionType === "optional");
  const total = (values: typeof lines, field: "finalNetCents" | "taxCents" | "grossCents") =>
    values.reduce((sum, line) => sum + line[field], 0);

  return {
    schemaVersion: "offer-release-candidate-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-release-candidate-template.v1",
    rendererRecipeVersion: "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: { name: "Synthetisches Angebotsprofil <Final>", revision: 4 },
    sender: {
      legalName: "Beispiel Energie GmbH <Test>",
      tradingName: "Beispiel Energie",
      representedBy: "Mia Musterfrau & Max Mustermann",
      address: {
        street: "Sonnenstraße",
        houseNumber: "12 <A>",
        postalCode: "10115",
        city: "Berlin & Mitte",
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
      displayName: "Mia & Max <Muster>",
      company: "Musterhaus & Partner GbR",
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "7 & 8",
        postalCode: "10117",
        city: "Berlin <Zentrum>",
        country: "DE",
        formattedAddress: "Rechnungsweg 7 & 8, 10117 Berlin <Zentrum>",
      },
    },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: { name: "Komfort & Autarkie <Plus>", revision: 7 },
    commercialTerms: { globalDiscountBps: 250, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{ position: 1, title: "PV-Anlage & Zubehör <Süd>", discountBps: 100, lines }],
    totals: {
      basisNetCents: total(basisLines, "finalNetCents"),
      basisTaxCents: total(basisLines, "taxCents"),
      basisGrossCents: total(basisLines, "grossCents"),
      optionalNetCents: total(optionalLines, "finalNetCents"),
      optionalTaxCents: total(optionalLines, "taxCents"),
      optionalGrossCents: total(optionalLines, "grossCents"),
    },
    legalDocuments: {
      terms: {
        title: "Allgemeine Geschäftsbedingungen & Hinweise",
        plainText: "1. Nur Text <script>alert(1)</script>\n2. Bedingungen für die Ausführung.",
      },
      withdrawalInformation: {
        title: "Widerrufsinformation",
        plainText: "Information über ein mögliches Widerrufsrecht.",
      },
      privacyNotice: {
        title: "Datenschutzhinweise",
        plainText: "Personenbezogene Daten werden nur zweckgebunden verarbeitet.",
      },
    },
  };
}

function issuanceInputFixture(lineCount = 3): OfferIssuanceInputV1 {
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
      candidateArtifactSha256: sha("1"),
      candidateArtifactSizeBytes: 12_345,
      variantId: "88888888-8888-4888-8888-888888888888",
      variantRevisionId: "99999999-9999-4999-8999-999999999999",
      variantRevision: 7,
      variantSnapshotSha256: sha("2"),
      profileActivationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      profileRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      profileRevision: 4,
      profileSnapshotSha256: sha("3"),
      recipientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      recipientRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      recipientRevision: 3,
      recipientSnapshotSha256: sha("4"),
    },
    candidateInput: candidateInputFixture(lineCount),
  });
}

function fiveHundredLineFixture(): OfferIssuanceInputV1 {
  const candidate = candidateInputFixture(1);
  candidate.sections[0]!.lines = Array.from({ length: 500 }, (_, index) => ({
    position: index + 1,
    title: `Leistungsposition ${index + 1} ${"Belastungstest".repeat(8)}`,
    description: index % 2 === 0
      ? `Technische Beschreibung ${index + 1} ${"mit langem Inhalt ".repeat(10)}`
      : null,
    quantityMilli: 1_000,
    unit: "piece" as const,
    positionType: "required" as const,
    salesUnitNetCents: 100,
    lineDiscountBps: 0,
    taxRateBps: 1_900 as const,
    finalNetCents: 100,
    taxCents: 19,
    grossCents: 119,
  }));
  candidate.totals = {
    basisNetCents: 50_000,
    basisTaxCents: 9_500,
    basisGrossCents: 59_500,
    optionalNetCents: 0,
    optionalTaxCents: 0,
    optionalGrossCents: 0,
  };
  return issuanceInputFixtureFromCandidate(candidate);
}

function issuanceInputFixtureFromCandidate(candidateInput: OfferReleaseCandidateInputV1) {
  const base = issuanceInputFixture(1);
  return buildOfferIssuanceInput({
    issuanceId: base.issuanceId,
    preparedAt: base.preparedAt,
    sourceBinding: {
      workspaceId: base.source.workspaceId,
      projectId: base.source.projectId,
      offerId: base.source.offerId,
      candidateId: base.source.candidateId,
      candidateApprovalId: base.source.candidateApprovalId,
      candidateApprovedAt: base.source.candidateApprovedAt,
      candidateArtifactVersion: base.source.candidateArtifactVersion,
      candidateArtifactSha256: base.source.candidateArtifactSha256,
      candidateArtifactSizeBytes: base.source.candidateArtifactSizeBytes,
      variantId: base.source.variant.id,
      variantRevisionId: base.source.variant.revisionId,
      variantRevision: base.source.variant.revision,
      variantSnapshotSha256: base.source.variant.snapshotSha256,
      profileActivationId: base.source.profile.activationId,
      profileId: base.source.profile.id,
      profileRevisionId: base.source.profile.revisionId,
      profileRevision: base.source.profile.revision,
      profileSnapshotSha256: base.source.profile.snapshotSha256,
      recipientId: base.source.recipient.id,
      recipientRevisionId: base.source.recipient.revisionId,
      recipientRevision: base.source.recipient.revision,
      recipientSnapshotSha256: base.source.recipient.snapshotSha256,
    },
    candidateInput,
  });
}

describe("offer issuance HTML template", () => {
  it("rendert deterministisches semantisches A4-HTML als finales Angebot", () => {
    const input = issuanceInputFixture();
    const first = renderOfferIssuanceHtml(input);
    const second = renderOfferIssuanceHtml(structuredClone(input));

    expect(first).toBe(second);
    expect(first).toMatch(/^<!doctype html>/u);
    expect(first).toContain('<html lang="de">');
    expect(first).toContain("@page { size: A4;");
    expect(first).toContain("<title>Angebot ANG-2026-000042</title>");
    expect(first).toContain('<div class="document-kind">Angebot</div>');
    expect(first).toContain("thead { display: table-header-group; }");
    expect(first).toMatch(/tr \{[^}]*break-inside: avoid/u);
    expect(first).not.toMatch(/freigabekandidat|entwurf|nicht[ -]ausgestellt|not_issued/iu);
    expect(first).not.toContain("offer-release-candidate-");
    expect(first).not.toMatch(/Reonic/iu);
  });

  it("escaped alle Inhalte und bindet keine externen Ressourcen oder aktiven Elemente ein", () => {
    const html = renderOfferIssuanceHtml(issuanceInputFixture());

    expect(html).toContain("Montage &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; Inbetriebnahme");
    expect(html).toContain("&lt;img src=https://evil.invalid/x onerror=alert(1)&gt;");
    expect(html).toContain("Nur Text &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script[\s>]/iu);
    expect(html).not.toMatch(/<(?:a|img|link|iframe|object|embed|video|audio|source)\b/iu);
    const markupOnly = html.match(/<[^>]*>/gu)?.join("\n") ?? "";
    expect(markupOnly).not.toMatch(/\s(?:src|href)\s*=/iu);
    const style = html.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
    expect(style).not.toMatch(/url\s*\(/iu);
    expect(html).toContain("default-src &#39;none&#39;");
  });

  it("zeigt Kundenparteien, Standort, Leistungen, Steuern und getrennte Optionssummen", () => {
    const html = renderOfferIssuanceHtml(issuanceInputFixture());
    const senderIndex = html.indexOf("Aussteller");
    const recipientIndex = html.indexOf("Empfänger und Rechnungsadresse");
    const siteIndex = html.indexOf("Anlagenstandort");
    const baseStart = html.indexOf("Basisleistungen");
    const optionalStart = html.indexOf("Optionale Leistungen");

    expect(senderIndex).toBeGreaterThan(-1);
    expect(recipientIndex).toBeGreaterThan(senderIndex);
    expect(siteIndex).toBeGreaterThan(recipientIndex);
    expect(baseStart).toBeGreaterThan(siteIndex);
    expect(optionalStart).toBeGreaterThan(baseStart);
    expect(html).toContain("Beispiel Energie GmbH &lt;Test&gt;");
    expect(html).toContain("Mia &amp; Max &lt;Muster&gt;");
    expect(html).toContain("Solstraße 8, 10115 Berlin");
    expect(html).toContain("19&nbsp;%");
    expect(html).toContain("0&nbsp;%");
    expect(html).toContain("Basis brutto");
    expect(html).toContain("219,00&nbsp;€");
    expect(html).toContain("Optionen brutto");
    expect(html).toContain("238,00&nbsp;€");
    expect(html).toContain("nicht in der Basissumme enthalten");
  });

  it("rendert Rechtstexte und fachliche Revisionsreferenzen ohne interne IDs oder Hashes", () => {
    const html = renderOfferIssuanceHtml(issuanceInputFixture());

    expect(html).toContain("Rechtliche Dokumente");
    expect(html).toContain("Allgemeine Geschäftsbedingungen &amp; Hinweise");
    expect(html).toContain("Widerrufsinformation");
    expect(html).toContain("Datenschutzhinweise");
    expect(html).toContain("Profilrevision 4");
    expect(html).toContain("Variantenrevision 7");
    expect(html).toContain("Empfängerrevision 3");
    expect(html).not.toContain("77777777-7777-4777-8777-777777777777");
    expect(html).not.toContain(sha("1"));
  });

  it("rendert 500 lange Tabellenzeilen vollständig und mehrseitentauglich", () => {
    const html = renderOfferIssuanceHtml(fiveHundredLineFixture());

    expect(html.match(/data-offer-line=/gu)).toHaveLength(500);
    expect(html).toContain("Leistungsposition 500");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("page-break-inside: avoid");
    expect(html).toContain("table-layout: fixed");
  });

  it("verweigert unbekannten oder inkonsistenten typumgangenen Input", () => {
    const unknownField = {
      ...issuanceInputFixture(),
      issued: true,
    } as OfferIssuanceInputV1;
    const inconsistent = structuredClone(issuanceInputFixture());
    inconsistent.document.totals.basisGrossCents += 1;

    expect(() => renderOfferIssuanceHtml(unknownField)).toThrow(/Ausstellungsfassung/iu);
    expect(() => renderOfferIssuanceHtml(inconsistent)).toThrow(/Ausstellungsfassung/iu);
  });
});
