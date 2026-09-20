import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as sizingV1 from "@/lib/integrations/heat-pump/sizing-estimate-v1";
import * as subsidiesContract from "@/lib/integrations/subsidies/contract";

// F5-07 Förder-Berichte (RED, Ref docs/spec/F5-07-foerder-berichte.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx vitest run tests/unit/f507-berichte.red.test.ts`
// (5 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.
//
// Umsetzungsziel (SPECIFIED, nicht implementiert): reiner Read-only-Builder
// `lib/integrations/subsidies/subsidy-estimate-v1.ts` (Muster F5-01
// `sizing-estimate-v1`), Regelsatz f56-458.v1, WE≠1 fail-closed.

const PLANNED_BUILDER = path.resolve(
  process.cwd(),
  "lib/integrations/subsidies/subsidy-estimate-v1.ts",
);

// SKIP-Grund: F5-07 noch nicht implementiert (reine Spec + RED-Beleg, ROT am
// 2026-09-20 bewiesen, Auszug in der Spec). Ref:
// docs/spec/F5-07-foerder-berichte.md — aktivieren, sobald der
// Umsetzungs-Slice (Schätzkarte-Builder f56-458.v1) landet.
describe.skip("f507 foerder-berichte", () => {
  it("Schätzkarte-Builder existiert (Read-only, Muster F5-01)", () => {
    expect(existsSync(PLANNED_BUILDER)).toBe(true);
  });

  it("458-Regelsatz f56-458.v1 ist als ESTIMATE-Tabelle gepinnt", () => {
    expect(subsidiesContract).toHaveProperty(
      "F56_KFW458_RULESET_VERSION",
      "f56-458.v1",
    );
  });

  it("WE-Staffel: nur EFH belegt, WE≠1 fail-closed (Guard exportiert)", () => {
    expect(subsidiesContract).toHaveProperty("assertF56SingleUnit");
    expect(sizingV1).toHaveProperty("F56_WE_MAX_V1", 1);
  });

  it("Deckel-Default 70 %, 80 % nur per Opt-in-Flag", () => {
    expect(subsidiesContract).toHaveProperty("F56_SUBSIDY_CAP_DEFAULT_V1", 70);
    expect(subsidiesContract).toHaveProperty("F56_SUBSIDY_CAP_OPTIN_V1", 80);
  });

  it("Disclaimer-Export ohne Zusicherungs-Wortlaut (unverbindliche Schätzung)", () => {
    expect(subsidiesContract).toHaveProperty(
      "F56_SUBSIDY_DISCLAIMER_V1",
      expect.stringContaining("unverbindliche Schätzung"),
    );
  });
});
