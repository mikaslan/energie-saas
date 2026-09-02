# M1-13 — Projektnotizen (F1.9 Notizen)

- Status: **DISCOVERED → SPECIFIED** · noch nicht CONTRACTED/RED/IMPLEMENTED
- Datum: 2026-09-02
- F-Bezug: **F1.9** (Notizen) — PARTIAL (nur `parentType = project`)
- Architektur: ADR 0019
- Basis-Branch: `01b52e9` (M1-12a „Globale Aufgaben-Inbox“, HEAD `codex/m1-12a-global-task-inbox`)
- Geplante Migration: **`0041_m1_13_project_notes.sql`** (nächste freie Nummer nach `0039_m1_11a_project_outcome.sql` am Basis-Branch; `0040` ist durch M1-11b reserviert, siehe §0.1)
- Ziel: keine — dieser Slice ist reine Spezifikation (Branch `tooling`, nur Doku).

## 0. Quellenlegende

| Kürzel | Quelle | Rolle |
|---|---|---|
| `AMAP:N` | `docs/parity/REONIC-API-CAPABILITY-MAP.md`, Zeile N | F1.9-Operationen (Z. 214–223) + Schemablock „Notes & Tasks“ (Z. 536–540) |
| `OAS` | `/tmp/reonic-openapi.json` (öffentliche OpenAPI `3.11.0`, neu geladen per `curl -sL https://api.reonic.de/rest/v3/openapi`) | maschinenprüfbare Extraktion der Notes-Pfade/Schemas/enums/„Allowed API keys“ |
| `M111B` | `docs/spec/M1-11b-cannot-fulfil.md` | Struktur-Vorlage (Capability-/Abnahme-Matrix, Testmatrix, Gates) |
| `M112A` | `docs/spec/M1-12a-globale-aufgaben-inbox.md` (Basis-Worktree) | Struktur-Vorlage (Vertrag/DTI-Minimierung/Unknowns) |
| `M110` | `lib/db/schema/project-task.ts` (Basis-Worktree `01b52e9`) | Drizzle-Tabellen-/Constraint-/Index-Muster |
| `M110SVC` | `modules/tasks/service.ts` (Basis-Worktree) | Service-/Contract-/Lock-/RLS-Muster |
| `ADR 0003/0018` | `docs/adr/` | Rollentrennung, Outbox-/Transaktionsmuster |

> **Evidenz-Klassifikation (Goal-Prompt §7):** `OBSERVED` (rechtmäßig beobachtet),
> `DOCUMENTED` (öffentliche Spec/Doku), `INFERRED`, `DECIDED` (bewusste
> Eigenentscheidung), `UNKNOWN`, `CONFLICTING`. **Es wurde kein API-Call mit
> Key ausgeführt** — nur die öffentliche OpenAPI-Spec geparst; keine Reonic-
> Texte, Assets oder Werte werden als Produktinhalt übernommen.

### 0.1 Migrationsnummern-Kette am Basis-Branch `01b52e9`

`… → 0036_m1_08b_catalog_import → 0037_m1_09_project_assignment →
0038_m1_10_project_task → 0039_m1_11a_project_outcome` (letzte am Basis-Branch).
M1-11b (gleiche Basis `01b52e9`) hat in seiner Spec `0040` als „geplante
Migration“ festgeschrieben [M111B Kopf]. M1-13 läuft als **Schwester-Slice** zu
M1-11b und nimmt daher **`0041`**. (Falls der Root-Integrator M1-13 *vor*
M1-11b integriert, wäre `0040` formal frei; `0041` bleibt die kollisionssichere
Wahl — siehe offene Frage O1.)

---

## 1. Nutzerergebnis (JTBD)

Ein interner **Editor oder Admin** hält an der **Projektakte** frei formatierte
Notizen fest (Rich-Text über das vorhandene Tiptap-Setup). Er kann Notizen
**erstellen**, den **Text nachbearbeiten**, Notizen **pinnen/entpinnen**
(Herausheben an den Anfang der Liste) und **löschen**. Interne **Viewer** lesen
die Notizen read-only. External-/Worker-/Fremdtenant-Akteure bleiben
fail-closed. Jede Änderung erzeugt in **derselben Transaktion** ein
Activity-Event **und** eine `audit_log`-Zeile.

M1-13 erzeugt **keinen** neuen, von der Projektakte getrennten Notiz-Bereich:
Es gibt weder eine globale Notizsuche noch eine eigene `/notizen`-Route. Alle
Mutationen erfolgen ausschließlich in der Projektakte.

## 2. Öffentliche Clean-Room-Evidenz (DOCUMENTED)

Die öffentliche OpenAPI `3.11.0` dokumentiert für den Tag **Notes** genau
**4 Operationen** — und **keine** davon ist ein Löschen oder ein Text-Edit:

| Methode + Pfad | Mut. | Request | Response | „Allowed API keys“ |
|---|---|---|---|---|
| `GET /notes` | — | Query: `parentType` (enum), `parentId` (uuid), `createdById` (uuid), `sort` (default `-createdAt`; sortierbar `createdAt`, `createdById`, `editedAt`), `page` (≥1, Default 1), `itemsPerPage` (1–200, Default 50), Header `Reonic-Cache-Control` | 200 `{ data: Note[], pagination }` | Read-only, Read and Write |
| `GET /notes/{noteId}` | — | Pfad `noteId` (uuid), Header `Reonic-Cache-Control` | 200 `{ data: Note }` | Read-only, Read and Write |
| `POST /notes/create` | create | Body `{ parent: { id: uuid, type: enum }, text: string (1–10000, „Supports markdown formatting“), pinned: boolean (default false) }`; required `parent`, `text` | 201 `Note` | **Read and Write, Lead creation only** |
| `POST /notes/{noteId}/update` | update | Body `{ pinned: boolean }`; required `pinned` — Summary „Update note“, Beschreibung „**Pin or unpin a note**“ | 200 `{ data: Note }` | Read and Write |

**Entscheidende Befunde (OAS):**

1. **Es gibt keinen** `POST /notes/{noteId}/delete`. Notizen sind über die
   REST v3 **nicht löschbar**.
2. **`/notes/{noteId}/update` ist ausschließlich Pin/Unpin.** Es gibt **keinen**
   Endpunkt, der den Notiztext ändert. `editedAt`/`editedById` existieren zwar
   im Schema, werden aber von **keiner** REST-Operation gesetzt.
3. `Note` (alle 9 Felder **required**): `id*` (uuid), `parent*` (`{ id: uuid, type: enum }`),
   `text*` (`{ plain: string, markdown: string }` — **beides** required; das
   Markdown-Beispiel trägt Reonys internen Marker `<!-- MDCV_2 -->`),
   `createdAt*` (date-time), `createdById*` (**uuid \| null**), `editedAt*`
   (date-time \| null), `editedById*` (uuid \| null), `pinnedAt*`
   (date-time \| null), `pinnedById*` (uuid \| null). [AMAP:538, OAS]
4. `parent.type`-**Enum**: `contact`, `residentialProject`, `commercialProject`,
   `checklistItem`, `task`, `photogrammetryJob` (identisch in Query-Filter,
   `parent.type` und `Note.parent.type`). [OAS]
5. **Pinning-Semantik**: Die Spec kennt **nur** den Wahrheitswert `pinned`; im
   Response-Schema wird Pinning als `pinnedAt`/`pinnedById` (Zeitstempel-Paar,
   nullable) repräsentiert. Es gibt **keine** Regel „genau eine gepinnte Notiz
   je Parent“ und **keinen** Pinning-Filter in `GET /notes`. → siehe DECIDED D2.
6. `createdById` ist **nullable** und dennoch required — ein Hinweis auf
   system-/integrationsseitig erzeugte Notizen. Für M1-13 (nur interaktive
   Projektakte) ist `createdById` bei uns stets gesetzt.

**Folgerung für den Scope:** Die vom Auftrag geforderte „Create/Edit/Delete,
Pin/Unpin“-Oberfläche ist **durch die API nur teilweise belegt**: Create und
Pin/Unpin sind `DOCUMENTED`; **Edit (Text) und Delete sind nicht dokumentiert**
und werden daher als `DECIDED WMEE` geführt (siehe D1), nicht als 1:1-Parität
behauptet.

## 3. Autoritativer Vertrag

Wie M1-12a: die einzige maschinenprüfbare Quelle ist der künftige Contract
`lib/integrations/notes/contract.ts` (im IMPLEMENTED-Schritt zu erzeugen).
Prosa beschreibt Semantik, darf die Runtime-Schemas nicht neu definieren.
Vorgesehene Verträge:

- `project-note-command.v1` — Commands `create_note`, `update_note_text`,
  `set_note_pinned`, `delete_note` (siehe §6).
- `project-note-item.v1` — minimiertes Notiz-DTO (§4.3).
- `project-note-page.v1` — Listenprojektion der Projektakte (§4.3).
- `note-text.v1` — Rich-Text-Vertrag `{ plain, markdown }` (§4.2, ADR 0019).

## 4. Datenmodell und Datenbankvertrag (Migration `0041`)

### 4.1 Tabelle `project_note` (Drizzle-Muster nach `project-task.ts` [M110])

| Spalte | Typ | Semantik / Mapping auf Reonic-`Note` |
|---|---|---|
| `id` | uuid PK default gen | `Note.id` |
| `workspace_id` | uuid not null | Tenant-Schlüssel (RLS-Anker, nicht im DTO) |
| `project_id` | uuid not null | `parent.id` (composite FK → `project`) |
| `parent_type` | text not null, default `'project'` | `parent.type` — M1-13 nur `'project'` (CHECK) |
| `text_version` | text not null | eigener Versionierungsanker `'note-text.v1'` (nicht Reonys `MDCV_2`) |
| `text_markdown` | text not null | `Note.text.markdown` (kanonisch, aus Tiptap-Serializer) |
| `text_plain` | text not null | `Note.text.plain` (serverseitig abgeleitet, nie client-seitig) |
| `pinned_at` | timestamptz null | `Note.pinnedAt` |
| `pinned_by` | uuid null | `Note.pinnedById` |
| `revision` | integer not null default 1 | CAS-Anker für Edit/Pin/Delete |
| `created_by` | uuid not null | `Note.createdById` (bei M1-13 stets gesetzt) |
| `edited_by` | uuid null | `Note.editedById` |
| `created_at` | timestamptz not null default now | `Note.createdAt` |
| `edited_at` | timestamptz null | `Note.editedAt` |
| `deleted_at` | timestamptz null | **WMEE**-Soft-Delete (Reonic hat kein Löschen/`deletedAt`) |

Constraints (analog [M110]):

- `unique(workspace_id, id)` — zusammengesetzter Tenant-FK-Anker.
- `foreignKey (workspace_id) → workspace.id`; `foreignKey (workspace_id, project_id) → project(workspace_id, id) ON DELETE CASCADE` (Erasure-Pfad, nicht Nutzer-Delete).
- `check parent_type = 'project'` — M1-13 erlaubt nur Projekteltern.
- `check text_version = 'note-text.v1'`.
- `check` Länge `text_markdown` 1–10000 Zeichen (Reonic `maxLength 10000`) und `text_plain` nicht leer; `pinned_at/pinned_by` paarweise NULL/NOT NULL (`(pinned_at IS NULL) = (pinned_by IS NULL)`); `edited_at/edited_by` paarweise; `deleted_at ≥ created_at`; `revision 1..2147483647`; `isfinite` auf Zeitstempel.
- RLS: `FORCE ROW LEVEL SECURITY` + Tenant-Policy wie `project_task` [M110/M110SVC].

Index:

- `project_note_ws_project_active_idx` auf `(workspace_id, project_id, pinned_at DESC NULLS LAST, created_at DESC, id)` mit `WHERE deleted_at IS NULL` — trägt die Pinning-an-erster-Stelle-Ordnung.
- `project_note_ws_project_deleted_idx` auf `(workspace_id, project_id)` mit `WHERE deleted_at IS NOT NULL` (Archiv-/Wiederherstellung später; M1-13 rendert gelöschte Notizen **nicht**).

### 4.2 Rich-Text-Vertrag `note-text.v1` (ADR 0019)

- Kanonisch gespeichert wird **Markdown** (`text_markdown`), erzeugt vom
  vorhandenen Tiptap-Editor über einen Markdown-Serializer. `text_plain` wird
  **serverseitig** aus dem validierten Markdown abgeleitet (Display/Liste/
  Suche); es ist nie ein Client-Feld.
- Reonys interner Marker `<!-- MDCV_2 -->` wird **nicht** übernommen
  (Clean-Room: fremdes Formatdetail). Stattdessen versioniert `text_version`
  unseren eigenen Vertrag.
- Limits (Übernahme der WMEE-Rich-Text-Obergrenzen aus `task-rich-text.v1`
  [M110SVC], da Reonic nur `maxLength 10000` nennt): Markdown ≤ 10.000 Zeichen,
  serverseitige Block-/Knoten-Tiefenprüfung analog TASK_RICH_TEXT_*.

### 4.3 Minimiertes DTO

`project-note-item.v1` projiziert **nur**: `id`, `revision`, `textPlain`,
`textMarkdown`, `pinned` (abgeleitet aus `pinnedAt ≠ null`), `createdAt`,
`createdByLabel` (Anzeigename/E-Mail des Erstellers), `editedAt`,
`editedByLabel`, `pinnedAt`, `pinnedByLabel`. **Verboten** im Runtime-Schema:
`workspace_id`, `parent_type`-Rohwert, Fremd-IDs/Namen/E-Mails außerhalb der
eigenen Notiz, rohe `domain_events`-/`audit_log`-Daten, Reonys `MDCV_2`-Marker.

## 5. Zustände und Übergänge

Notizen besitzen **keine** fachliche Zustandsmaschine (anders als
`project.outcome` [M111B]). Zwei unabhängige, additive Achsen:

```text
active --delete--> deleted(soft, deleted_at gesetzt)     [terminal, WMEE]
unpinned --pin--> pinned      (pinned_at/pinned_by gesetzt)
pinned   --unpin--> unpinned  (beide genullt)
```

- `deleted` ist terminal; es gibt in M1-13 **kein** Restore.
- Pin/Unpin und Text-Edit sind unabhängig von `deleted`; eine gelöschte Notiz
  wird nie mehr gerendert oder gemutet.
- **DECIDED D2 (Pinning):** mehrere Notizen dürfen gleichzeitig gepinnt sein.
  Es gibt **keinen** „genau eine gepinnte Notiz je Projekt“-Constraint, weil die
  Spec keinerlei Einzigartigkeit oder Fehlerfall dafür dokumentiert. Die Liste
  sortiert gepinnte Notizen zuerst (`pinned_at DESC NULLS LAST, created_at DESC`).

## 6. Commands und Actions

Version `project-note-command.v1`; jede Action reauthentifiziert, allowlistet
Felder, liest Project/Membership serverseitig neu und sperrt zuerst das
Project (Lock-Ordnung wie [M110SVC] `lockProject` → Project `FOR KEY SHARE`,
Erst-/Folgesnapshot gegen Erasure):

- `create_note(projectId, textMarkdown, pinned = false)` → Insert; Revision 1;
  `created_by = actor`; bei `pinned` zusätzlich `pinned_at/pinned_by`;
  serverseitig `text_plain` ableiten.
- `update_note_text(noteId, expectedRevision, textMarkdown)` → CAS auf
  `expectedRevision`; setzt `edited_at = now`, `edited_by = actor`,
  `revision + 1`, leitet `text_plain` neu ab. **[DECIDED WMEE, D1]**
- `set_note_pinned(noteId, expectedRevision, pinned)` → CAS; setzt/löscht
  `pinned_at/pinned_by`. (Ändert **nicht** `edited_*`, da Reonic Pin/Unpin
  getrennt vom Text-Edit modelliert.)
- `delete_note(noteId, expectedRevision)` → CAS; Soft-Delete
  `deleted_at = now`. **[DECIDED WMEE, D1]**

Erwartete Fehler: `invalid`, `not_found`, `conflict` (Revisionskonflikt),
`denied`, `unauthenticated`; unbekannte Fehler bleiben laut [M111A/M111B].
Keine Fehlermeldung verrät Existenz fremder Notizen/Projekte.

## 7. Rollen- und Datenvertrag

Neue Capabilities `note.read` und `note.write` (Muster `task.read`/`task.write`
[M110SVC]):

| Actor | Notizen lesen | erstellen/editieren/pinnen/löschen |
|---|---:|---:|
| interner Viewer | ja | nein |
| interner Editor | ja | ja |
| interner Admin | ja | ja |
| `external_only` | nein | nein |
| Worker/System (ohne Kapsel) | nein | nein |
| revoked / Fremdtenant | nein | nein |

- `note.write` ist `internalOnly`, mindestens Editor (analog `task.write`).
- Viewer, External, Worker und Fremdmandant bleiben in SQL (RLS), Service,
  Action und HTML fail-closed; es entsteht dabei **kein** Event/Audit.
- `createdById`/`editedById`/`pinnedById` sind im M1-13-Pfad stets der aktive
  interne Actor; der nullable `createdById`-Fall der Spec (System/Integration)
  ist Nichtziel.

## 8. Event-, Audit- und Activity-Vertrag

- Jede Mutation schreibt in **derselben Transaktion** ein `domain_events`-
  Event (Activity-Feed) **und** eine `audit_log`-Zeile (erlaubter Zugriff) —
  analog „Activity-Event + audit_log in derselben Transaktion“ (Auftrag).
- Eventtypen (Aggregat `project`, `aggregate_id = project_id`):
  `project.note_created`, `project.note_updated`, `project.note_deleted`,
  `project.note_pinned`, `project.note_unpinned`.
- Der partielle Activity-Index `domain_events_project_activity_idx` [events.ts]
  muss in Migration `0041` **additiv** um die fünf Note-Eventtypen erweitert
  (neu erzeugt) werden.
- Payloads minimal: `noteId`, `projectId`, `revision`; **kein** Freitext,
  **kein** Notiztext, **kein** PII im Payload. Die Projektaktivität rendert ein
  festes deutsches Label (z. B. „Notiz erstellt/pinnt/entfernt“), nie den
  rohen Payload oder Notizinhalt.

## 9. Lock- und Race-Vertrag

- Mutationsordnung: zuerst Project `FOR KEY SHARE`, danach frischer
  Active-Subject-Snapshot (Contact nicht gelöscht) — wie `lockProject`/
  `lockReadableProject` in [M110SVC]; erst dann Notiz-Insert/Update.
- Edit/Pin/Delete tragen `expectedRevision` im WHERE; `0` Zeilen = Conflict.
- **Erasure-Kreuzung:** `project_note` hängt am Projekt und damit am
  Contact-Graphen. `ErasureGraphIds` wird um `noteIds?` erweitert;
  `erase_inactive_lead` wird **quellgepinnt** (SHA-Anker, wie [M111B §5.4])
  erweitert und löscht die Projekt-Notizen desselben Graphen. Eine während der
  Mutation committende Erasure gewinnt; die Notiz-Mutation rollt zurück
  (`FOR KEY SHARE` aufs Project serialisiert gegen den Erasure-Project-Lock).

## 10. UI-Vertrag (Projektakte)

- Neuer Abschnitt „Notizen“ in der Projektakte
  (`app/w/[workspaceId]/anfragen/[projectId]/`, neben `project-tasks-section.tsx`).
  Dateien (künftig): `project-notes-section.tsx`, `note-editor-dialog.tsx`
  (Wiederverwendung des Tiptap-Setups), `note-actions.ts`, Readmodel über
  `modules/notes/`.
- **Kein eigenes Mutationstool außerhalb der Projektakte** (Non-Goal globale
  Suche/eigene Route).
- Viewer sieht Notizen ohne Mutationscontrols (Pin-Toggle/Edit/Delete/„Neu“
  ausgeblendet); External wird abgewiesen.
- Pinning: gepinnte Notizen zuerst; Pin-Indikator ohne Farbsignal-Only
  (Icon + Text). `aria-live="polite"` für Erfolg/Fehler; Touchziele ≥ 44 px;
  kein horizontaler Overflow bei 320/375 px; voller Tastaturpfad für
  Erstellen/Editieren/Pinnen/Löschen (analog M2-01-Capability-Matrix).

## 11. Capability-Sheet (Goal-Prompt §7)

Gemeinsamer Liefervertrag (gilt für alle fünf Capabilities):

- **Modul**: Notes; **Tenant-/Owner-Scope**: Workspace + Project.
- **Zustände/Übergänge/Nebenwirkungen/Notifications/Audit**: siehe §5, §8.
- **Notifications**: keine externe Mail/Push; nur lokale `aria-live`-Ergebnisse.
- **Loading/Empty/Error/Success/Disabled/Denied**: echte getrennte Zustände;
  Empty („Noch keine Notizen“), Disabled (fehlende Rechte/stale Revision),
  Denied (External/Fremdmandant, ohne Existenz-Leak), Error (Projektions-/
  Konfliktfehler an die Error Boundary; Eingabefehler als ehrliches
  `notFound()`/`invalid`).
- **Desktop/Tablet/Mobile**: responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, 44-px-Touchziele. **Offline**: kein Offline-Schreibversprechen.
  **Keyboard**: vollständiger Pfad ohne Drag.
- **Evidence-Quellen**: `OAS` (DOCUMENTED), `AMAP` (DOCUMENTED), `M110`/`M110SVC`
  (DOCUMENTED, hausinterne Konvention). **Confidence**: Create/Pin/List = `DOCUMENTED`;
  Edit/Delete/Pinning-Anzahl = `DECIDED`. **Owner**: Root; UI-/Test-Lanes mit
  unabhängiger Abschlussprüfung. **Implementierungsstatus**: SPECIFIED.
- **Test-IDs** je Capability unter §11 (Testmatrix); Blocker: keine.

| ID | Akteur / JTBD | Trigger / Vorbedingung / Happy Path | Felder / Validierungen | Berechtigung / API-Operation | Paritätsstatus |
|---|---|---|---|---|---|
| `M113-01` Create | Editor/Admin hält Erkenntnis als Notiz fest | Button „Notiz“ in der Projektakte; Project les-/schreibbar, Notiz-Editor offen; Eingabe → Speichern → Notiz erscheint oben (pinned) bzw. chronologisch | `projectId`, `textMarkdown` (1–10000, Rich-Text valid), `pinned` (default false); `text_plain` serverseitig | `note.write`; Vorbild `POST /notes/create` | FUNCTIONAL (DOCUMENTED) |
| `M113-02` Pin/Unpin | Editor/Admin hebt wichtige Notiz hervor | Pin-Toggle an Notiz; Notiz aktiv; Toggle → `pinned_at/pinned_by` gesetzt/genullt, Liste re-sortiert | `noteId`, `expectedRevision`, `pinned` (bool) | `note.write`; Vorbild `POST /notes/{noteId}/update` | FUNCTIONAL (DOCUMENTED) |
| `M113-03` Edit | Editor/Admin korrigiert Notiztext | Edit an Notiz; `expectedRevision`; Editor öffnen → Speichern → `edited_at/by` + Revision+1 | `noteId`, `expectedRevision`, `textMarkdown` (Limits wie Create) | `note.write`; **kein** API-Pendant | **ACCEPTED_EXCEPTION (DECIDED WMEE, D1)** |
| `M113-04` Delete | Editor/Admin entfernt falsche/veraltete Notiz | Delete mit Bestätigung; `expectedRevision`; → Soft-Delete, Notiz verschwindet | `noteId`, `expectedRevision` | `note.write`; **kein** API-Pendant | **ACCEPTED_EXCEPTION (DECIDED WMEE, D1)** |
| `M113-05` Read/List | Viewer/Editor/Admin lesen Notizen der Akte | Projektakte öffnen; `parentType=project`, `parentId=projectId`; Liste mit Pinning-Reihenfolge | `projectId`, Cursor (nur falls paginiert) | `note.read`; Vorbild `GET /notes` (Filter `parentType`, `parentId`, `sort`) | FUNCTIONAL (DOCUMENTED) |

## 12. Testmatrix

| Schicht | Fälle |
|---|---|
| Unit (Contract/Service) | `project-note-command.v1`-Parsing (jedes Feld, Limits, `text_plain`-Ableitung, Revisions-CAS), `project-note-item.v1`-Minimierung (verbotene Felder scheitern), Fehlercodes |
| Contract | `note-text.v1` Validierung (Markdown ≤ 10000, Block-/Tiefen-Grenzen), DTO-Schema-Hash gepinnt |
| DB | Create/Pin/Unpin/Edit/Delete gegen echtes PostgreSQL; `pinned_at/pinned_by`-Paarung; `parent_type`-CHECK; Soft-Delete-Terminalität; Activity-Index deckt Note-Eventtypen |
| RLS | Viewer read-only; Editor/Admin schreiben; External/Worker/Fremdtenant/revoked fail-closed (auch ohne Event/Audit-Seite) |
| Race | Revisionskonflikt (stale `expectedRevision`); zwei parallele Pins; parallel laufende Erasure gewinnt (Note-Mutation rollt zurück) |
| Erasure | `erase_inactive_lead` löscht Projekt-Notizen desselben Graphen; `ErasureGraphIds.noteIds` korrekt; Tombstone-Hash stabil |
| Chromium E2E | Editor erstellt/pinnt/editiert/löscht; Viewer read-only; External abgewiesen; Axe + Tastatur + 375 px (4/4-Muster [M111B]) |
| A11y | `aria-live`, Icon+Text (kein Farbsignal-Only), 44-px-Touchziele, Tastatur-Erstellen/Edit/Pin/Delete |

## 13. Abschlussgates

- `npm run check` (Vitest, alle Dateien grün), Rollenproben 88/88, PG18-Proben
  5/5, Fresh-Migration `0041` (inkl. quellgepinnter Erasure-Erweiterung),
  `db:generate` ohne Drift, TypeScript/ESLint/Dependency-Cruiser,
  `git diff --check`, Secret-Scan, Production-Build.
- Unabhängiger Review (Security/Race/Privacy) vor VERIFIED; keine offenen
  P0–P2. Visual-/Menschen-Gates bleiben INCONCLUSIVE bis Freigabe.

## 14. Nichtziele (Non-Goals)

- Notizen an **Kontakten** (`parentType=contact`) und alle übrigen
  `parent.type`-Werte (`commercialProject`, `checklistItem`, `task`,
  `photogrammetryJob`) — späterer Slice.
- **Mentions** (@-Erwähnungen), **Kommentare** an Notizen, **Anhänge**.
- **Globale Notizsuche** / eigene `/notizen`-Route / eigenes Mutationstool
  außerhalb der Projektakte.
- **Restore** gelöschter Notizen; Export/PDF; Benachrichtigungen (Mail/Push);
  Offline-Schreiben; Mobile-App-/Portal-Sicht.
- Reonys `MDCV_2`-Marker und sonstige private Reonic-Formatdetails.

## 15. Bewusste Entscheidungen (DECIDED) und UNKNOWNs

### DECIDED

- **D1 — Edit (Text) und Delete sind `DECIDED WMEE`.** Die REST v3 dokumentiert
  weder Text-Edit noch Delete. Sie bleiben dennoch im Slice, weil (a) der
  Auftrag sie fordert, (b) das `Note`-Schema selbst `editedAt/editedById`
  trägt (Beleg, dass Editieren konzeptionell existiert, nur nicht REST-exponiert
  ist) und (c) eine unveränderbare, unlöschbare Notiz für eine B2B-SaaS
  operationell unhaltbar ist (Tippfehler, versehentliche Notiz). Beides wird
  **nicht** als Reonic-1:1-Parität behauptet.
- **D2 — Pinning erlaubt mehrere gepinnte Notizen je Projekt.** Die Spec kennt
  nur einen booleschen `pinned`-Wert ohne Einzigartigkeits- oder Fehlerregel;
  ein „genau eine“-Constraint wäre erfunden. Repräsentation als
  `pinned_at/pinned_by`-Paar; Liste pinnt zuerst.
- **D3 — Notiztext wird als `{ plain, markdown }` gespeichert** (Paritäts-Form
  der Reonic-`Note.text`), erzeugt vom vorhandenen Tiptap-Setup über einen
  Markdown-Serializer; `plain` serverseitig abgeleitet. Kein neuer Editor, kein
  `MDCV_2`-Marker (ADR 0019).
- **D4 — Polymorpher Parent wird für M1-13 konkretisiert:** `project_id`
  (composite FK) + `parent_type` (CHECK `'project'`). Voll polymorph ohne FK
  würde RLS und Erasure unnötig verkomplizieren; andere Parent-Typen sind
  Nichtziel und können später additiv ergänzt werden (ADR 0019).
- **D5 — Migrationsnummer `0041`** (Basis `01b52e9` endet bei `0039`; `0040`
  ist durch M1-11b reserviert).

### UNKNOWN

- U1: exaktes Lösch-/Edit-Verhalten der Reonic-**UI** (nicht API) — nicht
  belegbar ohne private Sicht; deshalb D1 als `DECIDED`, nicht `INFERRED`.
- U2: Bedeutung des `MDCV_2`-Markers und des nullable `createdById` — bewusst
  nicht übernommen/repliziert.
- U3: ob Reonic gepinnte Notizen in einer definierten Ordnung liefert — `sort`
  nennt `createdAt/createdById/editedAt`, **nicht** `pinnedAt`; unsere
  Pinning-Ordnung ist daher `DECIDED WMEE`.
- U4: exakte Paging-/Rendering-Grenzen der Notizliste in der Reonic-UI.

## 16. Offene Fragen an den Root-Integrator

1. **O1 (Migrationsnummer):** M1-13 als Schwester zu M1-11b auf `01b52e9` →
   `0041` bestätigen — oder M1-13 vor M1-11b integrieren und dann `0040`?
2. **O2 (Scope Edit/Delete):** D1 bestätigen — Edit/Delete als `DECIDED WMEE`
   in M1-13 behalten, oder strikt API-treu nur Create + Pin/Unpin liefern und
   Edit/Delete als Non-Goal verschieben?
3. **O3 (Event/Audit-Mechanik):** M1-11b erzeugt Event+Audit aus einem
   DB-Trigger; M1-13 spezifiziert Service-Level (`emitEvent`+`writeAudit` in
   derselben Tx). Einheitlichen Mechanismus bestätigen (Service vs. Trigger).
4. **O4 (Erasure-Erweiterung):** `ErasureGraphIds.noteIds` + quellgepinnte
   `erase_inactive_lead`-Erweiterung — exakten Erasure-Graph-Vertrag (welche
   weiteren Slice-Anker) bestätigen.
5. **O5 (Tiptap-Markdown-Serializer):** vorhandenes Tiptap-Setup liefert
   `task-rich-text.v1` (JSON), **kein** Markdown-Serializer. Neue Abhängigkeit
   (z. B. `tiptap-markdown`) oder eigener schmaler Serializer — Lizenz-/Dep-
   Freigabe durch den Root-Integrator?

## 17. Root-Entscheidungen (2026-09-02)

- **O1 → bestätigt:** M1-13 bleibt Schwester-Slice auf `01b52e9` mit
  Migration `0041_m1_13_project_notes.sql`; `0040` bleibt für M1-11b
  reserviert. Integration beider Slices danach in einem Integrations-Branch
  (Reihenfolge 0040 → 0041).
- **O2 → D1 bestätigt:** Edit (Text) und Delete bleiben als `DECIDED WMEE` in
  M1-13, geführt als `ACCEPTED_EXCEPTION` (keine 1:1-Behauptung). Begründung:
  das API-Schema trägt `editedAt`/`editedById`, also existiert Editieren
  konzeptionell; ein unlöschbares Notiz-Objekt wäre operativ unhaltbar.
- **O3 → Service-Level bestätigt:** M1-13 emittiert `domain_events` und
  schreibt `audit_log` im Service in derselben Transaktion (Muster M1-10
  Tasks). Der DB-Trigger-Ansatz bleibt auf die M1-11b-Outcome-Evidenz
  beschränkt; kein zweiter Mechanismus für Notizen.
- **O4 → bestätigt:** `ErasureGraphIds.noteIds`; die quellgepinnte
  `erase_inactive_lead`-Erweiterung lockt und löscht Notiz-Zeilen des
  Contact-Graphen wie in der Spec beschrieben. Weitere Slice-Anker werden erst
  bei der Integrationsmigration 0041 gepinnt.
- **O5 → eigener schmaler Serializer (DECIDED):** keine neue Fremdabhängigkeit.
  Unterstützt wird genau die in der Spec definierte Teilmenge (Absätze,
  bold/italic/strike/code, H1–H3, UL/OL, Links) in beide Richtungen
  (JSON↔Markdown); alles andere wird serverseitig abgelehnt. Lizenzrisiko
  damit null.
