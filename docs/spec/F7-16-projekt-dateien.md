# SPEC F7-16 — Projekt-Dateien-Kern: interner Upload + Liste (Katalog F7.1/F10.2-Vorstufe)

## Matrix
Katalog F7.1 („Files"-Tab an der Projektakte) und F10.2-
Vorstufe (interne Dateiablage, auf die das Portal spaeter
sichtbar schaltet). F7-15-SPEC Zeile 18-22 hat diesen Slice
als machbar ohne Provider eingestuft (Praezedenzen unten
bestaetigt) und als Folgeslice zurueckgestellt. Portal,
Visible-Flag und Loeschen sind explizit Folgeslices.

Upload-Pfad-Entscheid: EIGENE Session-Route POST/GET
`app/api/workspaces/[workspaceId]/projects/[projectId]/
dateien/route.ts` (foto-Muster kopiert, generische Typen).
Verworfen mit Beleg: a) `.../checkliste/foto/route.ts`
wiederverwenden — foto-spezifisch (Fix-Typen jpeg/png per
`CHECKLIST_PHOTO_CONTENT_TYPES`, Domain `checklist-photos`,
Key an Checklisten-Punkt gebunden, Permission
checklist.read/write; modules/checklists/service.ts:395ff).
b) F10-10-Pfad (`fulfillFileRequestByToken`,
modules/file-requests/service.ts:505ff + Portal-Route
`app/p/[token]/file-requests/route.ts`) — strikt anonymer
Token-Pfad (`publicTokenCapsule`, Kapsel
`fulfill_file_request`, Anfrage-Bindung); kein Session-
Kontext, keine generische Route. Es gibt KEINE generische
interne Upload-Route (nur foto + gegenzeichnung +
address-candidates unter app/api/workspaces). c) Server-
Action — 10-MiB-Klasse sprengt das 1-MB-Action-Limit
(F10-04-Praezedenz, Kommentar foto/route.ts:14-18).

## Ziel
Interne Rolle laedt je Projekt PDF-/Bild-Dateien hoch
(25 MiB, pdf/jpg/jpeg/png); Liste mit Name, Groesse,
Datum, Download-Link auf der Projekt-Anfragenseite;
Reload-fest; interner Viewer liest (externer sieht
weder Sektion noch Bytes — Gate, D-10). Kein Portal,
kein Visible-Flag, kein Loeschen.

## Entwurf (foto + file-request gekreuzt, neue Tabelle)
- Route `.../dateien` (Session, intern): POST
  `project.write` (FormData-Feld `datei`, 1 Datei pro
  Request, Client-Loop bei Mehrfachwahl — KEIN
  Multipart-Batch in einem Request, foto-Praezedenz);
  GET `project.read` mit `?fileId=<uuid>` (id-
  adressiert, Key nie in URL/Antwort). Fehler uniform
  (`invalid`/`not_found`/`forbidden`/`unauthenticated`/
  `error`, kein Key-Leak, foto/route.ts:23-89-Muster).
- Key `immutable/<projektId>/project-files/
  <dateiId>_<sha8>.<ext>` (Service-seitig gebaut;
  `dateiId` = frische Zeilen-UUID, nicht Client-
  Input). Dateiname landet NIE im Key (Traversal
  tot, strikter als F10-10-`sanitizeStorageStem`).
  Re-Upload derselben Bytes = NEUE Zeile mit neuem
  Key (kein Dedupe, kein Ueberschreiben — WORM +
  append-only; der Konflikt-Fall existiert nur bei
  UUID-Kollision und faellt fail-closed).
- POST-Ablauf: validieren (Typ/Endung/Bytes) →
  `requireProject` (Fail-fast VOR dem Put, kein
  Orphan bei Fremdprojekt) → `putImmutable`
  (`resolveObjectStorage()`, Backend aus 02g/15
  wiederverwendet, kein neuer Provider) →
  Beleg-Hash gegenpruefen → INSERT. GET-Ablauf:
  Zeile lesen (uniform NotFound) → Key fail-closed
  aufs project-files-Muster → `storage.get` →
  Bytes mit `Content-Disposition: attachment`
  (Dateiname RFC-5987, Angebots-PDF-Praezedenz
  `app/w/.../pdf/[pdfDraftId]/route.ts:58`) +
  `Cache-Control: private, no-store, max-age=0` +
  `nosniff` (F10-07-Praezedenz; kein Inline wie
  foto-GET — Dateien sind Downloads inkl. PDF).
- Liste newest-first (`created_at DESC, id DESC`;
  Gegenpol zu file_request_upload `ORDER BY
  uploaded_at, id` — dort chronologisch, hier
  Ablage-UX).
- KEIN Loeschen in diesem Slice: WORM-Objekte sind
  unveraenderlich; ein Referenz-DELETE unter 15
  Zeilen haette weder Statusmaschine noch Audit-
  noch Storage-Story (file_request: storniert nur
  logisch, nie DELETE — 0104-Kommentar). Ehrliches
  Loeschen = Folgeslice mit Status + Portal-Regel.

## Vertrag DB (0181, neue Tabelle project_file)
- `drizzle/0181_f7_16_project_files.sql` (0181-0189
  frei, verifiziert: nur 0180 in 018x). Spalten
  (Namen = file_request-Beleg-Praezedenz 0104, Task-
  Skizze in Klammern): `id` uuid PK default
  gen_random_uuid, `workspace_id` uuid NOT NULL,
  `project_id` uuid NOT NULL, `storage_key` text
  NOT NULL, `file_sha256` text NOT NULL (sha256),
  `content_type` text NOT NULL (mime), `byte_size`
  integer NOT NULL (size_bytes), `original_filename`
  text NOT NULL (original_name), `created_by` uuid
  NOT NULL (uploaded_by, FK membership wie
  file_request_created_by_fk), `created_at`
  timestamptz default now() NOT NULL. KEIN
  `updated_at` (Zeilen sind immutabel, kein UPDATE-
  Pfad; file_request_upload-Praezedenz: ebenfalls
  ohne updated_at).
- FKs: workspace → `workspace(id)`; `(workspace_id,
  project_id)` → `project(workspace_id,id)`;
  `(workspace_id,created_by)` → `membership
  (workspace_id,user_id)` (alle ON DELETE no action,
  0104/0124-Muster). UNIQUE `(workspace_id,id)`;
  INDEX `(workspace_id,project_id,created_at DESC,
  id DESC)` (Listen-Pfad).
- CHECKs: Name `char_length(btrim(original_filename))
  between 1 and 180` (0036-Praezedenz
  `catalog_import_job.file_name` 1..180);
  `content_type in ('application/pdf','image/jpeg',
  'image/png')`; `byte_size between 1 and 26214400`
  (25 MiB, spiegelt Contract); `file_sha256 ~
  '^[0-9a-f]{64}$'`; `storage_key`-Regex
  `^immutable/[0-9a-f-]{36}/project-files/
  [0-9a-f-]{36}_[0-9a-f]{8}\.(pdf|jpg|jpeg|png)$`
  + Laenge <= 512 (0173/0104-Muster; neue Domain
  `project-files` — kein zentrales Domain-
  Register, jede Domain wird per CHECK gepinnt;
  verifiziert: nur Contract-Konstante + Service-
  String + SQL-Regex tragen Domains).
- RLS: `tenant_isolation` + FORCE, bytegleich zu
  0124/0086. KEIN Owner-Tanz (nur fuer DEFINER-
  Funktionen im Testmodus noetig, 0104-Muster
  Zeile 166ff; 0181 hat keine Funktion, plain
  INSERT/SELECT via TenantTx). KEINE Grants, KEINE
  neue Permission (Rollenvertrag wie 0104: Rechte
  im Service-Layer).

## Vertrag App
- Neues Modul `modules/project-files/{service.ts,
  index.ts}` (Modul-Layout wie file-requests/
  order-parts: `index.ts` re-exportiert).
  Konstanten im Service (file-requests-Muster,
  kein lib/integrations-Contract — der gehoert
  Checklisten/Portal): `PROJECT_FILE_MAX_BYTES =
  26_214_400` (25 MiB, ESTIMATE reversibel;
  groesser als 10-MiB-foto/file-request, weil
  Plaene/Datenblaetter-PDFs groesser sind),
  `PROJECT_FILE_CONTENT_TYPES` (pdf/jpg/png +
  jpeg-Endungstoleranz wie foto), `PROJECT_FILE_
  KEY_PATTERN` (s. DB-Regex), `PROJECT_FILE_
  NAME_MAX = 180`.
- `uploadProjectFile(tx, ctx, {projectId, bytes,
  filename, contentType})`: `requireWrite` =
  `!isExternalOnly(ctx) && can(ctx,
  "project.write")` (file-requests/
  service.ts:186-Muster + Write-Gate-Praezedenz
  page.tsx:1007, Resource `project_file`;
  Verweigerung = `PermissionDeniedError` wie
  file-requests/service.ts:182);
  Zod strikt (uuid lowercased, filename 1..180
  nach trim, contentType 1..128 lowercased);
  Typ/Endung/Bytes pruefen (jpeg: .jpg/.jpeg);
  `requireProject` (SELECT project, RLS —
  Fremdprojekt = NotFound); sha256 + Key bauen
  (`immutableKey(projectId,"project-files",
  ...)`, lib/storage/s3.ts:41 — erstes Segment
  ist projekt-skoped wie foto/file-request);
  `putImmutable` + Beleg-Hash-Vergleich
  (`receipt integrity mismatch`, foto-Muster);
  WORM-Konflikt → ValidationError (fail-closed,
  keine Idempotenz — Key enthaelt frische UUID);
  INSERT (created_by = ctx.actor) + `writeAudit`
  (`@/lib/audit`, action `project_file.uploaded`,
  transitionFileRequest-Muster); Return `{fileId}`
  (nie der Key). KEIN Domain-Event (kein
  Folgekonsument in diesem Slice).
- `listProjectFiles(tx, ctx, {projectId})`:
  `requireRead` = `!isExternalOnly(ctx) &&
  can(ctx,"project.read")` (Parent-Korrektur:
  Projekt-Dateien sind INTERN — externes Lesen
  gehoert dem Visible-Flag-Folgeslice, nicht
  diesem Kern; project.read ist NICHT
  internalOnly, daher explizites Gate wie beim
  Write-Gate);
  SELECT ohne storage_key/file_sha256 (Key/
  Pruefsumme nie in die Liste — F10-04-QR:
  Empfangs-QR nur intern); DTO `{id,
  originalFilename, contentType, byteSize,
  createdAt}`.
- `downloadProjectFile(tx, ctx, {projectId,
  fileId})`: `requireRead` (project.read +
  `!isExternalOnly`, F10-11-
  `downloadFileRequestUpload`-Muster,
  service.ts:450ff); Zeile per (workspace,
  projekt, id) lesen → NotFound uniform;
  Key-Prefix + Pattern fail-closed →
  ValidationError; `storage.get` → `{filename,
  contentType, body}`.
- Route POST: uuid-Guard (workspace/project),
  FormData `datei` (File, 1..MAX — Routen-
  Vorpruefung wie foto/route.ts:46-47),
  `authorizedAction(workspaceId,"project.write",
  "project_file", ...)` → `{fileId}` (JSON).
  Route GET: uuid-Guard + `fileId`-Query
  (Pflicht, sonst invalid) → `authorizedQuery
  (workspaceId,"project.read","project_file",
  ...)` → Bytes + attachment/no-store/nosniff.
- UI: `app/w/[workspaceId]/anfragen/[projectId]/
  page.tsx` + neue `./project-file-section.tsx`
  (Props `workspaceId,projectId,files,canWrite`
  — FileRequestSection-Nachbar, page.tsx:1333ff;
  Position direkt NACH FileRequestSection).
  Loader `loadProjectFiles` = fileRequestResult-
  Muster (page.tsx:988-1024): Read-Gate
  `!isExternalOnly(ctx) && can(ctx,
  "project.read")` (Sektion fuer Externe
  verborgen, denied-Pfad) + Write-Gate
  `!isExternalOnly(ctx) && can(ctx,
  "project.write")`. Upload-Form (nur canWrite):
  `fetch` POST FormData (`postItemPhoto`-Muster,
  project-checklist-manager.tsx:1234ff;
  Session-Cookie implizit), accept
  `.pdf,.jpg,.jpeg,.png`, Fehler deutsch nach
  Status gemappt (`itemPhotoUploadErrorText`-
  Muster: 400 = Typ/Groesse, 401/403 = Recht,
  sonst generisch; kein Key-Leak). Liste: Name,
  Groesse (de-DE), Datum (`dateFormatter`),
  Download-Link (`<a href>` auf GET-Route).
  Gatter begruendet (Parent-Korrektur):
  project.read ist NICHT internalOnly
  (lib/permissions.ts:76) — ohne explizites
  Gate saehen externe Projektleser interne
  Dateien, was dem Visible-Flag-Folgeslice
  widerspraeche (Flag sinnlos bei
  Alles-sichtbar). Daher intern-nur auf
  Service-EBENE (alle 3 Ops) + UI-Loader
  (Sektion verborgen). Verworfen: a) externes
  Lesen per file_request-QR-Praezedenz — QR ist
  Token-scharf, project.read nicht; b)
  installation.read — Dateien haengen am
  Projekt, auch ohne Installation.

## Sicherheit
- Upload-Validierung VOR putImmutable (Fail-fast,
  kein Orphan bei Fehltyp/Fremdprojekt); Key
  vollstaendig Service-seitig (kein Client-
  Bestandteil, keine Sanitierungs-Luecke);
  25-MiB-Limit pro Datei (DoS); Allowlist
  pdf/jpeg/png + Endungs-Match; Key-Regex
  DB-seitig (Traversal tot).
- GET id-adressiert (kein Key in URL), uniform
  NotFound (kein Orakel ueber fremde IDs);
  storage_key/file_sha256 nie an den Client
  (Liste + POST-Antwort tragen nur Metadaten/
  fileId); Audit-Zeile je Upload ohne Key/
  Dateiname-Detail? — mit Dateiname wie
  file_request-Audit (Praezedenz traegt IDs;
  Dateiname ist Metadaten, kein Geheimnis).
- RLS tenant_isolation + FORCE; keine neue
  Permission/Grant/Rolle (`db:roles:verify`
  unberuehrt — kein Definer, kein Rollen-Pin).

## Tests (RED zuerst)
- DB: `tests/db/f716-projekt-dateien.test.ts` —
  D-01 gueltiger INSERT; D-02 Name leer/181 →
  verletzt; D-03 MIME ausserhalb Enum →
  verletzt; D-04 byte_size 0 / >26214400 →
  verletzt; D-05 Key mit fremder Domain
  (checklist-photos) → verletzt; D-06
  sha256 nicht-64-hex → verletzt; D-07
  Fremdprojekt-FK → verletzt; D-08 RLS:
  fremder Workspace liest nichts; D-09
  Zweit-Upload derselben Bytes = zweite Zeile
  (eigener Key, kein Dedupe); D-10 Externer
  (Membership `capabilities {"external_only":
  true}`, Rolle viewer): Upload/Liste/Download
  alle `PermissionDeniedError` (kein E2E —
  kein Externen-Fixture; DB-Beleg genuegt).
- Service (Unit, Contract-Niveau): U-01
  Key-Pattern akzeptiert alle 4 Endungen,
  lehnt Traversal/Grossbuchstaben ab; U-02
  Fehltyp/Endungs-Mismatch/0-Bytes/
  Uebergroesse → ValidationError VOR Put
  (kein Storage-Call); U-03 Fremdprojekt →
  NotFound; U-04 Beleg-Hash-Mismatch →
  ValidationError; U-05 WORM-Konflikt →
  ValidationError (kein blinder Erfolg);
  U-06 Liste ohne Key/Hash (DTO-Shape);
  U-07 Download Fremdprojekt/Fremd-ID →
  NotFound (kein Orakel).
- E2E: `tests/e2e/f7-16-projekt-dateien.
  spec.ts` (Setup nach 02g/15: `m1-11g-
  fixture`, Admin+Viewer, isolierter
  Workspace) — E-01 Admin laedt 2 Dateien
  (PNG + PDF) hoch → Liste mit Name/Groesse/
  Datum; E-02 Reload persistent; E-03
  Download-Bytes bytegleich; E-04 interner
  Viewer (Fixture-Viewer, capabilities '{}')
  liest Liste + Download, sieht KEIN
  Upload-Form; E-05 Fehltyp (.txt) scheitert
  sichtbar; E-06 Axe; E-07 Server-Log ohne
  Fehler (readFileSync/statSync-Muster 02g).
- Fixture: PNG-1x1-Base64-Praezedenz (f7-15-
  Spec) + minimales ASCII-PDF als Inline-
  Buffer (kein Magic-Byte-Check server-
  seitig — Typ/Endung wie foto/file-request;
  kein Asset-File).
- Nachbarn: F7-02g (Route/Storage), F10-04/
  F10-10/F10-11 (Beleg/Download), F7-15
  (E2E-Muster).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; E2E Chromium gruen; Heartbeat +
  Push + CI gruen.
