# F8-13 Betrag-Teilrechnung (fester Netto-Betrag, Katalog F8.5)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F813 2/2, E2E F813-E2E-01 1/1, F8-Batch 13/13, F8-Nachbarn 16/16 + Pins 16/16, Vollsuite 217 Files 1407 bestanden/1 übersprungen, tsc/eslint/depcruise/db:generate grün, lokal beobachtet; Push wartet auf CI-Verdikt 34717575600).

Ziel: Fünfter belegter F8.5-Modus (`amount`) neben percent/lines
(F8-05), scheme (F8-07), closing (F8-08) und remainder (F8-12):
Teilrechnung über einen FREI gewählten Netto-Eurobetrag statt
Prozent (F8-08-Spec: „Bewusst offen: … absolute Rest-Beträge“).
Cent-exakt ohne Rundung — für Abschläge wie „1.000 € netto“.

## ESTIMATE (reversibel, Referenzfrage offen)

- Modus `amount` (Migration 0134, nur CHECKs, keine neue Tabelle,
  keine Grants, RLS unverändert): genau EINE Sammellinie
  `Teilbetrag zu {AB-Nr}`, netto = beantragter Betrag 1:1
  (kein `roundPercentCents` — Beträge sind cent-exakt).
- Guards: `amountCents` 1..Rest-Netto (aktiver Ketten-Rest aus
  zurückgelesenen Netto-Summen; ohne Kette = Auftrags-Netto);
  Rest-Netto ≤ 0 → `Conflict`; Betrag > Rest → `Conflict`
  (nichts mehr zu berechnen — kein Validation, konsistent mit Cap);
  gleiche Ein-Satz-Grenze (0/19 %, Mischsätze fail-closed).
- Sicherheits-Cap wie F8-05 (Brutto, zurückgelesen, Rollback).
- Gespeicherte `percent_bps` = nomineller Auftrags-Anteil
  (Anzeige „Betrag X €“ aus Linien-Summe, nicht aus Bps —
  Bps nur CHECK 1..10000).
- Fälligkeit +14 Tage Berlin, kein Skonto-Copy (wie F8-05/06/07/08).
- Berechtigung: `invoicing.read`/`invoicing.write` (KEINE neuen Keys).
  Events/Audit nur IDs + Modus/Folge.

## Scopes

1. Migration 0134 (mode-/percent-CHECK um `'amount'`),
   Schema-`$type` (db:generate driftfrei, CHECK-Rümpfe wie 0121ff
   nur in SQL).
2. Contract: `mode`-Enum + `amountCents` (nullable, ≥1) + Refine
   (amount mit Betrag, ohne Prozent/Positionen).
3. Service: `createPartialInvoice` versteht `amount`
   (Rest aus zurückgelesenen Netto-Summen, Ordinal zählt weiter);
   Filter/Mapping kennen den Modus.
4. AB-Detail: sechster Radio-Modus „Fester Betrag (netto, €)“ mit
   Euro-Input (Cent ohne Float: Math.round); Kettenanzeige
   „Betrag X €“.
5. Action-Allowlist + Euro-Parsing (`0 < €`, cent-exakt,
   >0 Cent nach Rundung).

## Geschlossene Testmatrix

- `F813-DB-01`: percent 30 % → amount 100.000 ct (brutto 119.000,
  cent-exakt), Kette [percent, amount], Rest schrumpft; danach
  closing → Rest 0.
- `F813-DB-02`: 0/negativ → Validation; Betrag > Rest →
  Conflict; Rest 0 → Conflict; Mischsatz fail-closed;
  Viewer-denied.
- `F813-E2E-01`: AB → Prozent-Teilrechnung (30 %) → Betrag
  (1.000 €) → Kette mit „Betrag“ + Rest 6.723,50 € sichtbar.

## Bewusst offen

- Skonto je Teilrechnung, Portal-Sicht, Staffel-Beträge
  (Scheme mit Euro statt Prozent).
