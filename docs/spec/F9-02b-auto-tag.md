# F9-02b Auto-Tag Residential/Commercial (Bereichskennzeichen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F9.2 verlangt „Auto-Tag Residential/Commercial über
Projekt": Kategorien (Eventtypen, custom) existieren, das
Bereichskennzeichen fehlt (null Treffer im Time-Pfad). Dieser Slice
leitet es strikt aus echten Daten ab: Eintrag → Projekt →
`kanban_board.scope` (`residential`/`commercial`, F15-01-Präzedenz).
Kein neues Datenmodell (reine Lesesicht, keine Migration), keine neue
Permission, kein erfundener Bereich.

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F9.2 (s. Ziel).
- Exakte Reonic-Darstellung UNKNOWN; Chip im bestehenden
  Listenzeilen-Muster (ESTIMATE nur Optik, keine Semantik).

## Berechnung/Anzeige

- `TimeEntryDto.scopeTag`: `residential` | `commercial` | null
  (additiv, Schema-Version unverändert — Präzedenz F9-05/F9-07).
- Ableitung: LEFT JOIN Projekt → Board; Scope außerhalb
  {residential, commercial} oder unauflösbar → null (ehrlich „—",
  kein Default-Raten).
- Anzeige: Chip „Residential"/„Commercial"/„—" in der Eintragszeile
  (Liste). CSV-Export unverändert (F9.4-Kopf exakt — kein
  stiller Spaltenbruch).

## Validierung (fail-closed)

- Unbekannter Scope wird nicht auf Residential normalisiert.
- Summe/Filter unberührt (reine Anzeige-Ableitung).

## Akzeptanz

- DB: residential/commercial/null-Ableitung je Board-Scope.
- E2E: Chip am Eintrag sichtbar (Residential-Projekt).
- Gates: lint/typecheck/depcruise + Nachbarn grün.
