import { describe, expect, it } from "vitest";
import {
  CONTACT_UPDATE_COMMAND_VERSION,
  contactUpdateCommandV1Schema,
  contactUpdatePatchV1Schema,
} from "@/modules/contacts/contract";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";

function command(patch: Record<string, unknown>) {
  return {
    schemaVersion: CONTACT_UPDATE_COMMAND_VERSION,
    projectId: PROJECT_ID,
    expectedRevision: 1,
    patch,
  };
}

describe("M1-14 Kontakt-Vertrag", () => {
  it("M114-CONTRACT-01: akzeptiert gültige Anrede + B2B-Invariante, lehnt fremde Anrede ab", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      salutation: "business",
      isBusiness: true,
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      salutation: "female",
      isBusiness: false,
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      salutation: "dr",
    })).success).toBe(false);
  });

  it("M114-CONTRACT-02: normalisiert/validiert E-Mail (sekundär) und E.164", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      emailSecondary: "Sekundaer@Example.com",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      emailSecondary: "keine-mail",
    })).success).toBe(false);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      phoneMobile: "+491701234567",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      phoneMobile: "0170-1234567",
    })).success).toBe(false);
  });

  it("M114-CONTRACT-03: Kontaktadresse Längen + PLZ-Form", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      addressPostalCode: "10115",
      addressCountry: "DE",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      addressPostalCode: "ABC123",
      addressCountry: "DE",
    })).success).toBe(true); // freie Form wird im Contract nicht gekoppelt
    expect(contactUpdateCommandV1Schema.safeParse(command({
      addressStreet: "a".repeat(201),
    })).success).toBe(false);
  });

  it("M114-CONTRACT-04: Consent-Policy-Version + https-Link (Format)", () => {
    // P1-2: Die DB-Invariante „marketing_consent=true ⇒ Version gesetzt"
    // (contact_marketing_consent_version_ck) wird hier NICHT geprüft, weil der
    // M1-14-Patch den Boolean nicht trägt (intake-owned). Der DB-Test
    // m114-contact-dataset-service.test.ts beweist die CHECK-Durchsetzung.
    expect(contactUpdateCommandV1Schema.safeParse(command({
      marketingConsentPolicyVersion: "v1",
      marketingConsentDataProtectionLink: "https://example.test/datenschutz",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      marketingConsentDataProtectionLink: "javascript:alert(1)",
    })).success).toBe(false);
  });

  it("P2-2: lehnt whitespace-only Namen ab (kein Phantom-Bump)", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      firstName: "   ",
    })).success).toBe(false);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      lastName: "\t\n",
    })).success).toBe(false);
  });

  it("M114-CONTRACT-05: UTM-Längen", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      utmSource: "newsletter",
      utmCampaign: "q1-2026",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      utmSource: "x".repeat(1001),
    })).success).toBe(false);
  });

  it("M114-CONTRACT-06: phone_reachability-Enum", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({
      phoneReachability: "morning",
    })).success).toBe(true);
    expect(contactUpdateCommandV1Schema.safeParse(command({
      phoneReachability: "anytime",
    })).success).toBe(false);
  });

  it("lehnt leeren Patch ab und verlangt expectedRevision", () => {
    expect(contactUpdateCommandV1Schema.safeParse(command({})).success).toBe(false);
    expect(contactUpdatePatchV1Schema.safeParse({}).success).toBe(false);
    expect(contactUpdateCommandV1Schema.safeParse({
      ...command({ firstName: "Erika" }),
      expectedRevision: 0,
    }).success).toBe(false);
  });
});
