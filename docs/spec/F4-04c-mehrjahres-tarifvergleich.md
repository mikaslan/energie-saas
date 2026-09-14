# F4-04c Mehrjahres-Tarifvergleich mit Eskalation je Tarif (Katalog F4.4)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (Unit economics 16/16 inkl. 3 neu, Unit m107-actions 22/22, f401-prepare/run grün, E2E M1-11g 15/15 inkl. neu, Triage-Datei 7/7, tsc grün, lokal beobachtet).

Ziel: Folgeslice zu F4-04a (dort als „Mehrjahres-Tarifvergleich mit
Eskalation je Tarif" bewusst offen). Die Engine kannte nur Jahr 1 und
nur die Current-Eskalation; jetzt trägt currentV2 bei belegtem Neutarif
die Stromrechnung je Jahr über den Horizont (ohne PV / aktuell / neu,
jeweils eigene Eskalation). Kein Reonic-Referenzbeleg; reversible
eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Eingabe: `consumption.alternativeImportPriceEscalationPct`
  (KnownOrUnknown, −10..25 % wie `annualPriceIncreasePercent`; Service-
  Save-Pfad via `normalizeKnownField`, Altzeilen unbelegt).
  Action-Allowlist exakt erweitert (Formulare müssen den Key tragen —
  Editor rendert ihn; Unit-Formular ergänzt).
- Engine-Input (`EconomicsInputV2`): `alternativePriceEscalationRate`
  optional, nur bei belegtem Profilfeld (sonst fehlt der Schlüssel und
  Althashes bleiben stabil — TOU-Vorbild). Bereich −10..25 %,
  fail-closed wie Geschwister.
- Engine (`computeEconomics`): `annualBillSeriesEuro` (Jahr,
  noPv/current/neu) über 1..Horizont, nur bei belegtem Neutarif (sonst
  fehlt der Schlüssel und Altresultate bleiben gültig — TOU-Vorbild).
  Reine Tarifrechnung: Physik je Jahr identisch (kein
  Degradations-/Verbrauchsdrift); unbelegte Neutarif-Eskalation =
  aktuelle Eskalation (dokumentiert); Jahr-1-Zeile == annualBillsEuro
  per Konstruktion (gepinnt).
- v2-Artefakt: Input-/Result-Schema optional erweitert, run-v2 echot
  nur bei Belegung (inputSha stabil ohne Neutarif-Eskalation).
- Regen-Pflicht: v1-/v2-Schema-Artefakt + beide SHA-Pins +
  Golden-Examples-Manifest per sanctioned `--write`-Generatoren neu
  erzeugt (semantische Hashes unverändert — keine semantische Drift).
- UI: Editor-Feld „Neutarif Preissteigerung (% p. a., −10–25, leer =
  wie aktueller Tarif)"; Ergebnis-Tabelle „Stromrechnung je Jahr (mit
  Tarif-Eskalation)" mit Eskalations-Legende (Testid `v2-bill-series`).
- Keine Migration, keine neue Permission, kein Provider.

## Geschlossene Testmatrix

- Unit (`economics-v2`, 3 neu): Serien-Mathematik (Jahr 2/3 exakt),
  Jahr-1-Konsistenz, Fallback-Eskalation, keine Serie ohne Neutarif,
  Schlüssel-Fehlung unbelegt, Bereich fail-closed.
- Unit (`m107-energy-actions` 22/22, `f401-prepare/run` grün):
  Allowlist-/Save-Pfad mit neuem Feld.
- E2E (`M1-11g: F4-04c`, isolierter Workspace): Profil mit 3 % aktuell
  + 28 Ct neu + 1 % neu speichern → currentV2 mit Serie über Horizont,
  Jahr 1 == Jahr-1-Rechnung, Jahr 2 neu = Import × 0,28 × 1,01;
  UI-Tabelle mit Horizont-Zeilen. Nachbarn: M1-11g-Datei 15/15
  (F4.4a-Assertion auf Jahr-1-Term präzisiert — gleiche Intent,
  Kollision mit neuem Tabellenkopf), Triage-Datei 7/7.

## Bewusst offen

- Grundpreis/Leistungspreis-Komponenten, Vergleich mehrerer Neutarife
  (F4-04a-Offenpunkte); Degradations-/Verbrauchsdrift in der
  Mehrjahres-Rechnung (derzeit reine Tarifrechnung, dokumentiert).
