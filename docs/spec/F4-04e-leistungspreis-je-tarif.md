# F4-04e Leistungspreis je Tarif (Katalog F4.4)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (Unit economics 20/20 inkl. 2 neu, Unit m107-actions 22/22, Pin-Suiten 27/27, E2E M1-11g 17/17 inkl. neu, Triage-Datei 7/7, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F4-04a/F4-04d (dort als „Leistungspreis-Komponente"
bewusst offen — „braucht ein Lastspitzen-Modell"). Tarife tragen jetzt
den Leistungspreis je Tarif (€/kW Jahresspitze) in Stromrechnung
(Jahr 1) und Mehrjahres-Serie. Kein Reonic-Referenzbeleg; reversible
eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Lastspitzen-Modell: Jahresspitze exakt aus der Viertelstunden-
  Simulation — geplante Spitze = max(Dispatch-Netzbezugs-Slot) × 4,
  Ohne-PV-Spitze = max(Lastreihen-Slot) × 4 (kW, 2 dp gerundet).
  Keine erfundene Physik: Import je Slot ≤ Last per Konstruktion
  (Entladung deckt nur Defizit), also Ohne-PV-Spitze ≥ geplante
  Spitze — im E2E gepinnt. TOU-Fahrweise bleibt eigene Spitze-fremde
  Rechnung (computeTouBillEuro unberührt).
- Eingabe: `consumption.demandChargeEuroPerKw` (aktueller Tarif) und
  `consumption.alternativeDemandChargeEuroPerKw` (Neutarif),
  KnownOrUnknown, 0..10.000 €/kW/a; Service-Save via
  `normalizeKnownField`, Altzeilen unbelegt. Action-Allowlist exakt
  erweitert (Editor rendert beide Felder; Unit-Formular ergänzt).
- Engine-Input: `demandChargeEuroPerKw` /
  `alternativeDemandChargeEuroPerKw`, optional, nur bei belegtem
  Profilfeld (sonst fehlt der Schlüssel und Althashes bleiben stabil —
  TOU-Vorbild). Bereich 0..10.000, fail-closed.
- Engine: Ohne-PV trägt Lastspitze × aktuellen Satz, geplante
  Rechnungen Dispatch-Spitze × je Tarif eigenen Satz (unbelegt =
  aktueller, dokumentiert). Leistungspreis konstant über Horizont
  (keine Eskalation — wie Grundpreis, dokumentiert).
  Ersparnis/Cashflow/IRR/Amortisation bleiben per Konstruktion
  unberührt — die Spitzenkappung ist im Rechnungsvergleich sichtbar
  (noPv − current = Eigenverbrauchswert + Spitzen-Delta), nicht in
  der Ersparnis-Definition (Grundpreis-Vorbild).
- Fehlende Spitze bei belegtem Satz ist fail-closed (kein stilles
  Nullen der Umlage). Altannuals ohne Spitzen bleiben lesbar
  (optionale Schema-Keys).
- v2-Artefakt: Input-/Result-/Annual-Schema optional erweitert,
  run-v2 echot nur bei Belegung; Spitzen stehen im Annual-Resultat.
- Regen-Pflicht (Reihenfolge!): v1-/v2-Schema-Artefakt per
  `--write`, Pins in `contract.ts`/`versions-v2.ts` eintragen, DANN
  erst Golden-Examples-Manifest per `--write` (es liest den Pin —
  umgekehrte Reihenfolge schlägt fehl). Semantische Hashes
  unverändert — keine semantische Drift.
- UI: Editor-Felder „Leistungspreis aktueller Tarif (€/kW, leer = 0)" /
  „Leistungspreis Neutarif (€/kW, leer = wie aktueller Tarif)";
  Ergebnis-Jahr-1 mit zwei Leistungspreis-Zeilen (— wenn unbelegt);
  Jahresspitzen (mit/ohne PV, — in Altläufen) im Annual-Block;
  Serie übernimmt die Werte automatisch.
- Keine Migration, keine neue Permission, kein Provider.

## Geschlossene Testmatrix

- Unit (`economics-v2`, 2 neu): Leistungspreis-Mathematik (100/80),
  Ersparnis/Cashflow/Amortisation identisch ohne/mit Satz,
  Serie Jahr 1 == Jahr-1-Rechnung, Neu-Fallback = aktuell,
  Schlüssel-Fehlung unbelegt, Bereich fail-closed, Spitze-fehlend
  fail-closed.
- Unit (`m107-energy-actions` 22/22, Pin-Suiten 27/27):
  Allowlist-/Save-Pfad, Artefakt-Regen.
- E2E (`M1-11g: F4-04e`, isolierter Workspace): 28 Ct neu + 100/80
  Leistungspreis speichern → currentV2 mit Echo, Spitzen aus der
  Simulation (ohne PV ≥ mit PV), Rechnungen mit Leistungspreis,
  noPv − current = Eigenverbrauchswert + Spitzen-Delta, Serie
  Jahr 1 == Rechnung, UI-Spitzen-/Satz-Zeilen sichtbar.
  Nachbarn: M1-11g-Datei 17/17, Triage-Datei 7/7.

## Bewusst offen

- Vergleich mehrerer Neutarife (F4-04a-Offenpunkt).
- Dynamische Day-ahead-Tarife, Länderspezifika, TOU-Spitzenlogik.
