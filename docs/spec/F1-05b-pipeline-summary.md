# F1-05b Conversion-Ratio + gewichtete Pipeline (Katalog F1.5)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F1.5 verlangt „optionale Conversion-Ratio je Spalte →
gewichtete Pipeline". Dieser Slice: Ratio (0–100 %, NULL = keine)
je Spalte setzen/löschen, Board-Summary mit Projektzahl,
Angebotswerten und gewichteter Summe. Angebotswert je Projekt =
aktueller Angebotswert aus M2 (`getProjectOfferValues`, Netto-Cent;
Projekte ohne Angebot zählen mit 0). Offen bleiben:
Spalten-Typen-Automatik (z. B. Angebotsnummern-Vergabe).

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F1.5.
- Keine neue Permission (setzen: `project.write`; lesen: `project.read`).

## Datenmodell (Migration 0100, additiv)

`kanban_column.conversion_ratio_bps` (NULL erlaubt) + CHECK 0–10000.
Schema-Def nachgezogen. Keine neuen Grants (gleiche Tabelle wie 0099).

## Validierung (fail-closed)

- Ratio nur Integer 0–10000 bps oder NULL (Formular: 0–100 %, Komma
  akzeptiert); archivierte Spalte → Conflict; unbekannte IDs →
  Conflict; Viewer schreibt nicht, liest aber.
- Gewichtung centgenau, kaufmännisch gerundet; Spalte ohne Ratio
  zählt NICHT (null statt 0 — „keine Ratio" ≠ „0 %").

## Anzeige

Board-Seite: Pipeline-Strip (Angebotswert + „Gewichtet: X €" oder
„Gewichtet: — (keine Ratio)"). Verwaltung: Ratio-Badge je Zeile
(„Ratio: —" / „Ratio: 50 %") + Prozent-Eingabe (leer = keine).

## Akzeptanz

- Unit: Math (Rundung, Null-Ausschluss, leere Menge; 2/2).
- DB: setzen/löschen, Summary-Zählung ohne Angebote, Viewer-read,
  Guards (2/2).
- E2E: Strip mit „keine Ratio"; 50 % auf Eingang → Badge + Strip
  „Gewichtet: 0,00 €" (1/1).
- Nachbarn: F1-05a-Locator auf exakten Button nachgezogen (eigener
  „Ratio speichern"-Button kollidierte); F1-05a/11/02-E2E 4/4 mit neuem.
- Gates: tests grün, typecheck/lint/depcruise grün.
