# SPEC F10-18 — My-Files-Download-Protokoll (Katalog F10.7)

## Matrix
Katalog F10.7 („Download-Protokollierung/Audit"):
F10-12-Folgeslice zur F10-17. F10-12 protokolliert nur
Angebots-Downloads (`portal_download_log` mit
`issuance_id NOT NULL`); F10-17 brachte den Portal-
Download fuer My-Files OHNE Protokoll (0182 enthaelt
0x `download_log`). F10-18 schliesst die Luecke: jeder
ausgelieferte My-Files-Download schreibt genau eine
Zeile; der interne Zaehler wird dadurch automatisch
vollstaendig (kein Service-Change).

## Bestand (verifiziert am Code)
- `drizzle/0137_f10_12_download_protokoll.sql:13-19`:
  `portal_download_log` mit `issuance_id uuid NOT
  NULL`; Download-Insert in der Issuance-Kapsel
  Zeile 114-121 (Zweitrumpf 230-236, 0137-Muster:
  SELECT INTO + IF FOUND + `mutation_time`); RLS
  `tenant_isolation` + FORCE Zeile 26-31; Grants
  Zeile 275-287 (SELECT+INSERT an app_owner,
  SELECT an app_runtime, table-level).
- `drizzle/0182_f10_17_portal_my_files.sql`: 0x
  `download_log`; `read_portal_project_file_
  artifact` Zeile 967-1023 schreibt KEINE Zeile
  (nur SELECTs + RETURN QUERY Zeile 1011-1021).
- `modules/portal/service.ts:365-367`:
  `download_count` = count(*) ueber (workspace,
  invite) OHNE issuance-Filter — zaehlt heute nur
  Angebots-Downloads, weil nur die Kapsel schreibt.
  My-Files-Zeilen fallen automatisch hinein.
- `app/w/[workspaceId]/anfragen/[projectId]/
  portal-section.tsx:94` zeigt „N Downloads".
- Aufrufkette unveraendert: `readPortalProjectFile
  ByToken` (`modules/project-files/service.ts:348`,
  Kapsel-Call Zeile 370-373) ← Route
  `app/p/[token]/dateien/[fileId]/route.ts:93`.
- Rollenvertrag (`scripts/db-role-contract.mts`):
  Issuance-Stufenmarker 4480-4492, Issuance-Hash
  ternaer 5974-5981, Project-File-Hash-Pin
  5983-5991 (`bec8c5ea…`, EINZIGE Stelle des
  Hashes), Policy-Pin 7011, ACL-Pin 7651,
  Relationen 719-721, Grant-Canon 2841-2851
  (Kommentar „einziger Schreiber"!).
- KEIN Drizzle-Modell fuer `portal_download_log`
  (`lib/db/schema/portal.ts` fuehrt nur
  `portalViewLog` Zeile 98ff + Locator) → Hand-
  SQL ohne Snapshot (kein 0137-Snapshot in
  `drizzle/meta/`), kein `db:generate`-Anteil.
- m111a: TOTAL 162 (`tests/db/m111a-project-
  outcome-migration-upgrade.test.ts:129`), idx
  161 + Tag 0182 Zeile 444-447, Kommentar Zeile
  127-128; Journal-End-Eintrag idx 161.
- 0183-0189 frei (nur 0180/0181/0182 in 018x).
- FK-Ziel existiert: `project_file` hat UNIQUE
  (workspace_id, id) (`project_file_ws_id_uq`,
  `lib/db/schema/project-file.ts`); app_owner hat
  bereits SELECT auf `project_file` (0182:1064)
  + SELECT/INSERT auf `portal_download_log`
  (0137:280).

## Ziel
Jeder ausgelieferte Portal-My-Files-Download
schreibt genau eine Protokollzeile (Invite +
Datei + Zeitpunkt); Fehlschlaege schreiben
nichts. Intern zeigt „N Downloads" danach die
Summe aus Angebots- + My-Files-Downloads.
Kein Loeschen, keine neue Permission, kein
neuer Provider, kein App-Change.

## Entwurf (0137-Muster auf die F10-17-Kapsel)
- Tabelle: `issuance_id` NULLABLE +
  `project_file_id` NULLABLE + CHECK genau-eine-
  gesetzt + FK auf `project_file` + Index
  (Details: Vertrag DB).
- Kapsel: Download-Insert in `read_portal_
  project_file_artifact` nach 0137-Muster
  (Zeile 89-120): Sichtbarkeits-SELECT INTO +
  IF FOUND INSERT mit `mutation_time` — nur bei
  Treffer, d.h. unsichtbar/fremd/tot schreibt
  nichts (kein Orakel, kein Rauschen).
- Zaehler: kein Service-Change noetig
  (VERIFIZIERT: invite-weiter count(*) ohne
  issuance-Filter, service.ts:365-367).

## Vertrag DB (0183, Tabelle + Kapsel-Replace)
- `drizzle/0183_f10_18_my_files_download_
  protokoll.sql` (0183-0189 frei, verifiziert):
  1. `ALTER TABLE portal_download_log ALTER
     COLUMN issuance_id DROP NOT NULL` (Bestand:
     alle Zeilen issuance-gesetzt, CHECK bleibt
     erfuellt); `ADD COLUMN project_file_id
     uuid`; `ADD CONSTRAINT portal_download_
     log_exactly_one_target_ck CHECK
     (num_nonnulls(issuance_id, project_file_
     id) = 1)`; FK `portal_download_log_file_
     fk (workspace_id, project_file_id) →
     project_file(workspace_id, id) ON DELETE
     cascade ON UPDATE no action` (0137-Z.23-
     Praezedenz: Invite-FK im selben Table;
     Loeschen ist Folgeslice); `CREATE INDEX
     portal_download_log_ws_file_idx
     (workspace_id, project_file_id,
     downloaded_at, id)`.
  2. `CREATE OR REPLACE` der Kapsel mit
     Download-Insert (Entwurf); Owner-Tanz wie
     0137 Zeile 38ff (beide Ruempfe, Signatur
     unveraendert); INSERT-Spalten
     `(workspace_id, portal_invite_id,
     project_file_id, downloaded_at)` —
     `issuance_id` bleibt NULL.
- Journal: idx 162, Tag `0183_f10_18_my_files_
  download_protokoll`, when > 1789674836728,
  breakpoints true. KEIN Snapshot (kein Modell,
  0137-Muster); `db:generate` ohne Drift.
- Grants/RLS UNVERAENDERT: table-level Grants
  (0137:275-287) decken die neue Spalte;
  `tenant_isolation` + FORCE sind spalten-
  unabhaengig (0137:26-31); kein DELETE-Grant.
- m111a-Pins: TOTAL 162→163 (Z.129), idx
  161→162 + Tag (Z.444-447), Kommentar-Zeile
  (Z.127-128).
- Rollenvertrag (`scripts/db-role-contract.mts`,
  F10-12-Muster): NEUER Stufenmarker
  `hasPortalProjectFileDownloadLog` (prosrc von
  `read_portal_project_file_artifact` enthaelt
  `portal_download_log`, Muster Z.4480-4492);
  Hash-Pin Z.5983-5991 wird ternaer alt/neu
  (alter Hash `bec8c5ea…` bleibt fuer Prefixe,
  Muster Z.5979-5981; neuer Hash per Probe
  geerntet). UNVERAENDERT: Policy-Pin (Z.7011),
  ACL-Pin (Z.7651), Relationen (Z.719-721).
  Grant-Canon-KOMMENTAR Z.2847-2848 („einziger
  Schreiber") auf zwei Kapseln erweitern —
  SQL unveraendert.

## Vertrag App
KEIN Change (DB-only-Slice + Tests + Pins):
Zaehler (service.ts:365-367), Anzeige (portal-
section.tsx:94), Service (project-files/
service.ts:348ff), Route (dateien/route.ts:93)
bleiben unberuehrt — das Protokoll passiert in
der Kapsel. Keine neue Permission.

## Sicherheit
- Nur erfolgreiche Auslieferung schreibt;
  Fehlschlaege (unsichtbar/fremd/tot) schreiben
  nichts (F10-12-Regel: kein Orakel, kein
  Rauschen).
- CHECK genau-eine verhindert Misch- und
  Leerzeilen (kein Target = kein Protokoll).
- RLS + FORCE unveraendert; `db:roles:verify`
  gruen (nur neuer Stufenmarker + Hash-Pin).

## Tests (RED zuerst)
- DB: `tests/db/f1018-my-files-download-
  protokoll.test.ts` (F1012/F1017-Muster:
  `tenantQuery` + Fixture-Helfer) —
  D-01 sichtbarer Download via `readPortal
  ProjectFileByToken` → genau eine Zeile
  (`project_file_id` gesetzt, `issuance_id`
  NULL); 2 Downloads → 2 Zeilen (kein Dedup,
  F1012-DB-01-Muster); D-02 Fehlschlaege
  schreiben nichts (unsichtbar, fremde Datei,
  fremdes Projekt, abgelaufen/zurueckgezogen,
  unbekanntes Token — F1012-DB-02-Muster);
  D-03 CHECK genau-eine (beide NULL / beide
  gesetzt → 23514) + FK (nichtexistente Datei
  → Violation); D-04 `getPortalStatus`
  `downloadCount` = Angebots- + My-Files-
  Downloads gemeinsam (Misch-Summe, kein
  Service-Change); D-05 Angebots-Regression
  (Issuance-Download schreibt weiterhin
  issuance-Zeile, CHECK erfuellt); D-06 RLS —
  fremder Workspace liest keine My-Files-
  Log-Zeilen.
- KEINE Contract-/Unit-Tests (kein Contract-,
  kein Service-Change).
- E2E: EIGENE Datei `tests/e2e/f10-18-my-files-
  download-protokoll.spec.ts` (Setup nach F10-17:
  `m1-11g-fixture`, Invite per UI wie F10-07) —
  ENTSCHEIDUNG: eigene Datei, weil die F10-17-
  Spec ein geschlossener Single-Test ist
  (E-01..E-07 in einem `test()`, Z.142) und die
  Zaehler-Assertion zusaetzlich den internen
  Portal-Status auf anderer Seite braucht
  (anfragen/[projectId]-Portal-Sektion) — das
  wuerde den F10-17-Ablauf aufblaehen; ein
  Spec-File je Slice ist das etablierte Muster
  (f10-14/15/16/17). E-01 interner Zaehlerstand
  vorher („N Downloads", Portal-Sektion); E-02
  sichtbare Datei im Portal laden (Bytes
  bytegleich); E-03 Portal-Sektion zeigt N+1;
  E-04 unsichtbarer Link → 404, Zaehler
  unveraendert (kein Orakel); E-05 Axe; E-06
  Server-Log ohne Fehler (F10-17-E-06/E-07-
  Muster).
- Nachbarn: F10-12 (Protokoll), F10-17
  (My-Files), m111a-Pins (0183),
  `db:roles:verify`.

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; DB-Tests + E2E Chromium gruen;
  Heartbeat + Push + CI gruen.
