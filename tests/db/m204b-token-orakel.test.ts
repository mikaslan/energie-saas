import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  generateSignatureToken,
  SIGNATURE_REQUEST_SIGN_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import {
  recordSignatureView,
  resolveSignatureByToken,
  revokeSignatureByCustomer,
  SignatureNotFoundError,
  signSignatureByToken,
} from "@/modules/signatures";
import { testPool } from "../setup/test-db";

// M2-04b (Kimi-P2 b2): deformiertes Roh-Token faellt an den oeffentlichen
// Kapseln uniform auf NotFound — nie TypeError/500, kein Orakel ueber
// Existenz, Stand oder Token-Format (wohlgeformt-unbekannt und deformiert
// sind ununterscheidbar).

const MALFORMED_TOKENS = [
  "!!!-kein-base64url-!!!",
  "zu-kurz",
  "x".repeat(44),
];

function signCommand(token: string) {
  return {
    schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
    token,
    mode: "click",
    artifactMimeType: null,
    artifactBytes: null,
  };
}

describe("M2-04b Token-Orakel", () => {
  it("M204B-DB-01 wirft fuer deformierte Token NotFound statt TypeError", async () => {
    for (const token of MALFORMED_TOKENS) {
      await expect(signSignatureByToken(testPool, signCommand(token))).rejects.toThrow(
        SignatureNotFoundError,
      );
      await expect(
        revokeSignatureByCustomer(testPool, { token }),
      ).rejects.toThrow(SignatureNotFoundError);
      await expect(resolveSignatureByToken(testPool, { token })).rejects.toThrow(
        SignatureNotFoundError,
      );
      const view = await recordSignatureView(testPool, { token });
      expect(view.status).toBe("not_found");
    }
  });

  it("M204B-DB-02 behandelt wohlgeformt-unbekannte Token identisch (kein Orakel)", async () => {
    const { token } = generateSignatureToken();
    await expect(signSignatureByToken(testPool, signCommand(token))).rejects.toThrow(
      SignatureNotFoundError,
    );
    await expect(
      revokeSignatureByCustomer(testPool, { token }),
    ).rejects.toThrow(SignatureNotFoundError);
    await expect(resolveSignatureByToken(testPool, { token })).rejects.toThrow(
      SignatureNotFoundError,
    );
    const view = await recordSignatureView(testPool, { token });
    expect(view).toEqual({
      requestId: null,
      status: "not_found",
      viewCount: 0,
      firstViewedAt: null,
    });
  });
});
