# F4-02 — Custom-Lastprofil (Monatswerte + Stundenprofil)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-10
Nachweis: Commit 40a675d (typecheck+lint 0, unit 40/40, m1-11g-e2e 6/6
lokal beobachtet); CI 34502966689 success (90/90 E2E).

## Ziel und Abgrenzung

Option `customer_monthly_hourly.v1` („Kunden-Monatsprofil stündlich") ist
heute eine leere Hülle: keine Monatswerte erfassbar, Berechnung läuft still
als H0. Dieser Slice macht den Pfad durchgängig: Formular/Validierung →
Persistenz → Berechnung → Anzeige. Keine neue Lane-Freigabe nötig
(Gesamtauftrag 2026-09-10).

## Evidenz (öffentlich, verifiziert 2026-09-09/10)

- Reonic-Hilfecenter, „Build a custom load profile"
  (`https://docs.reonic.com/docs/en/offers-plan-energy-consumption-custom-load-profile`):
  Kurve Monat für Monat und Stunde für Stunde formen, wenn das synthetische
  Profil nicht reicht. **Monatsverteilung: zwölf Werte** für die Verteilung
  übers Jahr. **Stundenverteilung optional: typischer Werktag + Wochenendtag.**
  Das Profil wird oft als **Prozent der Jahressumme** gezeigt (Form skaliert
  bei geänderter Jahressumme mit); die Jahressumme steht separat. Gespeichert
  pro Projekt. Residential im Editor; **Lastgang-CSV-Upload ist
  Commercial-Feature** (separater Pfad, hier NICHT gebaut).
- Reonic-Hilfecenter, „Plan – Energy consumption"
  (`https://docs.reonic.com/docs/en/category/offers-plan-energy-consumption`)
  und „Read the Energy flows simulation"
  (`https://docs.reonic.com/docs/en/offers-simulation-cat-energy-flows`):
  Verbrauch = Jahres-kWh + Lastprofil (Standard, dynamisch/stündlich);
  Kurve speist Haushalts-Energiebilanz.

## Datenmodell (additiv, keine Migration)

`consumption.customLoadProfile` (optional, strictObject):

```text
customLoadProfile: {
  monthlyKwh: [12 × ≥0 kWh, Monat Jan..Dez],
  weekdayHourlyKwh: [24 × ≥0 kWh] | null,   # typischer Werktag (ESTIMATE s.u.)
  weekendHourlyKwh: [24 × ≥0 kWh] | null,   # typischer Wochenendtag
} | null
```

- DB-CHECK `site_energy_profile_json_ck` bindet nur Top-Level-Keys
  (`consumption` ist Objekt) → keine Migration; Vertragsänderung rein in
  Zod-Schemas (`contract.ts`, Fetch-`consumptionSchema`).
- Semantik wie Reonic: Monats-kWh sind absolute Werte (Rechnungsnähe);
  die Form skaliert NICHT an `householdKwhPerYear` — Summe der 12 Monate IST
  die Jahres-Basislast. Stundenprofile sind Tagesgänge (beliebige positive
  Skala, energieexakt normiert).

## Validierung (fail-closed, keine stillen Defaults)

- `loadProfile == customer_monthly_hourly.v1` verlangt alle 12 Monatswerte
  (endlich, ≥0, Summe > 0); fehlt einer → Save/Compose verweigern (bisheriges
  stilles H0 war erfundene Form).
- Stundenprofile je optional, aber nur vollständig (alle 24 Stunden ≥0,
  Summe > 0) oder ganz leer; halb belegte Tage verweigern.
- Andere `loadProfile`-Werte mit belegten Monatswerten verweigern
  (keine doppelte Basisdefinition). Formular-Allowlist bleibt exakt, aber
  branchabhängig (Monats-/Stundenfelder nur bei Monatsprofil-Option).
- v1-Engine bleibt eingefroren (Spec F4-01: keine Umdeutung); v1 formt die
  Option weiter als Haushalt — dokumentierte Divergenz, v2 ist der
  Paritätspfad.

## Berechnung (v2, versioniert)

Neue Basisquelle `wmee-monthly-profile.v1` (Kind `basis`, genau eine Basis):

```text
w_slot = monthlyKwh[m] × dayShape(slot) / Σ_norm
```

- `dayShape`: Wochenend-/Wochentags-Stundengang aus belegten Tagesprofilen
  (ISO-Kalender wie übrige v2-Formen).
- `[ESTIMATE]` Fehlt ein Tagesprofil, trägt die Stunde das H0-Tagesgewicht
  (`wmee-monthly-h0-intraday.v1`-Anteil in der Quell-SHA): Reonic erlaubt
  Monats-only, irgendeine Intra-Tagesform ist daher unvermeidbar; H0 erhält
  Tag/Nacht- und Wochenstruktur statt flacher Verteilung.
- `[ESTIMATE]` Viertel flach in der Stunde (Last hat keine Solargestalt,
  energieexakt — wie übrige v2-Formen).
- Energieexaktheit: Σ Slots == Σ Monate (Neumaier-gebunden, Test).
- Provenienz: `sourceId`, `sourceRevision`, `sourceSha256` über
  (Monatswerte, Tagesprofil-Anwesenheit, Jahressumme); Annual wird NICHT aus
  `householdKwhPerYear` gelesen (Reonic: Summe separat).

## Anzeige

Keine neuen Blöcke: Jahres-/Monatstabellen zeigen die Kettenergebnisse;
Provenienz nennt die Monatsquelle. Sichtbarkeitsnachweis per E2E mit
belegten Monatswerten (Januar-Spitze vs. Juli-Senke in der Monatstabelle).

## Akzeptanz

- Unit: Monats-/Tagesgewicht-Regeln, Energieexaktheit, Normierung,
  Fail-closed-Matrix (fehlende/halbe/fremde Werte).
- Compose: Full-Fetch mit Fixture-Bytes → loadKwh-Summe == Monatssumme,
  Monatsform in Slots nachweisbar, Provenienz-ID.
- Actions: Formular-Parität (exakte Allowlist je Branch, 60 Felder nur bei
  Monats-Option).
- E2E: belegtes Monatsprofil → currentV2, Monatstabelle spiegelt
  Monatswerte, Axe sauber.
- Gates: lint/typecheck/test/build + CI `codex-lane-gates` grün; keine
  Migrations-/Rollenänderung.

## Bewusst offen

- Lastgang-CSV-Upload (Reonic: Commercial-Feature; F15-Modell fehlt).
- Rechnungs-Upload mit Tarif-/Muster-Extraktion (F14.5-Bill-Reading).
- Linky/PDL-, F1/F2/F3-Länderprofile (kein DE-Bedarf).
- v1-Divergenz (eingefroren) und Intra-Tages-Fallback bleiben ESTIMATE.
