export const REST_INTAKE_CONTRACT_VERSION = "rest-intake.v1" as const;
export const REST_SOURCE_KEY = "rest" as const;
export const REST_INTAKE_SCOPE = "rest-intake.write" as const;

export interface RestIntakeV1 {
  contractVersion: typeof REST_INTAKE_CONTRACT_VERSION;
  clientRecordId: string;
  sourceName?: string;
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
    geocodeSource: "rest" | "regional_default";
    precision: "house" | "street" | "locality" | "region";
  };
  note: string | null;
}

export type RestIntakeReceiptV1 = {
  contractVersion: "rest-intake-receipt.v1";
  receiptId: string;
  clientRecordId: string;
  status: "processed";
  duplicate: boolean;
};

// Transportneutraler, bereits serverseitig erzeugter Persistenz-Metadatensatz.
// HTTP-requestId und Header gehoeren bewusst nicht in den Fachservice.
export type RestIntakeMeta = {
  payloadSha256: string;
  signedAt: Date;
  receivedAt: Date;
};

export type RestIntakeErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "idempotency_conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "schema_invalid"
  | "rate_limited"
  | "temporarily_unavailable"
  | "internal_error";

export type RestIntakeErrorV1 = {
  contractVersion: "rest-intake-error.v1";
  error: {
    code: RestIntakeErrorCode;
    requestId: string;
    retryable: boolean;
    paths?: string[];
  };
};
