import { describe, expect, it } from "vitest";

import {
  generateSignatureToken,
  hashSignatureContent,
  hashSignatureToken,
  signatureRequestAnalogV1Schema,
  signatureRequestCreateV1Schema,
  signatureRequestSignV1Schema,
  signatureRequestWithdrawV1Schema,
} from "@/lib/integrations/offers/signature-contract";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";

describe("M2-04 signature command contracts", () => {
  it("validiert create mit TTL 1..60 und lehnt 0/61 ab", () => {
    const valid = signatureRequestCreateV1Schema.safeParse({
      schemaVersion: "signature-request-create.v1",
      workspaceId: WORKSPACE,
      offerId: OFFER,
      variantId: VARIANT,
      ttlDays: 14,
    });
    expect(valid.success).toBe(true);
    expect(signatureRequestCreateV1Schema.safeParse({
      schemaVersion: "signature-request-create.v1",
      workspaceId: WORKSPACE,
      offerId: OFFER,
      variantId: VARIANT,
      ttlDays: 0,
    }).success).toBe(false);
    expect(signatureRequestCreateV1Schema.safeParse({
      schemaVersion: "signature-request-create.v1",
      workspaceId: WORKSPACE,
      offerId: OFFER,
      variantId: VARIANT,
      ttlDays: 61,
    }).success).toBe(false);
  });

  it("validiert withdraw-Reason und analog-MIME", () => {
    expect(signatureRequestWithdrawV1Schema.safeParse({
      schemaVersion: "signature-request-withdraw.v1",
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      reasonCode: "content_error",
    }).success).toBe(true);
    expect(signatureRequestWithdrawV1Schema.safeParse({
      schemaVersion: "signature-request-withdraw.v1",
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      reasonCode: "legal_text_error",
    }).success).toBe(false);

    const pdf = Buffer.from("%PDF-1.7\nx\n%%EOF", "latin1");
    expect(signatureRequestAnalogV1Schema.safeParse({
      schemaVersion: "signature-request-analog.v1",
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      mimeType: "application/pdf",
      signingDate: "2026-09-03T00:00:00.000Z",
      artifactBytes: pdf,
    }).success).toBe(true);
    expect(signatureRequestAnalogV1Schema.safeParse({
      schemaVersion: "signature-request-analog.v1",
      workspaceId: WORKSPACE,
      requestId: REQUEST,
      mimeType: "image/png",
      signingDate: "2026-09-03T00:00:00.000Z",
      artifactBytes: pdf,
    }).success).toBe(false);
  });

  it("validiert Signatur-Modus click/draw und lehnt analog am Token-Pfad ab", () => {
    const click = signatureRequestSignV1Schema.safeParse({
      schemaVersion: "signature-request-sign.v1",
      token: "token",
      mode: "click",
      artifactMimeType: null,
      artifactBytes: null,
    });
    expect(click.success).toBe(true);
    const analog = signatureRequestSignV1Schema.safeParse({
      schemaVersion: "signature-request-sign.v1",
      token: "token",
      mode: "analog",
      artifactMimeType: null,
      artifactBytes: null,
    });
    expect(analog.success).toBe(false);
  });

  it("erzeugt 32-Byte-Token, hashed es deterministisch und hashed Content", () => {
    const a = generateSignatureToken();
    const b = generateSignatureToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash.length).toBe(32);
    expect(hashSignatureToken(a.token)).toEqual(a.tokenHash);
    expect(() => hashSignatureToken("zu-kurz")).toThrow();
    const content = Buffer.from("angebot", "utf8");
    expect(hashSignatureContent(content)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
