# SPEC F7-02k2 — Datenblatt Byte-Download (Katalog F7.2)

## Matrix
Katalog F7.2, F7-02k-Folgeslice. 02k-SPEC
Zeile 14-15 deferriert explizit „Byte-Download
(Session-Route nach 02g-Muster)". 02k rendert
nur Referenz-Links auf die Katalogseite; dieser
Slice liefert die Bytes dahinter. Kein Upload,
kein Writer, kein Portal-Bezug (intern).

## Bestand (verifiziert am Code)
- Manager rendert NUR Katalog-Links: `href`
  `/w/.../katalog/componentId` (project-checklist-
  manager.tsx:768-785, Pfad unter `anfragen/`,
  nicht `projekte/`), kein Download.
- `WorkbookDatasheetRef` = `{productName,
  filename, componentId}` OHNE objectKey/sha
  (workbook-service.ts:176-192); Helper
  `projectWorkbookDatasheets` (Z.305-310).
- Refs stammen aus dem VERSIEGELTEN Snapshot:
  installation → offer → offer_variant →
  `offer_variant_revision.revision_snapshot`
  (workbook-service.ts:338-377), Zeilen mit
  `product.kind/source.kind == catalog` +
  `product.datasheet != null` (Z.405-413).
- Volles Asset liegt im Snapshot: `datasheet:
  catalogAssetV1Schema.nullable()`
  (offers/contract.ts:585) = `{role, objectKey,
  sha256, mediaType, originalFilename}`
  (catalog/contract.ts:89-102).
- Foto-Routen-Muster existiert: POST/GET
  `app/api/workspaces/[workspaceId]/projects/
  [projectId]/checkliste/foto/route.ts`
  (GET: authorizedQuery checklist.read Z.119-
  124, Service `readChecklistItemPhoto`
  checklists/service.ts:557ff).
- Download-Attachment-Muster existiert:
  `.../dateien/route.ts` (RFC-5987-Dispositon
  Z.30-33, `private, no-store` Z.112, fileId-
  Query Z.95-98) + `downloadProjectFile`
  (project-files/service.ts:246-278).
- Katalogseite zeigt KEIN Datenblatt (kein
  presentation.datasheet-Render, kein Download
  in `katalog/[componentId]/page.tsx`); 02k2 ist
  der erste Byte-Zugriff ueberhaupt.
- KEIN Produktiv-Writer fuer Katalog-Assets:
  UI erzwingt `datasheet: null`
  (katalog/actions.ts:356), CSV-Import ebenso
  (import-contract.ts:289,1030); einziger
  Asset-Eintrag ist Test-Seeding via
  `reviseCatalogComponentDetails` (02k-E2E
  Z.199-216). Fehlendes Storage-Objekt ist
  daher Normalfall, kein Ausnahmefehler.
- Storage: `resolveObjectStorage().get(key)`
  (`@/lib/storage`, types.ts:4); Katalog-Keys
  (`catalog/...`) sind NICHT `immutable/`-
  praefiziert → nur via `put` schreibbar,
  `putImmutable` wuerfe (local.ts:43-62).
- Seite kombiniert beide Permissions:
  checklist.read fuers Tree (checkliste/
  page.tsx:47) + installation.read fuers
  Workbook/Refs (Z.167-170).

## Ziel
Je Datenblatt-Referenz laedt jede Rolle mit
Checklisten- + Installations-Leserecht das
PDF der GEBUNDENEN Variante bytegleich zum
versiegelten Snapshot herunter (Attachment).
Ohne Bindung, ohne Asset, ohne Recht oder bei
fehlendem Objekt: ehrlicher 404/403, kein
Orakel (fremd/fehlend/ungebunden uniform
NotFound), kein Key-Leak (DTO/URL/Fehler
tragen nie objectKey/sha).

## Entwurf (Foto-Route + Dateien-Attachment)
- Neue Service-Op `readWorkbookDatasheet`
  in `modules/installations/workbook-service.ts`
  (nah an `getInstallationWorkbook` +
  `projectWorkbookDatasheets`, keine neue
  Schicht — 02k-Praezedenz SPEC Z.48-52):
  `requireWorkbookRead` (installation.read)
  + Snapshot-Query wie Z.338-377 + Zeilen-
  Suche (`source.catalogComponentId ==
  componentId`, erster Treffer in Projektions-
  reihenfolge) → Asset-Guards → Storage-get →
  Byte-Guards → `{filename, body}`.
- Neue Session-Route GET `.../checkliste/
  datenblatt/route.ts` (Foto-Pfad-Muster,
  Dateien-Header-Muster): Params uuid,
  `?componentId=` uuid, `authorizedQuery`
  checklist.read, Fehler-Mapping wie foto-GET
  (400/404/403/401/500).
- Manager: je Referenz ZWEI Links — Bestand
  (Katalogseite) unveraendert + eigener
  Download-Link auf die Session-Route
  (Details: Vertrag App).

## Aufloesung (entschieden, belegt)
Quelle ist der VERSIEGELTE Varianten-Snapshot
(`offer_variant_revision.revision_snapshot`,
Abfrage workbook-service.ts:338-354), NICHT
der Live-Katalog. Kette: componentId →
Snapshot-Zeile (`source.kind == catalog` +
`source.catalogComponentId`, product-Zweig
Z.405-413) → `product.datasheet`
(CatalogAssetV1: objectKey/sha256/mediaType/
originalFilename, catalog/contract.ts:89-102)
→ `resolveObjectStorage().get(objectKey)` →
Bytes + sha256-Rueckvergleich. Keine neue
Tabelle/Spalte: der Storage-Key liegt im
JSONB-Snapshot (Heimat-Tabelle des Assets am
Katalog: `catalog_component_revision.
revision_snapshot`, schema/catalog.ts:101-114;
fuer den Download wird sie NICHT gelesen).
Verworfen: Live-Katalog via
`getCatalogComponent` (service.ts:404ff) —
braeche Snapshot-Konsistenz (neuere Revision
= andere Bytes als angezeigter Stand) und
braeuchte zusaetzlich catalog.read. Erster
Treffer bei doppelter componentId (gleiche
Resolution = gleiches Asset; deterministisch
ueber Positions-Sortierung Z.378-381).

## Vertrag DB (KEINE Migration)
Verifiziert nicht noetig: (a) kein neues
Datum — Snapshot-Spalte + Storage-Objekt
existieren; (b) kein Tree-Wandel — Download
ist id-adressiert (projectId+componentId),
kein neuer Item-Key, daher kein Validator-
Replace (02g-Muster 0173 nicht einschlaegig);
(c) RLS unberuehrt; (d) kein Rollen-Pin —
keine neue Permission, keine DEFINER-Funktion
(`db:roles:verify` unberuehrt); (e) drizzle-
Stand endet bei 0183 (0183_f10_18...) — keine
Nummer zu vergeben, kein Journal-Eintrag, kein
`db:generate`-Drift.

## Vertrag App
- Op-Signatur: `readWorkbookDatasheet(tx, ctx,
  {projectId, componentId})` →
  `{filename: string, body: Buffer}`.
  Fehlerklassen Bestand: `InstallationNotFound
  Error` / `InstallationValidationError`
  (installations/service.ts:14/28);
  `OfferIntegrityError` bei korruptem Snapshot
  propagieren (Z.374-376-Muster); Export via
  `modules/installations/index.ts` (Z.38-53).
- Route importiert aus `@/modules/
  installations` (Praezedenz checkliste/
  page.tsx:10 — kein Zyklus, kein neues Modul).
- Guards (alle fail-closed, Reihenfolge):
  1. uuid (projectId, componentId, lowercased);
  2. `requireWorkbookRead` VOR Snapshot-Read
     (workbook-service.ts:31-35);
  3. Bindung/Asset fehlt → NotFound uniform
     (kein Unterschied fremd/fehlend/leer);
  4. `asset.role == datasheet` +
     `asset.mediaType == application/pdf`,
     sonst ValidationError (MIME-Pin, s.u.);
  5. Key-Rebuild: objectKey MUSS exakt
     `catalog/{ctx.workspaceId}/{componentId}/
     {sha256}.pdf` sein (Contract-Refine
     catalog/contract.ts:259-264 + offers/
     contract.ts:921-927 gespiegelt), sonst
     ValidationError (Traversal tot, kein
     Echo fremder Keys);
  6. Storage-get wirft/fehlend → NotFound
     (foto-Muster service.ts:587-592);
  7. `sha256(body) == asset.sha256`, sonst
     Integrity (local-Backend pinnt nur
     immutable/-Objekte, local.ts:85-91 —
     Katalog-Keys brauchen den Vergleich
     hier);
  8. `1 <= byteLength <= 26_214_400`
     (25 MiB, s.u.), sonst Integrity;
  9. Magic-Bytes `%PDF` (F10-17-Muster),
     sonst Integrity;
  10. Dateiname `1..180` (Contract-Max
      catalog/contract.ts:99).
- MIME-Pin `application/pdf`, belegt ohne
  Fallback: role=datasheet ERZWINGT
  application/pdf per Refine (catalog/
  contract.ts:266-268 + offers/contract.ts:
  692-694); das Media-Enum enthaelt Bilder nur
  fuer role=image. Route setzt Content-Type
  hart (nie Snapshot-Echo).
- Groessen-Cap 25 MiB (`PROJECT_FILE_MAX_
  BYTES`, project-files/service.ts:59):
  Kommentar nennt explizit „Plaene/
  Datenblaetter-PDFs" als Grund gegen 10 MiB
  (Foto/file-request/handover-Praezedenz
  10_485_760). Leseseitiger Guard (kein Upload
  in diesem Slice) gegen riesige Katalog-
  Objekte am Session-GET.
- Permission: BEIDE, keine neue. Route:
  `authorizedQuery` checklist.read (Foto-
  Muster route.ts:119-124, Service-requireRead
  checklists/service.ts:38-42). Op:
  `requireWorkbookRead` installation.read
  (workbook-service.ts:31-35). Begruendung:
  Nur checklist.read leakte Bytes ohne
  sichtbare Refs (Seite gate Refs mit
  installation.read, page.tsx:167-170); nur
  installation.read umginge den Checklisten-
  Kontext. 403 uniform bei beiden. KEIN
  external_only-Gate (Bestand prueft es weder
  hier noch dort — kein Gate erfinden).
- Route (foto-GET × dateien-GET gekreuzt):
  KEIN checklistId/itemId-Param — Refs stammen
  aus dem Workbook, nicht aus dem Tree (03B
  „Art nie Inhalt"); Tree-Gate waere Schein-
  Autorisierung, Snapshot-Zugehoerigkeit ist
  der echte Gate. Header: `content-type:
  application/pdf` (gepinnt), `content-length`,
  `content-disposition: attachment` RFC-5987
  (dateien/route.ts:30-33 kopieren),
  `cache-control: private, no-store, max-age=0`
  (dateien/route.ts:112 — Bindungswechsel =
  gleiche URL, andere Bytes), `nosniff`.
  Mapping: Validation→400, NotFound→404,
  PermissionDenied→403, NotAuthenticated→401,
  OfferIntegrity/Integrity→500 `error`
  (kein Detail, kein Orakel; console.error-
  Muster foto-GET).
- UI (entschieden): je Referenz ZWEI Links —
  Katalog-Link (Bestand Z.773-778, Text
  „{product} — {file}") UNVERAENDERT +
  daneben eigener Download-Link „PDF
  herunterladen" (aria-label je Produkt,
  `href` Session-Route mit `?componentId=`).
  Begruendung: Link-Ziel des Bestands aendert
  sich nicht (kein Bruch fuer Nutzer/E2E-
  Hrefs wie 02k-E2E Z.295); Navigation vs.
  Aktion bleiben getrennt und screenreader-
  unterscheidbar. Verworfen: Zeile aufspalten
  (Produkt→Katalog, Datei→Download) —
  unsichtbare Doppel-Affordanz. Plain `<a>`
  (Browser handled attachment; Manager ist
  Client, kein fetch noetig). Fallback-Text,
  Strukturmodus, Typwechsel: unveraendert
  (02k-Vertrag).

## Sicherheit
- Key-Leak-Verbot: DTO (`WorkbookDatasheetRef`
  unveraendert ohne Key/sha), URL (nur
  componentId), Fehler/Logs (nur Typ, nie Key/
  sha/Dateiinhalt — 02k-E2E pinnt Abwesenheit
  Z.292-293) tragen nie Storage-Geheimnisse.
- Key nie aus Client/URL uebernommen: Route
  nimmt nur componentId, Service baut den
  Erwartungs-Key selbst (Foto-Prinzip
  service.ts:391-394).
- Download id-adressiert, uniform 404
  (fremd/fehlend/ungebunden/fehlendes Objekt
  ununterscheidbar — kein Orakel).
- Kein Tree-Write, kein Upload, kein WORM-
  Orphan, kein Audit (reiner Lese-Download
  wie foto-GET/dateien-GET; kein Audit dort).
- RLS + Mandanten-Queries unveraendert
  (workspace_id-Scoping in Snapshot-Query).

## Tests (RED zuerst)
- DB/Service (`tests/db/f702k2-datenblatt-
  download.test.ts`, echte Test-DB, KEIN
  Validator-Anteil — keine Migration):
  D-01 Happy Path (Seed Installation +
  Snapshot mit Asset + Storage-put →
  bytegleiche Bytes + Dateiname); D-02 ohne
  Bindung → NotFound; D-03 componentId nicht
  in Variante → NotFound; D-04 fremder
  Workspace → NotFound (kein Leak); D-05
  fehlendes Storage-Objekt → NotFound
  (Writer fehlt — Normalfall); D-06 sha-
  Mismatch → Integrity; D-07 mediaType !=
  pdf / role-Mismatch → Validation; D-08
  Key-Rebuild-Mismatch (fremde Workspace-ID
  im Key) → Validation; D-09 Uebergroesse
  (>25 MiB) + D-10 kein-%PDF → Integrity;
  D-11 ohne installation.read → Permission
  (trotz checklist.read); D-12 02k-Unit/
  DB-Suiten unveraendert gruen.
- Unit (`tests/unit/f702k2-datenblatt-
  download.test.ts`, pure Guards sofern
  extrahiert — Key-Rebuild, MIME-Pin, Cap,
  Magic-Bytes; sonst Deckung in D-07..D-10).
- E2E (`tests/e2e/f7-02k2-datenblatt-
  download.spec.ts`, M2-01 + 02k-Seeding
  Z.199-216 + zusaetzlich Storage-Seed via
  `resolveObjectStorage().put(objectKey,
  pdfBytes, "application/pdf")` — `put`,
  NICHT putImmutable (local.ts:61-62);
  kleinstes gueltiges `%PDF`-Byte-Array
  inline, 02g-Fixture-Praezedenz): E-01
  Download-Link je Referenz sichtbar neben
  Katalog-Link; E-02 Klick → Download-Event,
  Bytes bytegleich (sha), Dateiname +
  attachment; E-03 Viewer laedt (beide
  Leserechte); E-04 fremde componentId → 404;
  E-05 ohne Bindung → Fallback, kein Link;
  E-06 Reload stabil; E-07 Axe; E-08
  Server-Log ohne Fehler (readFileSync/
  statSync-Muster 02g).
- Nachbarn: 02g (Route), 02k (Refs/Seeding),
  F7-16 (Attachment), F10-17 (MIME/Magic),
  m111a-Pins (unberuehrt — keine Migration).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; E2E Chromium gruen; Heartbeat +
  Push + CI gruen.
