import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  CATALOG_SCHEMA_SHA256,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  canonicalizeCatalogJson,
  deriveProjectCatalogResolutionSummary,
  hashCatalogComponentRevision,
  hashProjectCatalogResolution,
  normalizeCatalogSku,
  renderCatalogJsonSchema,
  resolveProjectCatalogCommandV1Schema,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  toCatalogComponentView,
  toProjectCatalogResolutionView,
  validateCatalogComponentRevision,
  validateProjectCatalogResolution,
  type CatalogComponentRevisionV1,
  type ProjectCatalogResolutionLineV1,
} from "@/lib/integrations/catalog/contract";
import { deriveCatalogSelectionPreview } from "@/lib/integrations/catalog/selection";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/catalog.v1.schema.json");

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  requirement: "44444444-4444-4444-8444-444444444444",
  calculation: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
  module: "77777777-7777-4777-8777-777777777777",
  inverter: "88888888-8888-4888-8888-888888888888",
  battery: "99999999-9999-4999-8999-999999999999",
  wallbox: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  heatPump: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mounting: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  other: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

function provenance(kind: "technical" | "purchase" | "sales") {
  return {
    sourceKind: kind === "technical" ? "manufacturer_datasheet" as const
      : kind === "purchase" ? "supplier_price_list" as const
        : "workspace_pricing" as const,
    reference: `${kind}-fixture-2026-08`,
    observedOn: "2026-08-29",
    rightsBasis: kind === "sales" ? "workspace_owned" as const
      : kind === "technical" ? "manufacturer_published" as const
        : "supplier_authorized" as const,
    sourceDocumentSha256: null,
  };
}

function component(input: {
  id: string;
  revision?: number;
  sku: string;
  componentType:
    | "module"
    | "inverter"
    | "battery"
    | "wallbox"
    | "heat_pump"
    | "mounting"
    | "other";
  technicalData: Record<string, unknown>;
  purchase: number;
  sales: number;
}): CatalogComponentRevisionV1 {
  return sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: ids.workspace,
      componentId: input.id,
      revision: input.revision ?? 1,
      internalSku: input.sku,
      componentType: input.componentType,
    },
    presentation: {
      displayName: `${input.componentType} Fixture`,
      manufacturer: "WMEE Testwerk",
      model: `Modell ${input.sku}`,
      unit: "piece",
      keyPoints: ["Eigene synthetische Testkomponente"],
      image: null,
      datasheet: null,
    },
    technicalData: input.technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: input.purchase,
      salesPriceNetCents: input.sales,
      purchaseProvenance: provenance("purchase"),
      salesProvenance: provenance("sales"),
    },
    technicalProvenance: provenance("technical"),
  });
}

function coherentlyRehashComponent(value: Record<string, unknown>): void {
  const body = { ...value };
  delete body.snapshotSha256;
  value.snapshotSha256 = createHash("sha256")
    .update(canonicalizeCatalogJson(body), "utf8")
    .digest("hex");
}

function resealComponent(
  value: CatalogComponentRevisionV1,
  mutate: (body: Record<string, unknown>) => void,
): CatalogComponentRevisionV1 {
  const body = structuredClone(value) as unknown as Record<string, unknown>;
  delete body.snapshotSha256;
  mutate(body);
  return sealCatalogComponentRevision(body);
}

const pvModule = () => component({
  id: ids.module,
  sku: "PV-440-BLK",
  componentType: "module",
  technicalData: {
    schemaVersion: "module.v1",
    nominalPowerWatts: 440,
  },
  purchase: 7_900,
  sales: 12_900,
});

const inverter = () => component({
  id: ids.inverter,
  sku: "INV-10K-3P",
  componentType: "inverter",
  technicalData: {
    schemaVersion: "inverter.v1",
    nominalAcPowerWatts: 10_000,
    phaseCount: 3,
    mpptTrackerCount: 3,
  },
  purchase: 95_000,
  sales: 145_000,
});

const battery = () => component({
  id: ids.battery,
  sku: "BAT-10-0",
  componentType: "battery",
  technicalData: {
    schemaVersion: "battery.v1",
    nominalCapacityWh: 10_600,
    usableCapacityWh: 10_000,
    maxContinuousPowerWatts: 5_000,
    roundTripEfficiencyBasisPoints: 9_500,
    backupCapability: "unknown",
  },
  purchase: 310_000,
  sales: 489_000,
});

const wallbox = () => component({
  id: ids.wallbox,
  sku: "WB-11-T2",
  componentType: "wallbox",
  technicalData: {
    schemaVersion: "wallbox.v1",
    maxChargingPowerWatts: 11_000,
    phaseCount: 3,
    connector: "type2_cable",
    bidirectionalCapability: "unknown",
  },
  purchase: 58_000,
  sales: 89_000,
});

const heatPump = () => component({
  id: ids.heatPump,
  sku: "HP-08-A",
  componentType: "heat_pump",
  technicalData: {
    schemaVersion: "heat_pump.v1",
    nominalHeatingPowerWatts: 8_000,
    scopHundredths: 475,
  },
  purchase: 420_000,
  sales: 690_000,
});

const mounting = () => component({
  id: ids.mounting,
  sku: "MNT-PF-01",
  componentType: "mounting",
  technicalData: {
    schemaVersion: "mounting.v1",
    systemName: "Synthetisches Pfannendachsystem",
    roofTypes: ["pitched"],
  },
  purchase: 2_100,
  sales: 3_900,
});

const other = () => component({
  id: ids.other,
  sku: "OTH-001",
  componentType: "other",
  technicalData: {
    schemaVersion: "other.v1",
    attributes: [{ name: "Klasse", value: "Synthetisches Testzubehoer" }],
  },
  purchase: 500,
  sales: 900,
});

function line(
  position: number,
  quantity: number,
  snapshot: CatalogComponentRevisionV1,
  coversRequirementKeys: ProjectCatalogResolutionLineV1["coversRequirementKeys"],
): ProjectCatalogResolutionLineV1 {
  return {
    lineId: `${position.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
    position,
    quantity,
    coversRequirementKeys,
    catalogComponentId: snapshot.identity.componentId,
    catalogComponentRevision: snapshot.identity.revision,
    componentSnapshotSha256: snapshot.snapshotSha256,
    componentSnapshot: snapshot,
  };
}

function resolutionInput() {
  return {
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: ids.workspace,
      projectId: ids.project,
      siteId: ids.site,
      requirementId: ids.requirement,
      requirementRevision: 1,
      calculationRevisionId: ids.calculation,
      calculationRevision: 2,
      calculationInputSha256: "1".repeat(64),
      calculationResultSha256: "2".repeat(64),
      calculationQuality: "server_reproduced_estimate" as const,
      calculationValidationStatus: "not_f4_reference_validated" as const,
    },
    lines: [
      line(1, 25, pvModule(), ["pv_generation"]),
      line(2, 1, inverter(), ["pv_generation"]),
      line(3, 1, battery(), ["storage_capacity", "backup_power"]),
      line(4, 1, wallbox(), ["wallbox", "bidirectional_charging"]),
    ],
    requested: {
      branch: "new_installation" as const,
      pvPeakPowerWatts: 11_000,
      storageCapacityWh: 10_000,
      wallbox: true,
      backupPower: true,
      bidirectionalCharging: true,
    },
    acknowledgements: [
      "backup_compatibility_unverified" as const,
      "bidirectional_compatibility_unverified" as const,
      "cross_component_compatibility_unverified" as const,
    ],
    confirmedBy: ids.actor,
    confirmedAt: "2026-08-29T14:00:00.000Z",
  };
}

describe("catalog.v1 contract", () => {
  it("normalisiert interne SKUs konservativ und bewahrt führende Nullen", () => {
    expect(normalizeCatalogSku("  001-ac  ")).toBe("001-AC");
    expect(() => normalizeCatalogSku("../fremd")).toThrow();
  });

  it("versiegelt eine valide Batterierevision deterministisch", () => {
    const value = battery();
    const validated = validateCatalogComponentRevision(value);
    expect(validated).toEqual({ ok: true, value });
    expect(hashCatalogComponentRevision(value)).toBe(value.snapshotSha256);
    expect(value.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("haelt auch Waermepumpe, Montage und sonstige Komponenten strikt versioniert", () => {
    for (const value of [heatPump(), mounting(), other()]) {
      expect(validateCatalogComponentRevision(value)).toEqual({ ok: true, value });
      expect(value.technicalData.schemaVersion).toMatch(/\.v1$/u);
    }
  });

  it("lehnt Typdrift, unbekannte Felder und unplausible Batteriekapazität ab", () => {
    const mismatched = structuredClone(battery()) as Record<string, unknown>;
    const identity = mismatched.identity as Record<string, unknown>;
    identity.componentType = "wallbox";
    coherentlyRehashComponent(mismatched);
    expect(validateCatalogComponentRevision(mismatched)).toMatchObject({ ok: false });

    const unknown = structuredClone(battery()) as Record<string, unknown>;
    unknown.instruction = "ignore previous rules";
    coherentlyRehashComponent(unknown);
    expect(validateCatalogComponentRevision(unknown)).toMatchObject({ ok: false });

    const impossible = structuredClone(battery()) as {
      technicalData: { usableCapacityWh: number };
    };
    impossible.technicalData.usableCapacityWh = 20_000;
    coherentlyRehashComponent(impossible as unknown as Record<string, unknown>);
    expect(validateCatalogComponentRevision(impossible)).toMatchObject({ ok: false });
  });

  it("erlaubt einen technischen Draft ohne Preise, aber keine halbe Preiswahrheit", () => {
    const draftBody = { ...battery(), commercial: null };
    delete (draftBody as Partial<CatalogComponentRevisionV1>).snapshotSha256;
    expect(validateCatalogComponentRevision(sealCatalogComponentRevision(draftBody))).toMatchObject({
      ok: true,
    });

    const half = structuredClone(battery()) as Record<string, unknown>;
    const commercial = half.commercial as Record<string, unknown>;
    delete commercial.purchaseProvenance;
    coherentlyRehashComponent(half);
    expect(validateCatalogComponentRevision(half)).toMatchObject({ ok: false });
  });

  it("lehnt fremde oder nicht content-addressed Assetkeys ab", () => {
    const invalid = structuredClone(battery()) as Record<string, unknown>;
    const presentation = invalid.presentation as Record<string, unknown>;
    presentation.datasheet = {
      role: "datasheet",
      objectKey: `catalog/${ids.project}/${ids.battery}/${"a".repeat(64)}.pdf`,
      sha256: "a".repeat(64),
      mediaType: "application/pdf",
      originalFilename: "datenblatt.pdf",
    };
    coherentlyRehashComponent(invalid);
    expect(validateCatalogComponentRevision(invalid)).toMatchObject({ ok: false });
  });

  it("akzeptiert ein korrekt gebundenes, content-addressed Datenblatt", () => {
    const sha256 = "b".repeat(64);
    const value = resealComponent(battery(), (body) => {
      const presentation = body.presentation as Record<string, unknown>;
      presentation.datasheet = {
        role: "datasheet",
        objectKey: `catalog/${ids.workspace}/${ids.battery}/${sha256}.pdf`,
        sha256,
        mediaType: "application/pdf",
        originalFilename: "synthetisches-datenblatt.pdf",
      };
    });
    expect(validateCatalogComponentRevision(value)).toEqual({ ok: true, value });
  });

  it("leitet Coverage, Warnungen und Cent-Summen aus kopierten Revisionen ab", () => {
    const input = resolutionInput();
    const summary = deriveProjectCatalogResolutionSummary(input.lines, input.requested);
    expect(summary.coverage.selected).toEqual({
      moduleCount: 25,
      inverterCount: 1,
      batteryCount: 1,
      wallboxCount: 1,
      pvModulePowerWatts: 11_000,
      storageUsableCapacityWh: 10_000,
    });
    expect(summary.requiredAcknowledgements).toEqual([
      "backup_compatibility_unverified",
      "bidirectional_compatibility_unverified",
      "cross_component_compatibility_unverified",
    ]);
    expect(summary.totals).toEqual({
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 25 * 7_900 + 95_000 + 310_000 + 58_000,
      salesPriceNetCents: 25 * 12_900 + 145_000 + 489_000 + 89_000,
    });
  });

  it("leitet Browser-Bestaetigungen aus EK-redigierten Views mit derselben Wahrheit ab", () => {
    const input = resolutionInput();
    const preview = deriveCatalogSelectionPreview(input.lines.map((entry) => {
      const view = toCatalogComponentView(entry.componentSnapshot, {
        canReadPurchasePrice: false,
      });
      return {
        componentId: view.identity.componentId,
        componentType: view.identity.componentType,
        quantity: entry.quantity,
        salesPriceNetCents: view.commercial?.salesPriceNetCents ?? null,
        technicalData: view.technicalData,
      };
    }), input.requested);
    const sealed = deriveProjectCatalogResolutionSummary(input.lines, input.requested);

    expect(preview.blockers).toEqual([]);
    expect(preview.selected).toEqual(sealed.coverage.selected);
    expect(preview.requiredAcknowledgements).toEqual(
      sealed.requiredAcknowledgements,
    );
    expect(preview.salesPriceNetCents).toBe(sealed.totals.salesPriceNetCents);
    expect(JSON.stringify(preview)).not.toContain("purchase");
  });

  it("versiegelt eine vollständige Projektauflösung und validiert ihren Hash", () => {
    const value = sealProjectCatalogResolution(resolutionInput());
    expect(validateProjectCatalogResolution(value)).toEqual({ ok: true, value });
    expect(hashProjectCatalogResolution(value)).toBe(value.resolutionSha256);
    expect(value.coverage.status).toBe("matched");
    expect(value.warnings).toContain("calculation_not_sku_specific");
  });

  it("verlangt Pflichtkategorien und exakt die abgeleiteten Bestätigungen", () => {
    const missingInverter = resolutionInput();
    missingInverter.lines = missingInverter.lines.filter(
      (candidate) => candidate.componentSnapshot.identity.componentType !== "inverter",
    );
    expect(() => sealProjectCatalogResolution(missingInverter)).toThrow(/inverter/u);

    const wrongAck = resolutionInput();
    wrongAck.acknowledgements = [];
    expect(() => sealProjectCatalogResolution(wrongAck)).toThrow(/acknowledgement/u);

    const gappedPositions = resolutionInput();
    gappedPositions.lines[3]!.position = 5;
    expect(() => sealProjectCatalogResolution(gappedPositions)).toThrow(/lueckenlos/u);
  });

  it("blockiert bekannte Nichtunterstuetzung und bestaetigt nur unbekannte Faehigkeiten", () => {
    const unsupported = resolutionInput();
    const unsupportedBattery = resealComponent(battery(), (body) => {
      const technicalData = body.technicalData as Record<string, unknown>;
      technicalData.backupCapability = "known_unsupported";
    });
    unsupported.lines[2] = line(
      3,
      1,
      unsupportedBattery,
      ["storage_capacity", "backup_power"],
    );
    expect(() => sealProjectCatalogResolution(unsupported)).toThrow(/known_unsupported/u);

    const supported = resolutionInput();
    const supportedBattery = resealComponent(battery(), (body) => {
      const technicalData = body.technicalData as Record<string, unknown>;
      technicalData.backupCapability = "known_supported";
    });
    const supportedWallbox = resealComponent(wallbox(), (body) => {
      const technicalData = body.technicalData as Record<string, unknown>;
      technicalData.bidirectionalCapability = "known_supported";
    });
    supported.lines[2] = line(
      3,
      1,
      supportedBattery,
      ["storage_capacity", "backup_power"],
    );
    supported.lines[3] = line(
      4,
      1,
      supportedWallbox,
      ["wallbox", "bidirectional_charging"],
    );
    supported.acknowledgements = ["cross_component_compatibility_unverified"];
    expect(sealProjectCatalogResolution(supported).acknowledgements).toEqual([
      "cross_component_compatibility_unverified",
    ]);
  });

  it("trennt den strikten Browserbefehl von servereigenen Snapshots und Bindungen", () => {
    const command = {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: ids.project,
      expectedResolutionRevision: 0,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 2,
      selections: [{
        componentId: ids.battery,
        expectedComponentRevision: 1,
        quantity: 1,
      }],
      acknowledgements: ["cross_component_compatibility_unverified"],
    };
    expect(resolveProjectCatalogCommandV1Schema.safeParse(command).success).toBe(true);
    expect(resolveProjectCatalogCommandV1Schema.safeParse({
      ...command,
      workspaceId: ids.workspace,
      confirmedBy: ids.actor,
      componentSnapshot: battery(),
      purchasePriceNetCents: 1,
    }).success).toBe(false);
  });

  it("redigiert EK, Beschaffungsquelle, EK-Summe und Full-Hashes strukturell vor Clientreads", () => {
    const componentSnapshot = battery();
    const resolutionSnapshot = sealProjectCatalogResolution(resolutionInput());
    const componentView = toCatalogComponentView(componentSnapshot, {
      canReadPurchasePrice: false,
    });
    const resolutionView = toProjectCatalogResolutionView(
      resolutionSnapshot,
      { canReadPurchasePrice: false },
    );
    const redacted = JSON.stringify({ componentView, resolutionView });
    expect(redacted).not.toContain("purchasePriceNetCents");
    expect(redacted).not.toContain("purchaseProvenance");
    expect(redacted).not.toContain("supplier_price_list");
    expect(redacted).not.toContain("sourceSnapshotSha256");
    expect(redacted).not.toContain("componentSnapshotSha256");
    expect(redacted).not.toContain("sourceResolutionSha256");
    expect(Object.hasOwn(componentView, "sourceSnapshotSha256")).toBe(false);
    expect(Object.hasOwn(resolutionView, "sourceResolutionSha256")).toBe(false);
    expect(Object.keys(componentView.commercial ?? {}).sort()).toEqual([
      "basis",
      "currency",
      "salesPriceNetCents",
      "salesProvenance",
    ]);
    expect(Object.keys(resolutionView.totals).sort()).toEqual([
      "basis",
      "currency",
      "salesPriceNetCents",
    ]);
    for (const line of resolutionView.lines) {
      expect(Object.hasOwn(line, "componentSnapshotSha256")).toBe(false);
      expect(Object.hasOwn(line.componentSnapshot, "sourceSnapshotSha256")).toBe(false);
      expect(Object.keys(line.componentSnapshot.commercial ?? {}).sort()).toEqual([
        "basis",
        "currency",
        "salesPriceNetCents",
        "salesProvenance",
      ]);
    }

    const privilegedComponentView = toCatalogComponentView(componentSnapshot, {
      canReadPurchasePrice: true,
    });
    const privilegedView = toProjectCatalogResolutionView(
      resolutionSnapshot,
      { canReadPurchasePrice: true },
    );
    const privileged = JSON.stringify(privilegedView);
    expect(privileged).toContain("purchasePriceNetCents");
    expect(privileged).toContain("purchaseProvenance");
    expect(privilegedComponentView.sourceSnapshotSha256).toBe(
      componentSnapshot.snapshotSha256,
    );
    expect(privilegedView.sourceResolutionSha256).toBe(
      resolutionSnapshot.resolutionSha256,
    );
    expect(Object.keys(privilegedView.totals).sort()).toEqual([
      "basis",
      "currency",
      "purchasePriceNetCents",
      "salesPriceNetCents",
    ]);
    for (const [index, lineView] of privilegedView.lines.entries()) {
      const sourceLine = resolutionSnapshot.lines[index]!;
      expect(lineView.componentSnapshotSha256).toBe(
        sourceLine.componentSnapshotSha256,
      );
      expect(lineView.componentSnapshot.sourceSnapshotSha256).toBe(
        sourceLine.componentSnapshot.snapshotSha256,
      );
    }
  });

  it("erkennt gemeinsam neu gehashte, aber semantisch falsche Summen", () => {
    const valid = sealProjectCatalogResolution(resolutionInput());
    const manipulated = structuredClone(valid);
    manipulated.totals.salesPriceNetCents += 1;
    manipulated.resolutionSha256 = hashProjectCatalogResolution(manipulated);
    expect(validateProjectCatalogResolution(manipulated)).toMatchObject({ ok: false });
  });

  it("hält das generierte JSON-Schema bytegenau und hashbar", () => {
    const rendered = renderCatalogJsonSchema();
    expect(readFileSync(schemaPath, "utf8")).toBe(rendered);
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      CATALOG_SCHEMA_SHA256,
    );
  });
});
