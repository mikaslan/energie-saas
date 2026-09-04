# F9.4 Slice B — Versionshistorie bei Zeiteintrag-Edits

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F9.1 (CRUD), F9.2 (Stoppuhr), F9.3 (Filter), F9.4-A (Export).
Katalog: F9.3-Rest „Versionshistorie bei Edits" (Modulkatalog M9).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: Revisions-DTO + List-Query im Zeitvertrag.
- database-migrations: neue Tabelle per Migration (Nummer GLOBAL prüfen:
  `ls drizzle | sort`, `git fetch origin`, Parallel-Lanes — Lern-Register
  §2.1); RLS + Grants + Rollenvertrag-Pins (§2.2/§2.3); Zähler komplett
  (§2.4: Journal-idx + TOTAL_MIGRATION_COUNT).
- Lern-Register §2.6: immutable Snapshot-Tabelle nur `created_at`, kein
  `updated_at` (Muster `offer_variant_revision`).

## Scope
1. Migration `0057_f9_04_time_entry_revisions` (Nummer vor Anlage gegen
   alle Lanes verifizieren): `time_entry_revision` mit
   `(id, workspace_id, entry_id, user_id, project_id, type_id,
   start_at, end_at, working_time_minutes, break_duration_minutes,
   comment, revised_by, revised_at, created_at)` — Vollbild des
   Vor-Update-Stands, immutable (kein Update-/Delete-Pfad, kein
   `updated_at`). RLS FORCE + Policies (`time.read` lesend für interne
   Rollen, kein externer Zugriff), Grants für App-Rollen,
   Rollenvertrag-Pins nachziehen.
2. Service: `upsertTimeEntry` (Modus `update`) schreibt VOR dem UPDATE in
   derselben Transaktion die Revision (Vorher-Bild + `revised_by` =
   Actor). Erster Edit → 1 Revision; Edits ohne Feldänderung schreiben
   trotzdem (DECIDED: kein Diff-Vergleich — jeder Speichervorgang ist
   ein belegter Vorgang, kein stilles Überspringen).
3. Contract: `timeEntryRevisionDtoSchema` + `timeEntryRevisionListDto`
   (Einträge absteigend nach `revised_at`), Query `{ entryId }`.
4. Service-Read: `listTimeEntryRevisions(tx, ctx, entryId)` mit
   `requireRead` (Viewer sieht Verlauf, Externe nicht — gleiche Schranke
   wie Einträge; Eintrag muss im Workspace/Projekt liegen, sonst
   `not_found`).
5. UI: pro Eintrag Aufklapp-Bereich „Verlauf (n)" (n = Revisionszahl,
   `0` wird nicht angezeigt — kein toter Link); Liste mit altem Stand
   (Datum/Zeiten/Minuten/Typ/Kommentar) + „geändert von … am …".
   Berlin-Zeiten wie Export.
6. Tests: (a) Vitest-DB: Revision mit Vorher-Bild nach Update (alle
   Felder), keine Revision bei Create, zweiter Edit → 2 Revisionen,
   Fremdprojekt/`not_found`, Viewer lesen ok / Extern denied,
   m111a-Zähler + Rollenvertrag grün; (b) E2E (eigenes f94b-Projekt):
   Eintrag per UI, per UI „Bearbeiten" ändern, Verlauf aufklappen,
   alter Kommentar sichtbar.

## Nicht-Ziele
- Kein Wiederherstellen („auf Revision zurücksetzen") — eigener Slice.
- Kein Diff-Rendering (alt vs. neu farbig) — Liste genügt.
- Keine Archivierungs-Historie (Archiv bleibt Endzustand ohne Revision).
- Keine Änderung an Create-/Filter-/Export-Pfaden.
- Kein Löschen von Revisionen (unveränderlich, Erasure nur per
  DSGVO-Vertrag außerhalb dieses Slices).

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  beide Reviews (Exit-3: Selbstreview + Gates).
- Update ohne Änderung schreibt trotzdem genau eine Revision.
- Unbefugte sehen weder Einträge noch Verlauf (gleiche Schranke).
