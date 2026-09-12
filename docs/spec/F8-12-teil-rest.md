# F8-12 Teil-Rest zur Teilrechnungs-Kette (Katalog F8.5, Folgemodus)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F812 2/2, E2E F812-E2E-01 1/1, F8-Batch 12/12, tsc/eslint/depcruise/db:generate grün, lokal beobachtet).

Ziel: Vierter belegter F8.5-Katalogmodus (`remainder`) neben F8-05
(`percent`/`lines`), F8-07 (`scheme`) und F8-08 (`closing`): Einen
Anteil des AKTUELLEN Ketten-Rests als Teilrechnung stellen, ohne die
Kette zu schließen (F8-08-Spec: „Bewusst offen: … Teil-Rest (nur Teil
des Rests schließen — immer Voll-Rest in v1)“). Mehrstufige Ketten
werden damit fortsetzbar: Prozent → Teil-Rest → Teil-Rest →
Schlussrechnung.

## ESTIMATE (reversibel, Referenzfrage offen)

- Modus `remainder` (Migration 0132, nur CHECKs, keine neue Tabelle,
  keine Grants, RLS unverändert): genau EINE Sammellinie
  `Teil-Restbetrag zu {AB-Nr}`, netto = gerundeter Anteil
  (`roundPercentCents`, kaufmännisch halb auf) am Rest-Netto
  (AB-Netto − Σ Netto der aktiven Teilrechnungen, zurückgelesen,
  cent-exakt).
- Anteil `percentBps` 1..9999 (0,01 %..99,99 % VOM REST); 100 %
  ist kein Teil-Rest (dafür F8-08-`closing`), fail-closed als
  `Validation` in Contract-Refine und Service.
- Guards: keine aktive Teilrechnung → `Validation` (kein Ersatz für
  F8-04b-Vollduplikat, wie `closing`); Rest-Netto ≤ 0 → `Conflict`;
  gerundetes Linien-Netto ≤ 0 → `Conflict`; gleiche
  Ein-Satz-Grenze wie percent/scheme/closing (Mischsätze und Sätze
  ≠ 0/19 % fail-closed).
- Sicherheits-Cap wie F8-05 (Brutto, zurückgelesen, Rollback).
- Gespeicherte `percent_bps` = beantragter Rest-Anteil (Anzeige
  „Teil-Rest X %“); Storno gibt Budget/Rest frei (konsistent mit
  F8-05); `percent`-Modus bleibt Auftrags-Prozent (unverändert).
- Fälligkeit +14 Tage Berlin, kein Skonto-Copy (wie F8-05/06/07/08).
- Berechtigung: `invoicing.read`/`invoicing.write` (KEINE neuen Keys).
  Events/Audit nur IDs + Modus/Folge (kein PII über Beleg-IDs hinaus).

## Scopes

1. Migration 0132 (mode-/percent-CHECK um `'remainder'`, Anteil
   1..9999), Schema-`$type` + Checks (db:generate driftfrei).
2. Contract: `mode`-Enum + Refine (remainder mit Anteil 1..9999,
   ohne Positionen).
3. Service: `createPartialInvoice` versteht `remainder` (Rest aus
   zurückgelesenen Netto-Summen, Ordinal zählt weiter);
   `readActiveBilledNet`-Filter und `listPartialInvoices`-Mapping
   kennen den Modus.
4. AB-Detail: fünfter Radio-Modus „Teil-Rest (% vom Rest)“ mit
   Prozent-Input (wiederverwendet), deaktiviert ohne aktive Kette;
   Kettenanzeige „Teil-Rest X %“.
5. Action-Allowlist + Prozent-Parsing (`0 < p < 100`, 100 % →
   `invalid` mit Hinweis auf Rest-Schlussrechnung).

## Geschlossene Testmatrix

- `F812-DB-01`: percent 30 % → remainder 50 % vom Rest (Netto/
  Brutto cent-exakt), Kette [percent, remainder], Rest schrumpft;
  zweiter remainder auf kleinerem Rest; danach closing → Rest 0.
- `F812-DB-02`: remainder ohne Kette → Validation; 100 %
  (10000 bps) → Validation; Mischsatz fail-closed; Rest 0 →
  Conflict; Viewer-denied.
- `F812-E2E-01`: AB → Prozent-Teilrechnung (30 %) → Teil-Rest
  (50 % vom Rest) → Kette mit „Teil-Rest 50 %“ + geschrumpfter
  Rest sichtbar.

## Bewusst offen

- Skonto auf (Teil-)Restrechnungen, Portal-Sicht, absolute
  Rest-Beträge statt Prozent (immer Anteil in v1).
