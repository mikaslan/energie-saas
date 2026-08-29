export type CatalogSelectionAcknowledgement =
  | "pv_capacity_differs"
  | "storage_capacity_differs"
  | "backup_compatibility_unverified"
  | "bidirectional_compatibility_unverified"
  | "cross_component_compatibility_unverified";

export type CatalogSelectionBlocker =
  | "no_selection"
  | "missing_module"
  | "missing_inverter"
  | "missing_battery"
  | "missing_wallbox"
  | "backup_known_unsupported"
  | "bidirectional_known_unsupported"
  | "missing_pricing";

type Capability = "known_supported" | "known_unsupported" | "unknown";

export type CatalogSelectionPreviewLine = {
  componentId: string;
  componentType:
    | "module"
    | "inverter"
    | "battery"
    | "wallbox"
    | "heat_pump"
    | "mounting"
    | "other";
  quantity: number;
  salesPriceNetCents: number | null;
  technicalData: {
    schemaVersion: string;
    nominalPowerWatts?: number;
    usableCapacityWh?: number;
    backupCapability?: Capability;
    bidirectionalCapability?: Capability;
  };
};

export type RequestedCatalogSelectionCoverage = {
  branch: "new_installation" | "existing_installation";
  pvPeakPowerWatts: number;
  storageCapacityWh: number;
  wallbox: boolean;
  backupPower: boolean;
  bidirectionalCharging: boolean;
};

export type CatalogSelectionPreview = {
  selected: {
    moduleCount: number;
    inverterCount: number;
    batteryCount: number;
    wallboxCount: number;
    pvModulePowerWatts: number;
    storageUsableCapacityWh: number;
  };
  salesPriceNetCents: number;
  requiredAcknowledgements: CatalogSelectionAcknowledgement[];
  blockers: CatalogSelectionBlocker[];
};

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Katalogauswahl ueberschreitet den sicheren Ganzzahlbereich.");
  }
  return result;
}

function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Katalogauswahl ueberschreitet den sicheren Ganzzahlbereich.");
  }
  return result;
}

/**
 * EK-freie Vorschau derselben Auswahlregeln, die den versiegelten
 * Resolution-Snapshot bestimmen. Sie ist absichtlich browsergeeignet und
 * darf deshalb weder Node-APIs noch vertrauliche Preisfelder importieren.
 */
export function deriveCatalogSelectionPreview(
  lines: readonly CatalogSelectionPreviewLine[],
  requested: RequestedCatalogSelectionCoverage,
): CatalogSelectionPreview {
  const selected = {
    moduleCount: 0,
    inverterCount: 0,
    batteryCount: 0,
    wallboxCount: 0,
    pvModulePowerWatts: 0,
    storageUsableCapacityWh: 0,
  };
  let salesPriceNetCents = 0;
  let hasMissingPricing = false;
  const componentTypes = new Set<CatalogSelectionPreviewLine["componentType"]>();
  const batteryCapabilities: Capability[] = [];
  const wallboxCapabilities: Capability[] = [];

  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100_000) {
      throw new TypeError("Katalogmenge ist ungueltig.");
    }
    componentTypes.add(line.componentType);
    if (line.salesPriceNetCents === null) {
      hasMissingPricing = true;
    } else {
      salesPriceNetCents = checkedAdd(
        salesPriceNetCents,
        checkedMultiply(line.salesPriceNetCents, line.quantity),
      );
    }

    if (line.componentType === "module") {
      if (
        line.technicalData.schemaVersion !== "module.v1"
        || !Number.isSafeInteger(line.technicalData.nominalPowerWatts)
        || (line.technicalData.nominalPowerWatts ?? 0) < 1
      ) throw new TypeError("module verlangt gueltige module.v1-Daten.");
      selected.moduleCount = checkedAdd(selected.moduleCount, line.quantity);
      selected.pvModulePowerWatts = checkedAdd(
        selected.pvModulePowerWatts,
        checkedMultiply(line.technicalData.nominalPowerWatts!, line.quantity),
      );
    } else if (line.componentType === "inverter") {
      selected.inverterCount = checkedAdd(selected.inverterCount, line.quantity);
    } else if (line.componentType === "battery") {
      if (
        line.technicalData.schemaVersion !== "battery.v1"
        || !Number.isSafeInteger(line.technicalData.usableCapacityWh)
        || (line.technicalData.usableCapacityWh ?? 0) < 1
        || line.technicalData.backupCapability === undefined
      ) throw new TypeError("battery verlangt gueltige battery.v1-Daten.");
      selected.batteryCount = checkedAdd(selected.batteryCount, line.quantity);
      selected.storageUsableCapacityWh = checkedAdd(
        selected.storageUsableCapacityWh,
        checkedMultiply(line.technicalData.usableCapacityWh!, line.quantity),
      );
      batteryCapabilities.push(line.technicalData.backupCapability);
    } else if (line.componentType === "wallbox") {
      if (
        line.technicalData.schemaVersion !== "wallbox.v1"
        || line.technicalData.bidirectionalCapability === undefined
      ) throw new TypeError("wallbox verlangt gueltige wallbox.v1-Daten.");
      selected.wallboxCount = checkedAdd(selected.wallboxCount, line.quantity);
      wallboxCapabilities.push(line.technicalData.bidirectionalCapability);
    }
  }

  const blockers: CatalogSelectionBlocker[] = [];
  if (lines.length === 0) blockers.push("no_selection");
  if (requested.branch === "new_installation" && requested.pvPeakPowerWatts > 0) {
    if (selected.moduleCount === 0) blockers.push("missing_module");
    if (selected.inverterCount === 0) blockers.push("missing_inverter");
  }
  if ((requested.storageCapacityWh > 0 || requested.backupPower) && selected.batteryCount === 0) {
    blockers.push("missing_battery");
  }
  if ((requested.wallbox || requested.bidirectionalCharging) && selected.wallboxCount === 0) {
    blockers.push("missing_wallbox");
  }
  if (requested.backupPower && batteryCapabilities.includes("known_unsupported")) {
    blockers.push("backup_known_unsupported");
  }
  if (
    requested.bidirectionalCharging
    && wallboxCapabilities.includes("known_unsupported")
  ) {
    blockers.push("bidirectional_known_unsupported");
  }
  if (hasMissingPricing) blockers.push("missing_pricing");

  const requiredAcknowledgements: CatalogSelectionAcknowledgement[] = [];
  if (selected.pvModulePowerWatts !== requested.pvPeakPowerWatts) {
    requiredAcknowledgements.push("pv_capacity_differs");
  }
  if (selected.storageUsableCapacityWh !== requested.storageCapacityWh) {
    requiredAcknowledgements.push("storage_capacity_differs");
  }
  if (requested.backupPower && batteryCapabilities.includes("unknown")) {
    requiredAcknowledgements.push("backup_compatibility_unverified");
  }
  if (
    requested.bidirectionalCharging
    && wallboxCapabilities.includes("unknown")
  ) {
    requiredAcknowledgements.push("bidirectional_compatibility_unverified");
  }
  if (componentTypes.size > 1) {
    requiredAcknowledgements.push("cross_component_compatibility_unverified");
  }

  return { selected, salesPriceNetCents, requiredAcknowledgements, blockers };
}
