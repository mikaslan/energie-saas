import { createHash } from "node:crypto";

export const ADDRESS_FINGERPRINT_VERSION = 1;

export type AddressFingerprintParts = {
  countryCode: string;
  postalCode: string;
  city: string;
  street: string;
  houseNumber: string;
};

function canonicalAddressPart(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Builds the stable contact/site deduplication fingerprint introduced by the
 * Rechner intake. The version prefix and field order are persisted contract:
 * changing either requires a new ADDRESS_FINGERPRINT_VERSION.
 */
export function addressFingerprint(parts: AddressFingerprintParts): Buffer {
  const preimage = [
    `rechner-site-address:v${ADDRESS_FINGERPRINT_VERSION}`,
    canonicalAddressPart(parts.countryCode),
    canonicalAddressPart(parts.postalCode),
    canonicalAddressPart(parts.city),
    canonicalAddressPart(parts.street),
    canonicalAddressPart(parts.houseNumber),
  ].join("\0");

  return createHash("sha256").update(preimage, "utf8").digest();
}
