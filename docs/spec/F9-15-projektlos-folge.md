# F9-15 Projektlose Folge-UI (F9-EPIC R1: Edit/Archiv/Freigabe, CSV, Offline)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2b-f9` · Migration: keine
Basis: F9-14-Spec §5 (bewusst offen) + F9-EPIC-Restliste (R1). Service ist
id-basiert bereit; Route `/w/{ws}/zeiterfassung-ohne-projekt` existiert.
Verfahren: Welle 3a (6 Agenten, file-disjunkte Aufträge, Shared-Checkout).
Datei-Eigentum ist VERBINDLICH: wer ausserhalb seiner Files schreibt,
liefert ungültig. Kein Agent baut/testet/generiert (Lead verifiziert).

## Track R1a — Edit/Archiv/Freigabe (Agent R1a-impl)

EIGENE FILES (nur diese anfassen):
`app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/actions.ts` (nur
`update/archive/unapprove/approveTimeEntryAction` auf `parseOptionalProjectId`
+ Guard `projectId === null` umstellen — Muster F9-14 create/start/stop),
`app/w/[workspaceId]/zeiterfassung-ohne-projekt/edit-archive-section.tsx` (NEU:
Client-Sections je Eintrag: Archivieren-Button, Freigeben/Entsperren-Button
(exakte Projektseiten-Labels, kein „Zurückziehen"), Kompakt-Edit-Formular
(Kommentar + Minuten, volle Felder-Payload); Labels + Feedback-Meldungen =
Projektseite),
`tests/db/f915a-projectless-manage.test.ts` (NEU).
Manager-Komposition (Import + Platzierung) macht der LEAD — NICHT anfassen:
`projectless-time-manager.tsx`, `page.tsx`.
Vertrag: Actions ohne `projectId`-Feld → projektloser Pfad + Revalidate
projektlose Route; defektes UUID → invalid (nie raten). DB-Fälle: update/
archive/approve/unapprove an projektlosen Zeilen via Service (id-basiert),
inkl. Revisions-Copy NULL + Freigabe-Sichtbarkeit lesend.

## Track R1b — CSV-Export projektlos (Agent R1b-impl)

EIGENE FILES (nur diese anfassen):
`modules/time-tracking/service.ts` (NUR neue Funktion
`exportProjectlessTimeEntries` + ggf. privater CSV-Mapper-Extract; KEINE
anderen Zeilen),
`app/w/[workspaceId]/zeiterfassung-ohne-projekt/export/route.ts` (NEU: GET,
Muster Projekt-Export-Route: auth + `time.read` + CSV-Download),
`app/w/[workspaceId]/zeiterfassung-ohne-projekt/export-button.tsx` (NEU:
Link/Button „CSV exportieren"),
`tests/db/f915b-projectless-export.test.ts` (NEU).
Vertrag: gleiche Spalten wie Projekt-CSV
(`datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id`,
BOM, `;`, Injection-Guard), Filter `project_id IS NULL`, Dateiname
`zeiterfassung-ohne-projekt-{STAMP}.csv`. DB-Fälle: nur projektlose Zeilen
im Export; Projekt-Zeilen desselben Workspaces fehlen; BOM/Guard intakt.

## Track R1c — Offline-Anlage projektlos (Agent R1c-impl)

EIGENE FILES (nur diese anfassen):
`app/w/[workspaceId]/zeiterfassung-ohne-projekt/projectless-outbox.ts` (NEU:
IndexedDB-Queue für Create-Payloads mit `projectId: null`, Muster
`time-outbox.ts` — LESEN, nicht kopieren-blind),
`app/w/[workspaceId]/zeiterfassung-ohne-projekt/use-projectless-offline.ts` (NEU:
Hook `{ onSubmit, pendingCount, syncState }`, Muster
`time-outbox-sync.tsx`),
`tests/db/f915c-projectless-offline.test.ts` (NEU).
Manager-Verdrahtung (3 Zeilen) macht der LEAD. KEIN Timer-offline
(geschnitten, s. §5). KEINE Outbox-Schema-Änderung am Projekt-Pfad.
Vertrag: Offline-Create → Queue (clientKey-UUID); Online-Replay via
`createTimeEntryAction` ohne `projectId` (F9-14-parat) → idempotent per
ClientKey-Null-Zweig (service-seitig bereit). DB-Fälle: Replay idempotent
(2× derselbe Key → 1 Eintrag); Key-Kollision projektlos-vs-Projekt
unmöglich (IS-NULL-Zweig).

## Track E2E-RED (Agent e2e-prep, NUR neue Spec-Files)

EIGENE FILES (nur diese anlegen):
`tests/e2e/f9-15a-projectless-manage.spec.ts` (Kommentar editieren,
Archivieren, Freigeben/Entsperren per UI auf projektloser Route),
`tests/e2e/f9-15b-projectless-export.spec.ts` (CSV-Download + Inhalt:
projektlose Zeile drin, Projekt-Zeile fehlt),
`tests/e2e/f9-15c-projectless-offline.spec.ts` (offline Create →
Online-Replay → Eintrag da; Muster f11-03b).
Muster: `f9-14-projectless.spec.ts` (isolierter Workspace, NIEMALS W3,
Login-Helper kopieren, 375/768/1440 + Axe + Browser-Errors). Der Lead
fährt RED auf der Basis (ohne Implementierung) selbst.

## Track Audit (2 Agenten, READ-ONLY, keine Writes)

- spec-auditor: Spec-vs-Code-Konsistenz (Stimmen Routen/Labels/Actions/
  Dateinamen? Jede Abweichung als `unresolved` mit Datei-Beleg).
- contract-guard: Impact-Analyse (bricht R1a/b/c bestehende Aufrufer?
  Jede Bruchstelle als `unresolved` mit Aufrufer-Beleg).

## §5 Nicht-Ziele

Kein Timer-offline projektlos, kein XLSX, keine Pausen-/Verlauf-UI
projektlos (Service bereit, UI folgt bei Bedarf), keine
Projekt-Zuordnung nachträglich, kein Subunternehmer (FRAGEN B1).
