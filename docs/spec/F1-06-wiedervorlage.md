# F1-06 Lead-Wiedervorlage (Setzen → Eskalieren → Filtern)

Ziel: Pro offener Anfrage ein optionaler Wiedervorlage-Zeitpunkt mit
In-App-Eskalation auf dem Board — ohne Mailversand, ohne Worker, ohne
neue Permission (Bauarbeit, kein Referenzbeleg).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `project.follow_up_at timestamptz null` (Migration 0101,
  NULL = keine Wiedervorlage). Kein Revision-CAS: Last-Writer-Wins
  (harmlos, kein Beleg), Zeilensperre hält Event/Audit atomar.
- Bänder in Berlin-Kalendertagen (`lib/follow-up.ts`): anstehend
  (übermorgen+), fällig (heute/morgen), überfällig (1–7 Tage zurück),
  eskaliert (>7 Tage zurück, `FOLLOW_UP_ESCALATION_DAYS = 7`).
- Berechtigung: Wiederverwendung `project.read`/`project.write`
  (KEINE neuen Permission-Keys — Mandat). Externe Leser: kein Signal,
  kein Filter (internes Arbeitsdatum).
- Anzeige: Projektakte (eigene Sektion, Datum + Band, Setzen per
  `<input type=date>` → 09:00 Berlin DST-sicher, Löschen), Board-Karte
  (WV-Badge), Board-Presets (`?wiedervorlage=anstehend|ueberfaellig`,
  unbekannt fail-closed), kein Portal-Anteil.
- Exakte Reonic-Darstellung UNKNOWN; ESTIMATE-Layout, nur
  gespeicherte Werte.

## Scopes
1. Migration 0101 + `setProjectFollowUp`/`getProjectFollowUp`
   (fail-closed: Validation, NotFound ohne Orakel, Fremdtenant
   sieht nichts, Viewer read-only).
2. Board-Leseregel: `followUp` je Karte + `followUpFilter`
   (`due` = anstehend/fällig, `overdue` = überfällig/eskaliert).
3. Akte-Sektion + Board-Badge + Presets; Events/Audit ohne PII
   (nur IDs + cleared-Flag).

## Geschlossene Testmatrix
- `F106-U-01..07`: Bänder, Berlin-Tagesgrenze, Eskalationsschwelle,
  Parser fail-closed, Datum→09:00-Berlin (Winter/Sommer).
- `F106-DB-01`: setzen → lesen → Bänder → löschen (Board-Signal folgt).
- `F106-DB-02`: Filter-Presets anstehend/ueberfaellig.
- `F106-DB-03`: Validation, NotFound, Viewer-denied, Tenant-Isolation,
  unbekannter Filter fail-closed.
- `F106-E2E-01`: Akte setzen → Badge → Presets → 404 bei Müll → löschen.

## Bewusst offen
- Echte Erinnerungszustellung (Mail/Push), Eskalations-Workflows mit
  Zuweisung, wiederkehrende Wiedervorlagen, Dashboard-Widget.
