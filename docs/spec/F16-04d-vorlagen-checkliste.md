# F16-04d Vorlagen mit Checklisten-Inhalt (Katalog F16.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (DB F1604D 3/3, Nachbar-DB F1604B/C 8/8, E2E F16-04D-E2E-01 1/1, Nachbar-E2E F16-04 5/5, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F16-04b (dort als „Vorlagen mit Checklisten-/
Label-Inhalt" bewusst offen — Labels weiter offen, s. unten).
Aufgaben-Vorlagen tragen reine Checklisten-Texte; Anwenden erzeugt
daraus unerledigte Task-Items in stabiler Reihenfolge. Kein
Reonic-Referenzbeleg; reversible eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Speicherung: `task_template.checklist_items` jsonb (Migration 0146,
  Default `[]`, DB-Check Array + Cap 100 wie
  PROJECT_TASK_MAX_CHECKLIST_ITEMS). Kein RLS-/Grant-Umbau.
- Contract: `checklistItems` optional in Create/Update, Pflicht im
  DTO. Text-Semantik wie Task-Checkliste (getrimmt, einzeilig,
  1..500, keine Steuerzeichen) — Anwenden scheitert nie an der
  eigenen Vorlage. Vorlagen kennen keinen Erledigt-Zustand
  (done=false entsteht erst beim Anwenden).
- Service: Create/Update speichern (fehlend = leer, konsistent mit
  Bearbeitern); DTO liest defensiv (fremde Formen entfallen —
  Schreiben validiert strikt); Apply mappt auf
  `{text, done:false}` + `checklistCount` im Event.
- Action: `checklistText`-Textarea (eine Zeile je Punkt; Trim +
  Leerzeilen-Drop serverseitig, Bereich/Cap fail-closed).
- UI: Textarea in Create/Edit ( vorbelegt), Zähler in der Karte
  („N Checklistenpunkte"), keine Extra-Permission (`task.write`).
- Keine neue Permission, kein Provider; eine Migration (0146).

## Geschlossene Testmatrix

- DB (`f1604d`, F1604D-DB-01..03): Anlegen mit 3 Punkten → DTO +
  Apply erzeugt 3 unerledigte Items in Reihenfolge (Read-back über
  Service — Raw-SQL sieht durch die restriktive Actor-SELECT-Policy
  still nichts, dokumentierte Testfallen-Klasse); Update ersetzt,
  fehlend = leer (Migration-Default); Cap 101 / Leertext /
  Steuerzeichen / 501 Zeichen → Validation, exakt 100 ok.
- E2E (`F16-04D-E2E-01`, isolierter Workspace): Vorlage mit zwei
  Punkten per UI (Karte „2 Checklistenpunkte"), auf Projektseite
  anwenden → Aufgabe mit beiden Punkten unerledigt („0/2").
  Nachbarn F16-04 5/5 grün.

## Bewusst offen

- Vorlagen mit Label-Inhalt (F16-04b-Offenpunkt).
- Bearbeiter-Rollen je Vorlage (F16-04b-Offenpunkt —
  neue Autorisierungsdimension, zurückgestellt).
