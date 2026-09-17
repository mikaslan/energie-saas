# F9-13 Floating-Timer (Blaupause F9.1 „floating")

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2b-f9` · Migration: keine
Basis: Modulkatalog F9.1 (`docs/blaupause/01-modulkatalog.md:116`):
„Live-Timer in der App (floating, überlebt Neustart, kein Auto-Stop)".
Vorgänger: F9.2-Stoppuhr (Start/Stopp je Projektseite), F9-10
(kein Auto-Booking), F11-03c/d (Offline-Start/Stopp).
Matrix schweigt zu F9 (keine F9-Zeile); STATUS F9 nennt nur bis F9-10.

## 1. Befund

Timer-Kern ist gebaut: `startTimeEntry`/`stopTimeEntry`
(`modules/time-tracking/service.ts:1018/1086`), genau ein
laufender Eintrag je Actor (partieller Unique-Index, 23505 →
`TimeTrackingConflictError`), Stopp per Entry-Id + Actor +
Workspace (service.ts:1111: kein `projectId` nötig),
Neustart-Festigkeit via Postgres-Persistenz, kein Auto-Stop
(F9-10-Entscheidung). Es fehlt exakt das „floating": 0 Treffer
für ein persistentes Widget, kein „mein laufender Eintrag"-Read,
kein Workspace-Layout als Montagepunkt (`app/w/layout.tsx`
existiert nicht, Root-Layout rendert nur `{children}`).

## 2. ESTIMATE (reversibel, DECIDED)

1. **Montagepunkt**: neues `app/w/[workspaceId]/layout.tsx`
   mit Server-Widget (kein Eingriff ins Root-Layout: Portal-,
   Login- und Shared-Routen bleiben widget-frei).
2. **Widget-Verhalten**: nur rendern, wenn der Actor einen
   laufenden Eintrag hat (sonst `null`, kein Layout-Shift);
   Anzeige verstrichene Zeit (Client-Tick ab `start_at`),
   Projekt- + Typ-Name, Stopp-Link (Deep-Link zur
   Zeiterfassungsseite des Eintrags-Projekts —
   CONTRACTED-Korrektur: kein Direkt-Stopp, s. §3.2).
   Viewer sehen das Widget lesend (Stopp-Link führt auf
   die lesende Seite — `requireWrite` fail-closed
   serverseitig ohnehin).
3. **Kein neuer Stopp-Pfad**: null neue Service-/Action-Zeilen
   für den Stopp — das bestehende Stopp-Formular (explizite
   Minuten, „nie raten") bleibt der einzige Stopp-Ort.
4. **Kein Start/Pause im Widget**: nur Sichtbarkeit +
   Navigation (kleinste Blaupause-Einheit „floating").

## 3. Vertrag (ohne Migration)

1. **Read** `getMyRunningTimeEntry(tx, ctx)` (service.ts):
   Actor-laufender Eintrag (`end_at IS NULL`,
   `archived_at IS NULL`), inkl. Projekt-/Typ-Name fürs
   Widget. Tenant-RLS aus 0050 deckt den Read (keine
   Policy-Änderung, keine Rolle, kein Rollenvertrag-Delta).
2. **Stopp-Link statt Stopp-Action** (CONTRACTED, „nie
   raten"-Beleg `zeiterfassung/actions.ts:317-339`: Minuten
   sind explizit Pflicht, `workingTimeMinutes < 1` →
   invalid — ein One-Click-Stopp müsste Minuten erfinden):
   Das Widget verlinkt auf
   `/w/{ws}/anfragen/{projectId}/zeiterfassung`, wo das
   bestehende Stopp-Formular („Stoppuhr läuft") den Timer
   beendet. Keine neue Action, kein neuer Service-Write.
3. **Widget + Layout**: Server-Komponente (Daten) +
   Client-Tick (Anzeige), `position: fixed`, 375-px-Viewport
   ohne Horizontal-Scroll (F9-12-Muster), Axe-sauber,
   `data-testid` für E2E.
4. **Explizit keine**: keine Migration/Drift, keine
   RLS-/Rollen-/Permission-Änderung, keine Outbox-Änderung
   (Online-Stopp-Pfad existiert), kein Auto-Stop.

## 4. Tests (TDD RED-first)

### 4.1 DB — `tests/db/f913-floating-timer.test.ts` (neu)

- **F913-DB-01 my-running-returns-entry**: Timer starten →
  Read liefert genau diesen Eintrag (Id, Projekt, Typ).
- **F913-DB-02 idle-returns-null**: ohne laufenden Timer →
  `null`; beendeter/archivierter Eintrag → `null`.
- **F913-DB-03 actor-isolated**: fremder laufender Timer →
  `null` (kein Leak über Actor-Grenze).

### 4.2 E2E — `tests/e2e/f9-13-floating-timer.spec.ts` (neu)

Isolierter Workspace (F9-12-Muster, niemals W3):

- **F913-E2E-01**: Editor startet Timer an Projekt A →
  Widget auf Projekt-B-Seite sichtbar (Name + tickende
  Zeit) → Stopp-Link führt auf Projekt-A-Seite →
  Stopp-Formular (45 Min.) beendet den Eintrag →
  Widget weg.
- Viewports 375/768/1440 (kein Horizontal-Scroll),
  Axe ohne Violations, Console/Page-Errors leer.
- RED-first: Spec gegen Code ohne Widget laufen lassen
  (Widget fehlt → Fail), dann mit Widget grün.

## 5. Bewusst offen / Nicht-Ziele

- Kein Start/Pause im Widget, keine Widget-Historie,
  keine Offline-Widget-Pfade (F11-03c/d unberührt).
- Keine Portal-Sichtbarkeit (internes Arbeitsmittel).
- Kein „zuletzt gestoppt"-Gedächtnis, keine
  Raten-/Abrechnungsanzeige (Subunternehmer bleibt
  eigener Folge-Slice mit Geld-Domänen-Konzept).

## 6. Akzeptanz

- `npm run check` grün, `db:generate` ohne Drift
  (keine Migration), DB-Suite (`f913`) grün, E2E-Spec
  grün (CI), kein Horizontal-Scroll auf 375 px.
- Laufender Timer ist auf jeder Workspace-Seite sichtbar
  und per Widget-Link zum Stopp-Formular erreichbar; ohne
  laufenden Timer rendert nichts.
