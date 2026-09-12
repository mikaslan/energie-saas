# F16-08 Planungs-Vorlagen (Modus-Preset, Katalog F16.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F1608 2/2, E2E F1608-E2E-01/02/03 3/3, Nachbarn 7 Files/49 Tests, Tenant-Invarianten grün, tsc/eslint/depcruise/db:generate grün, lokal beobachtet; kein Push während CI läuft).

Ziel: Den in F16-07 als „getrennten Slice“ offen gelassenen
Vorlagentyp Planung schließen. Benannte Planungsmodus-Presets
(quick/2d/3d) je Workspace, Verwaltung in den Einstellungen,
Anwenden an einer Angebotsvariante (setzt deren Planungsmodus in
einem Schritt).

## ESTIMATE (reversibel, Referenzfrage offen)

- Modell: `planning_template` (Migration 0136, Tabelle + RLS wie
  F16-05/07): Name (1–200, normalisiert-eindeutig je aktive
  Vorlage), `mode` CHECK quick/2d/3d, Position, active-Flag.
  Archiv statt Delete (F7.3/F16.3-Muster).
- CRUD: `planning.settings.read` (Viewer+) lesen,
  `settings.manage` (Admin) schreiben — wie Planungs-Settings.
- Anwenden: `applyPlanningTemplate` (angebotsseitig, Muster F16-06,
  kein Modulzyklus): aktive Vorlage + `set_planning_mode`-Revision
  mit `expectedRevision`; Angebots-Fehler (Sperre, Stale-Revision)
  laufen transparent durch, Archiv-Vorlage → NotFound. Idempotent:
  gleicher Modus = No-op (Revision bleibt, kein Fehler).
- UI: Einstellungen-Seite `planungs-vorlagen` (Manager wie F16-07);
  Angebots-Detail: Apply-Panel bei Edit-Recht (Liste nur mit
  `planning.settings.read`), read-only Sichtbarkeit der Namen.
- Berechtigung: KEINE neuen Keys/Provider. Events/Audit nur IDs +
  Modus. RLS tenant_isolation + FORCE, Rollen-Hash/Marker geerntet.

## Scopes

1. Migration 0136 + Journal + m111a-Pins 137 + Tenant-Fixture.
2. Contract (`template-contract.ts`) + Service-CRUD
   (`modules/planning/templates.ts`) + Apply
   (`modules/offers/templates.ts`).
3. Einstellungen-UI (Actions/Page/Manager) + Angebots-Apply
   (State/Action/Panel/Page/Detail-View).

## Geschlossene Testmatrix

- `F1608-DB-01`: Anlage → Liste (canWrite je Rolle) → Anwenden
  setzt Modus (Revision 1→2, Snapshot belegt); Stale → Conflict.
- `F1608-DB-02`: Duplikat → Conflict; falscher Modus →
  Validation; Viewer-Create denied (settings.manage); Archiv →
  NotFound beim Anwenden; Restore heilt; Viewer-Apply denied
  (project.write); Update + Fremdmandant fail-closed.
- `F1608-E2E-01`: Admin anlegen/archivieren/reaktivieren.
- `F1608-E2E-02`: Viewer ausschließlich lesend (frischer Kontext).
- `F1608-E2E-03`: Angebot am F1606-Projekt → Gegen-Vorlage zum
  aktuellen Modus anwenden → Erfolgsmeldung + Revision 2 +
  Snapshot-Modus.

## Bewusst offen

- E-Mail-Vorlagen (letzter offener F16-Vorlagentyp), echte
  Produkte, Brand-/Human-Visual-Freigabe.
