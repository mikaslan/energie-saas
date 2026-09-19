# F9-12 Default-4er-Kategorie-Satz (Travel/On-site/Office/Other)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2b-f9` · Migration: 0149
Basis: Modulkatalog F9.2 (`docs/blaupause/01-modulkatalog.md:117`):
„Admin-Kategorien (Travel/On-site/Office/Other + custom)".
Vorgänger: F9.1 (Event-Typ-CRUD, 0050), F9.2 (Stoppuhr, 0054),
F9-02b (Auto-Tag, kein Modell). Blaupause F9.2 ist die einzige
Quelle für Namen und Reihenfolge des Default-Satzes.

## 1. Befund

`time_event_type` (0050, `lib/db/schema/time-tracking.ts:18-49`)
ist reiner Workspace-Stammdaten-CRUD ohne Defaults: Jeder neue
Workspace startet mit einer leeren Kategorie-Liste
(`listTimeEventTypes` → `[]`, Sortierung `position asc, name asc,
id asc`, `modules/time-tracking/service.ts:124-139`). Der
Blaupause-Satz Travel/On-site/Office/Other existiert nirgends —
weder als Seed noch als Provisionierung. Eindeutigkeit regelt
allein der partielle Index
`time_event_type_ws_active_name_uq (workspace_id, name_normalized)
WHERE archived_at IS NULL` (0050:55); `name_normalized` ist per
CHECK `lower(btrim(...))`, `position >= 0` default 0, Farben
nullable `#RRGGBB`.

Provisionierungs-Präzedenz: Die Workspace-Anlage ist die einzige
Provisionierungsgrenze — `provision_default_request_board()`
(`SECURITY DEFINER`, `SET search_path = pg_catalog`,
`REVOKE ALL ... FROM PUBLIC`, `AFTER INSERT ON public.workspace`,
0022:168-207) plus idempotenter Bestands-Backfill im
`DO`-Block mit `set_config('app.workspace_id', ...)` je
Workspace wegen FORCE RLS (0088:58-102, F15-01-Muster).
F9-12 folgt exakt diesem Muster für `time_event_type`.

## 2. ESTIMATE (reversibel, Blaupause-Reihenfolge)

1. **Satz + Positionen**: Genau 4 Typen in Blaupause-Reihenfolge —
   `Travel` position 0, `On-site` position 1, `Office` position 2,
   `Other` position 3. Positionen sind ESTIMATE (Blaupause nennt
   keine): 0–3 aufsteigend hält die Blaupause-Reihenfolge in der
   bestehenden Listensortierung stabil.
2. **Namen wörtlich**: `Travel`, `On-site` (mit Bindestrich, exakt
   wie Blaupause), `Office`, `Other`. `name_normalized` =
   `lower(trim(...))` → `travel`, `on-site`, `office`, `other`.
3. **Farben**: ESTIMATE `text_color = NULL`,
   `background_color = NULL` — die Blaupause nennt keine Farben,
   keine erfundenen Hex-Werte (reonic-parity).
4. **Backfill-all + Trigger-new**: Bestands-Workspaces erhalten
   den Satz per Backfill (nur fehlende Namen, s. Vertrag §3);
   neue Workspaces erhalten ihn per `AFTER INSERT`-Trigger.
5. **Reversibel**: Kein Schutz-Flag, kein `is_default`, keine
   Service-Sonderlogik — Admins können Defaults per bestehendem
   CRUD umbenennen/archivieren (F9.1-Pfade unverändert). Die
   Migration selbst ist per Folge-Migration entfernbar
   (Repo-Migrator ist forward-only: `scripts/migrate.mts` ruft
   nur `migrate()` up auf, kein Down-Mechanismus): Rollback als
   neue Migration — Seed-Zeilen löschen, Trigger
   `workspace_default_time_event_types` plus Funktionen
   `seed_default_time_event_types(uuid)` und
   `provision_default_time_event_types()` droppen; Trigger-Backfill
   schreibt niemals in archivierte oder umbenannte Zeilen hinein.

## 3. Vertrag (Migration 0149)

Datei: `drizzle/0149_f9_12_event_type_defaults.sql`.
Keine Änderung an `lib/db/schema/*` (Funktion/Trigger/Seed sind
SQL-only, kein `db:generate`-Drift — Präzedenz 0148 ohne Snapshot).

1. **Seed-Funktion** `public.seed_default_time_event_types(p_workspace_id uuid)`:
   `LANGUAGE plpgsql`, `SECURITY DEFINER`,
   `SET search_path = pg_catalog` (0022-Muster). Rumpf ZUERST
   GUC-Tanz wie 0022:174-193 (prior sichern,
   `set_config('app.workspace_id', p_workspace_id, true)` —
   FORCE RLS gilt auch für Owner, 0050:65; ohne gesetzten
   Kontext schlägt der Backfill unter Migrator-GUC fehl),
   dann 4× `INSERT INTO public.time_event_type (workspace_id,
   name, name_normalized, position)` mit
   `(p_workspace_id, 'Travel', 'travel', 0)` etc., je mit
   `ON CONFLICT (workspace_id, name_normalized)
   WHERE archived_at IS NULL DO NOTHING`, danach GUC
   restaurieren.
   Der Arbiter muss den partiellen Unique-Index exakt treffen
   (Spalten + Prädikat `archived_at IS NULL`); `DO NOTHING`
   macht Funktion und Backfill idempotent und konflikt-sicher
   gegen teil-customisierte Workspaces (z. B. existierendes
   Custom-`Travel` bleibt unangetastet, Rest wird ergänzt).
2. **Trigger-Funktion** `public.provision_default_time_event_types()`
   `RETURNS trigger`, `LANGUAGE plpgsql`, `SECURITY DEFINER`,
   `SET search_path = pg_catalog`: `PERFORM
   public.seed_default_time_event_types(NEW.id); RETURN NEW;`
   (kein eigener RLS-Tanz — die Seed-Funktion setzt den
   Kontext selbst, Trigger wie Backfill wie Direktaufruf).
3. **`REVOKE ALL ON FUNCTION public.seed_default_time_event_types(uuid)
   FROM PUBLIC;`** und `REVOKE ALL ON FUNCTION
   public.provision_default_time_event_types() FROM PUBLIC;`
   (0022:202-Muster: kein aufrufbarer API-Vertrag).
4. **Trigger**: `CREATE TRIGGER workspace_default_time_event_types
   AFTER INSERT ON public.workspace FOR EACH ROW EXECUTE FUNCTION
   public.provision_default_time_event_types();`
5. **Backfill**: `SELECT public.seed_default_time_event_types(w.id)
   FROM public.workspace w;` — ein Statement, kein Loop nötig
   (Kontext pro Zeile in der Funktion gesetzt —
   Migrator-GUC egal). Idempotent via `ON CONFLICT DO NOTHING`.
6. **Journal-Registrierung** (exakte Prozedur): An
   `drizzle/meta/_journal.json` einen Eintrag anhängen:
   `{"idx": 149, "version": "7", "when": <ms-epoch>,
   "tag": "0149_f9_12_event_type_defaults", "breakpoints": true}`.
   Kein Snapshot-File (SQL-only-Präzedenz 0148: kein
   `0148_snapshot.json`). Danach `npm run db:generate` ohne Drift
   und `npm run check` grün.
7. **Explizit keine**: keine Rollen/Policies/Permission/RLS/
   Provider-Änderungen (M1-CRM-Muster `tenant_isolation` + FORCE
   aus 0050 bleibt); keine Service-/Contract-Änderungen
   erwartet — `createTimeEventType` wirft bei Duplikat bereits
   `TimeTrackingConflictError` (23505-Mapping,
   `service.ts:169-172`), Server-Actions mappen bereits auf
   `{ status: "conflict" }` (`actions.ts:59-66`). REST-409 gibt es
   für Ereignistypen nicht (Server-Actions-UI, keine Route) —
   „duplicate-create 409" bedeutet: Service-Conflict + UI-
   Konfliktstatus, kein neues Fehler-Mapping nötig.
   Ausnahme (E2E-Befund, 375-px-Regression): `break-words` auf
   Typ-Name + Kommentar der Eintragszeile sowie
   `overflow-x-auto`-Wrapper mit `min-w-[560px]` um die
   Auslastung-Tabelle (`time-entry-manager.tsx`) — unbrechbarer
   Langtext bzw. die 4-spaltige Tabelle liefen bei 375 px über
   (latent, F9-12-E2E pinnt es als Regression).

## 4. Tests (TDD RED-first)

### 4.1 DB — `tests/db/f912-event-type-defaults.test.ts` (neu)

Frischer Workspace je Test (eigener Seed-Helper im F901-Stil —
`insert into workspace` feuert den Trigger; kein W3-Recycling):

- **F912-DB-01 fresh-ws-exactly-4-in-order**: `listTimeEventTypes`
  auf frischem Workspace →
  `map(t => [t.name, t.position])` deep-equal
  `[["Travel",0],["On-site",1],["Office",2],["Other",3]]`;
  Farben `null`; `includeArchived: true` ebenfalls 4.
- **F912-DB-02 function-idempotency-double-call**: direkter
  `SELECT seed_default_time_event_types(ws)` zweimal →
  weiterhin genau 4 aktive Typen, keine Duplikate.
- **F912-DB-03 partial-custom-Travel-conflict-safe**: vorab per
  Service Custom-`Travel` (eigene Farbe/Position) anlegen, dann
  Seed-Funktion aufrufen → Custom-Zeile unverändert (id, Farbe,
  Position), die 3 übrigen Defaults ergänzt, total 4 aktiv.
- **F912-DB-04 duplicate-create-conflict**: `createTimeEventType`
  mit `name: "travel"` (Case-Variante) auf frischem Workspace →
  `rejects.toBeInstanceOf(TimeTrackingConflictError)`; ebenso
  `"  Office  "` (Trim-Variante, Contract trimmt vorab) und
  exaktes `"Other"`.

### 4.2 F901-DB-02 intent-preserving adjustment (Behavior Change)

F901-DB-02 (`tests/db/time-tracking.test.ts:185-220`) behält
Name/Intent („Namenskollision aktiv; Name frei nach
Archivierung; Restore-Konflikt") — `Montage` kollidiert nicht
mit den Defaults, alle Conflict-Schritte bleiben unverändert.
Nur die Listen-Assertions am Ende ändern sich (4 Defaults sind
jetzt immer dabei). Exakte neue Assertions:

```ts
const active = await withAuthorizedTenantOn(
  testPool, fixture.editorId, fixture.workspaceId,
  (tx, ctx) => listTimeEventTypes(tx, ctx),
);
expect(active).toHaveLength(5); // 4 Defaults + recreated
expect(active.filter((t) => t.id === recreated.id)).toHaveLength(1);
expect(
  active.filter((t) =>
    ["Travel", "On-site", "Office", "Other"].includes(t.name),
  ),
).toHaveLength(4);
const all = await withAuthorizedTenantOn(
  testPool, fixture.editorId, fixture.workspaceId,
  (tx, ctx) => listTimeEventTypes(tx, ctx, { includeArchived: true }),
);
expect(all).toHaveLength(6); // 4 Defaults + archiviert + recreated
```

(Kollations-sicher: keine positionsübergreifende Exakt-Reihenfolge
behauptet.) Folge-Anpassungen gleicher Art sind an F901-DB-01
(Exakt-Array `["Büro","Montage"]` → Defaults einbeziehen) und
F901-DB-05 (`foreignList` `toHaveLength(0)` → `toHaveLength(4)`
mit Default-Namen) erforderlich — selbe Behavior-Change-Notiz,
keine Intent-Änderung.

### 4.3 E2E — `tests/e2e/f9-12-kategorie-defaults.spec.ts` (neu, RED-first)

- **Isolierter Workspace, NIEMALS W3** (F9-11-Muster
  `seedIsolatedWorkspace` + `seedProjectViaDb`): eigener
  Workspace + Editor-Membership per DB, damit die 4 Defaults
  exakt zählbar sind.
- **F912-E2E-01**: Editor öffnet
  `einstellungen/ereignistypen` → Liste zeigt genau die 4
  Defaults in Reihenfolge Travel/On-site/Office/Other; dann
  Zeiteintrag am Projekt per UI anlegen mit Typ-Auswahl
  `Travel` via UI-Select → Eintrag gespeichert, Typ-Label
  sichtbar.
- **Viewports + Axe**: Desktop + Mobile (F9.4-D-Muster,
  kein Horizontal-Scroll), `AxeBuilder` ohne violations auf
  Settings- und Zeiterfassungsseite; Browser-Error-Tracking
  (console/pageerror) leer.
- **RED-first**: Spec zuerst gegen Code ohne Migration 0149
  laufen lassen (leere Liste → Fail), dann mit Migration grün.

## 5. Bewusst offen / Nicht-Ziele

- **Farben-/Positionen-Admin bleibt CRUD**: keine Default-Farben,
  keine Positions-Neuvergabe, keine „auf Defaults
  zurücksetzen"-Aktion.
- **Kein Auto-Tag-Wandel**: F9-02b-Ableitung
  (Residential/Commercial) unberührt; Kategorien und Scope-Tag
  bleiben orthogonale Achsen.
- **Kein Backfill-Report**: kein UI-/Audit-Protokoll, welche
  Workspaces beim Backfill ergänzt wurden (stiller, idempotenter
  Seed; verifizierbar per DB-Test).
- Kein `is_default`-Flag, kein Lösch-/Umbenenn-Schutz für
  Defaults, keine Katalog-Pflicht (Einträge ohne Typ bleiben
  zulässig), keine Änderung an Stoppuhr/Pausen/Freigabe/Export.

## 6. Akzeptanz

- `npm run check` grün, `db:generate` ohne Drift, DB-Suite
  (`f912` + angepasste `time-tracking`) grün, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Frischer Workspace jeder Herkunft (Trigger wie Backfill) hat
  genau die 4 Defaults in Blaupause-Reihenfolge; Custom-Namen
  außerhalb des Satzes sind davon unberührt.
