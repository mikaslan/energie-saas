# F11-03a Notiz-Outbox (Offline-Anlage, Replay-sicher)

Erste vertikale Outbox-Scheibe nach F11-02 (dort ausdrücklich
offengelassen): Offline erstellte Projekt-Notizen werden in IndexedDB
zwischengespeichert und beim nächsten Online-Kontakt über dieselbe
Server-Action replayt. Fotos/Checklisten/Zeit-Sync bleiben Folge-Slices.
Kein Reonic-Referenzbeleg; Verhalten ist reversible eigene Näherung
(ESTIMATE).

## Vertrag

- `project_note.client_key` (nullable UUID, je Mandant eindeutig;
  Migration 0111; NULL = klassischer Pfad, mehrfach zulässig).
- `create_note` trägt optional `clientKey` (je Entwurf genau einmal
  clientseitig vergeben; Dialog: je Öffnung; Outbox: Wiederverwendung).
- Replay-Guard im Service: bekannter Schlüssel → Bestand
  (`changed: false`), ohne Events/Mentions zu duplizieren; Race zweier
  Replays über Unique-Verletzung abgefangen.
- Keine neuen Permissions (project.write wie bisher).

## Regeln

1. Offline erkannt (`navigator.onLine === false`) → nur Anlage geht in
   die Outbox (IndexedDB `wmee-outbox`/`note-creates`, Schlüssel =
   clientKey). Bearbeitungen brauchen den Server-Stand und bleiben
   online-pflichtig.
2. Sync bei Mount und `online`-Event plus manueller Button; Erfolg und
   endgültige Antworten (`invalid`/`not_found`/`denied`) räumen den
   Eintrag, Netzfehler behalten ihn für den nächsten Versuch.
3. UI: Wartungs-Badge („n Offline-Notizen warten …“),
   Erfolgsmeldung, danach `router.refresh()`.
4. Ohne IndexedDB bleibt die App nutzbar (Anzeige entfällt still).

## Tests

- DB (`f1103a-note-replay`): gleicher Schlüssel → eine Notiz, genau ein
  `project.note_created`-Event, `changed: false` bei Replay;
  klassischer Pfad dupliziert wie bisher; Schlüssel mandantengebunden.
- E2E (`F11-03a-E2E-01`): offline anlegen → „Offline gespeichert“,
  online → genau einmal synchronisiert und sichtbar; keine
  Browser-Fehler.
