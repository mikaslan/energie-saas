import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  sealCatalogComponentRevision,
} from "@/lib/integrations/catalog/contract";
import {
  CATALOG_CSV_IMPORT_CONTRACT_VERSION,
  CATALOG_CSV_JOB_ERROR_CODES,
  CATALOG_CSV_IMPORT_SCHEMA_SHA256,
  CATALOG_CSV_MAX_BYTES,
  CATALOG_CSV_MAX_ROWS,
  CATALOG_CSV_PREVIEW_ROW_CANONICAL_MAX_BYTES,
  CATALOG_CSV_PROCESSING_RESULT_CODES,
  CATALOG_CSV_REQUEST_ERROR_CODES,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
  CATALOG_IMPORT_PREPARE_VERSION,
  autoMapCatalogCsvHeaders,
  catalogCsvErrorReportRowV1Schema,
  catalogCsvErrorReportRows,
  catalogCsvMappingPersistenceEnvelope,
  catalogCsvPreviewRowPersistenceEnvelope,
  catalogCsvTemplate,
  catalogCsvPreviewV1Schema,
  catalogImportRowCommandV1Schema,
  catalogImportRowPersistenceEnvelope,
  catalogImportReservationSha256,
  inspectCatalogCsvFile,
  parseCatalogImportRowCommand,
  parseCatalogImportPrepareV1,
  parseCatalogCsvPreview,
  renderCatalogCsvErrorReport,
  renderCatalogCsvImportJsonSchema,
  sealCatalogImportRowCommand,
  sealCatalogImportPrepareV1,
  type CatalogCsvColumnMappingV1,
} from "@/lib/integrations/catalog/import-contract";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/catalog-csv-import.v1.schema.json");

const commonHeaders = [
  "internalSku",
  "componentType",
  "displayName",
  "manufacturer",
  "model",
  "unit",
  "keyPoints",
  "technicalSourceKind",
  "technicalReference",
  "technicalObservedOn",
  "technicalRightsBasis",
  "technicalDocumentSha256",
  "purchasePriceNet",
  "purchaseSourceKind",
  "purchaseReference",
  "purchaseObservedOn",
  "purchaseRightsBasis",
  "purchaseDocumentSha256",
  "salesPriceNet",
  "salesSourceKind",
  "salesReference",
  "salesObservedOn",
  "salesRightsBasis",
  "salesDocumentSha256",
] as const;

const technicalHeaders = [
  "nominalPowerWatts",
  "nominalAcPowerWatts",
  "phaseCount",
  "mpptTrackerCount",
  "nominalCapacityWh",
  "usableCapacityWh",
  "maxContinuousPowerWatts",
  "roundTripEfficiencyPercent",
  "backupCapability",
  "maxChargingPowerWatts",
  "connector",
  "bidirectionalCapability",
  "nominalHeatingPowerWatts",
  "scop",
  "systemName",
  "roofTypes",
  "attributes",
] as const;

const headers = [...commonHeaders, ...technicalHeaders] as const;

function quoted(value: string): string {
  return /[;"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function baseRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    internalSku: "PV-440-BLK",
    componentType: "module",
    displayName: "440-Watt-Modul",
    manufacturer: "WMEE Testwerk",
    model: "S440",
    unit: "piece",
    keyPoints: "synthetisch|schwarz",
    technicalSourceKind: "manufacturer_datasheet",
    technicalReference: "Datenblatt S440",
    technicalObservedOn: "2026-08-31",
    technicalRightsBasis: "manufacturer_published",
    technicalDocumentSha256: "",
    purchasePriceNet: "79,00",
    purchaseSourceKind: "supplier_price_list",
    purchaseReference: "Eigene Testpreisliste",
    purchaseObservedOn: "2026-08-31",
    purchaseRightsBasis: "supplier_authorized",
    purchaseDocumentSha256: "",
    salesPriceNet: "129,00",
    salesSourceKind: "workspace_pricing",
    salesReference: "Eigene Kalkulation",
    salesObservedOn: "2026-08-31",
    salesRightsBasis: "workspace_owned",
    salesDocumentSha256: "",
    nominalPowerWatts: "440",
    nominalAcPowerWatts: "",
    phaseCount: "",
    mpptTrackerCount: "",
    nominalCapacityWh: "",
    usableCapacityWh: "",
    maxContinuousPowerWatts: "",
    roundTripEfficiencyPercent: "",
    backupCapability: "",
    maxChargingPowerWatts: "",
    connector: "",
    bidirectionalCapability: "",
    nominalHeatingPowerWatts: "",
    scop: "",
    systemName: "",
    roofTypes: "",
    attributes: "",
    ...overrides,
  };
}

function csv(rows: Array<Record<string, string>>, delimiter = ";"): Uint8Array {
  const content = [
    headers.join(delimiter),
    ...rows.map((row) => headers.map((header) => quoted(row[header] ?? "")).join(delimiter)),
  ].join("\r\n");
  return new TextEncoder().encode(content);
}

function mapping(): CatalogCsvColumnMappingV1 {
  return autoMapCatalogCsvHeaders([...headers]);
}

describe("M108B-CONTRACT-01 catalog CSV import", () => {
  it("pinnt den versionierten JSON-Schema-Vertrag bytegenau", () => {
    const rendered = renderCatalogCsvImportJsonSchema();
    const stored = readFileSync(schemaPath, "utf8");
    expect(rendered).toBe(stored);
    expect(createHash("sha256").update(rendered).digest("hex"))
      .toBe(CATALOG_CSV_IMPORT_SCHEMA_SHA256);
    expect(JSON.parse(rendered)).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "WMEE Catalog CSV Import v1",
    });
  });

  it("kompiliert als aufloesbarer Draft-2020-12-Vertrag mit DB-kompatiblen Daten", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(renderCatalogCsvImportJsonSchema()));
    const preview = parseCatalogCsvPreview({
      filename: "schema-datum.csv",
      bytes: csv([baseRow()]),
      mapping: mapping(),
    });
    const withObservedDates = (
      technicalObservedOn: string,
      purchaseObservedOn: string,
      salesObservedOn: string,
    ) => {
      const candidate = structuredClone(preview);
      const row = candidate.rows[0];
      if (row?.status !== "valid") throw new Error("fixture must be valid");
      row.command.technicalProvenance.observedOn = technicalObservedOn;
      row.command.commercial.purchaseProvenance.observedOn = purchaseObservedOn;
      row.command.commercial.salesProvenance.observedOn = salesObservedOn;
      return candidate;
    };
    expect(validate(preview)).toBe(true);
    const uppercaseExtension = structuredClone(preview);
    uppercaseExtension.file.filename = "schema-datum.CSV";
    expect(validate(uppercaseExtension)).toBe(true);
    expect(catalogCsvPreviewV1Schema.safeParse(uppercaseExtension).success).toBe(true);
    for (const filename of ["x", "../x.csv", " bad.csv", "x\u202e.csv"]) {
      const candidate = structuredClone(preview);
      candidate.file.filename = filename;
      expect(validate(candidate)).toBe(false);
      expect(catalogCsvPreviewV1Schema.safeParse(candidate).success).toBe(false);
    }
    const nonCanonicalFilename = structuredClone(preview);
    nonCanonicalFilename.file.filename = "ｘ.csv";
    expect(catalogCsvPreviewV1Schema.safeParse(nonCanonicalFilename).success).toBe(false);
    expect(validate(withObservedDates("0000-01-01", "2026-08-31", "2026-08-31")))
      .toBe(false);
    expect(validate(withObservedDates("2026-08-31", "0000-01-01", "2026-08-31")))
      .toBe(false);
    expect(validate(withObservedDates("2026-08-31", "2026-08-31", "0000-01-01")))
      .toBe(false);
    expect(validate(withObservedDates("0001-01-01", "9999-12-31", "2026-08-31")))
      .toBe(true);

    const withCommandMutation = (
      mutate: (command: Record<string, unknown>) => void,
    ): unknown => {
      const candidate = structuredClone(preview) as unknown as {
        rows: Array<{ command: Record<string, unknown> }>;
      };
      const command = candidate.rows[0]?.command;
      if (!command) throw new Error("fixture command missing");
      mutate(command);
      return candidate;
    };
    expect(validate(withCommandMutation((command) => {
      command.commercial = null;
    }))).toBe(false);
    expect(validate(withCommandMutation((command) => {
      (command.presentation as Record<string, unknown>).unit = "set";
    }))).toBe(false);
    expect(validate(withCommandMutation((command) => {
      command.componentType = "battery";
    }))).toBe(false);
    expect(validate(withCommandMutation((command) => {
      command.internalSku = "not normalized sku";
    }))).toBe(false);
    expect(validate(withCommandMutation((command) => {
      (command.presentation as Record<string, unknown>).image = {
        role: "image",
        objectKey: "catalog/example/image.png",
        sha256: "0".repeat(64),
        mediaType: "image/png",
        originalFilename: "image.png",
      };
    }))).toBe(false);
  });

  it("erkennt UTF-8, Semikolon und bildet ein Modul exakt auf den Katalogvertrag ab", () => {
    const bytes = csv([baseRow()]);
    const inspection = inspectCatalogCsvFile({ filename: "produkte.csv", bytes });
    expect(inspection).toMatchObject({
      encoding: "utf-8",
      delimiter: ";",
      headers: [...headers],
      rowCount: 1,
    });

    const preview = parseCatalogCsvPreview({
      filename: "produkte.csv",
      bytes,
      mapping: mapping(),
    });
    expect(preview.schemaVersion).toBe(CATALOG_CSV_IMPORT_CONTRACT_VERSION);
    expect(preview.counts).toEqual({ total: 1, valid: 1, invalid: 0 });
    const row = preview.rows[0];
    expect(row.status).toBe("valid");
    if (row.status !== "valid") throw new Error("fixture must be valid");
    expect(row.command).toMatchObject({
      internalSku: "PV-440-BLK",
      componentType: "module",
      presentation: {
        displayName: "440-Watt-Modul",
        manufacturer: "WMEE Testwerk",
        model: "S440",
        unit: "piece",
        keyPoints: ["synthetisch", "schwarz"],
        image: null,
        datasheet: null,
      },
      technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 440 },
      commercial: {
        currency: "EUR",
        basis: "net",
        purchasePriceNetCents: 7_900,
        salesPriceNetCents: 12_900,
      },
    });
    expect(row.rowSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.commandSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.file.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.mappingSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("unterstützt den kontrollierten Windows-1252-Fallback", () => {
    const utf8 = new TextDecoder().decode(csv([
      baseRow({ manufacturer: "Müller Testgeräte" }),
    ]));
    const bytes = Uint8Array.from([...utf8].map((character) => {
      const code = character.charCodeAt(0);
      if (character === "ä") return 0xe4;
      if (character === "ü") return 0xfc;
      if (code > 0x7f) throw new Error(`unexpected non-ascii fixture ${character}`);
      return code;
    }));
    const inspection = inspectCatalogCsvFile({ filename: "cp1252.csv", bytes });
    expect(inspection.encoding).toBe("windows-1252");
    const preview = parseCatalogCsvPreview({
      filename: "cp1252.csv",
      bytes,
      mapping: mapping(),
    });
    const row = preview.rows[0];
    expect(row.status).toBe("valid");
    if (row.status !== "valid") throw new Error("fixture must be valid");
    expect(row.command.presentation.manufacturer).toBe("Müller Testgeräte");
  });

  it("validiert alle sieben technischen Typzweige", () => {
    const rows = [
      baseRow(),
      baseRow({
        internalSku: "INV-10K-3P", componentType: "inverter",
        nominalPowerWatts: "", nominalAcPowerWatts: "10000",
        phaseCount: "3", mpptTrackerCount: "3",
      }),
      baseRow({
        internalSku: "BAT-10-0", componentType: "battery", nominalPowerWatts: "",
        nominalCapacityWh: "10600", usableCapacityWh: "10000",
        maxContinuousPowerWatts: "5000", roundTripEfficiencyPercent: "95,00",
        backupCapability: "unknown",
      }),
      baseRow({
        internalSku: "WB-11-T2", componentType: "wallbox", nominalPowerWatts: "",
        maxChargingPowerWatts: "11000", phaseCount: "3",
        connector: "type2_cable", bidirectionalCapability: "unknown",
      }),
      baseRow({
        internalSku: "HP-08-A", componentType: "heat_pump", nominalPowerWatts: "",
        nominalHeatingPowerWatts: "8000", scop: "4,75",
      }),
      baseRow({
        internalSku: "MNT-PF-01", componentType: "mounting", nominalPowerWatts: "",
        unit: "set", systemName: "Pfannendach", roofTypes: "pitched|flat",
      }),
      baseRow({
        internalSku: "OTH-001", componentType: "other", nominalPowerWatts: "",
        unit: "set",
        attributes: '[{"name":"Klasse","value":"Synthetisch"},{"name":"Farbe","value":"Schwarz"}]',
      }),
    ];
    const preview = parseCatalogCsvPreview({
      filename: "alle-typen.csv",
      bytes: csv(rows),
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 7, valid: 7, invalid: 0 });
    expect(preview.rows.map((row) => row.status === "valid"
      ? row.command.technicalData.schemaVersion
      : "invalid")).toEqual([
      "module.v1", "inverter.v1", "battery.v1", "wallbox.v1",
      "heat_pump.v1", "mounting.v1", "other.v1",
    ]);
    const validRows = preview.rows.filter((row) => row.status === "valid");
    expect(validRows[2]?.command.technicalData).toMatchObject({
      roundTripEfficiencyBasisPoints: 9_500,
    });
    expect(validRows[4]?.command.technicalData).toMatchObject({
      scopHundredths: 475,
    });
    expect(validRows[6]?.command.technicalData).toMatchObject({
      attributes: [
        { name: "Klasse", value: "Synthetisch" },
        { name: "Farbe", value: "Schwarz" },
      ],
    });
  });

  it("weist mehrdeutige Listen, Rundung, ungültige ISO-Daten und Enums stabil zurück", () => {
    const preview = parseCatalogCsvPreview({
      filename: "strikte-felder.csv",
      bytes: csv([
        baseRow({ internalSku: "PV-LIST", keyPoints: "eins||zwei" }),
        baseRow({
          internalSku: "BAT-PRECISION", componentType: "battery", nominalPowerWatts: "",
          nominalCapacityWh: "10600", usableCapacityWh: "10000",
          maxContinuousPowerWatts: "5000", roundTripEfficiencyPercent: "95,001",
          backupCapability: "unknown",
        }),
        baseRow({
          internalSku: "HP-PRECISION", componentType: "heat_pump", nominalPowerWatts: "",
          nominalHeatingPowerWatts: "8000", scop: "4.751",
        }),
        baseRow({
          internalSku: "MNT-LIST", componentType: "mounting", nominalPowerWatts: "",
          unit: "set", systemName: "Pfannendach", roofTypes: "pitched||flat",
        }),
        baseRow({
          internalSku: "OTH-JSON", componentType: "other", nominalPowerWatts: "",
          unit: "set", attributes: "Klasse=Synthetisch|Farbe=Schwarz",
        }),
        baseRow({ internalSku: "PV-DATE", technicalObservedOn: "2026-02-30" }),
        baseRow({
          internalSku: "BAT-ENUM", componentType: "battery", nominalPowerWatts: "",
          nominalCapacityWh: "10600", usableCapacityWh: "10000",
          maxContinuousPowerWatts: "5000", roundTripEfficiencyPercent: "95",
          backupCapability: "maybe",
        }),
      ]),
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 7, valid: 0, invalid: 7 });
    const errorCodes = preview.rows.map((row) => row.status === "invalid"
      ? row.errors.map((error) => error.code)
      : []);
    expect(errorCodes[0]).toContain("invalid_value");
    expect(errorCodes[1]).toContain("invalid_value");
    expect(errorCodes[2]).toContain("invalid_value");
    expect(errorCodes[3]).toContain("invalid_technical_shape");
    expect(errorCodes[4]).toContain("invalid_technical_shape");
    expect(errorCodes[5]).toContain("invalid_date");
    expect(errorCodes[6]).toContain("invalid_enum");
  });

  it("weist Jahr 0000 in jeder Provenienz vor der DB-Persistenz zurück", () => {
    const preview = parseCatalogCsvPreview({
      filename: "jahr-null.csv",
      bytes: csv([
        baseRow({ internalSku: "PV-DATE-TECH", technicalObservedOn: "0000-01-01" }),
        baseRow({ internalSku: "PV-DATE-PURCHASE", purchaseObservedOn: "0000-01-01" }),
        baseRow({ internalSku: "PV-DATE-SALES", salesObservedOn: "0000-01-01" }),
      ]),
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 3, valid: 0, invalid: 3 });
    const expectedFields = [
      "technicalObservedOn",
      "purchaseObservedOn",
      "salesObservedOn",
    ] as const;
    for (const [index, row] of preview.rows.entries()) {
      expect(row.status).toBe("invalid");
      if (row.status === "invalid") {
        expect(row.errors).toContainEqual(expect.objectContaining({
          field: expectedFields[index],
          sourceHeader: expectedFields[index],
          code: "invalid_date",
          message: "Das Datum muss YYYY-MM-DD entsprechen.",
        }));
      }
    }

    const boundaries = parseCatalogCsvPreview({
      filename: "datumsgrenzen.csv",
      bytes: csv([
        baseRow({
          internalSku: "PV-DATE-MIN",
          technicalObservedOn: "0001-01-01",
          purchaseObservedOn: "0001-01-01",
          salesObservedOn: "0001-01-01",
        }),
        baseRow({
          internalSku: "PV-DATE-MAX",
          technicalObservedOn: "9999-12-31",
          purchaseObservedOn: "9999-12-31",
          salesObservedOn: "9999-12-31",
        }),
      ]),
      mapping: mapping(),
    });
    expect(boundaries.counts).toEqual({ total: 2, valid: 2, invalid: 0 });
  });

  it("pinnt die geschlossenen Verarbeitungs- und Jobcodeklassen", () => {
    expect(CATALOG_CSV_REQUEST_ERROR_CODES).toEqual([
      "invalid_file",
      "file_too_large",
      "invalid_encoding",
      "invalid_filename",
      "invalid_headers",
      "too_many_columns",
      "too_many_rows",
      "missing_mapping",
      "mapping_conflict",
      "snapshot_budget_exceeded",
      "parser_error",
    ]);
    expect(CATALOG_CSV_PROCESSING_RESULT_CODES).toEqual([
      "sku_created_since_preview",
      "revision_drift",
      "status_drift",
      "type_drift",
      "archived_requires_manual_reactivation",
      "catalog_write_conflict",
    ]);
    expect(CATALOG_CSV_JOB_ERROR_CODES).toEqual([
      "actor_revoked",
      "capability_revoked",
      "lease_lost",
      "enqueue_failed",
      "invalid_persisted_input",
      "technical_retry_exhausted",
      "all_rows_conflicted",
      "queue_locator_invalid",
    ]);
    expect(CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION)
      .toBe("catalog-import-rights-attestation.v1");
    expect(createHash("sha256").update(
      CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
      "utf8",
    ).digest("hex")).toBe(CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256);
  });

  it("liefert für 100 Zeilen genau 93 valide und sieben minimierte Fehler", () => {
    const rows = Array.from({ length: 100 }, (_, index) => baseRow({
      internalSku: `PV-${String(index + 1).padStart(3, "0")}`,
    }));
    const broken = [4, 18, 29, 41, 57, 76, 93];
    for (const index of broken) rows[index]!.purchasePriceNet = "1,2,3";
    const preview = parseCatalogCsvPreview({
      filename: "100-produkte.csv",
      bytes: csv(rows),
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 100, valid: 93, invalid: 7 });
    const errors = preview.rows.filter((row) => row.status === "invalid");
    expect(errors.map((row) => row.rowNumber)).toEqual(broken.map((index) => index + 2));
    expect(errors.every((row) => row.status === "invalid"
      && row.errors.some((error) => (
        error.field === "purchasePriceNet" && error.code === "invalid_money"
      )))).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("Eigene Testpreisliste");
    expect(JSON.stringify(errors)).not.toContain("1,2,3");
  });

  it("weist doppelte SKU, fehlendes Mapping und Größenlimits fail-closed aus", () => {
    const duplicate = parseCatalogCsvPreview({
      filename: "duplikat.csv",
      bytes: csv([baseRow(), baseRow({ internalSku: " pv-440-blk " })]),
      mapping: mapping(),
    });
    expect(duplicate.counts).toEqual({ total: 2, valid: 0, invalid: 2 });
    expect(duplicate.rows.every((row) => row.status === "invalid"
      && row.errors.some((error) => error.code === "duplicate_sku_in_file"))).toBe(true);

    const invalidUnit = parseCatalogCsvPreview({
      filename: "ungueltige-einheit.csv",
      bytes: csv([baseRow({ unit: "set" })]),
      mapping: mapping(),
    });
    expect(invalidUnit.rows[0]).toMatchObject({
      status: "invalid",
      errors: [expect.objectContaining({
        field: "unit",
        code: "invalid_value",
      })],
    });

    const incomplete = structuredClone(mapping());
    incomplete.columns = incomplete.columns.filter((entry) => entry.field !== "displayName");
    expectCatalogCsvError(() => parseCatalogCsvPreview({
      filename: "mapping.csv",
      bytes: csv([baseRow()]),
      mapping: incomplete,
    }), "missing_mapping");

    expectCatalogCsvError(() => inspectCatalogCsvFile({
      filename: "zu-gross.csv",
      bytes: new Uint8Array(CATALOG_CSV_MAX_BYTES + 1),
    }), "file_too_large");

    const tooMany = Array.from({ length: CATALOG_CSV_MAX_ROWS + 1 }, (_, index) => (
      baseRow({ internalSku: `PV-LIMIT-${index}` })
    ));
    expectCatalogCsvError(() => parseCatalogCsvPreview({
      filename: "zu-viele.csv",
      bytes: csv(tooMany),
      mapping: mapping(),
    }), "too_many_rows");
  });

  it("erzeugt eine kanonische, wieder einlesbare Semikolon-Vorlage", () => {
    const template = catalogCsvTemplate();
    expect(template.charCodeAt(0)).toBe(0xfeff);
    const inspection = inspectCatalogCsvFile({
      filename: "katalog-vorlage.csv",
      bytes: new TextEncoder().encode(template),
    });
    expect(inspection.delimiter).toBe(";");
    expect(inspection.headers).toEqual([...headers]);
    expect(inspection.rowCount).toBe(1);
  });

  it("normalisiert semantisch identische Mappings auf denselben Snapshot und Hash", () => {
    const bytes = csv([baseRow()]);
    const canonical = parseCatalogCsvPreview({
      filename: "mapping.csv",
      bytes,
      mapping: mapping(),
    });
    const permuted = structuredClone(mapping());
    permuted.columns.reverse();
    const reordered = parseCatalogCsvPreview({
      filename: "mapping.csv",
      bytes,
      mapping: permuted,
    });
    expect(reordered.mapping).toEqual(canonical.mapping);
    expect(reordered.mappingSha256).toBe(canonical.mappingSha256);
  });

  it("behandelt interne Leerzeilen stabil und mehrdeutige Delimiter fail-closed", () => {
    const first = new TextDecoder().decode(csv([baseRow({ internalSku: "PV-FIRST" })]));
    const second = new TextDecoder().decode(csv([baseRow({ internalSku: "PV-SECOND" })]))
      .split("\r\n")[1];
    const withBlank = new TextEncoder().encode(`${first.trimEnd()}\r\n   \r\n${second}\r\n`);
    const preview = parseCatalogCsvPreview({
      filename: "leerzeile.csv",
      bytes: withBlank,
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 3, valid: 2, invalid: 1 });
    expect(preview.rows[1]).toMatchObject({
      status: "invalid",
      rowNumber: 3,
      errors: [expect.objectContaining({ code: "empty_row" })],
    });

    const ambiguous = new TextEncoder().encode(
      "a;b;c,d;e;f\r\n1;2;3,4;5;6\r\n",
    );
    expectCatalogCsvError(() => inspectCatalogCsvFile({
      filename: "mehrdeutig.csv",
      bytes: ambiguous,
    }), "parser_error");
  });

  it("parst Geld ausschließlich gruppenbasiert und ohne Fließkomma", () => {
    const preview = parseCatalogCsvPreview({
      filename: "geld.csv",
      bytes: csv([
        baseRow({ internalSku: "PV-SPACE", purchasePriceNet: "7 9,00" }),
        baseRow({ internalSku: "PV-NBSP", purchasePriceNet: "7\u00a09,00" }),
        baseRow({
          internalSku: "PV-MAX",
          purchasePriceNet: "90000000000000.00",
          salesPriceNet: "90000000000000,00",
        }),
      ]),
      mapping: mapping(),
    });
    expect(preview.counts).toEqual({ total: 3, valid: 1, invalid: 2 });
    const max = preview.rows[2];
    expect(max.status).toBe("valid");
    if (max.status !== "valid") throw new Error("max fixture must be valid");
    expect(max.command.commercial).toMatchObject({
      purchasePriceNetCents: 9_000_000_000_000_000,
      salesPriceNetCents: 9_000_000_000_000_000,
    });
  });

  it("fängt Controls, unpaired Surrogates und unsichere Dateinamen im Vertrag ab", () => {
    expectCatalogCsvError(() => inspectCatalogCsvFile({
      filename: "binär.csv",
      bytes: Uint8Array.from([0x61, 0x3b, 0x62, 0x0d, 0x0a, 0x31, 0x3b, 0x81]),
    }), "invalid_encoding");
    for (const filename of ["../produkte.csv", "ordner/produkte.csv", "x\\produkte.csv", "x\n.csv"] ) {
      expectCatalogCsvError(() => inspectCatalogCsvFile({
        filename,
        bytes: csv([baseRow()]),
      }), "invalid_filename");
    }
    expectCatalogCsvError(() => autoMapCatalogCsvHeaders(["Fremdspalte"]), "missing_mapping");

    const surrogate = parseCatalogCsvPreview({
      filename: "surrogate.csv",
      bytes: csv([baseRow({
        internalSku: "OTH-SURROGATE",
        componentType: "other",
        nominalPowerWatts: "",
        unit: "set",
        attributes: '[{"name":"\\ud800","value":"x"}]',
      })]),
      mapping: mapping(),
    });
    expect(surrogate.rows[0]).toMatchObject({
      status: "invalid",
      errors: [expect.objectContaining({
        field: "attributes",
        code: "invalid_technical_shape",
      })],
    });
  });

  it("validiert Preview-Hashes, Zeilenfolge und SKU-Bindung exakt", () => {
    const preview = parseCatalogCsvPreview({
      filename: "exact.csv",
      bytes: csv([baseRow()]),
      mapping: mapping(),
    });
    for (const mutate of [
      (value: typeof preview) => { value.mappingSha256 = "0".repeat(64); },
      (value: typeof preview) => {
        const row = value.rows[0];
        if (row?.status === "valid") row.commandSha256 = "0".repeat(64);
      },
      (value: typeof preview) => {
        const row = value.rows[0];
        if (row) row.rowNumber = 3;
      },
      (value: typeof preview) => {
        const row = value.rows[0];
        if (row?.status === "valid") row.normalizedSku = "FREMDE-SKU";
      },
    ]) {
      const tampered = structuredClone(preview);
      mutate(tampered);
      expect(() => catalogCsvPreviewV1Schema.parse(tampered)).toThrow();
    }
    expect(preview.file).not.toHaveProperty("headers");
    expect(preview.file).not.toHaveProperty("ignoredHeaders");
  });

  it("trennt den öffentlichen Fehlerreport vom internen Previewvertrag", () => {
    const preview = parseCatalogCsvPreview({
      filename: "report.csv",
      bytes: csv([baseRow({ purchasePriceNet: "geheim-falsch" })]),
      mapping: mapping(),
    });
    const report = catalogCsvErrorReportRows(preview);
    expect(report).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        field: "purchasePriceNet",
        code: "invalid_money",
      }),
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("PV-440-BLK");
    expect(serialized).not.toMatch(/[0-9a-f]{64}/u);
    expect(serialized).not.toContain("geheim-falsch");
    expect(catalogCsvErrorReportRowV1Schema.safeParse({
      ...report[0],
      message: "Frei erfundene Meldung",
    }).success).toBe(false);
  });

  it("serialisiert den Fehlerreport als private-taugliche CSV und neutralisiert Formeln", () => {
    const base = catalogCsvErrorReportRowV1Schema.parse({
      rowNumber: 2,
      field: "purchasePriceNet",
      sourceHeader: "Einkaufspreis netto",
      code: "invalid_money",
      message: "Der Nettopreis ist nicht eindeutig lesbar.",
    });
    const report = renderCatalogCsvErrorReport([
      base,
      ...["=cmd", "+SUM(A1)", "-2+3", "@import", "\tcmd", "\rcmd"].map(
        (sourceHeader, index) => ({
          ...base,
          rowNumber: index + 3,
          sourceHeader,
        }),
      ),
    ]);

    expect(report.startsWith("\uFEFFZeile;Feld;Quellspalte;Code;Meldung\r\n"))
      .toBe(true);
    for (const dangerous of ["=cmd", "+SUM(A1)", "-2+3", "@import", "\tcmd", "\rcmd"]) {
      expect(report).toContain(`'${dangerous}`);
    }
    expect(report).not.toMatch(/(?:^|;)=(?:cmd|SUM)/mu);
    expect(report).not.toMatch(/[0-9a-f]{64}/u);
    expect(report).not.toContain("geheim-falsch");
    expect(report.endsWith("\r\n")).toBe(true);
  });

  it("versiegelt create, revise und unchanged als persistierten Row-Command", () => {
    const preview = parseCatalogCsvPreview({
      filename: "row-command.csv",
      bytes: csv([baseRow()]),
      mapping: mapping(),
    });
    const source = preview.rows[0];
    if (source?.status !== "valid") throw new Error("fixture must be valid");
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const componentId = "00000000-0000-4000-8000-000000000002";
    const target = sealCatalogComponentRevision({
      schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
      canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
      identity: {
        workspaceId,
        componentId,
        revision: 1,
        internalSku: source.command.internalSku,
        componentType: source.command.componentType,
      },
      presentation: source.command.presentation,
      technicalData: source.command.technicalData,
      commercial: source.command.commercial,
      technicalProvenance: source.command.technicalProvenance,
    });
    const create = sealCatalogImportRowCommand({
      fileSha256: preview.file.sha256,
      mappingSha256: preview.mappingSha256,
      sourceRow: source,
      operation: "create",
      targetComponentId: componentId,
      expected: null,
      sealedTarget: target,
    });
    expect(parseCatalogImportRowCommand(create)).toEqual(create);
    expect(create.sealedTarget).toMatchObject({
      snapshotSha256: target.snapshotSha256,
    });
    const mappingEnvelope = catalogCsvMappingPersistenceEnvelope(preview.mapping);
    expect(mappingEnvelope.snapshot).toEqual(preview.mapping);
    expect(mappingEnvelope.sha256).toBe(preview.mappingSha256);
    const createEnvelope = catalogImportRowPersistenceEnvelope(create);
    const previewRowEnvelope = catalogCsvPreviewRowPersistenceEnvelope(source);
    expect(createEnvelope.previewRowBodyCanonical).toBe(previewRowEnvelope.bodyCanonical);
    expect(createHash("sha256").update(createEnvelope.previewRowBodyCanonical).digest("hex"))
      .toBe(source.rowSha256);
    expect(Buffer.byteLength(createEnvelope.previewRowBodyCanonical, "utf8"))
      .toBeLessThanOrEqual(CATALOG_CSV_PREVIEW_ROW_CANONICAL_MAX_BYTES);
    expect(createHash("sha256").update(createEnvelope.sourceCommandBodyCanonical).digest("hex"))
      .toBe(createEnvelope.sourceCommandSha256);
    expect(createHash("sha256").update(createEnvelope.rowCommandBodyCanonical).digest("hex"))
      .toBe(createEnvelope.rowCommandSha256);
    expect(createEnvelope.sealedTargetBodyCanonical).not.toBeNull();

    const mismatchedTarget = sealCatalogComponentRevision({
      schemaVersion: target.schemaVersion,
      canonicalizationVersion: target.canonicalizationVersion,
      identity: target.identity,
      presentation: { ...target.presentation, displayName: "Fremder Zielstand" },
      technicalData: target.technicalData,
      commercial: target.commercial,
      technicalProvenance: target.technicalProvenance,
    });
    expect(() => sealCatalogImportRowCommand({
      fileSha256: preview.file.sha256,
      mappingSha256: preview.mappingSha256,
      sourceRow: source,
      operation: "create",
      targetComponentId: componentId,
      expected: null,
      sealedTarget: mismatchedTarget,
    })).toThrow();

    const expected = {
      componentId,
      revision: 1,
      status: "active" as const,
      snapshotSha256: target.snapshotSha256,
      internalSku: source.command.internalSku,
      componentType: source.command.componentType,
    };
    const targetRevision2 = sealCatalogComponentRevision({
      schemaVersion: target.schemaVersion,
      canonicalizationVersion: target.canonicalizationVersion,
      identity: { ...target.identity, revision: 2 },
      presentation: target.presentation,
      technicalData: target.technicalData,
      commercial: target.commercial,
      technicalProvenance: target.technicalProvenance,
    });
    const revise = sealCatalogImportRowCommand({
      fileSha256: preview.file.sha256,
      mappingSha256: preview.mappingSha256,
      sourceRow: source,
      operation: "revise",
      targetComponentId: componentId,
      expected,
      sealedTarget: targetRevision2,
    });
    const unchanged = sealCatalogImportRowCommand({
      fileSha256: preview.file.sha256,
      mappingSha256: preview.mappingSha256,
      sourceRow: source,
      operation: "unchanged",
      targetComponentId: componentId,
      expected,
      sealedTarget: null,
    });
    expect(parseCatalogImportRowCommand(revise).operation).toBe("revise");
    expect(parseCatalogImportRowCommand(unchanged).operation).toBe("unchanged");

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validateJsonContract = ajv.compile(
      JSON.parse(renderCatalogCsvImportJsonSchema()),
    );
    expect(validateJsonContract(create)).toBe(true);
    expect(validateJsonContract(revise)).toBe(true);
    expect(validateJsonContract(unchanged)).toBe(true);
    expect(validateJsonContract({ ...create, expected, sealedTarget: null })).toBe(false);
    expect(validateJsonContract({ ...revise, sealedTarget: null })).toBe(false);
    expect(validateJsonContract({ ...unchanged, expected: null })).toBe(false);

    const mismatchedTargetType = structuredClone(create);
    if (mismatchedTargetType.sealedTarget === null) throw new Error("target missing");
    mismatchedTargetType.sealedTarget.snapshot.identity.componentType = "battery";
    expect(catalogImportRowCommandV1Schema.safeParse(mismatchedTargetType).success).toBe(false);
    expect(validateJsonContract(mismatchedTargetType)).toBe(false);

    const mismatchedTargetTechnicalData = structuredClone(create);
    if (mismatchedTargetTechnicalData.sealedTarget === null) throw new Error("target missing");
    mismatchedTargetTechnicalData.sealedTarget.snapshot.technicalData = {
      schemaVersion: "battery.v1",
      nominalCapacityWh: 10_000,
      usableCapacityWh: 9_000,
      maxContinuousPowerWatts: 5_000,
      roundTripEfficiencyBasisPoints: 9_000,
      backupCapability: "known_supported",
    };
    expect(catalogImportRowCommandV1Schema.safeParse(mismatchedTargetTechnicalData).success)
      .toBe(false);
    expect(validateJsonContract(mismatchedTargetTechnicalData)).toBe(false);

    const mismatchedTargetUnit = structuredClone(create);
    if (mismatchedTargetUnit.sealedTarget === null) throw new Error("target missing");
    mismatchedTargetUnit.sealedTarget.snapshot.presentation.unit = "set";
    expect(catalogImportRowCommandV1Schema.safeParse(mismatchedTargetUnit).success).toBe(false);
    expect(validateJsonContract(mismatchedTargetUnit)).toBe(false);

    const maximumRevision = structuredClone(unchanged);
    if (maximumRevision.operation !== "unchanged" || maximumRevision.expected === null) {
      throw new Error("unchanged fixture must carry expected");
    }
    maximumRevision.expected.revision = 2_147_483_647;
    expect(catalogImportRowCommandV1Schema.safeParse(maximumRevision).success).toBe(true);
    const oversizedRevision = structuredClone(maximumRevision);
    if (oversizedRevision.expected === null) throw new Error("expected missing");
    oversizedRevision.expected.revision = 2_147_483_648;
    expect(catalogImportRowCommandV1Schema.safeParse(oversizedRevision).success).toBe(false);
    const uppercaseExpectedUuid = structuredClone(unchanged);
    if (uppercaseExpectedUuid.expected === null) throw new Error("expected missing");
    uppercaseExpectedUuid.targetComponentId =
      "00000000-0000-4000-8000-0000000000AB";
    uppercaseExpectedUuid.expected.componentId = uppercaseExpectedUuid.targetComponentId;
    expect(catalogImportRowCommandV1Schema.safeParse(uppercaseExpectedUuid).success)
      .toBe(false);
    const oversizedTargetRevision = structuredClone(create);
    if (oversizedTargetRevision.sealedTarget === null) throw new Error("target missing");
    oversizedTargetRevision.sealedTarget.snapshot.identity.revision = 2_147_483_648;
    expect(catalogImportRowCommandV1Schema.safeParse(oversizedTargetRevision).success)
      .toBe(false);
    const uppercaseTargetUuid = structuredClone(create);
    if (uppercaseTargetUuid.sealedTarget === null) throw new Error("target missing");
    uppercaseTargetUuid.sealedTarget.snapshot.identity.componentId =
      "00000000-0000-4000-8000-0000000000AB";
    expect(catalogImportRowCommandV1Schema.safeParse(uppercaseTargetUuid).success)
      .toBe(false);

    expect(() => sealCatalogImportRowCommand({
      fileSha256: preview.file.sha256,
      mappingSha256: preview.mappingSha256,
      sourceRow: source,
      operation: "unchanged",
      targetComponentId: componentId,
      expected,
      sealedTarget: targetRevision2,
    })).toThrow();
    for (const operation of ["create", "revise"] as const) {
      expect(() => sealCatalogImportRowCommand({
        fileSha256: preview.file.sha256,
        mappingSha256: preview.mappingSha256,
        sourceRow: source,
        operation,
        targetComponentId: componentId,
        expected: operation === "create" ? null : expected,
        sealedTarget: null,
      })).toThrow();
    }

    for (const tampered of [
      { ...create, targetComponentId: "00000000-0000-4000-8000-000000000003" },
      { ...revise, rowCommandSha256: "0".repeat(64) },
      { ...unchanged, expected: { ...expected, revision: 2 } },
    ]) {
      expect(() => parseCatalogImportRowCommand(tampered)).toThrow();
    }

    const intentId = "00000000-0000-4000-8000-000000000004";
    const prepared = sealCatalogImportPrepareV1({
      workspaceId,
      preview,
      rows: [{ status: "valid", command: create }],
    });
    expect(prepared.schemaVersion).toBe(CATALOG_IMPORT_PREPARE_VERSION);
    expect(parseCatalogImportPrepareV1(prepared, { workspaceId })).toEqual(prepared);
    expect(catalogImportReservationSha256({ intentId, preview })).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    const driftedPrepare = structuredClone(prepared);
    driftedPrepare.file.sha256 = "0".repeat(64);
    expect(() => parseCatalogImportPrepareV1(driftedPrepare, { workspaceId }))
      .toThrow();
    expect(() => parseCatalogImportPrepareV1(prepared, {
      workspaceId: "00000000-0000-4000-8000-000000000099",
    })).toThrow();
  });

  it("pinnt die echte PapaParse-Version statt eines semver-Bereichs", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.papaparse).toBe("5.7.0");
  });
});

function expectCatalogCsvError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected CatalogCsvImportError ${code}`);
}
