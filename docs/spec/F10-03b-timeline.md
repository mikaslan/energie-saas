# F10-03b Status-Timeline im Portal (F7.7 öffentlich ohne Login)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F7.7 verlangt eine „öffentliche Status-Timeline ohne
Login"; F10-03 zeigt nur den Stand. Dieser Slice projiziert die
Timeline in den Installations-Tab: angelegt → abgeschlossen →
abgenommen (je Typ + Zeitstempel, ohne Payloads/Akteure). Quelle sind
die echten `domain_events` (`installation.created/completed/
handover_recorded`). `installation.lead_installer_assigned` bleibt
intern (Membership-PII, kein Kundenstatus).

## Evidenz

- Modulkatalog F7.7; F10-03-Spec (Projektion/Privacy-Präzedenz).
- Exakte Reonic-Darstellung UNKNOWN; Liste im Tab-Muster (ESTIMATE
  nur Optik).

## Datenmodell (Migration 0097, additiv)

`resolve_portal_public_view` (CREATE OR REPLACE, Muster 0091):
`installation.timeline` als JSON-Array `[{type, at}]`, leeres Array
ohne Installation/Ereignisse (ehrlich, kein Orakel — Invite bindet
ohnehin ans Projekt). GRANT SELECT ON domain_events (42501-Präzedenz).
Keine Tabellenänderung, keine neue Permission.

## Validierung (fail-closed)

- Nur Allowlist-Typen; fremde Typen kommen per IN-Liste gar nicht erst
  aus SQL (kein Parser-Raten nötig, Parser prüft trotzdem strikt).
- Fehlendes `timeline` (Alt-Projektion) → [] (F10-03-undefined-Präzedenz).
- Entzogen/abgelaufen → weiter `not_found` (unverändert).

## Anzeige

Installations-Tab: Timeline-Liste („Angelegt / Abgeschlossen /
Abgenommen am …", Berlin-Datum) oder „Noch keine Ereignisse."
(kein Status ohne Ereignis erfunden — Liste zeigt nur echte Events).

## Akzeptanz

- DB: created/completed/handover in Reihenfolge, assign_lead fehlt,
  keine Payloads/Akteure im JSON.
- E2E: Installation anlegen + abschließen (UI), Invite (UI), Portal:
  Timeline mit 2 Einträgen.
- Gates: migrate+tests grün, typecheck/lint/depcruise grün.
