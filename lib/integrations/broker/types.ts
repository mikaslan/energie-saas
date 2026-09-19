export const BROKER_INTAKE_CONTRACT_VERSION = "broker-intake.v1" as const;
export const BROKER_SOURCE_KEY = "broker" as const;
export const BROKER_INTAKE_SCOPE = "broker-intake.write" as const;

export const BROKER_KEYS = [
  "wattfox",
  "aroundhome",
  "daa",
  "eza",
  "interlead",
  "bitrix",
] as const;

export type BrokerKey = (typeof BROKER_KEYS)[number];

export interface BrokerIntakeV1 {
  contractVersion: typeof BROKER_INTAKE_CONTRACT_VERSION;
  brokerKey: BrokerKey;
  brokerRecordId: string;
  submittedAt: string;
  customer: {
    displayName: string;
    email: string;
    phoneRaw: string | null;
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
    geocodeSource: "broker" | "regional_default";
    precision: "house" | "street" | "locality" | "region";
  };
  note: string | null;
}

export type BrokerIntakeReceiptV1 = {
  contractVersion: "broker-intake-receipt.v1";
  receiptId: string;
  brokerKey: BrokerKey;
  brokerRecordId: string;
  status: "processed";
  duplicate: boolean;
};

// Transportneutraler, bereits serverseitig erzeugter Persistenz-Metadatensatz.
// HTTP-requestId und Header gehoeren bewusst nicht in den Fachservice.
export type BrokerIntakeMeta = {
  payloadSha256: string;
  signedAt: Date;
  receivedAt: Date;
};

export type BrokerIntakeErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "idempotency_conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "schema_invalid"
  | "rate_limited"
  | "temporarily_unavailable"
  | "internal_error";

export type BrokerIntakeErrorV1 = {
  contractVersion: "broker-intake-error.v1";
  error: {
    code: BrokerIntakeErrorCode;
    requestId: string;
    retryable: boolean;
    paths?: string[];
  };
};
