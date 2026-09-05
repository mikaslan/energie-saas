# F1-09 — Projektnotizen @-Mentions (SPEC, Welle 03/04)

- Status: SPEC (Turn 34). RED/IMPLEMENTED folgen nach CI-Stau (Nr. 5).
- Scope: Parsen + Speichern + Auflösen + Rendern + RLS. KEINE
  Benachrichtigung (externer Versand braucht eigene Beauftragung).
- Fundament: `project_note` (0041, `text_markdown`, v1-Check bleibt),
  `modules/notes/service.ts` (Command/CAS), Labels aus
  `user_identity.email` (bereits sichtbar → keine neue Leak-Klasse).

## 1. Ziel

Autoren können Workspace-Mitglieder in Notizen erwähnen
(`@lizenzierte-e-mail`). Erwähnungen sind abfragbar (pro Notiz),
lösen gegen den Workspace-Mitgliederstand auf und rendern als
 stabiler Verweis. Unauflösbare Refs bleiben als Rohtext stehen
 (nie Datenleck durch Raten).

## 2. Vertrag

- Syntax: `@` + E-Mail (RFC-sparsam: `local@domain`, max. 254
  Zeichen, ASCII-Case-insensitiv). Nur außerhalb von Code-Spans
  (Backticks) und URLs. Max. 20 Mentions pro Notiz (DoS-Schranke,
  Validierungsfehler darüber).
- Referenz: `mention.v1` = `{ userIdentityId: uuid, emailLower: string }`.
  Auflösung beim Schreiben gegen `membership JOIN user_identity`
  im selben Workspace (aktive Mitgliedschaft, `deleted_at IS NULL`).
- Speicherung: Seitentabelle `project_note_mention`
  (`workspace_id, note_id, project_id, mentioned_identity_id,
  email_lower, revision`, UNIQUE (workspace_id, note_id,
  mentioned_identity_id)), RLS + FORCE RLS im 0041/0050-Muster,
  `tenant_isolation` über `app.workspace_id`. Markdown behält die
  Roh-Refs (kein Text-Versionswechsel, kein Rewrite).
- Schreibpfad: `create_note`/`update_note_text` extrahieren Mentions
  aus `textMarkdown` (eigener Parser `lib/integrations/notes/
  note-mentions.ts`, rein, DB-frei testbar), speichern ersetzend
  (Diff pro Revision, CAS-geschützt wie der Notiztext).
- Lesepfad: `listProjectNotes` liefert `mentions: mention.v1[]`
  pro Notiz (nur auflösbare; gelöschte/verlassene Mitglieder fallen
  raus, Rohtext bleibt). Externe Mitglieder sehen nur Mentions
  auflösbarer Identitäten mit `note.read` (kein Identitäts-Listing:
  kein Endpoint „alle Mitglieder“ in diesem Slice).
- Events/Audit: `project.note_mentioned` (payload: noteId,
  mentionedIdentityIds[]) zusätzlich zum Text-Event; Audit wie
  bestehend (`note.write`).

## 3. Tests (RED)

- DB-01: Create mit 2 auflösbaren + 1 Phantom-Ref → 2 Mention-
  Zeilen, Rohtext unverändert, Phantom nirgends gespeichert.
- DB-02: Update ersetzt Mention-Menge (Diff), CAS-Konflikt bei
  veralteter Revision (NoteConflictError, keine halben Writes).
- DB-03: Cross-Workspace-Ref (E-Mail aus fremdem Workspace) wird
  NICHT aufgelöst (kein Leak über Workspace-Grenze).
- DB-04: RLS — Fremd-Workspace-Insert in Mention-Tabelle scheitert
  an `with check`; Tenant-Invarianten-Zeile ergänzen.
- DB-05: 21. Mention → NoteValidationError.
- E2E-06 (eigene Spec-Datei): `@`-Ref tippen, speichern, Reload →
  Mention-Chip sichtbar; Phantom-Ref rendert als Text.

## 4. Nicht-Ziele

Benachrichtigungen (E-Mail/Push/In-App), Mention-Autocomplete-
Endpoint, Mentions in anderen Textfeldern (Checklisten, Angebote),
Migration bestehender Notizen (keine Refs → keine Zeilen).
