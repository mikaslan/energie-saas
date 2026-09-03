export const RECHNER_INTAKE_CONTRACT_VERSION = "rechner-intake.v1" as const;
export const RECHNER_CALCULATION_SCHEMA_VERSION = "wmee-solar-snapshot.v1" as const;
export const RECHNER_SOURCE_KEY = "wmee-rechner-v3" as const;
export const RECHNER_INTAKE_SCOPE = "rechner-intake.write" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RechnerIntakeV1 {
  contractVersion: typeof RECHNER_INTAKE_CONTRACT_VERSION;
  submissionId: string;
  submittedAt: string;
  producer: {
    application: "wmee-rechner-v3" | "wmee-rechner-v5";
    gitRevision: string;
    environment: "production" | "preview" | "development";
    deploymentId: string | null;
    calculatorEngine: "wmee-solar.v1";
  };
  acquisition: {
    channel: "website_calculator";
    source: "solarrechner";
    pagePath: string | null;
    referrerOrigin: string | null;
    utm: {
      source: string | null;
      medium: string | null;
      campaign: string | null;
      term: string | null;
      content: string | null;
    };
  };
  customer: {
    displayName: string;
    email: string;
    phoneRaw: string;
  };
  privacy: {
    purpose: "offer_request";
    legalBasis: "art_6_1_b_precontractual";
    noticeVersion: string;
    noticeUrl: string;
    marketingConsent: "not_collected";
  };
  site: {
    addressMode: "selected" | "regional_estimate";
    formattedAddress: string;
    street: string | null;
    houseNumber: string | null;
    postalCode: string | null;
    city: string | null;
    countryCode: "DE";
    latitude: number;
    longitude: number;
    geocodeSource: "photon" | "regional_default";
    precision: "house" | "street" | "locality" | "region";
  };
  // v3 liefert den vollen Berechnungs-Snapshot; der v5-Lead-only-Fan-out
  // (Kontaktformular ohne Fachdaten) darf ihn weglassen — das Board zeigt
  // dann eine unqualifizierte Anfrage ohne Berechnung.
  calculation?: RechnerCalculationSnapshotV1;
}

export interface RechnerCalculationSnapshotV1 extends JsonObject {
  schemaVersion: typeof RECHNER_CALCULATION_SCHEMA_VERSION;
  calculatedAt: string;
  branch: "new_installation" | "existing_installation";
  questionnaireVariant: "short" | "standard" | "pro";
  resultIntegrity: "client_reported_unverified";
  inputs: RechnerCalculationInputsV1;
  provenance: {
    yield: "pvgis_hourly" | "pvgis_annual" | "estimate";
    roof: "lod2" | "user_drawn" | "osm" | "default";
    consumption: "metered_kwh" | "derived_from_cost" | "estimated_people" | "default";
    electricityPrice: "customer" | "default";
    annualPriceIncrease: "customer" | "default";
    investment: "market_estimate";
  };
  result: JsonObject & { mode: "new_installation" | "existing_installation" };
}

export interface RechnerCalculationInputsV1 extends JsonObject {
  roofs: Array<{
    id: string;
    areaM2: number;
    azimuthDeg: number;
    tiltDeg: number;
    type: "pitched" | "flat";
    shading: "none" | "light" | "medium" | "strong" | null;
  }>;
  consumption: JsonObject;
  requestedProducts: {
    targetStorageKwh: number;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  };
  existingInstallation: JsonObject | null;
  assumptions: JsonObject;
  answeredFieldIds: string[];
}

export type RechnerIntakeReceiptV1 = {
  contractVersion: "rechner-intake-receipt.v1";
  receiptId: string;
  submissionId: string;
  status: "processed";
  duplicate: boolean;
};

// Transportneutraler, bereits serverseitig erzeugter Persistenz-Metadatensatz.
// HTTP-requestId und Header gehoeren bewusst nicht in den Fachservice.
export type RechnerIntakeMeta = {
  payloadSha256: string;
  signedAt: Date;
  receivedAt: Date;
};

export type RechnerIntakeErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "idempotency_conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "schema_invalid"
  | "rate_limited"
  | "temporarily_unavailable"
  | "internal_error";

export type RechnerIntakeErrorV1 = {
  contractVersion: "rechner-intake-error.v1";
  error: {
    code: RechnerIntakeErrorCode;
    requestId: string;
    retryable: boolean;
    paths?: string[];
  };
};
