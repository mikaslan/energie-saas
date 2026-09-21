# F1-26 Team-Mentions in Notizen (`@team:slug`)

Lane `codex/muse-fleet-6e-f1crm` (Agent 6E). Migration **0321** (Range 0321-0329, Nr. 1).
F1-12-Nahtstelle: Notizen × Teams. Providerfrei.

## DISCOVERED (W1-D2, Code-verifiziert)

- Mentions sind User-only (`@email` → `project_note_mention.mentioned_identity_id`,
  Auflösung Membership×user_identity, `notes/service.ts:150-204`).
- Teams haben `name_normalized` (eindeutig je Workspace, 0114) — als Mention-Slug
  nutzbar, keine neue Spalte nötig.
- Stille Expansion (Team → Member-Zeilen) verworfen: Cap-Bombe bei großen Teams,
  Team-Wechsel-Inkonsistenz → eigene Tabelle + dynamische Auflösung.

## SPECIFIED

- Syntax: `@team:<slug>` (Slug = `name_normalized`, Lowercase-Letters/Digits/`-`,
  Muster in `note-mentions.ts`, rein + DB-frei, Cap: Team-Refs zählen wie User-Refs
  gegen 20).
- NEU `project_note_team_mention` (0321): workspace_id, project_id, note_id,
  team_id, revision; UNIQUE(ws,note,team); FK note CASCADE / team RESTRICT
  (F1-20-Muster); RLS tenant_isolation + FORCE, keine Grants (Rollenvertrag:
  ACL-Menge + GRANT + Policy-Pin, live ernten).
- Auflösung beim Speichern: nur AKTIVE Teams eigener Workspace (archiviert/
  fremd/unbekannt → ignoriert wie unbekannte User, kein Throw, kein Orakel).
- Lesepfade: `listMentionedNotes` (F1-25) erweitert — Notizen, deren Teams mich
  als Mitglied enthalten (team_member aktiv), UNION mit direkten Mentions,
  Dedupe je Notiz (direkt gewinnt), gleiche Sichtbarkeits-Regel; Notiz-Detail
  zeigt Team-Chips (Name, Archiv-Status lesbar).
- Events: Team-Mention löst KEIN neues Event (kein Spam); `note_mentioned`-Feed
  (F1-24) bleibt User-bezogen (keine Fan-Out-Projektion).
- Keine neuen Permissions (note.read/write wie bisher).

## CONTRACTED

- NEU (max): `drizzle/0321_f1_26_note_team_mention.sql` (+ Journal/Snapshot),
  `lib/db/schema/project-note-team-mention.ts`, `tests/db/f126-note-team-mentions.test.ts`,
  `tests/e2e/f1-26-team-mentions.spec.ts`, diese Spec.
- EDIT (max): `note-mentions.ts` (Pattern), `notes/service.ts` (Schreib+Lesepfad),
  `notes/index.ts` (+ Contract-Schemas additiv), Notiz-UI (Team-Chips),
  Dashboard-Sektion (F1-25 nutzt erweiterten Pfad), `db-role-contract.mts`,
  `tenant-fixtures.ts` (Factory), m111a-Pins, STATUS.
- Tests: DB (Team-Mention speichert Zeile, Archiv/Fremd ignoriert, Mitglied sieht
  Notiz in Meine-Erwähnungen, Ex-Mitglied nicht mehr, Dedupe direkt+Team, Cap,
  Tenant-Trennung, RESTRICT); E2E F1-26-E2E-01 (`@team:slug` schreiben → Mitglied
  sieht Dashboard-Zeile → Chip an Notiz).
- Nachbarn: f109, f125, f124, f1012, tenant-invariants, db:roles:verify.
- NICHT: Benachrichtigung (F1-09-Nicht-Ziel), Versand (Provider — VERBOTEN).
