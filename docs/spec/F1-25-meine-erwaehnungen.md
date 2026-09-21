# F1-25 „Meine Erwähnungen" (In-App-Einstieg ohne Benachrichtigung)

Lane `codex/muse-fleet-6e-f1crm` (Agent 6E). KEINE Migration (erwartet).
Providerfrei: Leseliste über bestehende `project_note_mention`-Zeilen.

## DISCOVERED (W1-D1/D2, Code-verifiziert)

- Mentions sind User-only (`project_note_mention.mentioned_identity_id`,
  F1-09); es gibt KEINE Stelle, die „wo wurde ich erwähnt?" beantwortet
  (kein Filter, kein Widget, kein `mentioned_identity_id`-Lesepfad außer
  Notiz-Detail).
- F1-06b-Muster: Dashboard-Widget (Limit, fälligste zuerst) — Vorlage für
  Einstiegspunkt.

## SPECIFIED

- NEU `listMentionedNotes(tx, ctx, { limit })`: Notizen mit Mention auf die
  eigene Identity, workspace-weit, neueste zuerst, Limit (Default 5, max 20,
  F1-06b-Muster); je Zeile: Projekt (id+Name), Notiz (id, Kurztext 120 Zeichen,
  created_at), Link-Ziel Projekt+Notiz-Anker.
- Sichtbarkeit: nur Projekte mit `note.read` + `lockReadableProject`
  (identische Regel wie `listProjectNotes`); Mention ohne Projekt-Sicht
  entfällt lautlos (kein Leak über Titel/Existenz). External: was
  `lockReadableProject` hergibt (idR. nichts ohne Zuweisung — ehrlich leer).
- UI: Dashboard-Sektion „Meine Erwähnungen" (F1-06b-Platzierung): Liste mit
  Projekt-Link; Leerzustand ehrlich („Keine Erwähnungen"); ohne JS lesbar
  (Server-Render wie F1-06b).
- Keine neuen Permissions, keine Migration, KEINE Benachrichtigung
  (F1-09-Nicht-Ziel bleibt).

## CONTRACTED

- EDIT (max): `modules/notes/service.ts` (Lesepfad) + `index.ts` (Export),
  Dashboard-Seite (Sektion), `docs/parity/STATUS.md` (F1-Zeile bei CLOSE).
- NEU (max): `tests/db/f125-my-mentions.test.ts`,
  `tests/e2e/f1-25-meine-erwaehnungen.spec.ts`, diese Spec.
- Tests: DB (eigene Mention gefunden, fremde nicht, Projekt ohne Recht
  entfällt, Tenant-Trennung, Limit/Cap, External ehrlich leer);
  E2E F1-25-E2E-01 (Mention schreiben → Dashboard zeigt Zeile mit Link →
  Link führt zu Notiz; keine Browser-Fehler).
- Nachbarn: f109, f106b, f1012 (Membership-Rollen).
- NICHT: Mail/Push, Team-Mentions (eigener Slice), Versand (Provider — VERBOTEN).
