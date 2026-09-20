import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as sizingEstimateV1 from "@/lib/integrations/heat-pump/sizing-estimate-v1";

// F5-02 Heizlast-Methoden (RED, Ref docs/spec/F5-02-heizlast-methoden.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx vitest run tests/unit/f502-methoden.red.test.ts`
// (4 rote Tests, Auszug in der Spec §ROT-Beleg); danach describe.skip
// bis zur Umsetzung.
// SKIP-Grund: SPECIFIED, nicht implementiert (Indication-Builder,
// U-Wert-Seed, Simple-Builder, Roomwise-Stufen-Gate offen) — Ref §1/§4.

const HEAT_PUMP_DIR = path.join(process.cwd(), "lib/integrations/heat-pump");

describe.skip("F5-02 Heizlast-Methoden (RED, SPECIFIED)", () => {
  it("Indication-Builder existiert (heat-load-indication-v1)", () => {
    // Heute: nur sizing-estimate-v1.ts im heat-pump-Ordner.
    expect(existsSync(path.join(HEAT_PUMP_DIR, "heat-load-indication-v1.ts"))).toBe(true);
  });

  it("U-Wert-Lookup nach Baujahr ist exportiert", () => {
    // Heute: sizing-estimate-v1 kennt kein Baujahr-U-Wert-Mapping (§4).
    expect("lookupUWertByBaujahr" in sizingEstimateV1).toBe(true);
  });

  it("Simple-Abgrenzung ist exportiert (kein stilles F5-01-Relabel)", () => {
    // Spec §3: F5-01 bleibt Orientierungswert; Simple braucht eigenen Export.
    expect("HEATING_METHOD_KIND" in sizingEstimateV1).toBe(true);
  });

  it("Roomwise-Stufe-B-Gate existiert (Normkauf-Gate)", () => {
    // Spec §1/§4: Stufe B erst mit Normkauf-Gate; heute kein Gate-Export.
    expect("ROOMWISE_STAGE_B_GATE" in sizingEstimateV1).toBe(true);
  });
});
