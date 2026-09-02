# ADR 0019: Projektnotizen — konkreter Projekt-Parent, `{plain, markdown}`-Text und Pinning ohne Einzigartigkeitszwang

- Status: vorgeschlagen (zu SPECIFIED-Entscheidung von M1-13)
- Datum: 2026-09-02
- Bezug: `docs/spec/M1-13-projektnotizen.md`

## Kontext

M1-13 (F1.9) führt Notizen an der Projektakte ein. Die öffentliche
Reonic-OpenAPI `3.11.0` ist die funktionale Referenz und dokumentiert vier
Notes-Operationen (`GET /notes`, `GET /notes/{noteId}`, `POST /notes/create`,
`POST /notes/{noteId}/update`) mit dem `Note`-Schema (9 Felder). Drei
Modellierungsfragen sind durch die Spec **nicht** vorentschieden und müssen
bewusst getroffen werden, weil sie den Datenbankvertrag prägen:

1. **Parent-Modellierung**: `Note.parent` ist polymorph (`{ id, type }`) mit
   `type ∈ { contact, residentialProject, commercialProject, checklistItem,
   task, photogrammetryJob }`. M1-13 unterstützt nur Projekteltern.
2. **Textrepräsentation**: `Note.text` ist `{ plain, markdown }` (beide
   required). Das vorhandene WMEE-Tiptap-Setup speichert bisher
   `task-rich-text.v1` als JSON (`project_task.body`), **kein** Markdown.
3. **Pinning**: Die Spec kennt nur `pinned: boolean` (Create) bzw.
   `{ pinned }` (Update) und repräsentiert Pinning im Response als
   `pinnedAt/pinnedById`. Es gibt weder einen „genau eine gepinnte Notiz“-
   Constraint noch einen Pinning-Filter/-Sortierwert.

## Optionen

**Parent**
1. Voll polymorph (`parent_type` + `parent_id` ohne FK) — flexibel, aber
   RLS-/Erasure-/Referenzintegrität schwächer, für genau einen Parent-Typ
   überdimensioniert.
2. Konkret `project_id` (composite FK) + `parent_type` (CHECK `'project'`) —
   typisiert, referenziell gesichert; andere Parent-Typen additiv ergänzbar.
3. Generische M:N-Zuordnung — unnötig; eine Notiz hat genau einen Parent.

**Text**
1. `{ plain, markdown }` als `text_markdown` (kanonisch) + `text_plain`
   (serverseitig abgeleitet) — Paritäts-Form der Reonic-`Note.text`;
   Tiptap-Editor erzeugt Markdown über einen Serializer.
2. Tiptap-JSON (`task-rich-text.v1`) wiederverwenden und `plain/markdown` bei
   Bedarf on-the-fly ableiten — konsistent mit Tasks, aber DTO-Form weicht von
   Reonic ab.
3. Nur Markdown, `plain` nicht speichern (je Read ableiten) — spart eine
   Spalte, aber jeder Read re-deriviert; DTO muss trotzdem beide liefern.

**Pinning**
1. Einzigartig je Parent (partial unique index auf `pinned_at IS NOT NULL`) —
   „genau eine gepinnte Notiz“, aber die Spec kennt weder diese Regel noch
   einen Fehler-/Ersetzungsfall.
2. Mehrere gepinnt erlaubt, `pinned_at/pinned_by` nur setzen/löschen —
   Spec-treu, kein erfundener Constraint.

## Entscheidung

1. **Parent — konkret** (Option 2): `project_id` als zusammengesetzter
   Tenant-FK zu `project(workspace_id, id)` plus `parent_type` mit CHECK
   `'project'`. Andere Parent-Typen bleiben Nichtziel und können später
   additiv (eigene Migration/ADR) ergänzt werden, ohne den M1-13-Vertrag zu
   brechen.
2. **Text — `{ plain, markdown }`** (Option 1): gespeichert werden
   `text_markdown` (kanonisch, vom Tiptap-Editor über einen Markdown-Serializer
   erzeugt) und `text_plain` (serverseitig aus dem validierten Markdown
   abgeleitet, nie Client-Feld), versioniert über `text_version = 'note-text.v1'`.
   Reonys interner Marker `<!-- MDCV_2 -->` wird **nicht** übernommen
   (Clean-Room: fremdes Formatdetail).
3. **Pinning — mehrere erlaubt** (Option 2): `pinned_at/pinned_by` werden pro
   Notiz gesetzt/genullt; **kein** Einzigartigkeitsindex. Die Liste sortiert
   gepinnte Notizen zuerst (`pinned_at DESC NULLS LAST, created_at DESC`).

Ergänzend (keine eigene Option, aber bewusste Abweichung): **Text-Edit und
Delete** sind in der REST v3 **nicht** dokumentiert (`/notes/{noteId}/update`
ist ausschließlich Pin/Unpin; es gibt keinen Delete-Endpunkt). Sie werden als
`DECIDED WMEE` aufgenommen, weil das `Note`-Schema `editedAt/editedById` trägt
(Edit-Konzept existiert, ist nur nicht REST-exponiert) und eine
unveränderbare/unlöschbare Notiz operationell unhaltbar ist. Delete ist ein
Soft-Delete (`deleted_at`), da Reonic weder Delete noch `deletedAt` kennt.

## Konsequenzen

- **Positiv**: referenziell gesicherter Parent, RLS-Tenant-Anker wie bei
  `project_task`; DTO-Form liegt nahe an Reonic `Note.text`; kein erfundener
  Pinning-Constraint; Clean-Room bleibt gewahrt (kein `MDCV_2`).
- **Negativ**: ein Markdown-Serializer für Tiptap ist neu (bisher nur
  `task-rich-text.v1`-JSON) → neue, vom Root-Integrator freizugebende
  Abhängigkeit oder schmaler Eigen-Serializer (offene Frage O5). Edit/Delete
  sind nicht parity-verifizierbar und müssen als `ACCEPTED_EXCEPTION`
  geführt werden. `text_plain` verdoppelt die Inhaltsspeicherung und muss
  strikt serverseitig abgeleitet bleiben, sonst driftet die Form.
- **Neutral**: `parent_type` ist redundant-schmal (konstant `'project'`), hält
  aber das Reonic-`parent.type`-Konzept sichtbar und den späteren Polymorphie-
  Ausbau migrationsarm.
