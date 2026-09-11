import { describe, expect, it } from "vitest";

import {
  formatPortalDate,
  formatPortalInstallationStatus,
  formatPortalRange,
  formatPortalSignatureStatus,
  formatPortalTimelineEntry,
  parsePortalLang,
  PORTAL_GRID_STATUS_WORD,
  PORTAL_SERVICE_STATUS_WORD,
  PORTAL_STRINGS,
  PORTAL_SUBSIDY_PROGRAM_WORD,
  PORTAL_SUBSIDY_STATUS_WORD,
  resolvePortalNextStep,
} from "@/lib/integrations/portal/portal-language";

describe("F1006 Portal-Sprachen (Contract)", () => {
  it("F1006-01: Parser fällt fail-closed auf Deutsch zurück", () => {
    expect(parsePortalLang("en")).toBe("en");
    expect(parsePortalLang("EN")).toBe("en");
    expect(parsePortalLang(" en ")).toBe("en");
    expect(parsePortalLang("de")).toBe("de");
    expect(parsePortalLang("xx")).toBe("de");
    expect(parsePortalLang("")).toBe("de");
    expect(parsePortalLang(undefined)).toBe("de");
    expect(parsePortalLang(null)).toBe("de");
    expect(parsePortalLang(42)).toBe("de");
    expect(parsePortalLang(["en"])).toBe("en");
    expect(parsePortalLang(["xx"])).toBe("de");
    expect(parsePortalLang([])).toBe("de");
  });

  it("F1006-02: EN enthält jeden DE-Schlüssel (kein Drift)", () => {
    const deKeys = Object.keys(PORTAL_STRINGS.de).sort();
    const enKeys = Object.keys(PORTAL_STRINGS.en).sort();
    expect(deKeys.length).toBeGreaterThan(30);
    expect(enKeys).toEqual(deKeys);
    for (const key of deKeys) {
      const value = PORTAL_STRINGS.en[key as keyof typeof PORTAL_STRINGS.en];
      expect(typeof value, `EN-Text fehlt: ${key}`).toBe("string");
      expect(value.length, `EN-Text leer: ${key}`).toBeGreaterThan(0);
    }
  });

  it("F1006-03: Formate und Statusworte je Sprache", () => {
    // Berlin-Datum je Locale (fester Zeitpunkt, Zeitzone Europe/Berlin).
    expect(formatPortalDate("de", "2026-09-06T08:00:00.000Z")).toBe("06.09.2026");
    expect(formatPortalDate("en", "2026-09-06T08:00:00.000Z")).toBe("06/09/2026");
    // Bereich: DE mit Uhr-Suffix, EN ohne; ganztägig je Sprache.
    expect(formatPortalRange("de", "2026-09-06T08:00:00.000Z", "2026-09-06T11:00:00.000Z", false))
      .toContain("Uhr");
    expect(formatPortalRange("en", "2026-09-06T08:00:00.000Z", "2026-09-06T11:00:00.000Z", false))
      .not.toContain("Uhr");
    expect(formatPortalRange("de", "2026-09-06T08:00:00.000Z", "2026-09-06T08:00:00.000Z", true))
      .toContain("ganztägig");
    expect(formatPortalRange("en", "2026-09-06T08:00:00.000Z", "2026-09-06T08:00:00.000Z", true))
      .toContain("all day");
    // Statusworte: identische Schlüssel, übersetzte Worte.
    expect(formatPortalSignatureStatus("de", "pending", null)).toBe("Signatur: ausstehend");
    expect(formatPortalSignatureStatus("en", "pending", null)).toBe("Signature: pending");
    expect(formatPortalSignatureStatus("de", "signed", "2026-09-06T08:00:00.000Z"))
      .toBe("Signiert am 06.09.2026");
    expect(formatPortalSignatureStatus("en", "signed", "2026-09-06T08:00:00.000Z"))
      .toBe("Signed on 06/09/2026");
    expect(formatPortalSignatureStatus("de", "unbekannt", null))
      .toBe("Signatur: nicht angefragt");
    expect(formatPortalSignatureStatus("en", "unbekannt", null))
      .toBe("Signature: not requested");
    expect(PORTAL_SERVICE_STATUS_WORD.de.open).toBe("Offen");
    expect(PORTAL_SERVICE_STATUS_WORD.en.open).toBe("Open");
    expect(formatPortalTimelineEntry("de", "created", "06.09.2026")).toBe("Angelegt am 06.09.2026");
    expect(formatPortalTimelineEntry("en", "created", "06/09/2026")).toBe("Created on 06/09/2026");
    expect(resolvePortalNextStep("offer", "open", "de")).toBe("Angebot liegt vor");
    expect(resolvePortalNextStep("offer", "open", "en")).toBe("Offer available");
    expect(resolvePortalNextStep("offer", "won", "en")).toBe("Order confirmed");
    expect(resolvePortalNextStep("unbekannt", "open", "de")).toBe("Stand in Klärung");
    expect(resolvePortalNextStep("unbekannt", "open", "en")).toBe("Status being clarified");
    // Installation-Fallback nur ohne Override; Override nie übersetzt.
    expect(formatPortalInstallationStatus("de", "active", null, null, {}))
      .toBe("In Ausführung");
    expect(formatPortalInstallationStatus("en", "active", null, null, {}))
      .toBe("In progress");
    expect(formatPortalInstallationStatus("en", "completed", null, "2026-09-06T08:00:00.000Z", {}))
      .toBe("Accepted on 06/09/2026");
    expect(formatPortalInstallationStatus("en", "completed", null, "2026-09-06T08:00:00.000Z", { handover: "Übernommen!" }))
      .toBe("Übernommen! on 06/09/2026");
    // Förder-/Netzstatus je Sprache, Eigennamen stabil.
    expect(PORTAL_SUBSIDY_STATUS_WORD.en.bza_eingereicht).toBe("BzA submitted");
    expect(PORTAL_SUBSIDY_PROGRAM_WORD.en.sonstige).toBe("Other");
    expect(PORTAL_SUBSIDY_PROGRAM_WORD.de.kfw).toBe("KfW");
    expect(PORTAL_GRID_STATUS_WORD.de.fertiggemeldet).toBe("Fertig gemeldet");
    expect(PORTAL_GRID_STATUS_WORD.en.fertiggemeldet).toBe("Completion reported");
  });
});
