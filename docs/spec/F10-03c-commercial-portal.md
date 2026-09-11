# F10-03c Commercial-Portal ohne Angebot/Signatur (Katalog F10.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F10.3 verlangt: „Kein Preis-/Signatur-Tab im
Commercial-Portal". Bestand: Der Dokumentenbereich (Angebot +
Signatur-Status) liegt in der Übersicht und wurde unterschiedslos für
beide Bereiche gezeigt. Dieser Slice blendet ihn für Gewerbe-Projekte
aus: Resolver-Strip (Token erhält keine Dokumente) + Seite zeigt den
Bereich gar nicht erst (kein Heading, kein Leerzustand als Orakel).
Termine-/Installation-Tabs bleiben für beide Bereiche gleich.

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F10.3.
- Exakte Reonic-Darstellung UNKNOWN; Ausblendung im Tab-Muster
  (ESTIMATE nur Optik, kein Preis-Tab erfunden).

## Datenmodell (Migration 0098, additiv)

`resolve_portal_public_view` (CREATE OR REPLACE, Muster 0097):
`project.scope` aus `kanban_board.scope` des Projekt-Boards.
GRANT SELECT ON kanban_board (42501-Präzedenz wie domain_events).
Fehlendes Board → NULL → strikter Contract bricht fail-closed ab
(kein Scope-Fallback). Keine Tabellenänderung, keine neue Permission.
Funktions-Pin im Rollenvertrag per Marker `portal_project_scope`
nachgezogen (Muster 0097).

## Validierung (fail-closed)

- Contract parst scope strikt (`residential`/`commercial`); fehlend/
  fremd → null → `PortalIntegrityError` (kein Orakel, kein Default).
- Strip NACH striktem Parse: deformierte Dokumente brechen auch bei
  scope commercial ab.
- `commercial` → `documents: []` (Token sieht keine Angebotsdaten);
  `residential` unverändert.

## Anzeige

Übersicht: `scope === "commercial"` → kein Dokumentenbereich.
Residential unverändert (Liste oder „Aktuell liegen keine
freigegebenen Dokumente vor.").

## Akzeptanz

- Unit: commercial leert belegtes Dokument, residential behält,
  deformiert/fehlender scope → null.
- DB: scope je Bereich korrekt (Wohnbau/Gewerbe-Projekt + Invite).
- E2E: Gewerbe-Link ohne „Dokumente"/„Angebot" (Tabs bleiben),
  Wohnbau-Kontrolle mit Dokumentenbereich.
- Gates: migrate+tests grün, typecheck/lint/depcruise grün.
