# F1-05a Spaltenverwaltung (frei definierbare Spalten, Katalog F1.5)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F1.5 verlangt frei definierbare Spalten, Spalten-Typen,
Conversion-Ratio und Automatik. Dieser Slice liefert die Verwaltung:
anlegen (Typ frei wählbar), umbenennen, verschieben, archivieren/
wiederherstellen — auf dem Anfrage-Board je Bereich. Das Modell
(`column_type` lead/offer/won/lost, Farben, Intake-Flag) existierte,
Mutationen fehlten. Offen bleiben: Conversion-Ratio (eigene Migration),
Automatik je Typ (z. B. Angebotsnummern-Vergabe), Admin-Rollen-Feinschliff.

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F1.5.
- Keine neue Permission (`project.write`, Muster Karten-Verschiebung).

## Datenmodell (Migration 0099, additiv)

Keine Schemaänderung. `GRANT SELECT, INSERT, UPDATE ON kanban_column
TO app_runtime` (kein DELETE: Archiv statt Löschen, Muster 0041) +
Pin-Zeilen im Rollenvertrag. Befund dabei: Das Vertragsskript
`applyRoleContract` vergibt ACLs selbst (Migration allein erreicht die
Provisioning-Flows nicht) — Kanban-Block dort ergänzt, Board bleibt
Read-only.

## Validierung (fail-closed)

- Name 1–120 Zeichen; unbekannter Typ/Farbe → Validation.
- Intake-Spalte: kein Archiv (genau-ein Intake-Pfad der Anfrage-Lane).
- Belegte Spalte: kein Archiv (Conflict mit Kartenzahl).
- Verschieben an der Kante: `changed: false` (kein Fehler).
- Restore bei belegter Position: ans Ende ausweichen.
- Unbekannte IDs → Conflict; Viewer → denied.

## Anzeige

Anfragen-Seite (Editoren): „Spalten verwalten" mit Zeilen je Spalte
(Typ-/Farb-/Eingangs-Badges, Kartenzahl), Umbenennen, ←/→,
Archivieren/Wiederherstellen, Anlageformular (Name, Typ, Farbe).

## Akzeptanz

- DB: Roundtrip + Guards + Restore-Kollision + Validierung/NotFound/
  Viewer (3/3).
- E2E: anlegen → Header sichtbar; umbenennen → neuer Header;
  archivieren → Header weg; Eingang ohne Archiv-Button (1/1).
- Gates: tests grün, typecheck/lint/depcruise grün, Rollenvertrag in
  beiden Provisioning-Flows verifiziert.
