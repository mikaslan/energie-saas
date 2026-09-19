# F13-00 Filing-Kern (gemeinsames Muster, SPECIFIED)

Ziel: Gemeinsamer Filing-Kern zuerst — vor dem Ausbau der
einzelnen Capabilities. M13-Grundmuster (Modulkatalog:142):
Filing-Objekt am Projekt — Formular (vorbefüllt) →
Draft/Submit-Sperre → Statusmaschine → Chat mit typisierten
Datei-Slots → E-Mail je Übergang → Abrechnung pro Vorgang.

Stand: SPECIFIED, nicht implementiert. Stil nach F13-01;
keine neue Permission (Bauarbeit auf `installation.read/write`
bzw. `project.read/write` je Pfad — Mandat).

## §1 Draft-Konzept

- Jede Capability startet im Status `draft`: vorbefüllt,
  unversandt, frei editierbar, unsichtbar für Externe.
- Vorbefüllung aus Projekt/Angebot/Rechner-Snapshot
  (CRM-/Planungsdaten); F13-08-Heuristik (`suggestSubsidyProgram`,
  Signale aus `calculator_snapshot` + `project_requirement`) ist
  Quelle für den Programm-Vorschlag — nie persistiert, nie
  geraten (`no_basis` fail-closed), Entscheidung bleibt manuell.
- Anlage idempotent je Projekt (UNIQUE-`ensure`-Muster aus
  grid/subsidy, Race via 23505-Fallback).
- ESTIMATE: exakte Reonic-Draft-Felder UNKNOWN; nur
  gespeicherte Werte.

## §2 Submit-Freeze

- Feld-Edits (`set*Details`) nur in `draft`/`rückfrage`
  (bzw. dem Korrektur-Pendant je Maschine); nach Submit
  transition-only.
- Gate-Reihenfolge je Schreibpfad: Validation → Scope →
  Transition → Race (s. §3).
- Revisionskette: jede Änderung nach Freeze nur als
  Transition mit Pflicht-Event + Audit (Historie bleibt
  ehrlich — kein Zurücksetzen, Muster F13-01-Reopen-Verbot).
- Verstoß fail-closed (`*ValidationError`, illegaler
  Übergang benannt).

## §3 Maschinen-Norm

- Kanten-Tabelle pro Capability (Bestand, Doktrin):
  - `service_case`: `open → in_progress → done`,
    `cancelled` aus `open`/`in_progress`
    (`modules/service-cases/service.ts:229-234`).
  - `grid_registration`: `vorbereitung → eingereicht →
    genehmigt → fertiggemeldet → abgeschlossen`,
    `storniert` aus jedem Vor-Terminal.
  - `subsidy_case`: `vorbereitung → bza_eingereicht →
    bza_bewilligt → bnd_eingereicht → abgeschlossen`
    (+ `korrektur`-Wiedereinstieg, `storniert` terminal;
    `lib/subsidy-case.ts`).
  - `file_request`: `offen → hochgeladen → erledigt`
    (`hochgeladen` nur via Token-DEFINER, `storniert`
    nur aus `offen`; `lib/file-request.ts`; Upload
    10 MiB, PDF/JPEG/PNG —
    `modules/file-requests/service.ts:56-61`).
  - `planning_request` (SPECIFIED, F13-11): `requested →
    in_progress → finished → accepted`.
- Jede Maschine exportiert `next*`-Folgezustände UND
  `isAllowed*`-Guard (Norm; `file_request`-Guard fehlt —
  F1300-U-05).
- Guard-Reihenfolge: Validation (Zod/Statusworte) →
  Scope (Permission + Tenant-/Projektbindung) → Transition
  (Kante erlaubt? Pflichtbelege erfüllt? §4) → Race
  (`SELECT … FOR UPDATE`, UNIQUE-23505-Muster).
- Error-Typen: `*NotFoundError` (uniform, kein Orakel),
  `*ValidationError` (inkl. illegaler Kanten),
  `*ConflictError` (Duplikat), `PermissionDeniedError`.
- 1:1-v1-Grenzen als Doktrin: EIN Datensatz je Projekt
  (grid, subsidy), EIN Belegkontext je Anfrage
  (file-request), 1 Anfrage je Angebot (planning) —
  Rückbau nur als Historie-Folgepfad (neuer Vorgang
  statt Reset).

## §4 Typisierte Datei-Slots

- Slot-Typ-Enum pro Capability (ESTIMATE, Katalog
  F13.2-Rest; z. B. subsidy: `bza_angebot`,
  `bza_vollmacht`, `bnd_rechnung`, `typenschild_foto`).
- Pflichtbeleg-Guards pro Übergang (z. B. BnD-Einreichung
  verlangt erledigte Pflicht-Slots; F13-07 kennt heute
  keine Pflicht — ehrliche Anzeige bis dahin).
- Übergang: F13-07-Titel-Konvention („BnD-Beleg: …")
  bleibt Portal-kompatible Darstellung; der Slot-Typ
  wird strukturiertes Feld an `file_request` (kein
  Schema-Umbruch am anonymen Pfad).
- Upload-Grenzen unverändert (10 MiB, PDF/JPEG/PNG).

## §5 Chat-Norm

- Generischer Filing-Chat nach F13-10-Muster: Nachrichten
  je Akte (`workspace/project/case`, `author_side`
  `internal|customer`, Body 1–2000 getrimmt ohne
  Controls, `created_by` nullable, unveränderlich).
- Projektion `{side, body, at}` (nie IDs/Akteure;
  BzA-Nummer bleibt ausgeschlossen).
- Chat↔Slot-Verknüpfung (ESTIMATE): Nachricht kann
  Slot referenzieren; Beleg-Upload meldet sich im Chat.
- Intern `installation.read/write`; Kunde ausschließlich
  via Token-DEFINER-Kapsel (kein Orakel, Muster F10.1).

## §6 Übergangs-Events

- Pflicht-Event je Transition: `<aggregate>.transition`
  mit Payload `{from, to, caseId?}` (+ Portal-Outcome
  wo zutreffend, Muster F13-05).
- Naming-Doktrin: `.transition` löst `.status_changed`
  ab (Bestand migriert, s. §7); `.created` bleibt
  Anlage-Event; `.message_posted`-Muster bleibt.
- Details-Politik: Events/Audit nur IDs + Status —
  kein Kundenkontext (keine Titel, Bodies, Token).

## §7 Migration der 5 Maschinen (SPECIFIED, nicht implementiert)

Pfad je Maschine (keine Migration in diesem Slice):
1. `planning_request` (F13-11, noch kein Code): direkt
   auf Kern bauen (Draft + Freeze + `.transition`).
2. `subsidy_case`: Pilot — `draft`-Status, Freeze-Gate,
   Slot-Typen, Event-Rename.
3. `grid_registration`: dto. nachziehen.
4. `service_case`: dto.; Token-Pfad F13-06 bleibt.
5. `file_request`: Slot-Typ-Feld + `isAllowed`-Guard.
Reihenfolge Pilot → Nachzug; jede Migration mit
DB-Test (Kanten/Freeze) + E2E.

Referenzen (nicht in F13-00): E-Mail je Übergang,
Preis/Abrechnung, Audit-Form → F13-16 (Provider-Blocker
`RESEND_API_KEY` extern).

## Geschlossene Testmatrix

- `F1300-U-01…U-06` (`tests/unit/f1300-filing-kern.red.test.ts`):
  Draft-Status, Freeze-Gate-Export, Slot-Typ-Enum,
  Filing-Chat-Pfad, Kanten-Norm-Export, `.transition`-Naming.
  Aktuell geskippt (s. §ROT-Beleg); Entskip je
  Implementierungs-Slice.

## §ROT-Beleg

`npx vitest run tests/unit/f1300-filing-kern.red.test.ts`
(2026-09-19, vor Skip): 6/6 ROT wie spezifiziert —

- `× F1300-U-01: Draft-Status existiert in der Förderakte`
  (`expected [ 'vorbereitung', …(6) ] to include 'draft'`)
- `× F1300-U-02: Submit-Freeze-Gate ist exportiert`
  (`expected 'undefined' to be 'function'`)
- `× F1300-U-03: Slot-Typ-Enum hängt an der Datei-Anfrage`
  (`expected undefined to be defined`)
- `× F1300-U-04: generischer Filing-Chat-Pfad existiert`
  (`expected undefined to be defined`)
- `× F1300-U-05: Kanten-Norm-Export (isAllowed-Guard je Maschine)`
  (`expected 'undefined' to be 'function'`)
- `× F1300-U-06: Übergangs-Event folgt dem .transition-Naming`
  (`expected undefined to be 'subsidy_case.transition'`)

`Test Files 1 failed (1)` / `Tests 6 failed (6)`.
Skip-Begründung: F13-00 ist reine Spezifikation (kein
Kern-Code in diesem Slice); die Tests sichern die Norm
und werden je Migrations-Slice (§7) entskipped.

## Bewusst offen

- Preise/Abrechnung pro Vorgang (→ F13-16).
- Portal-Darstellung des Drafts (Sichtbarkeit je Tab).
- Slot-Typ-Katalog je Capability (mit Katalogabgleich).
- Chat↔Slot-Verknüpfung im Portal-Resolver.
