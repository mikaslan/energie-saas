# SPEC F10-17 — Portal My-Files: Visible-Flag + Kunden-Download (Katalog F10.2)

## Matrix
Katalog F10.2 („My Files (Visible to customer)"):
Kunde sieht im Portal freigeschaltete Projekt-Dateien und
laedt sie herunter. Natuerlicher F7-16-Folgeslice (0181 hat
Portal/Flag/Loeschen explizit zurueckgestellt, F7-16-SPEC
Zeile 9). Loeschen bleibt Folgeslice.

Praezedenz-Korrektur (verifiziert, keine Annahme): F10-11
war KEIN Portal-Download, sondern der INTERNE Einzel-
Download eines Folge-Belegs (`downloadFileRequestUpload`,
modules/file-requests/service.ts:450ff + Base64-Action
`downloadFileRequestUploadAction`, app/w/[workspaceId]/
anfragen/[projectId]/file-request-actions.ts:190ff; die
Portal-file-requests-Route hat nur POST, app/p/[token]/
file-requests/route.ts:61). Das Portal-Download-Muster
ist F10-07: `readPortalDocumentArtifactByToken`
(modules/offers/issuance-service.ts:934ff) + anonyme
Token-Route `GET app/p/[token]/dokumente/[issuanceId]/
route.ts` + DEFINER-Funktion `read_portal_issuance_
artifact` (0116), Kapsel `publicTokenCapsule`
(lib/action.ts:215). F10-17 uebernimmt F10-07 EXAKT
(Kapsel, Guards, Header, Zugehoerigkeits-Check).

## Bestand (verifiziert am Code)
- Portal `app/p/[token]/page.tsx`: Tabs uebersicht/
  termine/installation/dateien. Der Dateien-Tab
  (Zeile 364-397) zeigt NUR `view.fileRequests`
  (`PortalFileRequest`: id, title, description,
  status, createdAt, uploadedAt, originalFilename,
  allowMany, uploadCount, filenames, fileType,
  subsidyLinked — lib/integrations/portal/portal-
  contract.ts:154ff) mit Upload-Formularen an den
  Kunden. Das sind Anfragen AN den Kunden, keine
  Dateien FUER den Kunden.
- Uebersichts-Tab: `view.documents` mit Download-
  Links auf `/p/[token]/dokumente/[id]` (F10-07,
  page.tsx:646ff) + Rechnungen ohne Download (F8-15).
- `grep project_file|projectFile|myFile` ueber
  lib/integrations/portal + app/p + Resolver: NULL
  Treffer. `project_file` fehlt in
  `resolve_portal_public_view` vollstaendig; ein
  Visible-Flag existiert nirgends (F10-14-
  `portal_status_label.visible` ist Workspace-
  Anzeigestands-Sichtbarkeit, kein Datei-Flag).
- Resolver: `resolvePortalByToken`
  (modules/portal/service.ts:414) ruft DEFINER
  `public.resolve_portal_public_view` (letztes
  Replace 0179, ~920 Zeilen, beide Owner-Tanz-
  Ruempfe). Ansicht-Schema `portalPublicViewV1Schema`
  (portal-contract.ts:294ff); Alt-Projektions-Muster
  `z.unknown().optional()` (fileRequests Zeile 347).
- Intern: `modules/project-files/service.ts` (upload/
  list/download, alle intern-nur), DTO
  `ProjectFileDto` ohne Flag; UI
  `project-file-section.tsx` (Client, Upload + Liste
  + Download-Link auf Session-Route `.../dateien`);
  Loader page.tsx:1037ff mit Read/Write-Gates.

## Ziel
Interne Rolle schaltet je Projekt-Datei „Fuer Kunden
sichtbar" (Default unsichtbar); Portal-Dateien-Tab
zeigt dem Kunden (ohne Login, nur Token-Link) die
freigeschalteten Dateien mit Download-Links; Bytes
bytegleich zum internen Download. Unsichtbare Datei
im Portal: als gaebe es sie nicht (Liste + Download
uniform NotFound, kein Orakel). Kein Loeschen, keine
neue Permission, kein neuer Provider.

## Entwurf (F10-14-Flag + F10-07-Download gekreuzt)
- Flag `visible_to_customer` auf `project_file`
  (DEFAULT false = sicherer Default: nichts wird
  versehentlich sichtbar; Gegenpol zu F10-14-
  `visible` DEFAULT true, dort verhaltenserhaltend).
- Toggle-Op `setProjectFileVisibility` (project.write
  + intern-nur, file-requests-Muster): plain UPDATE
  per (workspace, projekt, id) — Zeile existiert
  immer (kein F10-14-Upsert-NoOp-Tanz noetig, dort
  war die Zeile optional); fehlende Zeile = uniform
  NotFound; Audit `project_file.visibility_set` mit
  `{projectId, fileId, visible}` (kein PII).
- Portal-Projektion: Resolver-Replace (0172/0179-
  Vollkopie, beide Ruempfe) + `projectFiles`-Key in
  `portalPublicViewV1Schema` (optional im Resolver-
  Parse, Alt-Projektion = leer, F10-04-Muster).
- Portal-Download: F10-07 exakt — Service prueft
  Projektion (Zugehoerigkeit zu `view.projectFiles`)
  + DEFINER-Funktion mit eigenem Sichtbarkeits-
  WHERE (Defense in Depth); Route mit privaten
  Headern + Attachment.

## Vertrag DB (0182, Spalte + Resolver + Kapsel)
- `drizzle/0182_f10_17_portal_my_files.sql`
  (0182-0189 frei, verifiziert: nur 0180/0181 in
  018x; Journal-End-Eintrag + `TOTAL_MIGRATION_
  COUNT` 161 → 162 in tests/db/m111a-project-
  outcome-migration-upgrade.test.ts:128).
- Generator-Anteil (Schema-TS +
  `lib/db/schema/project-file.ts`: `visibleToCustomer:
  boolean("visible_to_customer").notNull().default
  (false)`, danach `db:generate` + Snapshot
  `0182_snapshot.json`, Re-Run ohne Drift —
  0181-Muster): Spalte `visible_to_customer boolean
  NOT NULL DEFAULT false`. KEIN Backfill-Drama dank
  DEFAULT (alle Bestandszeilen unsichtbar, F10-14-
  Muster). KEIN Werte-CHECK (BOOLEAN + NOT NULL =
  zweiwertig). Schema-Kommentar korrigieren: 0181
  sagt „kein UPDATE-Pfad" — 0182 bringt den ersten
  (nur diese Spalte; Bytes/Key bleiben immutabel).
- Hand-Anteil 1 (Resolver-Replace, Owner-Tanz wie
  0172/0179, beide Ruempfe, Signatur unveraendert —
  Grants bleiben): `project_files_list` via
  `jsonb_agg(jsonb_build_object('id',...,
  'originalFilename',..., 'contentType',...,
  'byteSize',..., 'createdAt',...))` ueber
  `project_file` mit `workspace_id + project_id
  aus dem Invite` UND `visible_to_customer = true`,
  ORDER newest-first (`created_at DESC, id DESC`,
  F7-16-Listen-Muster); fehlend = `[]`. NIE
  `storage_key`/`file_sha256` projizieren (F10-04-
  QR-Muster). DEFINER-Grant im Tanz:
  `GRANT SELECT ON public.project_file TO
  app_owner` (Muster 0179 Zeile 461ff).
- Hand-Anteil 2 (Download-Kapsel, F10-07/0116-
  Muster): `read_portal_project_file_artifact
  (token_hash bytea, file_id uuid)` (SECURITY
  DEFINER, read-only, kein Event/Touch): Invite
  gueltig (aktiv, nicht abgelaufen) + Zeile in
  Mandant+Projekt + `visible_to_customer = true`
  → Artefakt-Zeile (Dateiname, MIME, Bytes, SHA,
  Groesse), sonst NULL Zeilen (kein Orakel).
  Sichtbarkeits-Check ZWINGEND in der Funktion
  (nicht nur im Service).
- RLS unveraendert (tenant_isolation + FORCE auf
  project_file, 0181); Grants: DEFINER-SELECT
  (Kapsel) + `UPDATE` an app_runtime (Toggle;
  ohne schlaegt der Toggle permission-denied
  fehl — E2E-Befund); KEINE neue Permission
  (`db:roles:verify` + ACL-Pin).
- Rollenvertrag (`scripts/db-role-contract.mts`,
  Muster Zeile 4449): Stufenmarker
  `hasPortalProjectFilesProjection` (prosrc
  enthaelt `project_files_list`, Muster
  `hasPortalStatusVisibilityProjection`); neue
  Kettenstufe mit geerntetem Prosrc-Pin (alte
  Prefixe bleiben gruen).

## Vertrag App
- `modules/project-files/service.ts`:
  - `ProjectFileDto` += `visibleToCustomer: boolean`
    (interne Liste zeigt Toggle-Zustand).
  - `listProjectFiles`: SELECT += `visible_to_customer`
    (Gates unveraendert: project.read +
    `!isExternalOnly`).
  - `setProjectFileVisibility(tx, ctx, {projectId,
    fileId, visible})`: `requireWrite` (project.write
    + `!isExternalOnly`, service.ts:78-Muster);
    Zod strikt (uuid lowercased, striktes Boolean);
    UPDATE `visible_to_customer` WHERE (workspace,
    projekt, id) → 0 Zeilen = NotFound uniform;
    `writeAudit` (`@/lib/audit`, action
    `project_file.visibility_set`, transition-
    Muster). KEIN Domain-Event (kein Konsument).
  - `readPortalProjectFileByToken(pool, {token,
    fileId})` (F10-07-Muster, Portal-Import ohne
    Zyklus wie issuance-service): `resolvePortalBy
    Token` (PortalNotFound → `ProjectFileNotFound
    Error`, uniform) → Zugehoerigkeit zu
    `view.projectFiles` (gleicher Fehler —
    unsichtbar faellt hier automatisch heraus) →
    `hashPortalToken` → DEFINER `read_portal_
    project_file_artifact` → 0 Zeilen = NotFound,
    !=1 = Integrity; SHA256/Laenge wie interner
    Pfad (Mismatch → Integrity). Keine neue
    Permission (rollenloser Token-Pfad).
- Intern-UI: `project-file-section.tsx` — Toggle je
  Zeile („Fuer Kunden sichtbar", nur canWrite):
  Server-Action `setProjectFileVisibilityAction`
  in NEUER Datei `project-file-actions.ts` neben
  `file-request-actions.ts` (`transitionFileRequest
  Action`-Muster Zeile 136ff: parseIds + uuid +
  `authorizedAction(project.write)` + `revalidate
  Path` + mapError; KEIN Routen-Umbau — `.../
  dateien` bleibt Upload/Download). Positiv- +
  Fehler-Feedback deutsch (error/success-Muster
  der Sektion). Toggle-Text deutsch only (interne
  App bleibt deutsch, F10-06-Regel).
- Contract (`lib/integrations/portal/portal-
  contract.ts`, F10-04/10/13/15-Kommentar-Muster):
  `portalProjectFileSchema = z.strictObject({id:
  z.uuid(), originalFilename: z.string(),
  contentType: z.string(), byteSize: z.number().
  int().min(1), createdAt: z.iso.datetime(...)})`
  (KEIN Key/Hash — F10-04-QR); `portalPublicView
  V1Schema` += `projectFiles: z.array(...)`;
  `portalResolveOkSchema` += `projectFiles:
  z.unknown().optional()` (Alt-Projektion = leer);
  `parsePortalPublicView`: strikter Parse je Eintrag
  (deformiert → Eintrag verwerfen oder null fail-
  closed — Entscheid: null fail-closed wie
  F10-14-statusVisibility, kein Teil-Render).
- Portal-UI (`app/p/[token]/page.tsx`, Dateien-Tab
  Zeile 364ff): NEUE Sektion „Vom Anbieter
  bereitgestellt" UNTER der File-Request-Liste im
  SELBEN Tab (kein neuer Tab — Leiste schon 4
  Tabs; F10-07-Dokumente bleiben in der Uebersicht).
  Je Datei: Name, Groesse (Portal-Locale-Format),
  Datum (`formatPortalDate`), Download-Link
  (`<Link href=/p/[token]/dateien/[id]?lang=...>`,
  F10-07-Link-Muster page.tsx:646ff). Leertext wenn
  keine sichtbaren Dateien. Neue Labels (Heading +
  Leertext) in `PortalStrings` + alle 11 Kataloge
  (portalLangs: de/en/cs/el/es/fr/hu/it/nl/pl/ro —
  F10-06-Muster; Dateinamen selbst nie uebersetzt).
  Download-Wort `downloadWord` wiederverwenden
  (existiert, F10-07).
- Route `GET app/p/[token]/dateien/[fileId]/
  route.ts` (F10-07-`dokumente`-Route exakt
  kopiert): `paramsSchema` (token min(1) + fileId
  uuid-lowercased), `PRIVATE_HEADERS` (private/
  no-store/no-cache/nosniff/no-referrer/DENY/
  sandbox) + `privateFailure(404/503)`; Kapsel
  `publicTokenCapsule((pool) => readPortalProject
  FileByToken(...))`; Guards: Dateiname-Pattern
  auf pdf/jpg/jpeg/png erweitert (F10-07-Pattern
  ist pdf-only — neuer `SAFE_PROJECT_FILE_PATTERN`
  mit gleicher Strenge: ASCII-Start, 1..200,
  Allowlist-Endung), MIME aus Allowlist
  (`PROJECT_FILE_CONTENT_TYPES`-Spiegel, kein
  Echo ungepruefter DB-Werte), Magic-Bytes je Typ
  (%PDF / JPEG-SOI / PNG-Signatur statt F10-07-
  PDF-only + EOF). `Content-Disposition: attachment`
  (RFC-5987, Angebots-PDF-Muster) + `Content-Type`
  aus validierter Allowlist + `Content-Length`.
  Fehler: NotFound → 404, Integrity → 503 (F10-07-
  Muster). Keine `lang`-Pflicht (Link traegt sie).
  Verworfen: Session-Route — Portal ist anonym per
  Token-Kapsel (kein Session-Kontext, F10-07-Regel).

## Sicherheit
- Sichtbarkeit doppelt geschlossen: Resolver-WHERE
  + Kapsel-WHERE + Service-Zugehoerigkeits-Check;
  unsichtbar/fremd/tot → ueberall identisch 404
  (kein Orakel zwischen „Link tot", „Datei fremd",
  „Datei unsichtbar").
- Key/Hash nie ans Portal (Projektion + Route +
  Download-Antwort tragen nur Metadaten/Bytes);
  Dateiname nie im Storage-Key (F7-16); Download
  id-adressiert (kein Key in URL).
- Upload-Pfad unveraendert intern-nur (Toggle ist
  kein Schreibakt am Portal — Portal bleibt read-
  only ausser bestehenden F10-04/15-POSTs).
- RLS + FORCE; `db:roles:verify` gruen (nur neuer
  Stufenmarker, kein Rollen-Pin-Umbau).

## Tests (RED zuerst)
- DB: `tests/db/f1017-portal-my-files.test.ts` —
  D-01 INSERT ohne Flag → `visible_to_customer =
  false` (Default); D-02 Toggle flip false→true→
  false (Roundtrip, andere Spalten unberuehrt);
  D-03 Toggle fremde ID → NotFound (kein Orakel);
  D-04 Resolver projiziert NUR sichtbare (je 1
  sichtbar/unsichtbar angelegt → Liste = 1, DTO
  ohne Key/Hash); D-05 Download-Kapsel unsichtbar
  → 0 Zeilen (NotFound), sichtbar → Bytes/SHA/
  Groesse; D-06 RLS: fremder Workspace liest
  nichts (Toggle + Liste); D-07 Externer
  (Membership `capabilities {"external_only":
  true}`, Viewer): Toggle/Liste/interner Download
  alle `PermissionDeniedError` (F7-16-D-10-Muster,
  kein E2E — kein Externen-Fixture).
- Contract (Unit): C-01 `parsePortalPublicView`
  mit `projectFiles` → DTO-Shape (5 Felder, kein
  Key/Hash); C-02 ohne Key (Alt-Projektion) → [];
  C-03 deformiert (fremde Keys, Key/Hash drin,
  byteSize 0) → null fail-closed.
- E2E: `tests/e2e/f10-17-portal-my-files.spec.ts`
  (Setup nach F7-16: `m1-11g-fixture`, Admin+
  Viewer, isolierter Workspace; Portal-Token per
  Invite-Builder wie F10-07-E2E) — E-01 Admin
  laedt Datei hoch → Portal (ohne Login, Token-
  Link) Dateien-Tab zeigt sie NICHT (Default
  unsichtbar); E-02 Admin toggelt sichtbar →
  Portal zeigt Name/Groesse/Datum + Download-
  Link, GET-Bytes bytegleich; E-03 zurueck-
  toggeln → weg aus Portal-Liste, alter Download-
  Link → 404 (kein Orakel); E-04 fremde fileId →
  404; E-05 interner Viewer liest Liste inkl.
  Flag, sieht KEIN Toggle (canWrite-Gate); E-06
  Axe; E-07 Server-Log ohne Fehler (readFileSync/
  statSync-Muster 02g).
- Nachbarn: F7-16 (Upload/Liste), F10-07 (Portal-
  Download), F10-14 (Toggle/Resolver-Muster),
  F10-06 (11 Sprachen), m111a-Pins (0182),
  `db:generate` ohne Drift.

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; E2E Chromium gruen; Heartbeat +
  Push + CI gruen.
