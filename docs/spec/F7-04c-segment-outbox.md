# F7-04c Segment-Outbox (Offline-Abschluss + Replay, Katalog F9-Folge)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02`
Ziel: Offline getippte Segmentabschlüsse gehen in eine IndexedDB-Outbox
und werden beim nächsten Online-Kontakt über dieselbe Server-Action
(`mutateChecklistSegmentAction`, Op `complete`) replayt. Erster
vertikaler Checklisten-Outbox-Slice nach F11-03a (dort ausdrücklich
offengelassen). Kein Reonic-Referenzbeleg; reversible eigene Näherung
(ESTIMATE).

## Vertrag

- Queue-Eintrag je Segment: `{workspaceId, projectId, checklistId,
  segmentId, queuedAt}` (IndexedDB `wmee-outbox`/`segment-completes`,
  Schlüssel `checklistId:segmentId`; erneutes Tippen überschreibt).
- Replay-Entscheidung (`planSegmentSync`, rein, unit-getestet) gegen den
  aktuellen Server-Stand (Props nach Revalidierung):
  - Segment fehlt → verwerfen („nicht mehr vorhanden").
  - `completedAt` gesetzt → verwerfen, Fremd-/Eigenstand bleibt
    unangetastet („bereits abgeschlossen") — **nie überschreiben**.
  - Sonst Replay mit der **aktuellen** Version aus den Props (nie mit der
    Queue-Version).
- Ergebnis-Mapping wie F11-03a: `success`/`incomplete`/`invalid`/
  `not_found`/`denied` räumen; `conflict` → genau eine Revalidierung,
  danach maximal eine zweite Runde (Konvergenzschutz); Netzfehler/
  `error` behalten den Eintrag.
- Keine neue Permission (`checklist.write` wie der Button), keine
  Migration, keine Schemaänderung.

## Regeln

1. Offline erkannt (`navigator.onLine === false`) → Submit des
   Abschluss-Formulars wird abgefangen, Eintrag gequeued, ehrliche
   Meldung („Offline gespeichert …"). Unlock bleibt online-pflichtig.
2. Sync bei Mount, `online`-Event, Props-Wechsel (frischer Stand) und
   manuellem Button; Badge mit Wartestand; Erfolgs-/Kept-Meldungen,
   danach `router.refresh()`.
3. Ohne IndexedDB bleibt die App nutzbar (Anzeige entfällt still).

## Tests

- Unit (`f704c-segment-outbox`): Replay-/Drop-Entscheidung je Zustand,
  Key-Bildung, Rundenbegrenzung.
- E2E (`F704C-E2E-01`): F7.4-Aufbau → offline abschließen → Badge +
  Offline-Meldung → online → Sync-Meldung + Fortschritt (kein
  Formular-Toast: Direkt-Call läuft nicht durch `useActionState`) +
  Badge weg; keine Browser-Fehler; Axe sauber.
- Gates: lint/typecheck/test/build grün; keine Migrationsänderung.
