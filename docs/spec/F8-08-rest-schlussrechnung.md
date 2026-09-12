# F8-08 Rest-Schlussrechnung (Remaining) zur Teilrechnungs-Kette

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12

Ziel: Dritter belegter F8.5-Katalogmodus („Remaining") neben F8-05
(`percent`/`lines`) und F8-07 (`scheme`): Eine AB mit aktiver
Teilrechnungs-Kette per Knopfdruck über den exakten Restbetrag
schließen. Keine Automatik bisher (F8-05-Spec: „keine Automatik");
F8-01 bleibt Anzahlungs-Anrechnung (anderer Mechanismus).

## ESTIMATE (reversibel, Referenzfrage offen)

- Modus `closing` (Migration 0122, Kette zeigt „Rest"): genau EINE
  Sammellinie `Restbetrag zu {AB-Nr}`, netto = AB-Netto − Σ Netto der
  aktiven Teilrechnungen (zurückgelesen, cent-exakt).
- Guards: keine aktive Teilrechnung → `Validation` (kein Ersatz für
  F8-04b-Vollduplikat); Rest ≤ 0 → `Conflict`; gleiche
  Ein-Satz-Grenze wie percent/scheme (Mischsätze fail-closed).
- Sicherheits-Cap wie F8-05 (Brutto, zurückgelesen, Rollback).
- Storno der Restrechnung gibt Budget/Rest frei (konsistent mit F8-05).
- Zweiter Closing-Versuch → Rest 0 → `Conflict`.
- Fälligkeit +14 Tage Berlin, kein Skonto-Copy (wie F8-05/06/07).

## Scopes

1. Migration 0122 (mode-/percent-CHECK um `'closing'`), Schema-`$type`.
2. Contract: `mode`-Enum + Refine (closing ohne Parameter).
3. Service: `createPartialInvoice` versteht `closing` (Rest aus
   zurückgelesenen Netto-Summen, Ordinal zählt weiter).
4. AB-Detail: vierter Radio-Modus „Restbetrag (Kette schließen)" mit
   deaktiviertem Zustand ohne aktive Kette; Anzeige „Rest".
5. Action-Allowlist + `closing`.

## Geschlossene Testmatrix

- `F808-DB-01`: percent 30 % → closing = exakt 70 % (Netto/Brutto),
  Kette [percent, closing], Rest 0; zweites closing → Conflict.
- `F808-DB-02`: closing ohne Kette → Validation; Mischsatz
  fail-closed; Viewer-denied.
- `F808-E2E-01`: AB → Prozent-Teilrechnung → Rest schließen → Kette
  mit „Rest" + Rest 0,00 €.

## Bewusst offen

- Skonto auf Restrechnung, Portal-Sicht.
- Absolute Rest-Beträge sind seit 2026-09-12 als eigener Modus
  `amount` in F8-13 belegt (fester Netto-Centbetrag gegen Rest).
- Teil-Rest (nur Teil des Rests schließen) ist seit 2026-09-12 als
  eigener Modus `remainder` in F8-12 belegt (dort: Prozentanteil vom
  Rest, Kette bleibt offen).
