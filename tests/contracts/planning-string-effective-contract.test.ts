import { describe, expect, it } from "vitest";

import { stringEffectiveAdvisoriesV1 } from "@/lib/integrations/planning/contracts/string-plan";

/**
 * F3-05d Effektive String-Advisories — Contract-RED.
 * Vertrag: docs/spec/F3-05d-effective.md
 * Export fehlt → Import-RED.
 */

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";

describe("F3-05d Effektive String-Advisories-Contract", () => {
  it("F305d-CON-01: H/V-Mix → orientation-mix", () => {
    const advisories = stringEffectiveAdvisoriesV1({
      members: [
        { groupId: GROUP_A, kind: "h", cells: 4, deselectedCells: 0 },
        { groupId: GROUP_B, kind: "v", cells: 4, deselectedCells: 0 },
      ],
      maxStringModules: 24,
      equipment: [],
    });
    expect(advisories.map((a) => a.code)).toContain("orientation-mix");
    for (const advisory of advisories) {
      expect(advisory.message.length).toBeGreaterThan(0);
    }
  });

  it("F305d-CON-02: effektiv-ok vs effektiv-drüber (over-length)", () => {
    // Brutto 6 > max 5, aber effektiv 4 → kein over-length.
    const effectiveOk = stringEffectiveAdvisoriesV1({
      members: [{ groupId: GROUP_A, kind: "h", cells: 6, deselectedCells: 2 }],
      maxStringModules: 5,
      equipment: [],
    });
    expect(effectiveOk.map((a) => a.code)).not.toContain("over-length");

    // Effektiv 4 > max 3 → over-length.
    const effectiveOver = stringEffectiveAdvisoriesV1({
      members: [{ groupId: GROUP_A, kind: "h", cells: 6, deselectedCells: 2 }],
      maxStringModules: 3,
      equipment: [],
    });
    expect(effectiveOver.map((a) => a.code)).toContain("over-length");
  });

  it("F305d-CON-03: Equipment auf abgewählter Zelle → equipment-on-deselected", () => {
    const flagged = stringEffectiveAdvisoriesV1({
      members: [{ groupId: GROUP_A, kind: "h", cells: 4, deselectedCells: 1 }],
      maxStringModules: 24,
      equipment: [{ cell: { groupId: GROUP_A, row: 1, col: 2 }, deselected: true }],
    });
    expect(flagged.map((a) => a.code)).toContain("equipment-on-deselected");

    const clean = stringEffectiveAdvisoriesV1({
      members: [{ groupId: GROUP_A, kind: "h", cells: 4, deselectedCells: 1 }],
      maxStringModules: 24,
      equipment: [{ cell: { groupId: GROUP_A, row: 1, col: 2 }, deselected: false }],
    });
    expect(clean.map((a) => a.code)).not.toContain("equipment-on-deselected");
  });

  it("F305d-CON-04: keine Members → leer", () => {
    expect(
      stringEffectiveAdvisoriesV1({ members: [], maxStringModules: 24, equipment: [] }),
    ).toEqual([]);
  });
});
