# F11-03b Zeit-Outbox (Offline-Anlage, Replay-sicher)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F1103b 2/2, E2E F11-03b-E2E-01 1/1, am Code verifiziert vorgefunden + erneut beobachtet).

Zweite vertikale Outbox-Scheibe nach F11-03a (dort ausdrücklich als
Folge-Slice offengelassen: „Outbox für Fotos/Checklisten/Zeit-Sync“):
Offline erstellte manuelle Zeiteinträge (F9.1) werden in IndexedDB
zwischengespeichert und beim nächsten Online-Kontakt über dieselbe
Server-Action replayt. Kein Reonic-Referenzbeleg; Verhalten ist reversible
eigene Näherung (ESTIMATE).

## Vertrag

- `time_entry.client_key` (nullable UUID, je Mandant eindeutig;
  Migration 0112; NULL = klassischer Pfad, mehrfach zulässig).
- `createTimeEntry` trägt optional `clientKey` (je Entwurf genau einmal
  clientseitig vergeben; Formular: je Absendung; Outbox: Wiederverwendung).
- Replay-Guard im Service: bekannter Schlüssel → Bestand (DTO des
  vorhandenen Eintrags), ohne `time_entry.created`-Event/Audit zu
  duplizieren; Race zweier Replays über Unique-Verletzung abgefangen.
- Keine neuen Permissions (time.write wie bisher).

## Regeln

1. Offline erkannt (`navigator.onLine === false`) → nur manuelle Anlage
   geht in die Outbox (IndexedDB `wmee-time-outbox`/`time-creates`,
   Schlüssel = clientKey). Online gestartete Stoppuhr, Pausen, Freigabe
   und Bearbeitungen brauchen den Server-Stand und bleiben
   online-pflichtig (offline GESTARTETE Stoppuhr: F11-03c).
2. Sync bei Mount und `online`-Event plus manueller Button; Erfolg und
   endgültige Antworten (`invalid`/`not_found`/`denied`) räumen den
   Eintrag, Netzfehler behalten ihn für den nächsten Versuch.
3. UI: Wartungs-Badge („n Offline-Zeiteinträge warten …“),
   Erfolgsmeldung, danach `router.refresh()`.
4. Ohne IndexedDB bleibt die App nutzbar (Anzeige entfällt still).
5. IDB-Fehlschlag beim Einreihen zeigt einen Alert (Härtung wie F11-03a),
   kein stilles Verwerfen.

## Tests

- DB (`f1103b-time-replay`): gleicher Schlüssel → ein Eintrag, genau ein
  `time_entry.created`-Event, DTO des Bestandseintrags bei Replay;
  klassischer Pfad dupliziert wie bisher; Schlüssel mandantengebunden.
- E2E (`F11-03b-E2E-01`): offline anlegen → „Offline gespeichert“,
  online → genau einmal synchronisiert und sichtbar; keine
  Browser-Fehler.
