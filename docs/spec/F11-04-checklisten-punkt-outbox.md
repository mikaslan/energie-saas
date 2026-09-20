# F11-04 Checklisten-Punkt-Outbox (Offline-Haken + Replay, Katalog F11.3/F11.4)

Status: **IMPLEMENTED** · Lane: `codex/muse-fleet-2c-f11` · Basis `4a4d7c1`
Ziel: Offline gesetzte Haken und Antworttexte an Checklistenpunkten gehen
beim „Speichern" in eine IndexedDB-Outbox und werden beim nächsten
Online-Kontakt über dieselbe Server-Action (`saveProjectChecklistAction`)
replayt. Schließt die Lücke aus F7-04c (dort nur Segmentabschluss) und
liefert erstmals den im Katalog wörtlich geforderten Vertrag
„Queue + Auto-Replay … last-write-wins" (F11.4) für „Checklisten offline"
(F11.3).

## Evidenz (FACT, Basis 4a4d7c1)

- Katalog: `docs/blaupause/01-modulkatalog.md:130-131`. CAPABILITY-MATRIX
  ohne F11-Zeile. `docs/parity/STATUS.md:139`: F11 PARTIAL.
- Haken sind lokaler Zustand des Managers und werden nur als ganzer Baum
  gespeichert (`project-checklist-manager.tsx:354-380`); offline scheitert
  dieser Weg, abgefangen wird bisher nur der Segmentabschluss (`:692`).
- Die Save-Kapsel prüft CAS über `version` (`drizzle/0077…:596-672`,
  `40001`), lässt Nicht-Admins nur `done`/`value` an voll sichtbaren
  Punkten ändern (`drizzle/0144…:213-250`, sonst `42501`) und hält
  abgeschlossene Segmente unveränderlich (`23514`).

## Vertrag

- Queue-Eintrag je Punkt: `{workspaceId, projectId, checklistId, itemId,
  done?, value?, queuedAt}` (strict, mindestens eines von `done`/`value`;
  eigene IndexedDB `wmee-item-outbox`, Store `item-patches`, Schlüssel
  `checklistId:itemId`). Letzter Eintrag je Punkt gewinnt. Eigene
  Datenbank statt Versionssprung der Segment-DB: ein Upgrade ließe noch
  offene Alt-Tabs mit `VersionError` scheitern; der Opener
  (`withOutboxStore`) wird mit der Segment-Outbox geteilt.
- Offline-Speichern setzt die Warteschlange dieser Checkliste auf den
  sichtbaren Stand: Patch je Punkt, dessen `done`/`value` vom Serverstand
  (Props) abweicht; Einträge für Punkte ohne Abweichung werden entfernt.
- Replay-Entscheidung (`planItemSync`, rein, unit-getestet) gegen den
  **aktuellen** Serverbaum (Props nach Revalidierung):
  - Punkt fehlt → verwerfen („nicht mehr vorhanden").
  - Block, Segment oder Punkt nicht sichtbar, oder Anzeige-Punkt
    (`title`/`description`) → verwerfen.
  - Segment abgeschlossen → verwerfen, **nie überschreiben**.
  - `value` nur an Textpunkten, sonst wird nur `done` übernommen; ein
    leerer Antworttext gilt als „kein Wert" (der Server wiese Leertext ab
    und damit den ganzen Replay).
  - Radio-Punkt auf erledigt → übrige Radio-Punkte desselben Segments
    werden unerledigt (Exklusivität wie `toggleRadioItem`).
  - Punkt entspricht bereits dem Patch → räumen ohne Speichern.
  - Sonst: Patch auf den frischen Baum anwenden; alle fremden Punkte
    bleiben unverändert (**last-write-wins je Punkt**, nicht je Baum).
- Ein Replay ist genau ein Whole-Tree-Save mit der aktuellen Version aus
  den Props (nie mit einer Queue-Version).
- Ergebnis-Mapping (Konflikt/Retry/Permission):
  - `success` → räumen, Meldung, `router.refresh()`.
  - `conflict` → genau eine Revalidierung, danach höchstens eine zweite
    Runde (Konvergenzschutz); danach bleiben die Einträge, Button
    „Jetzt synchronisieren".
  - `denied`/`invalid`/`not_found` → räumen **mit sichtbarer Meldung**
    (kein stilles Verwerfen).
  - Netzfehler/`error` → Einträge bleiben.
- Keine neue Permission (`checklist.write` wie der Speichern-Button),
  keine Migration, keine Schemaänderung.

## Regeln

1. Offline erkannt (`navigator.onLine === false`) und Checkliste existiert
   (`checklistId` gesetzt) → Submit des Speichern-Formulars wird
   abgefangen, Patches gequeued, ehrliche Meldung („Offline gespeichert …").
2. Strukturänderungen (Namen, neue Blöcke/Segmente/Punkte, Pflicht, Art)
   bleiben online-pflichtig: weicht der lokale Baum strukturell vom
   Serverstand ab, wird offline **nichts** gequeued (auch keine Haken), der
   Nutzer bekommt einen sichtbaren Hinweis und der lokale Stand bleibt für
   das Online-Speichern erhalten (kein stiller Teilverlust).
3. Sync bei Mount, `online`-Event, Props-Wechsel und manuellem Button;
   Wartestand sichtbar; Ziele mindestens 44 px.
4. Ohne IndexedDB bleibt die App nutzbar (Anzeige entfällt still).

## ESTIMATE

Kein Reonic-Live-Beleg für das Konfliktverhalten der nativen App; der
Katalog nennt nur „last-write-wins". Die Auflösung „je Punkt statt je
Baum" und „abgeschlossene Segmente nie überschreiben" ist eine eigene,
reversible Näherung. Nativ-Grenze: reine Web-PWA im Browser-Tab; kein
Background Sync, kein natives Device-Gate — Replay läuft nur bei geöffneter
Seite.

## Geschlossene Testmatrix

- Unit `tests/unit/f1104-item-outbox.test.ts` (`F1104-U-01…`): Diff nur
  `done`/`value` + Strukturflag; Schlüssel; Schema strict; Plan wendet
  Patches auf frischen Baum an und lässt Fremdhaken stehen; Drop je
  Zustand (fehlt, unsichtbar, Anzeige-Punkt, abgeschlossen); Radio-
  Exklusivität; No-op ohne Save.
- DB `tests/db/f1104-item-replay.test.ts` (`F1104-DB-01…`): paralleler
  Fremd-Haken überlebt den Replay (Editor, aktuelle Version); veraltete
  Version → Konflikt; abgeschlossenes Segment wird vom Plan verworfen und
  vom Server zusätzlich abgewiesen.
- E2E `tests/e2e/f11-04-item-outbox.spec.ts` (`F11-04-E2E-01`): isolierter
  Workspace → Checkliste anlegen → offline abhaken + Speichern → Wartestand
  + Offline-Meldung → online → Sync-Meldung, Haken nach Reload persistent;
  375/768/1440 ohne horizontalen Überlauf; keine Browser-Fehler; Axe
  sauber.
- Gates: lint/typecheck/contract/depcruise/test/db:roles:verify/build,
  keine Migrationsdrift.

## Bewusst offen

- Foto-/Upload-Outbox (braucht interne Upload-Route und Foto-Tabelle;
  Bildpunkte hängen an Q-STORAGE-UPLOADS).
- Web-Push (kein VAPID/Provider, keine Subscription-Tabelle).
- „Als irrelevant markieren" und Unlock bleiben online-pflichtig.
- Segmentabschluss offline direkt nach einem Offline-Haken: bleibt
  gesperrt (`hasUnsavedChanges`), bis der Replay lief.
- Ungespeicherter lokaler Stand wird bei einem Versionswechsel verworfen
  (Bestandsverhalten des Managers); gequeuete Patches überleben das.
- Netzabbruch bei `navigator.onLine === true` (wie F7-04c nicht
  abgefangen).
- Gemeinsames Outbox-Badge über alle Features.
