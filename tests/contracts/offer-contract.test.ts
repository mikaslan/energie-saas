import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OFFER_SCHEMA_SHA256,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  canonicalizeOfferJson,
  createOfferCommandV1Schema,
  hashOfferCreateDigest,
  hashOfferVariantSnapshot,
  normalizeOfferSnapshotText,
  offerContactContextV1Schema,
  offerInstallationSiteContextV1Schema,
  renderOfferJsonSchema,
  reviseOfferVariantCommandV1Schema,
  sealOfferVariantSnapshot,
  toOfferVariantView,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/offer.v1.schema.json");

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  offer: "22222222-2222-4222-8222-222222222222",
  variant: "33333333-3333-4333-8333-333333333333",
  line: "44444444-4444-4444-8444-444444444444",
  workspace: "55555555-5555-4555-8555-555555555555",
  contact: "66666666-6666-4666-8666-666666666666",
  site: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  receipt: "99999999-9999-4999-8999-999999999999",
  requirement: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  calculation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  resolution: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  component: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  section: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;

const sha = (digit: string) => digit.repeat(64);

function sourceBindings() {
  return {
    projectId: ids.project,
    contactId: ids.contact,
    siteId: ids.site,
    inboundReceiptId: ids.receipt,
    inboundPayloadSha256: sha("1"),
    requirementId: ids.requirement,
    requirementRevision: 3,
    calculationRevisionId: ids.calculation,
    calculationRevision: 4,
    calculationInputSha256: sha("2"),
    calculationResultSha256: sha("3"),
    resolutionId: ids.resolution,
    resolutionRevision: 5,
    resolutionSha256: sha("4"),
  } as const;
}

function provenance(kind: "technical" | "purchase" | "sales") {
  return {
    sourceKind: kind === "technical" ? "manufacturer_datasheet" as const
      : kind === "purchase" ? "supplier_price_list" as const
        : "workspace_pricing" as const,
    reference: `${kind}-fixture-2026-08`,
    observedOn: "2026-08-30",
    rightsBasis: kind === "technical" ? "manufacturer_published" as const
      : kind === "purchase" ? "supplier_authorized" as const
        : "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
}

function lineDomainId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function snapshotBody(lineCount = 1) {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    lineDomainId: lineDomainId(index + 1),
    position: index + 1,
    componentCategory: "module" as const,
    positionType: "required" as const,
    isHidden: false,
    quantityMilli: 1_000,
    product: {
      kind: "catalog" as const,
      internalSku: `PV-${String(index + 1).padStart(3, "0")}`,
      displayName: `PV-Modul ${index + 1}`,
      manufacturer: "WMEE Testwerk",
      model: `S-${index + 1}`,
      unit: "piece" as const,
      technicalData: {
        schemaVersion: "module.v1" as const,
        nominalPowerWatts: 440,
      },
      image: null,
      datasheet: null,
      technicalProvenance: provenance("technical"),
    },
    source: {
      kind: "catalog" as const,
      catalogComponentId: ids.component,
      catalogComponentRevision: 2,
      componentSnapshotSha256: sha("5"),
      resolutionLineId: lineDomainId(index + 1),
      resolutionId: ids.resolution,
      resolutionRevision: 5,
      resolutionSha256: sha("4"),
      catalogSalesUnitNetCents: 100,
      catalogPurchaseUnitNetCents: 50,
    },
    salesPricing: {
      originalUnitNetCents: 100,
      effectiveUnitNetCents: 100,
      provenance: {
        kind: "catalog_seed" as const,
        catalogProvenance: provenance("sales"),
      },
    },
    purchasePricing: {
      originalUnitNetCents: 50,
      effectiveUnitNetCents: 50,
      provenance: {
        kind: "catalog_seed" as const,
        catalogProvenance: provenance("purchase"),
      },
    },
    lineDiscountBps: 0,
    taxTreatment: "standard_19" as const,
    taxRateBps: 1_900 as const,
    taxDecision: {
      treatment: "standard_19" as const,
      rateBps: 1_900 as const,
      selectedBy: ids.actor,
      selectedAt: "2026-08-30T10:00:00.000Z",
    },
    computed: {
      lineBaseNetCents: 100,
      lineDiscountedNetCents: 100,
      sectionDiscountedNetCents: 100,
      finalSalesNetCents: 100,
      salesTaxCents: 19,
      salesGrossCents: 119,
      purchaseNetCents: 50,
    },
  }));
  return {
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: "offer-jcs.v1" as const,
    workspaceId: ids.workspace,
    offerId: ids.offer,
    variantId: ids.variant,
    revision: 1,
    variantName: "Basis",
    description: null,
    contactContext: {
      displayName: "Mia Müller",
      emailPrimary: "mia@example.test",
      phoneE164: "+491701234567",
    },
    installationSiteContext: {
      addressRevision: 7,
      formattedAddress: "Solstraße 8, 10115 Berlin",
      street: "Solstraße",
      houseNumber: "8",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    sourceBindings: sourceBindings(),
    priceAudienceDecision: {
      audience: "b2c" as const,
      confirmationCode: "b2c_operator_confirmed" as const,
      confirmedBy: ids.actor,
      confirmedAt: "2026-08-30T10:00:00.000Z",
    },
    taxDecision: {
      treatment: "standard_19" as const,
      rateBps: 1_900 as const,
      selectedBy: ids.actor,
      selectedAt: "2026-08-30T10:00:00.000Z",
    },
    currency: "EUR" as const,
    priceBasis: "net" as const,
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    // F16.3 Slice D: v2-Pflichtfeld (null = kein Fix-Rabatt).
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      category: "module" as const,
      title: "PV-Module",
      discountBps: 0,
      lines,
    }],
    totals: {
      basisNetCents: lineCount * 100,
      basisTaxCents: lineCount * 19,
      basisGrossCents: lineCount * 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    createdBy: ids.actor,
    createdAt: "2026-08-30T10:00:00.000Z",
  } as const;
}

function createCommand() {
  return {
    schemaVersion: "offer-create-command.v1",
    projectId: ids.project,
    expectedRequirementRevision: 3,
    expectedCalculationRevision: 4,
    expectedResolutionRevision: 5,
    forecastValueNetCents: 2_500_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: {
      code: "b2c_operator_confirmed",
      confirmed: true,
    },
    taxTreatment: "standard_19",
  } as const;
}

describe("offer.v1 contract", () => {
  it("akzeptiert nur den geschlossenen B2C-Create-Command ohne Serverwahrheiten", () => {
    expect(createOfferCommandV1Schema.safeParse(createCommand()).success).toBe(true);

    for (const [key, value] of [
      ["workspaceId", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["actorId", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ["confirmedAt", "2026-08-30T10:00:00.000Z"],
      ["resolutionSha256", "a".repeat(64)],
      ["basisNetCents", 1],
      ["contactContext", { displayName: "Nicht aus dem Browser" }],
    ] as const) {
      expect(createOfferCommandV1Schema.safeParse({
        ...createCommand(),
        [key]: value,
      }).success, key).toBe(false);
    }

    expect(createOfferCommandV1Schema.safeParse({
      ...createCommand(),
      priceAudience: "b2b",
    }).success).toBe(false);
    expect(createOfferCommandV1Schema.safeParse({
      ...createCommand(),
      priceAudienceConfirmation: undefined,
    }).success).toBe(false);
  });

  it("erzwingt eine frische strukturierte 0-Prozent-Bestaetigung", () => {
    expect(createOfferCommandV1Schema.safeParse({
      ...createCommand(),
      taxTreatment: "zero_operator_confirmed",
      zeroConfirmation: {
        code: "zero_tax_draft_operator_confirmed",
        confirmed: true,
      },
    }).success).toBe(true);

    expect(createOfferCommandV1Schema.safeParse({
      ...createCommand(),
      taxTreatment: "zero_operator_confirmed",
    }).success).toBe(false);
    expect(createOfferCommandV1Schema.safeParse({
      ...createCommand(),
      zeroConfirmation: {
        code: "zero_tax_draft_operator_confirmed",
        confirmed: true,
      },
    }).success).toBe(false);
  });

  it("nimmt im Edit-Command nur kompakte erlaubte Patchoperationen an", () => {
    const valid = {
      schemaVersion: "offer-variant-revise-command.v1",
      offerId: ids.offer,
      variantId: ids.variant,
      expectedRevision: 2,
      operations: [{
        operation: "set_line_sales_price",
        lineDomainId: ids.line,
        salesUnitNetCents: 123_456,
        reasonCode: "customer_specific_pricing",
      }],
    } as const;
    expect(reviseOfferVariantCommandV1Schema.safeParse(valid).success).toBe(true);
    expect(reviseOfferVariantCommandV1Schema.safeParse({
      ...valid,
      totals: { basisNetCents: 1 },
    }).success).toBe(false);
    expect(reviseOfferVariantCommandV1Schema.safeParse({
      ...valid,
      operations: Array.from({ length: 501 }, () => valid.operations[0]),
    }).success).toBe(false);
  });

  it("pinnt exakt die erlaubten Kontakt- und Anlagenstandortfelder", () => {
    const contact = offerContactContextV1Schema.parse({
      displayName: "  Mia Mu\u0308ller  ",
      emailPrimary: "mia@example.test",
      phoneE164: "+491701234567",
    });
    expect(contact).toEqual({
      displayName: "Mia Müller",
      emailPrimary: "mia@example.test",
      phoneE164: "+491701234567",
    });
    expect(offerContactContextV1Schema.safeParse({
      ...contact,
      phoneRaw: "0170 1234567",
    }).success).toBe(false);
    expect(offerContactContextV1Schema.safeParse({
      ...contact,
      emailNormalized: "mia@example.test",
    }).success).toBe(false);

    const site = offerInstallationSiteContextV1Schema.parse({
      addressRevision: 7,
      formattedAddress: "  Solstraße 8, 10115 Berlin ",
      street: "Solstraße",
      houseNumber: "8",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    });
    expect(Object.keys(site).sort()).toEqual([
      "addressRevision",
      "city",
      "country",
      "formattedAddress",
      "houseNumber",
      "postalCode",
      "street",
    ]);
    expect(offerInstallationSiteContextV1Schema.safeParse({
      ...site,
      latitude: 52.5,
    }).success).toBe(false);
  });

  it("normalisiert Snapshot-Text mit NFC und lehnt Leertext ab", () => {
    expect(normalizeOfferSnapshotText("  Gru\u0308nstraße  ")).toBe("Grünstraße");
    expect(() => normalizeOfferSnapshotText(" \t ")).toThrow(TypeError);
    expect(() => normalizeOfferSnapshotText("A\u0000B")).toThrow(TypeError);
    expect(reviseOfferVariantCommandV1Schema.safeParse({
      schemaVersion: "offer-variant-revise-command.v1",
      offerId: ids.offer,
      variantId: ids.variant,
      expectedRevision: 1,
      operations: [{ operation: "set_variant_name", name: "A\u0000B" }],
    }).success).toBe(false);
  });

  it("kanonisiert Unicode und Schluessel deterministisch", () => {
    expect(canonicalizeOfferJson({ z: "Gru\u0308n", a: [2, 1] })).toBe(
      "{\"a\":[2,1],\"z\":\"Grün\"}",
    );
    expect(() => canonicalizeOfferJson("\ud800")).toThrow(TypeError);
  });

  it("bindet den Create-Digest an servergeladene Quellhashes und NFC-Kontexte", () => {
    const material = {
      schemaVersion: "offer-create-digest-material.v1",
      command: createCommand(),
      sourceBindings: sourceBindings(),
      contactContext: snapshotBody().contactContext,
      installationSiteContext: snapshotBody().installationSiteContext,
    } as const;
    const digest = hashOfferCreateDigest(material);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe("43358d5bba0023c4b8e00e6733aea50252e7fac3a0bf05594267b2169a1859e0");
    expect(hashOfferCreateDigest({
      ...material,
      contactContext: {
        ...material.contactContext,
        displayName: "  Mia Mu\u0308ller  ",
      },
    })).toBe(digest);
    expect(hashOfferCreateDigest({
      ...material,
      sourceBindings: { ...material.sourceBindings, resolutionSha256: sha("9") },
    })).not.toBe(digest);

    const uppercaseUuid = {
      ...material,
      sourceBindings: {
        ...material.sourceBindings,
        resolutionId: material.sourceBindings.resolutionId.toUpperCase(),
      },
    };
    expect(hashOfferCreateDigest(uppercaseUuid)).toBe(digest);
    const omittedForecast = structuredClone(material) as Record<string, unknown>;
    const command = { ...(omittedForecast.command as Record<string, unknown>) };
    delete command.forecastValueNetCents;
    omittedForecast.command = command;
    expect(hashOfferCreateDigest(omittedForecast)).not.toBe(digest);
    expect(hashOfferCreateDigest({
      ...omittedForecast,
      command: { ...command, forecastValueNetCents: null },
    })).toBe(hashOfferCreateDigest(omittedForecast));
  });

  it("versiegelt einen vollstaendigen Snapshot und erkennt semantische Summenmanipulation", () => {
    const snapshot = sealOfferVariantSnapshot(snapshotBody());
    expect(validateOfferVariantSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(snapshot.snapshotSha256).toBe(hashOfferVariantSnapshot(snapshot));
    // F16.3 Slice D: v2-Siegel (Fix-Key null + v2-Literal) — per Renderer
    // deterministisch abgeleitet, kein Rateversuch.
    expect(snapshot.snapshotSha256).toBe(
      "b11fae1dd125d560dccce21fdee39c0f5baa33e8a5dff3e76537ab13eebe8f1e",
    );

    const manipulated = structuredClone(snapshot);
    manipulated.totals.basisNetCents += 1;
    expect(() => hashOfferVariantSnapshot(manipulated)).toThrow(TypeError);
    expect(validateOfferVariantSnapshot(manipulated)).toMatchObject({ ok: false });
  });

  it("akzeptiert 500 Seed-Zeilen ohne Kuerzung und weist 501 atomar ab", () => {
    const maximum = sealOfferVariantSnapshot(snapshotBody(500));
    expect(maximum.sections[0]?.lines).toHaveLength(500);
    expect(validateOfferVariantSnapshot(maximum).ok).toBe(true);
    expect(() => sealOfferVariantSnapshot(snapshotBody(501))).toThrow(TypeError);
  });

  it("redigiert EK, Marge und private Vollhashes strukturell im Viewer-DTO", () => {
    const snapshot = sealOfferVariantSnapshot(snapshotBody());
    const publicView = toOfferVariantView(snapshot, {
      canReadPurchasePrice: false,
      canReadPrivateHashes: false,
    });
    const serializedPublic = JSON.stringify(publicView);
    expect(serializedPublic).not.toContain("purchasePricing");
    expect(serializedPublic).not.toContain("purchaseNetCents");
    expect(serializedPublic).not.toContain("marginNetCents");
    expect(serializedPublic).not.toContain("Sha256");
    expect(serializedPublic).not.toContain(sha("1"));

    const privateView = toOfferVariantView(snapshot, {
      canReadPurchasePrice: true,
      canReadPrivateHashes: true,
    });
    const serializedPrivate = JSON.stringify(privateView);
    expect(serializedPrivate).toContain("purchasePricing");
    expect(serializedPrivate).toContain("purchaseNetCents");
    expect(serializedPrivate).toContain("marginNetCents");
    expect(serializedPrivate).toContain("snapshotSha256");
    expect(privateView.snapshot.snapshotSha256).toBe(snapshot.snapshotSha256);
    expect(() => toOfferVariantView(snapshot, {
      canReadPurchasePrice: false,
      canReadPrivateHashes: true,
    })).toThrow(TypeError);
  });

  it("haelt Katalogoriginal, Override und technische Herkunft widerspruchsfrei", () => {
    const wrongOriginal = structuredClone(snapshotBody());
    wrongOriginal.sections[0]!.lines[0]!.salesPricing.originalUnitNetCents = 99;
    expect(() => sealOfferVariantSnapshot(wrongOriginal)).toThrow(TypeError);

    const fakeSeedOverride = structuredClone(snapshotBody());
    fakeSeedOverride.sections[0]!.lines[0]!.salesPricing.effectiveUnitNetCents = 99;
    expect(() => sealOfferVariantSnapshot(fakeSeedOverride)).toThrow(TypeError);

    const wrongTechnicalFamily = structuredClone(snapshotBody()) as unknown as {
      sections: Array<{ lines: Array<{ product: Record<string, unknown> }> }>;
    };
    wrongTechnicalFamily.sections[0]!.lines[0]!.product.technicalData = {
      schemaVersion: "battery.v1",
      nominalCapacityWh: 10_000,
      usableCapacityWh: 9_000,
      maxContinuousPowerWatts: 5_000,
      roundTripEfficiencyBasisPoints: 9_500,
      backupCapability: "unknown",
    };
    expect(() => sealOfferVariantSnapshot(wrongTechnicalFamily)).toThrow(TypeError);

    const wrongAssetRole = structuredClone(snapshotBody()) as unknown as {
      sections: Array<{ lines: Array<{ product: Record<string, unknown> }> }>;
    };
    wrongAssetRole.sections[0]!.lines[0]!.product.image = {
      role: "datasheet",
      objectKey: `catalog/${ids.workspace}/${ids.component}/${sha("6")}.pdf`,
      sha256: sha("6"),
      mediaType: "application/pdf",
      originalFilename: "falsche-rolle.pdf",
    };
    expect(() => sealOfferVariantSnapshot(wrongAssetRole)).toThrow(TypeError);
  });

  it("modelliert freie Klartextzeilen ohne erfundene Katalogfelder", () => {
    const custom = structuredClone(snapshotBody()) as unknown as {
      sections: Array<{ lines: Array<Record<string, unknown>> }>;
    };
    const target = custom.sections[0]!.lines[0]!;
    target.componentCategory = "other";
    target.product = {
      kind: "custom",
      displayName: "Individuelle Gerueststellung",
      description: "Synthetische Testposition",
      unit: "set",
    };
    target.source = {
      kind: "custom",
      enteredBy: ids.actor,
      enteredAt: "2026-08-30T10:00:00.000Z",
    };
    const customProvenance = {
      kind: "custom",
      enteredBy: ids.actor,
      enteredAt: "2026-08-30T10:00:00.000Z",
    };
    target.salesPricing = {
      originalUnitNetCents: 100,
      effectiveUnitNetCents: 100,
      provenance: customProvenance,
    };
    target.purchasePricing = {
      originalUnitNetCents: 50,
      effectiveUnitNetCents: 50,
      provenance: customProvenance,
    };
    custom.sections[0]!.lines[0] = target;
    (custom.sections[0] as unknown as Record<string, unknown>).category = "other";
    expect(sealOfferVariantSnapshot(custom).sections[0]!.lines[0]!.source.kind).toBe("custom");
  });

  it("fordert je Zeile eine passende Steuerentscheidung und eindeutige Position", () => {
    const unconfirmedZero = structuredClone(snapshotBody()) as unknown as {
      sections: Array<{ lines: Array<Record<string, unknown>> }>;
    };
    const target = unconfirmedZero.sections[0]!.lines[0]!;
    target.taxTreatment = "zero_operator_confirmed";
    target.taxRateBps = 0;
    delete target.taxDecision;
    expect(() => sealOfferVariantSnapshot(unconfirmedZero)).toThrow(TypeError);

    const duplicatePosition = structuredClone(snapshotBody(2));
    duplicatePosition.sections[0]!.lines[1]!.position = 1;
    expect(() => sealOfferVariantSnapshot(duplicatePosition)).toThrow(TypeError);
  });

  it("drueckt Custom-Section, freie Zeile und frische Steueränderung im Patch aus", () => {
    const command = {
      schemaVersion: "offer-variant-revise-command.v1",
      offerId: ids.offer,
      variantId: ids.variant,
      expectedRevision: 2,
      operations: [
        {
          operation: "add_custom_section",
          sectionDomainId: ids.section,
          position: 2,
          title: "Montageleistungen",
          category: "other",
        },
        {
          operation: "add_custom_line",
          lineDomainId: ids.line,
          sectionDomainId: ids.section,
          position: 1,
          displayName: "Gerueststellung",
          description: null,
          unit: "set",
          quantityMilli: 1_000,
          salesUnitNetCents: 100_000,
          purchaseUnitNetCents: 50_000,
          positionType: "additional",
          isHidden: false,
          taxTreatment: "standard_19",
        },
        {
          operation: "set_line_tax",
          lineDomainId: ids.line,
          taxTreatment: "zero_operator_confirmed",
          zeroConfirmation: {
            code: "zero_tax_draft_operator_confirmed",
            confirmed: true,
          },
        },
      ],
    };
    expect(reviseOfferVariantCommandV1Schema.safeParse(command).success).toBe(true);
  });

  it("aendert Metadaten einer bestehenden freien Zeile mit einem geschlossenen Command", () => {
    const command = {
      schemaVersion: "offer-variant-revise-command.v1",
      offerId: ids.offer,
      variantId: ids.variant,
      expectedRevision: 2,
      operations: [{
        operation: "set_custom_line_details",
        lineDomainId: ids.line,
        displayName: "Individuelle Gerueststellung",
        description: "Mit Seitenschutz",
        unit: "set",
      }],
    };
    expect(reviseOfferVariantCommandV1Schema.safeParse(command).success).toBe(true);
    expect(reviseOfferVariantCommandV1Schema.safeParse({
      ...command,
      operations: [{ ...command.operations[0], internalSku: "forbidden" }],
    }).success).toBe(false);
    expect(reviseOfferVariantCommandV1Schema.safeParse({
      ...command,
      operations: [{ ...command.operations[0], displayName: "  " }],
    }).success).toBe(false);
  });

  it("haelt das generierte JSON-Schema bytegenau und hashbar", () => {
    const rendered = renderOfferJsonSchema();
    expect(readFileSync(schemaPath, "utf8")).toBe(rendered);
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      OFFER_SCHEMA_SHA256,
    );
  });
});
