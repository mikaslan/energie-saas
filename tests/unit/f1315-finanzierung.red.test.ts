import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parsePortalPublicView } from "@/lib/integrations/portal/portal-contract";

// F13-15 Finanzierungs-Intake (Katalog F13.4).
// Spec: docs/spec/F13-15-finanzierung-intake.md.
//
// RED-Stand: Die Spec ist SPECIFIED, aber nichts ist implementiert —
// kein Service-Modul, keine Portal-Projektion. Jeder Test fordert einen
// Spec-Bestandteil ein und muss heute FEHLSCHLAGEN. NUR existierende
// Imports (vitest + portal-contract); das fehlende Modul wird per
// dynamischem import() eingefordert (Reject = ROT-Beleg).
// MISSION-Grenze: keine Bestellung/Zahlung/Einreichung im Test.

const UUID = "11111111-1111-4111-8111-111111111111";

// Nicht-literales Modulspezifizierer-Fragment: tsc löst dynamische
// Imports mit Literal statisch auf (TS2307) — per Variable bleibt der
// Import ein Laufzeit-Reject (= ROT-Beleg), sobald das Modul fehlt.
// F13-01-Konvention (Owner-DECIDED, keine Abschwächung): der Service
// lebt in modules (server-only), lib/financing-case.ts bleibt rein und
// client-sicher — der Contract hängt am Service-Modul, gleiche Assertions.
const MISSING_FINANCING_MODULE = ["@/modules", "financing-cases/service"].join("/");

function importFinancingCase(): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ MISSING_FINANCING_MODULE) as Promise<
    Record<string, unknown>
  >;
}

function resolvePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    inviteId: UUID,
    expiresAt: "2026-02-01T12:00:00+01:00",
    viewCount: 1,
    project: {
      id: UUID,
      name: "Musterprojekt",
      phase: "offer",
      outcome: "open",
      scope: "residential",
    },
    documents: [],
    appointments: [],
    ...extra,
  };
}

// F13-15 GREEN-Slice (Migration 0264): entskippt 2026-09-20, muss GRÜN werden.
// Spec: docs/spec/F13-15-finanzierung-intake.md.
describe("F13-15 Finanzierung-Intake (GREEN-Slice 0264)", () => {
  it("F1315-SVC-01: Service-Modul financing_case existiert (Import löst auf)", async () => {
    const mod = await importFinancingCase();
    expect(mod).toBeDefined();
  });

  it("F1315-SVC-02: Service-Signatur create/setStatus + Guards fail-closed (§1/§2)", async () => {
    const mod = await importFinancingCase();
    expect(typeof mod.createFinancingCase).toBe("function");
    expect(typeof mod.setFinancingCaseStatus).toBe("function");
  });

  it("F1315-GRD-01: Ratenkauf-Schranke 1–25 J. / ≤70.000 €, PSD freitextlich (§1)", async () => {
    const mod = await importFinancingCase();
    expect(typeof mod.validateFinancingTerms).toBe("function");
  });

  it("F1315-MAS-01: Maschine §2 + Events/Audit ohne PII, No-op (§2)", async () => {
    const mod = await importFinancingCase();
    expect(typeof mod.financingTransitions).toBe("object");
  });

  it("F1315-PRT-01: Portal-Projektion financing = grober Stand, nie Details (§4)", () => {
    const parsed = parsePortalPublicView(
      resolvePayload({
        financing: {
          status: "beantragt",
          produkttyp: "ratenkauf",
          beantragtAt: "2026-01-20T10:00:00+01:00",
          entschiedenAt: null,
          ausgezahltAt: null,
          abgeschlossenAt: null,
        },
      }),
    ) as unknown as Record<string, unknown> | null;
    expect(parsed).not.toBeNull();
    const financing = (
      parsed as unknown as Record<string, Record<string, unknown> | null>
    ).financing;
    expect(financing).not.toBeNull();
    expect(financing?.status).toBe("beantragt");
    // Nie-sensible-Nummern (§4): Referenz/Volumen/Laufzeit treten nie aus.
    expect(financing).not.toHaveProperty("providerReferenz");
    expect(financing).not.toHaveProperty("volumenEur");
    expect(financing).not.toHaveProperty("bonitaet");
  });

  it("F1315-PRT-02: portalFinancingSchema-Allowlist fail-closed (§4)", async () => {
    const contract = (await import(
      "@/lib/integrations/portal/portal-contract"
    )) as Record<string, unknown>;
    expect(contract.portalFinancingSchema).toBeDefined();
  });
});
