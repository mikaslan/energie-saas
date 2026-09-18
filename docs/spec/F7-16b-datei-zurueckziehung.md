# SPEC F7-16b — Projekt-Datei-Zurueckziehung (soft Withdraw, Katalog F7.1)

## Matrix
F7-16-SPEC Zeile 74-79 („Loeschen = Folgeslice mit
Status + Portal-Regel", file_request-Praezedenz:
„storniert nur logisch, nie DELETE"); F10-17-SPEC
Zeile 8 („Loeschen bleibt Folgeslice"). F10-18 hat
die Kapsel um den Download-Insert erweitert — der
Withdraw muss BEIDE Kapsel-WHEREs schliessen
(sonst Log-ohne-Lieferung). Parent-verifiziert +
hier bestaetigt: `grep withdraw|delete|remove`
ueber modules/project-files = NULL Treffer (kein
Loesch-Pfad vorhanden). KEIN physisches DELETE —
WORM-Bruch verboten (F7-16-SPEC Z.52-55:
append-only, kein Dedupe/Ueberschreiben).

## Bestand (verifiziert am Code)
- `modules/project-files/service.ts`: upload/list/
  download (alle intern-nur, service.ts:98-108) +
  `setProjectFileVisibility` (Z.292-319: plain
  UPDATE per (workspace, projekt, id), 0 Zeilen =
  NotFound, Audit `project_file.visibility_set`
  Z.310-317, KEIN Domain-Event) +
  `readPortalProjectFileByToken` (Z.348-413:
  Projektion → Zugehoerigkeit Z.363-365 → Kapsel
  Z.370-377). DTO `ProjectFileDto` Z.71-78.
- Schema `lib/db/schema/project-file.ts`:
  `visibleToCustomer` Z.37; Kommentar Z.17-23
  („einziger UPDATE-Pfad seit F10-17" — 0184
  bringt den zweiten).
- 0182 (1077 Zeilen): Spalte Z.10; Resolver-
  Ruempfe Z.17ff + Z.497ff; `project_files_list`
  Z.45/432ff/525/912ff, WHERE `visible_to_
  customer = true` Z.444 + Z.924; Kapsel
  `read_portal_project_file_artifact` Z.967-1023
  (WHERE Z.1021); SELECT-Grants an app_owner
  Z.495/1064.
- 0183 (202 Zeilen): Kapsel-Replace beide Ruempfe
  Z.32ff + Z.118ff; SELECT INTO (Auslieferungs-
  bedingung) + Download-Insert + RETURN QUERY;
  Kommentar „Auslieferungsbedingung = gleiche
  Sichtbarkeit wie unten" (Sync-Pflicht!).
- Storno-Praezedenz file-requests: Enum 0104 Z.19
  (offen/hochgeladen/erledigt/storniert), 0104
  Z.54-55 („storniert nur aus offen (logisch, nie
  DELETE)"); Maschine `lib/file-request.ts`
  (`offen: [storniert]`, `storniert: []` =
  terminal); Storno-Pfad `transitionFileRequest`
  (service.ts:347-408: SELECT FOR UPDATE +
  UPDATE + Event + Audit). `listFileRequests`
  (Z.335-344) hat KEINEN Status-Filter —
  storniert bleibt intern sichtbar.
- Rollenvertrag (`scripts/db-role-contract.mts`):
  UPDATE-Grant Z.3467 (`grant select, insert,
  update on public.project_file to app_runtime`,
  F10-17-Kommentar Z.3452-3455); Resolver-Marker
  Z.4465-4469 (`project_files_list`); Kapsel-
  Marker Z.4505-4517 (`portal_download_log`);
  Resolver-Pin Z.5931-5967 (0182-Hash
  `5a8abb76…` Z.5934); Kapsel-Pin Z.6001-6009
  (0183 `2e4e2be4…` Z.6007, 0182 `bec8c5ea…`
  Z.6008).
- UI: `project-file-section.tsx` (Toggle Z.78-138,
  Zeile Z.246-283, dt. Feedback); `project-file-
  actions.ts` (Action Z.50-77: parseIds +
  parseFileId + `authorizedAction(project.write)`
  + `revalidatePath` + mapError).
- Portal-Contract: `portalProjectFileSchema`
  Z.173-180, `projectFiles` Z.318 + Z.363; Route
  `app/p/[token]/dateien/[fileId]/route.ts`
  existiert (F10-17).
- m111a: TOTAL 163 (Z.130), idx 162 + Tag 0183
  (Z.446-447), Kommentar Z.127-129. Journal:
  idx 162, when 1789674836729 (0183).
- 018x enthaelt nur 0180/0181/0182/0183 →
  0184-0189 FREI (verifiziert). `withdrawn`
  existiert nur an `offer_issuance_withdrawal`
  (0035) — `project_file.withdrawn` kollidiert
  nicht.

## Ziel
Interne Rolle zieht je Projekt-Datei zurueck
(soft, one-way, Default aktiv). Portal: Datei
als gaebe es sie nicht (Liste + Download
uniform NotFound, kein Orakel). Intern: Zeile
bleibt mit Status-Badge sichtbar, Download
weiter erlaubt (Beleg). Kein physisches DELETE,
keine neue Permission, kein neuer Provider.

## Entwurf (F10-17-Flag + Storno-Semantik)
- ENTSCHEIDUNG Status-Abbildung: BOOLEAN-Spalte
  `withdrawn DEFAULT false` (F10-17-Toggle-
  Muster), KEIN Status-Enum. Begruendung: das
  file_request-Enum traegt eine 4-Zustands-
  Maschine mit gerichteten Transitionen
  (`allowedTransitions`, lib/file-request.ts) —
  project_file hat nur EINEN Uebergang (aktiv →
  zurueckgezogen, terminal wie `storniert:
  []`). Ein 2-Wert-Enum waere Boolean mit
  CHECK-Overhead. BOOLEAN + NOT NULL =
  zweiwertig ohne CHECK (F10-17-SPEC-Muster).
  Der Storno-Pfad (`transitionFileRequest`:
  lesen → NotFound → UPDATE → Audit) liefert
  die Semantik-Vorlage (terminal, logisch, nie
  DELETE), nicht den Datentyp.
- Withdraw ist ONE-WAY (terminal, kein
  Re-Activate in diesem Slice — wie storniert
  terminal ist); Reversibilitaet = Folgeslice.
  Idempotent: erneuter Withdraw = Erfolg ohne
  Aenderung, Audit nur beim Flip (kein
  Rauschen bei Retry).
- Orthogonalitaet: Withdraw aendert
  `visible_to_customer` NICHT. Portal-
  Sichtbarkeit = sichtbar UND NICHT
  zurueckgezogen. (Falls je Re-Activate kommt,
  bleibt das Flag erhalten.)
- ENTSCHEIDUNG intern sichtbar: zurueckgezogene
  Dateien BLEIBEN in der internen Liste, mit
  Status-Badge. Begruendung: Beleg-Nachvollzug
  schlaegt Aufraeumen — WORM-Audit (`project_
  file.uploaded`) duerfte sonst auf unsichtbare
  Zeilen zeigen; Praezedenz `listFileRequests`
  ohne Status-Filter (s. Bestand).
- ENTSCHEIDUNG interner Download: ERLAUBT
  (Beleg). Begruendung: WORM-Bytes sind
  unveraenderlich und dienen als Beleg;
  F10-11-Muster laedt Belege unabhaengig vom
  Anfrage-Status; Zurueckziehung entzieht nur
  Portal-Sicht + markiert intern. Gegenpol:
  Portal-Download → uniform 404.
- Portal dreifach geschlossen (F10-17-Muster):
  Resolver-WHERE + Kapsel-WHERE + Service-
  Zugehoerigkeit (faellt automatisch heraus).

## Vertrag DB (0184, Spalte + Resolver + Kapsel)
- `drizzle/0184_f7_16b_datei_zurueckziehung.sql`
  (0184-0189 frei, verifiziert).
- Generator-Anteil (Schema-TS + `db:generate` +
  Snapshot `0184_snapshot.json`, Re-Run ohne
  Drift — 0181/0182-Muster): `withdrawn:
  boolean("withdrawn").notNull().default
  (false)` in `lib/db/schema/project-file.ts`
  (nach `visibleToCustomer` Z.37); Spalte
  `withdrawn boolean NOT NULL DEFAULT false`.
  KEIN Backfill-Drama (alle Bestandszeilen
  aktiv). KEIN Werte-CHECK (zweiwertig).
  Schema-Kommentar Z.17-23 korrigieren: 0184
  bringt den zweiten UPDATE-Pfad (nur diese
  Spalte; Bytes/Key bleiben immutabel).
- Hand-Anteil 1 (Resolver-Replace, 0182-
  Vollkopie — 0183 fasste den Resolver NICHT
  an; Owner-Tanz, beide Ruempfe 0182 Z.17ff +
  Z.497ff, Signatur unveraendert — Grants
  bleiben): `project_files_list`-WHERE +
  `AND pfile.withdrawn = false` (0182 Z.444 +
  Z.924); ORDER + Projektion unveraendert
  (nie Key/Hash).
- Hand-Anteil 2 (Kapsel-Replace, 0183-Vollkopie
  INKL. Download-Insert, beide Ruempfe 0183
  Z.32ff + Z.118ff, Signatur unveraendert):
  BEIDE WHEREs + `AND pfile.withdrawn =
  false` — SELECT INTO (Auslieferungsbedingung)
  UND RETURN QUERY, je Rumpf (Sync-Pflicht per
  0183-Kommentar; sonst Log-ohne-Lieferung).
  Fehlschlag (zurueckgezogen) schreibt nichts
  (F10-18-Regel: kein Orakel, kein Rauschen).
- Journal: idx 163, Tag `0184_f7_16b_datei_
  zurueckziehung`, when > 1789674836729,
  breakpoints true.
- RLS unveraendert (tenant_isolation + FORCE,
  0181). Grants UNVERAENDERT: UPDATE-Grant
  Z.3467 ist table-level (spaltenunabhaengig)
  und deckt `withdrawn`; SELECT-Grants an
  app_owner bestehen (0182 Z.495/1064). KEINE
  neue Permission (`db:roles:verify` + ACL-Pin).
- Rollenvertrag (`scripts/db-role-contract.mts`,
  F10-17/F10-18-Muster): prosrc aendert sich an
  BEIDEN Funktionen → ZWEI neue Stufenmarker +
  BEIDE Hash-Pins neu ernten:
  - Resolver: `hasPortalProjectFileWithdrawn
    Projection` (Muster Z.4465-4469; Resolver-
    prosrc enthaelt `withdrawn`); neuer Hash
    als innerste Ternaer-Stufe im Resolver-Pin
    Z.5931-5967 (0182-Hash `5a8abb76…` Z.5934
    bleibt fuer Prefixe).
  - Kapsel: `hasPortalProjectFileWithdrawn`
    (Muster Z.4505-4517; Kapsel-prosrc
    enthaelt `withdrawn`); neuer Hash im
    Kapsel-Pin Z.6001-6009 (0183 `2e4e2be4…`
    Z.6007 + 0182 `bec8c5ea…` Z.6008 bleiben
    fuer Prefixe). Hashes per Probe ernten
    (Methode gegen 0182/0183-Pins bewiesen).
  - UNVERAENDERT: Policy-Pin, ACL-Pin,
    Relationen, Grant-Canon (F10-18-Muster).
- m111a-Pins: TOTAL 163→164 (Z.130), idx
  162→163 + Tag (Z.446-447), Kommentar-Zeile
  (Z.127-129: F7-16b-Zeile ergaenzen).

## Vertrag App
- `modules/project-files/service.ts`:
  - `ProjectFileDto` += `withdrawn: boolean`;
    `ProjectFileRow` += `withdrawn`;
    `listProjectFiles` (Z.217-244): SELECT +=
    `withdrawn`, KEIN WHERE-Filter (interne
    Liste zeigt alles, newest-first
    unveraendert).
  - `downloadProjectFile` (Z.246-278):
    UNVERAENDERT (kein Withdraw-Guard —
    interner Download bleibt Beleg; Entscheid
    s. Entwurf). Verworfen: NotFound fuer
    zurueckgezogene — braeche den Beleg-
    Nachvollzug ohne Katalog-Auftrag.
  - NEU `withdrawProjectFile(tx, ctx,
    {projectId, fileId})` (file-requests-
    Lese-Muster + F10-17-Toggle-Muster):
    `requireWrite` (project.write +
    `!isExternalOnly`, Z.104-108); Zod strikt
    (uuid lowercased, fileId-Pflicht);
    SELECT FOR UPDATE per (workspace,
    projekt, id) → 0 Zeilen = NotFound
    uniform; bereits `withdrawn = true` →
    Erfolg OHNE Audit (idempotent, Flip-only);
    sonst UPDATE `withdrawn = true` +
    `writeAudit` (`@/lib/audit`, action
    `project_file.withdrawn`, Partizip wie
    `project_file.uploaded` service.ts:209,
    details `{projectId, fileId}`, kein PII).
    Return `{fileId, withdrawn: true}`. KEIN
    Domain-Event (kein Konsument, F10-17).
  - `readPortalProjectFileByToken`
    UNVERAENDERT (Zugehoerigkeit Z.363-365
    wirft NotFound — zurueckgezogen faellt
    automatisch heraus; Kapsel prueft erneut).
- Intern-UI: `project-file-section.tsx` —
  Withdraw-Button je NICHT-zurueckgezogener
  Zeile (nur canWrite, neben Toggle/Download);
  Server-Action `withdrawProjectFileAction` in
  `project-file-actions.ts` (Muster Z.50-77:
  parseIds + parseFileId + `authorizedAction
  (project.write)` + `revalidatePath` +
  mapError; KEIN Routen-Umbau). Bestaetigung:
  Zwei-Klick (scharfschalten + „Wirklich
  zurueckziehen", rot, aria-label je Datei) —
  E2E-Befund: nativer `confirm()`-Dialog im
  Event-Fluss umgeht Reacts Action-Interception
  (nativer Submit + Reload statt Action-State;
  `useActionState` sah nie pending/success).
  Status-Anzeige:
  „Zurueckgezogen"-Badge je Zeile fuer ALLE
  internen Leser (canWrite sieht Button nur
  bei aktiven Zeilen). Positiv-/Fehler-
  Feedback deutsch (error/success-Muster der
  Sektion; Toggle-Texte bleiben). Intern
  deutsch only (F10-06-Regel).
- Contract (`portal-contract.ts`): KEIN Change
  (`portalProjectFileSchema` Z.173-180 +
  `projectFiles` Z.318/363 unveraendert —
  zurueckgezogene fallen im Resolver heraus;
  kein neues Feld noetig).
- Portal-UI + Portal-Route: KEIN Change
  (Liste ohne Datei, alter Link → 404 via
  Service-NotFound, F10-17-Muster).

## Sicherheit
- Portal dreifach geschlossen: Resolver-WHERE
  + Kapsel-BEIDE-WHEREs + Service-
  Zugehoerigkeit; zurueckgezogen/fremd/tot →
  ueberall identisch 404 (kein Orakel).
- Kapsel-Sync: Auslieferungsbedingung =
  Lieferbedingung (Withdraw in beiden WHEREs
  — sonst Log-ohne-Lieferung oder Lieferung-
  ohne-Log).
- Key/Hash nie ans Portal (unveraendert);
  Withdraw ist intern-nur (project.write +
  `!isExternalOnly`); Upload-Pfad + RLS +
  FORCE unveraendert; `db:roles:verify` gruen
  (nur Marker + Hash-Pins).
- WORM unangetastet: Zeile + Bytes bleiben;
  nur das Flag flipt (logisch, nie DELETE —
  0104-Regel).

## Tests (RED zuerst)
- DB: `tests/db/f716b-datei-zurueckziehung.
  test.ts` (F1017/F1018-Muster: `tenantQuery`
  + Fixture-Helfer) — D-01 INSERT ohne Flag →
  `withdrawn = false` (Default); D-02 Withdraw
  flip false→true (andere Spalten unberuehrt:
  `visible_to_customer` bleibt — Ortho-
  gonalitaet); D-03 Withdraw fremde ID →
  NotFound (kein Orakel); D-04 Idempotenz:
  zweiter Withdraw → Erfolg, KEIN zweites
  Audit (Flip-only); D-05 Resolver projiziert
  Zurueckgezogene NICHT (sichtbar+zurueck-
  gezogen angelegt → fehlt in `projectFiles`,
  DTO ohne Key/Hash); D-06 Kapsel: zurueck-
  gezogen-sichtbar → 0 Zeilen (NotFound) +
  KEINE Download-Log-Zeile (F10-18-Sync);
  aktiv-sichtbar → Bytes/SHA/Groesse + genau
  1 Log-Zeile (Regression); D-07 intern:
  Liste enthaelt Zurueckgezogene mit
  `withdrawn = true`, Download-Bytes
  bytegleich (Beleg); D-08 RLS: fremder
  Workspace liest nichts; D-09 Externer
  (Membership `capabilities {"external_only":
  true}`, Viewer): Withdraw/Liste/interner
  Download alle `PermissionDeniedError`
  (F7-16-D-10-Muster, kein E2E). KEIN
  CHECK/FK-Test: BOOLEAN ohne Enum (entfaellt
  mit Begruendung, F10-17-Muster).
- KEINE Contract-/Unit-Tests (kein Contract-,
  kein Portal-Service-Change — F10-18-Muster).
- E2E: EIGENE Datei `tests/e2e/f7-16b-datei-
  zurueckziehung.spec.ts` (Spec-File-je-Slice-
  Muster f10-14/15/16/17/18; Setup nach F10-17:
  `m1-11g-fixture`, Admin+Viewer, isolierter
  Workspace, Invite-Builder wie F10-07-E2E) —
  E-01 Admin laedt hoch + toggelt sichtbar →
  Portal-Dateien-Tab zeigt Datei; E-02 Admin
  zieht zurueck (zwei Klicks) → Portal-
  Liste ohne Datei, alter Download-Link → 404
  (kein Orakel); E-03 intern: Zeile mit Badge,
  Download weiter bytegleich; E-04 Reload
  persistent; E-05 interner Viewer: Badge
  sichtbar, KEIN Button (canWrite-Gate);
  E-06 Axe; E-07 Server-Log ohne Fehler
  (readFileSync/statSync-Muster 02g).
- Nachbarn: F7-16 (Upload/Liste), F10-17
  (Toggle/Resolver/Kapsel), F10-18 (Log-Sync),
  m111a-Pins (0184), `db:generate` ohne Drift.

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; DB-Tests + E2E Chromium gruen;
  Heartbeat + Push + CI gruen.
