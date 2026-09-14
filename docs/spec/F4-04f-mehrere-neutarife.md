# F4-04f Vergleich mehrerer Neutarife (Katalog F4.4)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (Unit economics 22/22 inkl. 2 neu, Unit m107-actions 22/22, Pin-Suiten 27/27, E2E M1-11g 18/18 inkl. neu, Triage-Datei 7/7, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F4-04a (dort als „Vergleich mehrerer Neutarife"
bewusst offen; F4-04c/d/e bauten je einen Tarif aus). Bis zu drei
zusätzliche Vergleichstarife je Profil — additiv zum Haupt-Neutarif,
der unverändert bleibt (alle Altpins stabil). Kein Reonic-
Referenzbeleg; reversible eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Eingabe: `consumption.comparisonTariffs` (KnownOrUnknown-Array,
  max 3, je `{name 1..40, importPriceCtPerKwh 1..200 Pflicht,
  priceEscalationPct −10..25, baseFeeEuroPerYear 0..100.000,
  demandChargeEuroPerKw 0..10.000 optional}`). Unbelegte Komponenten
  fallen auf den aktuellen Tarif zurück (Haupt-Neutarif-Vorbild);
  Doppelnamen und Teilmengen sind fail-closed (kein stilles
  Ergänzen/Kürzen). Service-Save via `normalizeKnownField`
  (Tiefenvergleich für Objekt-Arrays — TOU-Zweig verallgemeinert,
  Zahlengleichheit unverändert).
- Editor: drei Gruppen (Name + Preis + Eskalation + Grundpreis +
  Leistungspreis); leere Gruppe = kein Tarif. Action-Allowlist exakt
  um die 15 Feldnamen erweitert; Teilgruppe/Doppelname verweigert
  den Save (`invalid`, kein stilles Entfallen).
- Engine-Input: `comparisonTariffs` voll aufgelöst (keine Nulls),
  nur bei belegtem Profilfeld (sonst fehlt der Schlüssel und
  Althashes bleiben stabil — TOU-Vorbild).
- Engine: je Tarif Jahr-1-Rechnung (Netzbezug × Preis + Grundpreis +
  Dispatch-Spitze × Satz) plus Serie über Horizont (Energie
  eskaliert, Sätze konstant — reine Tarifrechnung wie F4-04c).
  Unabhängig vom Haupt-Neutarif (eigener Result-Schlüssel).
  Ersparnis/Cashflow/IRR/Amortisation bleiben per Konstruktion
  unberührt (Grundpreis-Vorbild); Haupt-Rechnungen identisch
  (Vergleich ist additiv — Unit-gepinnt).
- Fehlende Spitze bei belegtem Vergleichs-Satz ist fail-closed
  (gleicher Maßstab wie Haupt-Neutarif).
- v2-Artefakt: Input-/Result-Schema optional erweitert, run-v2
  echot nur bei Belegung.
- Regen-Pflicht (Reihenfolge!): v1-/v2-Schema-Artefakt per
  `--write`, Pins in `contract.ts`/`versions-v2.ts` eintragen, DANN
  erst Golden-Examples-Manifest per `--write`. Semantische Hashes
  unverändert — keine semantische Drift.
- UI: Jahr-1-Block mit je einer Zeile „Mit PV (Name)"; eigene
  Tabelle „Vergleichstarife je Jahr" (Jahr-Zeilen × Tarif-Spalten,
  Horizont-Zeilen gepinnt); ohne Tarife kein Block (kein
  Leergerüst).
- Keine Migration (DB-CHECK bindet nur Top-Level-Keys), keine neue
  Permission, kein Provider.

## Geschlossene Testmatrix

- Unit (`economics-v2`, 2 neu): Vergleichs-Mathematik (2 Tarife,
  Serie Jahr 1 == Jahr-1), Ersparnis/Cashflow/Amortisation und
  Haupt-Rechnungen identisch ohne/mit Vergleich,
  Schlüssel-Fehlung unbelegt, Name-Trimm, Doppelname/Überzahl/
  Bereich fail-closed.
- Unit (`m107-energy-actions` 22/22, Pin-Suiten 27/27):
  Allowlist-/Save-Pfad (15 cmp-Felder), Artefakt-Regen.
- E2E (`M1-11g: F4-04f`, isolierter Workspace): 2 Vergleichstarife
  speichern (einer nur Name + Preis, einer + Grundpreis) →
  currentV2 mit Echo, Jahr-1-Mathematik, Serienlänge Horizont,
  Jahr-1-Zeilen + Spaltenköpfe + Horizont-Zeilen sichtbar.
  Nachbarn: M1-11g-Datei 18/18, Triage-Datei 7/7.

## Bewusst offen

- Dynamische Day-ahead-Tarife, Länderspezifika, TOU-Spitzenlogik.
