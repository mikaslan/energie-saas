import { describe, expect, it } from "vitest";

import {
  formatPortalDate,
  formatPortalInstallationStatus,
  formatPortalRange,
  formatPortalSignatureStatus,
  formatPortalTimelineEntry,
  parsePortalLang,
  portalLangs,
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
    for (const lang of portalLangs) {
      expect(parsePortalLang(lang), `Parser rundetrip: ${lang}`).toBe(lang);
      expect(parsePortalLang(lang.toUpperCase()), `Parser case-insensitiv: ${lang}`).toBe(lang);
      expect(parsePortalLang([lang]), `Parser Array-Erstwert: ${lang}`).toBe(lang);
    }
  });

  it("F1006-02: Jede Katalogsprache enthält jeden DE-Schlüssel (kein Drift)", () => {
    expect([...portalLangs].sort()).toEqual(
      ["cs", "de", "el", "en", "es", "fr", "hu", "it", "nl", "pl", "ro"],
    );
    const deKeys = Object.keys(PORTAL_STRINGS.de).sort();
    expect(deKeys.length).toBeGreaterThan(30);
    for (const lang of portalLangs) {
      const keys = Object.keys(PORTAL_STRINGS[lang]).sort();
      expect(keys, `Schlüssel-Drift: ${lang}`).toEqual(deKeys);
      for (const key of deKeys) {
        const value = PORTAL_STRINGS[lang][key as keyof typeof PORTAL_STRINGS.de];
        expect(typeof value, `${lang}-Text fehlt: ${key}`).toBe("string");
        expect(value.length, `${lang}-Text leer: ${key}`).toBeGreaterThan(0);
      }
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

  it("F1006-04: Slice-2-Sprachen rendern eigene Worte/Formate (ESTIMATE-Spotchecks)", () => {
    // Datum je Sprache: Berliner Tag, eigene Locale-Schreibung.
    for (const lang of portalLangs) {
      const rendered = formatPortalDate(lang, "2026-09-06T08:00:00.000Z");
      expect(rendered, `Datum leer: ${lang}`).toContain("2026");
      expect(rendered, `Datum ohne Tag: ${lang}`).toContain("06");
    }
    expect(formatPortalDate("de", "2026-09-06T08:00:00.000Z")).toBe("06.09.2026");
    // Status-Spotchecks je Slice-2-Sprache (eigene Worte, Eigennamen stabil).
    const pending: Record<string, string> = {
      cs: "Podpis: čeká",
      el: "Υπογραφή: σε εκκρεμότητα",
      es: "Firma: pendiente",
      fr: "Signature : en attente",
      hu: "Aláírás: függőben",
      it: "Firma: in attesa",
      nl: "Handtekening: in afwachting",
      pl: "Podpis: oczekujący",
      ro: "Semnătură: în așteptare",
    };
    for (const [lang, word] of Object.entries(pending)) {
      expect(
        formatPortalSignatureStatus(lang as (typeof portalLangs)[number], "pending", null),
        `Signaturwort: ${lang}`,
      ).toBe(word);
      expect(PORTAL_SERVICE_STATUS_WORD[lang as (typeof portalLangs)[number]].open.length)
        .toBeGreaterThan(0);
      expect(PORTAL_SUBSIDY_PROGRAM_WORD[lang as (typeof portalLangs)[number]].kfw).toBe("KfW");
      expect(PORTAL_SUBSIDY_PROGRAM_WORD[lang as (typeof portalLangs)[number]].bafa).toBe("BAFA");
    }
    expect(PORTAL_STRINGS.fr.brand).toBe("Portail client");
    expect(PORTAL_STRINGS.pl.navOverview).toBe("Przegląd");
    expect(PORTAL_STRINGS.ro.invalidTitle).toBe("Acest link nu este valid.");
  });
});
