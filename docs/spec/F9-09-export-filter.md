# F9-09 Listen-/Export-Filter (Zeitraum + Ereignistyp)

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Liste und CSV-Export filtern nur je Nutzer (F9-03/F9-04 benennen die
Lücke wörtlich: „keine eventTypeIds, keine Datums-/Seiten-Filter").
Dieser Slice schließt Zeitraum (Kalendertage, Berlin) + Ereignistyp(en)
für Liste, Summe, CSV-Export und Export-Link durchgängig an. Keine neue
Lane-Freigabe nötig (Gesamtauftrag 2026-09-10).

## Evidenz

- F9-03-Spec („keine eventTypeIds, keine Datums-/Seiten-Filter"),
  F9-04-Export (nur userIds).
- Exakte Reonic-Darstellung UNKNOWN; Filter-ESTIMATE im bestehenden
  Formularmuster (GET, tolerante Liste).

## Datenmodell (keine Migration)

Nur Query-Contract: `startDate`/`endDate` (Kalendertag `YYYY-MM-DD`,
`startDate <= endDate`), `eventTypeIds` (UUID, max 50, wie userIds).

## Validierung (fail-closed, keine stillen Defaults)

- Liste (UI, tolerant wie userIds): ungültige Werte fallen auf
  ungefiltert zurück? Nein — Review-Welle-03-Präzedenz (Export):
  Export wirft 400 bei ungültigen UUIDs/Daten. Liste: ungültige UUIDs
  werden wie userIds ignoriert (bestehendes tolerantes Muster),
  ungültige Daten auf leer zurückgesetzt (kein stiller Voll-Export,
  keine stillen Alle-Zeilen).
- Datumsgrenze: `start_at` in Europe/Berlin im Intervall
  [startDate, endDate] (eintägig erlaubt); Typfilter: exakte
  Übereinstimmung mit `type_id` (NULL-Typen nur ohne Typfilter).
- Summe folgt allen Filtern (Muster userIds-Filter).

## Berechnung/Anzeige

- Filterformular: Von/Bis-Datumsfelder + Ereignistyp-Checkboxen neben
  Nutzer-Checkboxes (ein GET-Formular, Reset-Link löscht alles).
- Export-Link übernimmt alle aktiven Filter; Route parst strikt (400).

## Akzeptanz

- DB F0909 4/4 (Datum, Typ, kombiniert + Summe, Export-Filter, invalid).
- E2E F9-09-E2E-01 (Datumsfilter blendet Eintrag aus/ein).
- Gates: typecheck/lint/depcruise grün, Nachbarn (F9-03/04/07/08) lokal.

## Bewusst offen

- Seiten-/Limit-Filter (kein Bedarf belegt), Freigabe-Filter bleibt
  separat, Mobile-/Offline-Verhalten.
