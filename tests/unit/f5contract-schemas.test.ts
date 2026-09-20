import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function loadValidator(fileName: string) {
  const schema = JSON.parse(
    readFileSync(resolve(root, "contracts", fileName), "utf8"),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const SHA = "c".repeat(64);
const SESSION_ID = "77777777-7777-4777-8777-777777777777";
const ESTIMATE_DISCLAIMER = "Schaetzung - keine zertifizierte Heizlastberechnung.";

function validHeatLoadMethods(): Record<string, unknown> {
  return {
    contractVersion: "heat-load-methods.v1",
    method: "roomwise",
    stage: "estimate",
    uValueSource: { table: "tabula_like", version: "tabula-de.v1", sha: SHA },
    resultKw: 8.4,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

function validLidarScan(): Record<string, unknown> {
  return {
    contractVersion: "lidar-scan.v1",
    sessionId: SESSION_ID,
    deviceGate: {
      capabilityCheck: true,
      method: "native_capability",
      uaSniffing: false,
    },
    rooms: [
      {
        roomId: "eg-wohnen",
        polygon: [
          { xM: 0, yM: 0 },
          { xM: 5.2, yM: 0 },
          { xM: 5.2, yM: 4.1 },
          { xM: 0, yM: 4.1 },
        ],
        wallAreas: [
          { wallId: "wand-nord", areaM2: 12.5 },
          { wallId: "wand-sued", areaM2: 12.5 },
        ],
        openings: [
          { openingId: "fenster-1", kind: "window", widthM: 1.2, heightM: 1.4 },
          { openingId: "tuer-1", kind: "door", widthM: 0.9, heightM: 2.0 },
        ],
      },
    ],
    stitching: { commonFrame: true, doorLinks: [] },
    trackingWarnings: [],
    provenance: "lidar_scan",
  };
}

function validRoomModel(): Record<string, unknown> {
  return {
    contractVersion: "room-model.v1",
    storeys: [
      { storeyId: "eg", kind: "zwischen", ceilingHeightM: 2.5 },
      { storeyId: "dg", kind: "dach", ceilingHeightM: 2.3 },
    ],
    rooms: [
      {
        roomId: "eg-wohnen",
        storeyId: "eg",
        type: "wohnen",
        targetTempC: 20,
        airChangesPerHour: 0.5,
      },
    ],
    walls: [
      {
        wallId: "wand-nord",
        roomId: "eg-wohnen",
        towards: "aussenluft",
        areaM2: 12.5,
        uValueWPerM2K: 0.24,
        windows: [{ windowId: "fenster-1", areaM2: 1.68 }],
        doors: [],
      },
    ],
    roof: {
      dormers: [{ dormerId: "gaube-1", areaM2: 3.2 }],
      validation: { status: "valid", checkedAt: "2026-09-20T10:00:00.000Z" },
    },
    materialSnapshot: {
      sha: SHA,
      updatedAt: "2026-09-20T10:00:00.000Z",
      manualUpdate: false,
    },
  };
}

function validWpSizing(): Record<string, unknown> {
  return {
    contractVersion: "wp-sizing.v1",
    heatLoadKw: 8.4,
    operationMode: "bivalent",
    bivalencePointC: -6,
    heaterKw: 3,
    manufacturerRef: {
      manufacturer: "Musterwerke",
      model: "WP-9",
      nominalPowerKw: 9,
    },
    normRef: "vdi4645_est",
    fixturesSha: SHA,
  };
}

function validSubsidyEstimateCard(): Record<string, unknown> {
  return {
    contractVersion: "subsidy-estimate-card.v1",
    ruleVersion: "f56-458.v1",
    basePct: 30,
    bonusPct: 20,
    capPct: 70,
    dwellingUnits: 1,
    estimateEuroCents: 1500000,
    disclaimer: "Unverbindliche Schaetzung, keine Foerderzusage.",
    asOfDate: "2026-09-20",
  };
}

describe("F5 contract schemas", () => {
  it("heat-load-methods.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("heat-load-methods.v1.schema.json");
    expect(validate(validHeatLoadMethods())).toBe(true);
  });

  it("heat-load-methods.v1 verlangt den const-disclaimer bei estimate", () => {
    const validate = loadValidator("heat-load-methods.v1.schema.json");
    const missing = { ...validHeatLoadMethods() };
    delete missing.disclaimer;
    expect(validate(missing)).toBe(false);
    const wrong = { ...validHeatLoadMethods(), disclaimer: "frei erfunden" };
    expect(validate(wrong)).toBe(false);
    const badMethod = { ...validHeatLoadMethods(), method: "raten" };
    expect(validate(badMethod)).toBe(false);
  });

  it("lidar-scan.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("lidar-scan.v1.schema.json");
    expect(validate(validLidarScan())).toBe(true);
  });

  it("lidar-scan.v1 verbietet ua-sniffing und fremde methoden", () => {
    const validate = loadValidator("lidar-scan.v1.schema.json");
    const sniffing = {
      ...validLidarScan(),
      deviceGate: {
        capabilityCheck: true,
        method: "native_capability",
        uaSniffing: true,
      },
    };
    expect(validate(sniffing)).toBe(false);
    const sniffedMethod = {
      ...validLidarScan(),
      deviceGate: {
        capabilityCheck: true,
        method: "user_agent",
        uaSniffing: false,
      },
    };
    expect(validate(sniffedMethod)).toBe(false);
  });

  it("room-model.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("room-model.v1.schema.json");
    expect(validate(validRoomModel())).toBe(true);
  });

  it("room-model.v1 begrenzt keller/dach und towards-Werte", () => {
    const validate = loadValidator("room-model.v1.schema.json");
    const twoCellars = {
      ...validRoomModel(),
      storeys: [
        { storeyId: "kg-1", kind: "keller" },
        { storeyId: "kg-2", kind: "keller" },
      ],
    };
    expect(validate(twoCellars)).toBe(false);
    const badTowards = validRoomModel();
    (badTowards.walls as Record<string, unknown>[])[0] = {
      wallId: "wand-nord",
      towards: "weltraum",
      areaM2: 12.5,
      windows: [],
      doors: [],
    };
    expect(validate(badTowards)).toBe(false);
  });

  it("wp-sizing.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("wp-sizing.v1.schema.json");
    expect(validate(validWpSizing())).toBe(true);
  });

  it("wp-sizing.v1 weist modus/norm/sha-Verstoesse ab", () => {
    const validate = loadValidator("wp-sizing.v1.schema.json");
    const badMode = { ...validWpSizing(), operationMode: "monovalent" };
    expect(validate(badMode)).toBe(false);
    const badNorm = { ...validWpSizing(), normRef: "din4701" };
    expect(validate(badNorm)).toBe(false);
    const badSha = { ...validWpSizing(), fixturesSha: "kein-sha" };
    expect(validate(badSha)).toBe(false);
  });

  it("subsidy-estimate-card.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("subsidy-estimate-card.v1.schema.json");
    expect(validate(validSubsidyEstimateCard())).toBe(true);
  });

  it("subsidy-estimate-card.v1 verlangt regelversion/cap/datum", () => {
    const validate = loadValidator("subsidy-estimate-card.v1.schema.json");
    const badRule = { ...validSubsidyEstimateCard(), ruleVersion: "f56-458.v2" };
    expect(validate(badRule)).toBe(false);
    const badCap = { ...validSubsidyEstimateCard(), capPct: 90 };
    expect(validate(badCap)).toBe(false);
    const badDate = { ...validSubsidyEstimateCard(), asOfDate: "20.09.2026" };
    expect(validate(badDate)).toBe(false);
  });
});
