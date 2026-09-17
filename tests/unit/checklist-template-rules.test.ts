import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  checklistTemplateItemsSchema,
  sanitizeTemplateRuleTargets,
  type ChecklistTemplateItemV1,
} from "@/lib/integrations/checklists/template-contract";

/**
 * F7-03D Template-Regeln: visibleIfComponentId muss eine ANDERE Position
 * derselben Vorlage referenzieren (fail-closed: baumelnd/Selbst =
 * ungueltig). Keine Migration (items=jsonb ohne Item-CHECK).
 */

function item(
  componentId: string,
  patch: Partial<ChecklistTemplateItemV1> = {},
): ChecklistTemplateItemV1 {
  return {
    componentId,
    quantity: 1,
    position: 0,
    visibleToCustomer: false,
    priceOverridesComponent: false,
    kind: null,
    visibleIfComponentId: null,
    ...patch,
  };
}

describe("F7-03D Template-Regeln (Contract)", () => {
  it("F703D-U-01: Regel auf Geschwister ist gueltig; null bleibt gueltig", () => {
    const a = randomUUID();
    const b = randomUUID();
    const parsed = checklistTemplateItemsSchema.safeParse([
      item(a),
      item(b, { visibleIfComponentId: a }),
    ]);
    expect(parsed.success).toBe(true);
  });

  it("F703D-U-02: Baumelnd und Selbstbezug scheitern", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(checklistTemplateItemsSchema.safeParse([
      item(a),
      item(b, { visibleIfComponentId: randomUUID() }),
    ])).toMatchObject({ success: false });
    expect(checklistTemplateItemsSchema.safeParse([
      item(a, { visibleIfComponentId: a }),
    ])).toMatchObject({ success: false });
  });

  it("F703D-U-03: Mehrfach-Regeln und Ketten-Referenzen parsen (Single-Hop gilt im Projekt)", () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const parsed = checklistTemplateItemsSchema.safeParse([
      item(a),
      item(b, { visibleIfComponentId: a }),
      item(c, { visibleIfComponentId: b }),
    ]);
    expect(parsed.success).toBe(true);
  });

  it("F703D-U-04: Sanitize raeumt baumelnde Regeln ab, Eingabe bleibt unveraendert", () => {
    const a = randomUUID();
    const b = randomUUID();
    const items = [item(a, { visibleIfComponentId: b })];
    const next = sanitizeTemplateRuleTargets(items);
    expect(next[0]!.visibleIfComponentId).toBeNull();
    expect(items[0]!.visibleIfComponentId).toBe(b);
  });

  it("F703D-U-05: Sanitize behaelt gueltige Regeln, raeumt Selbstbezug ab", () => {
    const a = randomUUID();
    const b = randomUUID();
    const next = sanitizeTemplateRuleTargets([
      item(a),
      item(b, { visibleIfComponentId: a }),
      item(a, { position: 2, visibleIfComponentId: a }),
    ]);
    expect(next[1]!.visibleIfComponentId).toBe(a);
    expect(next[2]!.visibleIfComponentId).toBeNull();
  });
});
