# F16-04e Vorlagen mit Label-Inhalt (Katalog F16.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-15 (DB F1604E 3/3, Nachbar-DB F1604/A/B/C 15/15, E2E F16-04E-E2E-01 1/1, Nachbar-E2E F16-04 6/6, tsc/eslint/depcruise grün, lokal beobachtet).

Ziel: Folgeslice zu F16-04d (dort als „Vorlagen mit Label-Inhalt"
bewusst offen gelassen). Aufgaben-Vorlagen tragen Label-Inhalt
(Name + Farbe); Anwenden erzeugt daraus Task-Labels in stabiler
Reihenfolge. Kein Reonic-Referenzbeleg; reversible eigene Näherung
(ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Speicherung: `task_template.label_items` jsonb (Migration 0147,
  Default `[]`, DB-Check Array + Cap 15 wie
  PROJECT_TASK_MAX_LABELS), keine Extra-Permission (`task.write`).
- Eingabe-Format der Verwaltungs-Textarea (`Name` oder `Name | Farbe`,
  eine Zeile je Label; unbekannte Farbe = Invalid, Default `slate`).
- IDs/Positionen der Task-Labels vergibt die Task-Anlage beim Anwenden;
  Vorlagen kennen nur Inhalt (wie F16-04d keinen Erledigt-Zustand kennt).
- Keine neue Permission, kein Provider; eine Migration (0147).

## Geschlossene Testmatrix

- DB (`f1604e`, F1604E-DB-01..03): Anlegen mit 2 Labels → DTO +
  Apply erzeugt Task-Labels mit Farbe 1:1 (Read-back über Service —
  Raw-SQL sieht durch die restriktive Actor-SELECT-Policy still nichts,
  dokumentierte Testfallen-Klasse); Update ersetzt, fehlend = leer
  (Migration-Default); Cap 16 / Duplikat case-insensitiv / Leername /
  Steuerzeichen / 41 Zeichen → Validation, exakt 15 ok.
- E2E (`F16-04E-E2E-01`, isolierter Workspace): Vorlage mit zwei
  Labels per UI (Karte „2 Labels"), auf Projektseite anwenden →
  Aufgabe zeigt beide Label-Chips. Nachbarn F16-04 6/6 grün.

## Bewusst offen

- Bearbeiter-Rollen je Vorlage (F16-04b-Offenpunkt —
  neue Autorisierungsdimension, zurückgestellt).
