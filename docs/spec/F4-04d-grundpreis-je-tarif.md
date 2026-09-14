# F4-04d Grundpreis je Tarif (Katalog F4.4)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (Unit economics 18/18 inkl. 2 neu, Unit m107-actions 22/22, Pin-Suiten 27/27, E2E M1-11g 16/16 inkl. neu, Triage-Datei 7/7, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F4-04a (dort als „Grundpreis/Leistungspreis-
Komponenten" bewusst offen — Leistungspreis weiter offen, s. unten).
Tarife waren reine Arbeitspreis-Rechnung; jetzt tragen Stromrechnung
(Jahr 1) und Mehrjahres-Serie den Grundpreis je Tarif (€/Jahr). Kein
Reonic-Referenzbeleg; reversible eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Eingabe: `consumption.baseFeeEuroPerYear` (aktueller Tarif) und
  `consumption.alternativeBaseFeeEuroPerYear` (Neutarif),
  KnownOrUnknown, 0..100.000 €/Jahr; Service-Save via
  `normalizeKnownField`, Altzeilen unbelegt. Action-Allowlist exakt
  erweitert (Editor rendert beide Felder; Unit-Formular ergänzt).
- Engine-Input: `baseFeeEuro` / `alternativeBaseFeeEuro`, optional,
  nur bei belegtem Profilfeld (sonst fehlt der Schlüssel und Althashes
  bleiben stabil — TOU-Vorbild). Bereich 0..100.000, fail-closed.
- Engine: Ohne-PV und aktueller Tarif tragen den aktuellen Grundpreis,
  der Neutarif den eigenen (unbelegt = aktueller, dokumentiert).
  Grundpreis konstant über Horizont (keine Eskalation —
  Grundpreis-Änderungen sind unregelmäßig, dokumentiert).
  Ersparnis/Cashflow/IRR/Amortisation bleiben per Konstruktion
  unberührt — der Grundpreis kürzt sich analytisch (Netzanschluss
  bleibt), nur die Rechnungen werden ehrlich (Unit-gepinnt).
- v2-Artefakt: Input-/Result-Schema optional erweitert, run-v2 echot
  nur bei Belegung.
- Regen-Pflicht (Reihenfolge!): v1-/v2-Schema-Artefakt per
  `--write`, Pins in `contract.ts`/`versions-v2.ts` eintragen, DANN
  erst Golden-Examples-Manifest per `--write` (es liest den Pin —
  umgekehrte Reihenfolge schlägt fehl). Semantische Hashes
  unverändert — keine semantische Drift.
- UI: Editor-Felder „Grundpreis aktueller Tarif (€/Jahr, leer = 0)" /
  „Grundpreis Neutarif (€/Jahr, leer = wie aktueller Tarif)";
  Ergebnis-Jahr-1 mit zwei Grundpreis-Zeilen (— wenn unbelegt);
  Serie übernimmt die Werte automatisch.
- Keine Migration, keine neue Permission, kein Provider.

## Geschlossene Testmatrix

- Unit (`economics-v2`, 2 neu): Grundpreis-Mathematik (120/60),
  Ersparnis/Cashflow/Amortisation identisch ohne/mit Grundpreis,
  Serie Jahr 1 == Jahr-1-Rechnung, Neu-Fallback = aktuell,
  Schlüssel-Fehlung unbelegt, Bereich fail-closed.
- Unit (`m107-energy-actions` 22/22, `f401-prepare/run`,
  Pin-Suiten 27/27): Allowlist-/Save-Pfad, Artefakt-Regen.
- E2E (`M1-11g: F4-04d`, isolierter Workspace): 28 Ct neu + 120/60
  Grundpreis speichern → currentV2 mit Echo, Rechnungen mit
  Grundpreis, Ersparnis grundpreisfrei (noPv − current = self ×
  Preis), Serie Jahr 1 == Rechnung, UI-Grundpreis-Zeilen sichtbar.
  Nachbarn: M1-11g-Datei 16/16, Triage-Datei 7/7.

## Bewusst offen

- Leistungspreis (€/kW Spitze): braucht ein Lastspitzen-Modell
  (Jahresenergien reichen nicht — ehrlich weiter offen).
- Vergleich mehrerer Neutarife (F4-04a-Offenpunkt).
