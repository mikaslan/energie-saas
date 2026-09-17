import { describe, expect, it } from "vitest";

import { portalInstallationTimelineEntrySchema } from "@/lib/integrations/portal/portal-contract";
import {
  formatPortalTimelineEntry,
  portalLangs,
} from "@/lib/integrations/portal/portal-language";

const DAY_DE = "06.09.2026";
const DAY_EN = "06/09/2026";

describe("F10-16 Gegenzeichnung in der Portal-Timeline (rein)", () => {
  it("F1016-CONTRACT-01: Enum parst den 4. Typ, 5. Typ invalid", () => {
    const base = { at: "2026-09-06T08:00:00.000Z", day: "2026-09-06" };
    for (const type of ["created", "completed", "handover_recorded", "handover_countersigned"]) {
      expect(
        portalInstallationTimelineEntrySchema.safeParse({ ...base, type }).success,
        `Typ ok: ${type}`,
      ).toBe(true);
    }
    expect(
      portalInstallationTimelineEntrySchema.safeParse({ ...base, type: "lead_installer_assigned" }).success,
    ).toBe(false);
    expect(
      portalInstallationTimelineEntrySchema.safeParse({ ...base, type: "countersigned" }).success,
    ).toBe(false);
    // Strikter Objekt-Key-Pin (f1003b): keine Zusatz-Keys auf der neuen Zeile.
    const parsed = portalInstallationTimelineEntrySchema.safeParse({
      ...base, type: "handover_countersigned",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(["at", "day", "type"]);
    }
    expect(
      portalInstallationTimelineEntrySchema.safeParse({
        ...base, type: "handover_countersigned", byName: "Familie Berger",
      }).success,
    ).toBe(false);
  });

  it("F1016-CONTRACT-02: Formatter zeigt Gegengezeichnet in allen 11 Sprachen", () => {
    expect(formatPortalTimelineEntry("de", "handover_countersigned", DAY_DE))
      .toBe("Gegengezeichnet am 06.09.2026");
    expect(formatPortalTimelineEntry("en", "handover_countersigned", DAY_EN))
      .toBe("Countersigned on 06/09/2026");
    // Rest: eigene Worte, kein other-Fallback (f1006-ESTIMATE-Muster).
    const words: Record<string, string> = {
      cs: "Spolupodepsáno",
      el: "Συνυπογράφηκε",
      es: "Refrendado",
      fr: "Contresigné",
      hu: "Ellenjegyezve",
      it: "Controfirmato",
      nl: "Medeondertekend",
      pl: "Kontrasygnowano",
      ro: "Contrasemnat",
    };
    for (const [lang, word] of Object.entries(words)) {
      const rendered = formatPortalTimelineEntry(
        lang as (typeof portalLangs)[number], "handover_countersigned", DAY_DE,
      );
      expect(rendered, `Gegenzeichnungswort: ${lang}`).toContain(word);
      expect(rendered, `Tag fehlt: ${lang}`).toContain(DAY_DE);
    }
    for (const lang of portalLangs) {
      const rendered = formatPortalTimelineEntry(lang, "handover_countersigned", DAY_DE);
      const fallback = formatPortalTimelineEntry(lang, "fremder_typ", DAY_DE);
      expect(rendered, `other-Fallback statt Wort: ${lang}`).not.toBe(fallback);
      expect(rendered.length, `leerer Eintrag: ${lang}`).toBeGreaterThan(DAY_DE.length);
    }
  });
});
