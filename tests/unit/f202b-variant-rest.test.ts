import { describe, expect, it } from "vitest";
import {
  contentLockToBlockedCode,
  dominantContentLock,
} from "@/lib/integrations/offers/variant-controls";

/**
 * F2-02b F202B-UNIT-01 — Code-Mapping Lock-Status → Block-Code (RED).
 *
 * Vertrag aus docs/spec/F2-02b-varianten-rest.md, D1-03: dieselben Codes wie
 * reviseOfferVariant (service.ts Z.2886–2892: pending → variant_signature_pending,
 * signed → variant_signed, sonst variant_revoked_by_customer) plus Bulk-Priorität
 * revoked > signed > pending (SQL-ORDER-BY-Präzedenz Z.648–652 / Z.679–683).
 *
 * Import-Heimat wie Muster f202-variant-controls.test.ts: das reine Modul
 * @/lib/integrations/offers/variant-controls (kein server-only in der Kette).
 * @/modules/offers ist hier falsch — service.ts Z.1 zieht "server-only" und
 * failt als Setup-Fehler statt als fehlendes Feature.
 *
 * RED-Grund: Das Mapping existiert nur inline (revise, privat) bzw. als privater
 * bulkLockSkipReason (SkipReason-Union, nicht Block-Code); die Bulk-Priorität nur
 * als SQL-ORDER-BY. Beide obigen Named-Exports fehlen — GREEN ergänzt sie als
 * reine Helfer in variant-controls.ts (Service nutzt sie dann nach).
 */

// Lokale Abbilder (kein @/modules/offers-Import: server-only-Kette).
type VariantContentLock = "pending" | "signed" | "revoked_by_customer";
type VariantBlockCode =
  | "variant_signature_pending"
  | "variant_signed"
  | "variant_revoked_by_customer";

describe("F2-02b Varianten-Rest (F202B-UNIT-01: Lock-Status → Block-Code)", () => {
  it("mappt jeden Lock-Status auf den revise-kanonischen Block-Code", () => {
    const cases: Array<[VariantContentLock, VariantBlockCode]> = [
      ["pending", "variant_signature_pending"],
      ["signed", "variant_signed"],
      ["revoked_by_customer", "variant_revoked_by_customer"],
    ];
    for (const [lock, code] of cases) {
      expect(contentLockToBlockedCode(lock)).toBe(code);
    }
  });

  it("liefert exakt die drei D1-03-Block-Codes (OfferBlockedError-Vertrag)", () => {
    const locks: readonly VariantContentLock[] = ["pending", "signed", "revoked_by_customer"];
    expect(locks.map(contentLockToBlockedCode).sort()).toEqual(
      ["variant_revoked_by_customer", "variant_signature_pending", "variant_signed"].sort(),
    );
  });

  it("Bulk-Priorität: revoked schlägt signed schlägt pending (jede Reihenfolge)", () => {
    expect(dominantContentLock([])).toBeNull();
    expect(dominantContentLock(["pending"])).toBe("pending");
    expect(dominantContentLock(["signed"])).toBe("signed");
    expect(dominantContentLock(["revoked_by_customer"])).toBe("revoked_by_customer");
    expect(dominantContentLock(["pending", "signed"])).toBe("signed");
    expect(dominantContentLock(["signed", "pending"])).toBe("signed");
    expect(dominantContentLock(["signed", "revoked_by_customer"])).toBe("revoked_by_customer");
    expect(dominantContentLock(["revoked_by_customer", "signed"])).toBe("revoked_by_customer");
    expect(dominantContentLock(["pending", "revoked_by_customer"])).toBe("revoked_by_customer");
    expect(dominantContentLock(["pending", "signed", "revoked_by_customer"])).toBe("revoked_by_customer");
    expect(dominantContentLock(["revoked_by_customer", "pending", "signed"])).toBe("revoked_by_customer");
  });

  it("Bulk-Priorität: Duplikate und Map-Werte (readVariantContentLocks-Form)", () => {
    expect(dominantContentLock(["pending", "pending"])).toBe("pending");
    const locks = new Map<string, VariantContentLock>([
      ["00000000-0000-0000-0000-000000000001", "pending"],
      ["00000000-0000-0000-0000-000000000002", "signed"],
    ]);
    expect(dominantContentLock(locks.values())).toBe("signed");
    locks.set("00000000-0000-0000-0000-000000000003", "revoked_by_customer");
    expect(dominantContentLock(locks.values())).toBe("revoked_by_customer");
    expect(contentLockToBlockedCode(dominantContentLock(locks.values())!)).toBe(
      "variant_revoked_by_customer",
    );
  });
});
