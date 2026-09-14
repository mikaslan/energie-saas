# F16-04c Ausgeschiedene Bearbeiter sichtbar (Katalog F16.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (DB F1604C 4/4, Nachbar-DB F1604B 4/4, E2E F16-04C-E2E-01 1/1, Nachbar-E2E F16-04 4/4, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F16-04b (dort als „Anzeige ausgeschiedener Bearbeiter
in der Vorlage (stille Filterung)" bewusst offen). Ausgeschiedene
Bearbeiter entfallen nicht mehr still: Das DTO weist sie separat aus,
das Edit-Formular zeigt sie, und Speichern erhält sie statt sie still zu
purgen. Kein Reonic-Referenzbeleg; reversible eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Contract (`taskTemplateDtoSchema`): neues Feld
  `departedAssigneeMembershipIds` (UUIDs, Cap wie live). `assignees`
  bleibt live-only mit Label; Ausgeschiedene stehen separat ohne Label
  (kein PII-Lookup an Nicht-Mitglieder — nur die bereits gespeicherte ID
  wird sichtbar gezählt).
- Service (`toDto`): `resolveAssigneeOptions` liefert `{ live,
  departedIds }` in Vorlagen-Reihenfolge; Anwenden (`applyTaskTemplate`)
  unverändert (überspringt Ausgeschiedene, Fallback Anwender).
- Service (`updateTaskTemplate`): Werterhalt statt Purgen — Lebende
  strikt validiert (gleiche Prädikate, extrahiert nach
  `selectLiveAssigneeIds`); der Rest muss bereits gespeicherte
  Ausgeschiedene sein, sonst Validation (kein Einschleusen fremder IDs
  über Update). Bewusstes Leeren (nur Lebende schicken) bleibt möglich —
  ehrliches Löschen statt stillem Purgen. Update auf fehlende Vorlage
  weiter NotFound.
- Action: `parseFields` parst zweite Hidden-JSON-Liste
  (`departedAssigneeMembershipIds`, gleiche Form/UUID-Prüfung); Union mit
  Cap-Prüfung geht an den Service — Create verweigert Ausgeschiedene
  (nicht live), Update erhält nur gespeicherte (Service-Guard).
- UI (`AssigneePicker`): Zähler-Hinweis („N ausgeschiedene Bearbeiter —
  beim Anwenden übersprungen, bleiben gespeichert.", Testid
  `template-departed-notice`) + Hidden-JSON zum Werterhalt.
- Keine Migration (Spalte besteht), keine neue Permission (`task.write`
  wie bisher), kein Provider.

## Geschlossene Testmatrix

- DB (`f1604c`, F1604C-DB-01..04): DTO-Trennung (live mit Label,
  departed als ID ohne Label); Update erhält Ausgeschiedene bei
  Titeländerung; eingeschleuste Fremd-ID → Validation; explizites Leeren
  purgt ehrlich; fehlende Vorlage → NotFound.
- E2E (`F16-04C-E2E-01`, isolierter Workspace): Vorlage mit Zweitmitglied
  per UI, Abgang per DB (Membership-Zeile weg — kein UI-Pfad, nicht
  Testgegenstand), Reload → Hinweis „1 ausgeschiedener Bearbeiter",
  Speichern (Titelwechsel) → Hinweis bleibt, DB-Read-back belegt ID
  weiter gespeichert. Nachbarn F16-04 4/4 grün.

## Bewusst offen

- Vorlagen mit Checklisten-/Label-Inhalt, Fremdsystem-Feeds,
  Bearbeiter-Rollen je Vorlage (F16-04b-Offenpunkte).
