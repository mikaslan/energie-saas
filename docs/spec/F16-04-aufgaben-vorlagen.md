# F16-04 Aufgaben-Vorlagen (Titel + Fälligkeits-Offset, anwenden je Projekt)

Ziel: Wiederkehrende Aufgaben als Vorlage standardisieren (Name,
Titel-Preset, optionaler Fälligkeits-Offset in Tagen) und per Klick
als Aufgabe im Projekt anlegen — aus eigenen Daten, ohne neue
Belegtypen. F16.3 nennt Task-Vorlagen als fehlenden Typ.

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `task_template` (Migration 0092, Archiv statt Delete,
  Checklisten-/Rabatt-Muster; RLS tenant_isolation + FORCE).
- Anwenden: `create`-Befehl mit Titel-Preset, Fälligkeit =
  heute (Europe/Berlin) + Offset oder leer, leere
  Body/Checkliste/Labels, Bearbeiter = Anwendender. Kein
  Angebots-/Preisbezug.
- Offset-Semantik (0 = heute, null = ohne Fälligkeit) ist
  ESTIMATE; exakte Reonic-Felder UNKNOWN.
- Keine neuen Permissions: `task.read` (lesen), `task.write`
  (CRUD + anwenden).

## Scopes
1. Migration + CRUD (Name eindeutig je aktivem Workspace,
   Titel 1–200, Offset 0–3650 oder null), Archiv statt Delete,
   fail-closed (Validation/Conflict/NotFound ohne Orakel).
2. `applyTaskTemplate` (Vorlage aktiv + lesbar, Projekt
   vorhanden; erzeugt Aufgabe Revision 1).
3. UI: Einstellungsseite (Liste/Anlage/Archiv) + „Aus Vorlage"-
   Auswahl in der Projekt-Aufgabenliste. Globale Inbox
   unverändert.
4. Sichtbarkeit: `task.read`/`task.write`; keine neue Permission.

## Geschlossene Testmatrix
- `F1604-DB-01`: CRUD + Anwenden (Titel, Fälligkeit = heute +
  Offset, Bearbeiter = Anwendender).
- `F1604-DB-02`: Doppel-Name, Titel-/Offset-Grenzen,
  Anwenden archivierter/fremder Vorlage fail-closed.
- `F1604-RBAC-01`: Viewer liest, schreibt nicht; Fremdtenant
  sieht nichts.
- `F16-04-E2E-01`: Vorlage anlegen → im Projekt anwenden →
  Aufgabe mit Fälligkeit sichtbar (lokal beobachtet).

## Bewusst offen
- Termin-/E-Mail-/File-Request-Vorlagen, Vorlagen mit
  Checklisten-/Label-Inhalt, Mehrfach-Bearbeiter aus Vorlage,
  Fremdsystem-Feeds.
