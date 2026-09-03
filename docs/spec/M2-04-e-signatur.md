# M2-04 — E-Signatur (F2.8)

- Status: DISCOVERED → SPECIFIED
- Datum: 2026-09-02
- F-Bezug: F2.8 E-Signatur — PARTIAL (Vorbereitungs-Slice; E-Mail-Versand,
  `Won`-Automatik, Portal-White-Label und Change Order bewusst NICHTZIEL)
- Architektur: ADR 0022 (E-Signatur) — siehe Nummern-Kollisions-Hinweis im ADR
  (parallel existiert `docs/adr/0021-termine-kalender.md`, M1-15)
- Basis: Spec-/ADR-Ablage `tooling` HEAD `788d142`; funktionale Hash-/Issuance-Basis
  M2-03b1 `a06f961` (Worktree `energie-saas-m203b-issuance-archive`, **noch nicht**
  in `tooling`/`main` integriert — geprüft: `a06f961` ist kein Ancestor von
  `788d142`, `git merge-base --is-ancestor` = nein)
- Geplante Migration: additiv, Nummer bei CONTRACTED (nach M2-03b-/M1-wave-01-
  Integration; Stand heute frühestens `0043`)

> **Scope-Disziplin.** Dieses Dokument spezifiziert die E-Signatur als
> **Vorbereitungs-Slice**: Signatur-Request wird intern an einer **freigegebenen
> Angebotsvariante** erzeugt, ein öffentlicher Token-Link mit TTL, die
> Signierroute (Click-to-sign + Zeichnen), Attestierung mit Content-Hash des
> freigegebenen PDF, View-Tracking, interner Widerruf und Analog-Upload sind
> vollständig spezifiziert und testbar. Es baut **keine** öffentliche REST-API,
> **keinen** Rechts-/Zertifikatsdienst, **keine** E-Mail-Versandkette (Resend),
> **kein** Portal-White-Label (F10) und **kein** Change-Order-Fork. Die
> Reonic-OpenAPI ist ausschließlich funktionale Referenz.

## Quellenlegende

- `SRC-API-SPEC` — Reonic OpenAPI v3.11.0, `https://api.reonic.de/rest/v3/openapi`,
  DOCUMENTED (öffentliche Spec, **kein** API-Call mit Key), kartiert in
  `docs/parity/REONIC-API-CAPABILITY-MAP.md`
- `API-MAP:N` — `docs/parity/REONIC-API-CAPABILITY-MAP.md`, Zeile N
- `MODKAT:F2.8` — `docs/blaupause/01-modulkatalog.md`, Zeile 37 (F2.8)
- `GOAL:F2` — `REONIC-PARITY-GOAL-PROMPT.md`, §8 F2 (E-Signatur-Punkte)
- `ADR0021` — `docs/adr/0021-e-signatur.md`
- `ADR0012` — `docs/adr/0012-angebotsausstellung-und-archivgate.md` (M2-03b-Worktree)
- `M203B1` — Spec `M2-03b1-angebotsausstellungsfassung.md` (M2-03b-Worktree)
- `ISSUANCE` — `offer_issuance`-Tabellen aus M2-03b1 (Byte-/Hash-Bindung)
- `M114` — Spec `M1-14-kontaktdatensatz.md` (CAS-/Erasure-/Rollenmuster)
- `M111A` — Outcome-Slice M1-11a (Projektergebnis Won/Lost/Reopen, Referenz für
  den späteren `Won`-Übergang)

### Öffentliche Reonic-Doku (DOCUMENTED, Zugriff 2026-09-02)

| ID | URL | Belegte Semantik |
|---|---|---|
| `SRC-REONIC-SIGN-LINK` | https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity | Freeze bei Versand; TTL „typisch 14/30/60 Tage"; Click-to-sign ODER Zeichnen (Workspace-Setting draw-to-sign); Attestierung „who/when/from where/content check"; Tablet = digitale Kundensignatur; Analog-Datum „max. 1 Tag Zukunft"; Finalise-Tab-Liste `pending/signed/expired/withdrawn`; Pending sperrt Variante |
| `SRC-REONIC-SIGN-TRACK` | https://docs.reonic.com/docs/en/offers-finalise-cat-track-openings-of-offer | Signatur-Events; **View-Count** inkrementiert je Link-Load, trägt über Resends fort; Link-Gültigkeitsfenster |
| `SRC-REONIC-SIGN-WITHDRAW` | https://docs.reonic.com/docs/en/offers-finalise-cat-handle-a-contract-withdrawal | §356a-Widerruf; Default 14 Tage ab Signatur; Admin-Toggle; „Withdrawn by customer"; Deal bleibt Won; einmalig/einseitig; getrennt vom Team-Withdraw |
| `SRC-REONIC-SIGN-REVOKE` | https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer | Team-Withdraw eines Pending-Links → sofort tot, „Signature request withdrawn"; „Signed/Expired … cannot be withdrawn"; signierte Variante gesperrt; Fork = Change Order |
| `SRC-REONIC-SIGN-MANUAL` | https://docs.reonic.com/docs/en/offers-finalise-cat-upload-manual-signature | Analog-Upload an Pending-Row; PDF; Signierdatum (≤1 Tag Zukunft, früher erlaubt); „accepted analogously"; → Won; Variante gesperrt |
| `SRC-REONIC-SIGN-REMIND` | https://docs.reonic.com/docs/en/offers-finalise-cat-remind-customer | Notify/Resend desselben Links (NICHTZIEL M2-04, Referenz) |

> **Hinweis `docs.reonic.de`:** `https://docs.reonic.de/sitemap.xml` liefert ein
> Docusaurus-Platzhalter-Set (`your-docusaurus-test-site.com`) — keine
> Inhaltsquelle. Reale Inhalte liegen ausschließlich unter `docs.reonic.com`.
> Zugriffsdatum beider Sitemaps 2026-09-02.

## 1. Nutzerergebnis

Ein interner Editor/Admin erzeugt an einer **freigegebenen** Angebotsvariante
(`approved_for_archive_not_issued` aus M2-03b1) einen Signatur-Request mit
öffentlichem Token-Link und TTL (Default 14 Tage, Bereich 1–60). Der öffentliche
Link öffnet eine signierfähige PDF-Ansicht: Kunde unterschreibt per
Click-to-sign oder zeichnet (signature_pad); eine Attestierungsseite bindet
Signer, Zeitpunkt und den Content-Hash des freigegebenen PDF. Jede Link-Öffnung
wird als Zeitstempel-Zähler ohne Fingerprinting erfasst. Intern kann ein noch
nicht signierter Link widerrufen (withdrawn) und ein Papier-Scan analog
hochgeladen werden (PDF/JPG, Typ-/Größen-/Malware-Check). Der Kunden-Widerruf
eines signierten Vertrags (`revoked_by_customer`, §356a-Fenster) ist modelliert
und über die internen Zustände sichtbar. Status: `pending`, `signed`, `expired`,
`withdrawn`, `revoked_by_customer`.

Bis zur Send-/Issued-Freigabe (M2-03b2 + Resend-Slice) bleibt jede Request intern
ehrlich als „vorbereitet · nicht versendet" gekennzeichnet; es wird **kein**
`issued`, kein E-Mail-Versand und **kein** automatischer `Won`-Übergang
behauptet.

## 2. Clean-Room-Evidenz (API) und Gap-Analyse

### 2.1 API-Operation (DOCUMENTED)

| Methode + Pfad | Mut. | Schema | Hinweise (API) |
|---|---|---|---|
| `GET /residentialProjects/{projectId}/signatureRequests` | — | `{ data: ResidentialProjectSignatureRequest[] }` | „Allowed API keys: Read-only, Read and Write"; „Signature requests are created once the project reaches the offer stage and its offer is sent out for signature." |

- **Nur lesbar.** Es gibt **keinen** create/update/delete-Endpunkt für
  Signatur-Requests in der Spec; die Erzeugung ist Portal-only →
  `UNKNOWN` (`API-MAP:624`). M2-04 implementiert die Erzeugung daher als
  **interne Server-Action**, nicht als API-Endpunkt.
- Das `signatureRequests`-Feld am `ResidentialProjectDetail` ist laut
  `API-MAP:626` **deprecated** zugunsten dieses Endpunkts.

### 2.2 API-Schema `ResidentialProjectSignatureRequest` (DOCUMENTED)

13 Pflichtfelder (alle nullable-fähig):

| Feld | Typ | Hinweis |
|---|---|---|
| `id`* | uuid | — |
| `projectId`* | uuid | Referenz Residential Projects |
| `status`* | enum | `awaitingSignature \| signed \| expired \| withdrawn \| revokedByCustomer` |
| `offerDocuments`* | array | je Variante/Zahlart: `{ variantId*, paymentOptionId* (nullable), pdfUrl* }`; `pdfUrl` „URL valid 24 hours" |
| `signedVariantId`* | uuid|null | „null until the request is signed" |
| `signedPaymentOptionId`* | uuid|null | „null until signed, or for legacy/default-payment documents" |
| `signedPdfUrl`* | uri|null | gegengezeichnetes PDF; „URL valid 24 hours"; nach Kunden-Widerruf gestempelt |
| `revocationPdfUrl`* | uri|null | separate Widerrufserklärung des Kunden, falls vorhanden; „URL valid 24 hours" |
| `createdAt`* | date-time | — |
| `expiresAt`* | date-time|null | TTL-Hinweis: Ablaufzeitpunkt des Requests |
| `signedAt`* | date-time|null | — |
| `withdrawnAt`* | date-time|null | „When your team withdrew a still-pending request" |
| `revokedByCustomerAt`* | date-time|null | „When the customer revoked an already-signed contract" |

### 2.3 Beobachtungen, die die Spec treiben

- **Status-Enum ≠ Kürzelliste.** Die API kennt fünf Werte; Modulkatalog
  (`MODKAT:F2.8`) und Finalise-Tab nennen vier Hauptzustände
  (`pending/signed/expired/withdrawn`) plus „Kunden-Widerruf" als eigenes
  Konzept. → 5-Zustands-Modell (ADR 0022, Entscheidung 3); `pending` ist intern,
  `awaitingSignature` der API-Wert.
- **Zwei Widerrufe.** `withdrawnAt` (Team, „still-pending") vs.
  `revokedByCustomerAt` (Kunde, „already-signed") sind getrennt belegt.
- **TTL.** `expiresAt` + Doku „typisch 14/30/60 Tage" + `MODKAT:F2.8`
  „Link 1–60 Tage gültig". Default öffentlich nicht als Einzelwert belegt →
  `DECIDED` 14 Tage (ADR 0022, Entscheidung 2).
- **PDF-URL-TTL ≠ Link-TTL.** Die 24-Stunden-Gültigkeit betrifft die
  PDF-Download-URLs (`pdfUrl`, `signedPdfUrl`, …), nicht den Signaturlink.
- **Content-Hash.** Doku belegt „content check" → SHA-256 der freigegebenen
  Ausstellungsbytes (ADR 0022, Entscheidung 1). „from where" ist `UNKNOWN`
  (nicht spezifiziert) und wird bewusst nicht als IP/Geo repliziert.
- **View-Tracking.** Doku belegt nur einen **View-Count**; M2-04 ergänzt minimal
  Zeitstempel, kein Fingerprinting (ADR 0022, Entscheidung 5).
- **`Won`-Automatik.** Doku: Signatur → `Won` + Installations-Board
  (`MODKAT:F2.8`). M2-04 endet bei `signed` und emittiert `signature.signed`;
  der Outcome-/Installations-Übergang ist NICHTZIEL (eigener Slice, s. §12).

### 2.4 Gap-Analyse Ist-Repo ↔ Referenz

| Aspekt | Referenz | Ist-Repo | Aktion |
|---|---|---|---|
| Signatur-Request-Entität | DOCUMENTED (Schema) | — | NEU `signature_request` |
| Status (5 Zustände) | DOCUMENTED (Enum) | — | NEU Status-Spalte + CHECK/Guards |
| `offerDocuments[]` (Variante+Zahlart) | DOCUMENTED | M2-03b1: **eine** freigegebene Ausstellungsfassung je Offer | M2-04: Array modelliert, aber genau **ein** Dokument (freigegebene Variante + optionale Zahlart); Mehr-Varianten-Auswahl NICHTZIEL |
| Content-Hash-Quelle | INFERRED („content check") | `offer_issuance` SHA-256 (`ISSUANCE`, M2-03b1) | bindet `issuance_id` + `content_sha256` (ADR 0022) |
| TTL | DOCUMENTED (1–60 Tage; typisch 14/30/60) | — | `expires_at`, Default 14 Tage |
| Click-to-sign | DOCUMENTED | — | Server-Action `sign` |
| Zeichnen | DOCUMENTED (draw-to-sign-Setting) | `signature_pad@5.1.4` installiert (`package.json`) | PNG-Artefakt aus Canvas/SVG |
| Attestierung | DOCUMENTED (who/when/content check) | — | NEU `signature_attestation` |
| View-Count | DOCUMENTED | — | NEU `signature_view_log` (kein Fingerprinting) |
| Team-Withdraw | DOCUMENTED | M2-03b1-Withdrawal-Muster (`ISSUANCE`) | NEU `withdrawn`-Übergang |
| Kunden-Widerruf §356a | DOCUMENTED | — | NEU `revoked_by_customer` |
| Analog-Upload | DOCUMENTED (PDF) | Upload-/Datei-Muster vorhanden (M1-08b) | Typ-/Größen-/Malware-Check; PDF/JPG |
| Tablet-Signatur | DOCUMENTED (digitale Kundensignatur) | responsive E2E-Basis vorhanden | `draw`-Modus auf Touch-Geräten |
| E-Mail-Versand (Resend/Notify) | DOCUMENTED | — | NICHTZIEL (Resend-Slice) |
| `Won`/Installation | DOCUMENTED | M1-11a Outcome vorhanden (`M111A`) | NICHTZIEL; nur `signature.signed`-Event |

## 3. Capability-Sheet (Goal-Prompt §7)

### 3.1 Gemeinsamer Liefervertrag

- **Modul:** Offers (F2). **Tenant-/Owner-Scope:** Workspace + Offer +
  SignatureRequest (`workspace_id`-Composite-Schlüssel, FORCE-RLS wie Bestand).
- **Akteur/Rolle:** interner Viewer read-only; interner Editor/Admin erzeugt
  Request und führt Withdraw/Analog-Upload aus (Capability `offer.signature`);
  der **öffentliche Signierlink** ist ein Token-Endpunkt ohne interne Rolle;
  `external_only`, Worker, Auth, System und Fremdmandant bleiben fail-closed.
- **Route/Oberfläche:** intern `/w/[workspaceId]/angebote/[offerId]` (Finalise-
  Sektion „Signatur"); öffentlich `/s/[token]` (Token-Route, read-only PDF +
  Signierformular).
- **Notifications:** nur lokale `aria-live`-Ergebnisse; keine externe Mail in
  M2-04.
- **Loading/Empty/Error/Success/Disabled/Permission-Denied:** echte getrennte
  Zustände; abgelaufener/entzogener Link zeigt definierten Endzustand ohne
  Inhalts-Orakel; Denied/NotFound ohne Offer-Leak.
- **Desktop/Tablet/Mobile:** responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, Touchziele ≥ 44 px; Tablet-Zeichnen (Pointer Events) eigens
  getestet.
- **Keyboard:** vollständiger Signierpfad ohne Maus (Click-to-sign per Tastatur;
  Zeichnen mit klarer Alternative).
- **Offline:** kein Offline-Schreibversprechen; sicherer Online-Fehlerzustand.
- **Paritätsstatus:** FUNCTIONAL (eigenständige Ausgestaltung, API/Doku als
  Referenz); kein Anspruch auf private Reonic-Interna, kein Rechtsdienstleistungs-
  Claim.
- **Confidence:** Status/TTL/Analog/Withdraw hoch (DOCUMENTED); Content-Hash-
  Quelle und „from where" teils INFERRED/UNKNOWN; interne Ausgestaltung DECIDED
  WMEE.
- **Owner:** Root; UI-/Test-Lanes mit unabhängigen Abschlussprüfungen.
- **Letzte Prüfung:** 2026-09-02 (Discovery/Spec; noch nicht implementiert).

### 3.2 Feingranulare Capabilities

| ID / F-Nr. | Job, Trigger, Happy Path | Eingaben / Validierungen | Zustand / Nebenwirkung | Recht / Daten / Event | Tests | Status |
|---|---|---|---|---|---|---|
| `M204-01` / F2.8 | Editor erzeugt Signatur-Request an freigegebener Variante | Offer-ID + Variante-ID (freigegeben, `approved_for_archive_not_issued`), TTL-Tage 1–60 | `pending` + Token-Link + `expires_at`; bindet `issuance_id`+`content_sha256` append-only; Rehash | `offer.signature`; SignatureRequest; `signature.request_created` | `M204-SVC-01`, `M204-DB-01`, `M204-ACTION-01`, `M204-RBAC-01` | SPECIFIED |
| `M204-02` / F2.8 | öffentlicher Link öffnet signierfähige PDF-Ansicht | Token (hoch-entropisch, serverseitig gehasht); Status `pending`; nicht abgelaufen | View-Event (Zeitstempel, kein Fingerprinting); read-only PDF | öffentlich (Token); `signature.viewed` | `M204-ROUTE-01`, `M204-E2E-01` | SPECIFIED |
| `M204-03` / F2.8 | Click-to-sign | Bestätigung + fester Bestätigungstext; Server-Zeit | `signed` + Attestierung (Signer, Zeit, Hash, Modus `click`) | öffentlich (Token); `signature.signed` | `M204-CONTRACT-01`, `M204-SVC-02`, `M204-E2E-02` | SPECIFIED |
| `M204-04` / F2.8 | gezeichnete Signatur (signature_pad) | Canvas/SVG → PNG, Größenlimit; draw-to-sign aktiv | `signed` + Attestierung (Modus `draw`, PNG-Artefakt + SHA) | öffentlich (Token); `signature.signed` | `M204-CONTRACT-02`, `M204-SVC-03`, `M204-E2E-03` | SPECIFIED |
| `M204-05` / F2.8 | TTL-Ablauf | `expires_at` serverseitig; kein Client-Setzen | abgelaufener Link → terminal `expired`; kein Signieren/Withdraw mehr | — | `M204-DB-02`, `M204-RACE-01` | SPECIFIED |
| `M204-06` / F2.8 | interner Widerruf eines Pending-Links | structured reason; nur `pending` | `withdrawn` terminal; Link sofort tot; Variante wieder editierbar (Kopplung NICHTZIEL) | `offer.signature`; `signature.request_withdrawn` | `M204-SVC-04`, `M204-DB-03`, `M204-E2E-04` | SPECIFIED |
| `M204-07` / F2.8 | Kunden-Widerruf §356a | nur aus `signed`, innerhalb Fenster (Default 14 Tage), einmalig | `revoked_by_customer` terminal; `revoked_by_customer_at`; kein `Won`-Rückgang in M2-04 | öffentlich (Token) ODER intern; `signature.revoked_by_customer` | `M204-CONTRACT-03`, `M204-SVC-05` | SPECIFIED |
| `M204-08` / F2.8 | analoger Upload (PDF/JPG) | MIME-Magic, Größenlimit, Malware-Check; Signierdatum ≤ 1 Tag Zukunft; an `pending` | `signed` + Attestierung (Modus `analog`, Artefakt + SHA) | `offer.signature`; `signature.signed` | `M204-CONTRACT-04`, `M204-SVC-06`, `M204-E2E-05` | SPECIFIED |
| `M204-09` / F2.8 | Tablet-Signatur | Touch/Pointer-Events; `draw`-Modus | identisch `M204-04`; keine „on behalf of"-Semantik | öffentlich (Token) | `M204-E2E-06` | SPECIFIED |
| `M204-10` / F2.8 | RLS/RBAC fail-closed | — | External/Worker/Fremdmandant lesen/mutieren nicht; Token-Route nur lesbar/signierbar | RLS/FORCE-RLS + Actions | `M204-RBAC-01/02` | SPECIFIED |
| `M204-11` / F2.8 | Race/CAS | paralleles Signieren/Withdraw/Ablauf | genau ein terminaler Übergang gewinnt; andere Conflict | Request-Lockreihenfolge Offer→Request | `M204-RACE-01/02/03` | SPECIFIED |
| `M204-12` / F2.8 | Erasure | Signaturbild/Analog-PDF/View-Zeitstempel/Signer-Name | DSGVO-Graph erweitert; ID-only-WORM-Tombstone | Erasure/Scrub | `M204-ERASURE-01/02` | SPECIFIED |
| `M204-13` / F2.8 | Migration + Rollenvertrag | — | additive Migration, `db:generate` ohne Drift, Rollenprobe | Migrator/Runtime/Worker | `M204-MIG-01`, Rollenprobe | SPECIFIED |
| `M204-14` / F2.8 | UI/A11y | — | öffentliche Signier- + interne Finalise-Sicht, Axe, Tastatur, 375 px, Touch | — | `M204-E2E-01…06`, `M204-A11Y-01` | SPECIFIED |

## 4. Datenmodell und Datenbankvertrag

Additiv (Details ADR 0022); alle Tabellen `workspace_id`-gebunden,
`UNIQUE(workspace_id, id)`, RLS/FORCE-RLS, Composite-Tenant-FKs:

| Tabelle | Spalten (wesentlich) | Hinweis |
|---|---|---|
| `signature_request` | id, workspace_id, offer_id, variant_id, payment_option_id (nullable), status (CHECK 5 Werte), token_hash, expires_at, content_sha256, issuance_id/artifact_ref, signed_variant_id (nullable), signed_payment_option_id (nullable), created_at, signed_at, withdrawn_at, revoked_by_customer_at, view_count/first_viewed_at (abgeleitet, ggf. materialisiert) | `offer_id`→`offer`, `variant_id`→Variant, `issuance_id`→`offer_issuance`; Statusübergänge per DB-Guard/Service |
| `signature_attestation` | id, workspace_id, signature_request_id, mode (`click\|draw\|analog`), signer_name, signed_at, content_sha256, artifact_storage_key (nullable), artifact_sha256 (nullable) | append-only; genau eine je `signed`-Request |
| `signature_view_log` | id, workspace_id, signature_request_id, viewed_at | append-only; **kein** IP/UA/Referrer; nur Zeitstempel |

- **Status-Guard:** Übergänge ausschließlich `pending→signed|expired|withdrawn`
  und `signed→revoked_by_customer`; terminale Zustände sind nicht umkehrbar;
  DB-Guard/SECURITY-DEFINER hält die Maschine exakt (Muster `ISSUANCE`).
- **Token:** öffentlicher Link trägt ein hoch-entropisches Token; in der DB nur
  `token_hash` (SHA-256, salted) — das Klartext-Token wird nie persistiert.
- **Artefakte (Signatur-PNG, Analog-PDF):** Größenbegrenzt (PNG ≤ 512 KiB,
  Analog-PDF/JPG ≤ 8 MiB, ESTIMATE) über den bestehenden Artefakt-Pfad
  (Postgres-gebunden bis M2-03b2-S3, Muster `M203B1`), MIME-Magic + Malware-Check
  vor Annahme.
- **Erasure (quellgepinnt):** neue Tabellen werden im DSGVO-Erasuregraphen
  registriert; Scrub löscht Signaturbild, Analog-PDF, View-Zeitstempel und
  Signer-Name; Tombstone bleibt ID-only (Muster `M114`/ADR 0018).
- **Backfill:** keiner (neue Tabellen, keine bestehenden Zeilen).

## 5. Commands, Actions und öffentliche Route

- Server-Action `createSignatureRequest({ workspaceId, offerId, variantId, ttlDays })`:
  lädt/sperrt Offer+Project+Tenantgraph, prüft Variante `approved_for_archive_not_issued`
  (Rehash des `offer_issuance`-SHA), validiert `ttlDays ∈ 1..60`, erzeugt Token
  (nur Hash gespeichert), schreibt `pending` + `expires_at` + Content-Hash-Bindung,
  emittiert `signature.request_created` + Audit in derselben Transaktion.
- Öffentliche Token-Route `GET /s/[token]`: liest Request über Token-Hash, prüft
  `pending` + `expires_at > now()`, schreibt View-Event, rendert read-only PDF
  (aus `offer_issuance`-Bytes) + Signierformular. Abgelaufen/entzogen → definierter
  Endzustand.
- `signSignature({ token, mode, ... })`: Click (`mode=click` + Bestätigungstext)
  oder Zeichnen (`mode=draw` + PNG-Daten). Server: Token-Hash → Request `pending`
  → Rehash der Ausstellungsbytes → genau eine Attestierung → `signed` +
  `signed_variant_id` + `signature.signed`-Event, atomar. CAS gegen paralleles
  Signieren/Withdraw/Ablauf.
- `withdrawSignatureRequest({ workspaceId, requestId, reason })` (intern):
  nur `pending`, strukturierter Grund, terminal `withdrawn`, Link sofort tot.
- `uploadAnalogSignature({ workspaceId, requestId, file, signingDate, ... })`
  (intern): nur `pending`; Typ-/Größen-/Malware-Check (PDF/JPG); `signingDate`
  nicht > 1 Tag in der Zukunft (früher erlaubt); `signed` + Attestierung
  (`mode=analog`).
- Fehlerklassen: `invalid`, `not_found`, `conflict` (Race), `expired`,
  `withdrawn`, `revoked`, `already_signed`, `denied`, `unauthenticated`.
  Unbekannte Fehler nicht roh nach außen; Token-Route leakt weder Offer noch
  interne IDs.

## 6. Rollen- und Datenvertrag

`offer.signature` ist `internalOnly`, mindestens Editor (Erzeugung/Withdraw/
Analog-Upload). Die öffentliche Token-Route ist bewusst rollenlos, aber
ausschließlich lesend + signierend und durch ein hoch-entropisches Token
geschützt.

| Actor | Request lesen | Request erzeugen | Withdraw/Analog | öffentlich signieren |
|---|---|---|---|---|
| interner Viewer | ja (read-only DTO) | nein | nein | — |
| interner Editor | ja | ja | ja | — |
| interner Admin | ja | ja | ja | — |
| `external_only` | nein | nein | nein | — |
| Worker/Auth/System | nein | nein | nein | — |
| öffentliches Token | PDF+Signierformular (nur `pending`, unexpired) | nein | nein | ja (click/draw) |

SQL-Ebene (RLS/FORCE-RLS) und Action-Ebene bleiben doppelt fail-closed. Kein
Offer-/Variante-Leak über Fehlermeldungen oder abgelaufene Links.

## 7. Event-, Audit- und Activity-Vertrag

- `domain_events`: `signature.request_created`, `signature.viewed`,
  `signature.signed`, `signature.request_withdrawn`,
  `signature.revoked_by_customer` — Payload **minimal** (IDs + Status + Modus,
  keine PII/Preise/Rechtstexte/Vollhashes).
- `audit_log`: `action ∈ {signature.create, signature.sign, signature.withdraw,
  signature.upload_analog, signature.view}`, `allowed`, Details ID-only.
- Projektaktivität (redigiert): feste deutsche Labels („Signaturanforderung
  vorbereitet", „Signiert (digital/analog)", „Signaturlink widerrufen",
  „Vom Kunden widerrufen"), keine Roh-Payload-/Wertanzeige.
- `signature.signed` ist der **Integrationspunkt** für den späteren
  `Won`-/Installations-Übergang; er wird in M2-04 emittiert, aber nicht
  konsumiert.

## 8. Lock- und Race-Vertrag

- Lock-Reihenfolge fest: Offer → SignatureRequest (wie Erasure-/Issuance-Pfad).
- Terminale Übergänge sind CAS-geschützt: genau ein `signed`/`expired`/
  `withdrawn`/`revoked_by_customer` gewinnt; parallele konkurrierende Aktionen
  erhalten `conflict` ohne Teilstand.
- Ablauf-Check (`expires_at <= now()`) läuft in derselben Transaktion wie der
  Signier-/Withdraw-Versuch; ein abgelaufener Request kann nicht mehr signiert
  oder widerrufen werden.
- View-Log-Schreiben ist append-only und toleriert hohe Last; es blockiert nie
  den Signierpfad (separate Transaktion, retriable).
- Kreuzung mit Erasure: Erasure sperrt Offer→Request zuerst und gewinnt; ein
  paralleler Signier-/Withdraw-Versuch auf einer gerade gelöschten Zeile erhält
  `denied`/`not_found`.

## 9. UI-Vertrag

- **Öffentliche Signierroute** (`/s/[token]`): read-only PDF-Vorschau
  (react-pdf vorhanden), am Ende Click-to-sign (Primär-Button) und bei
  aktiviertem draw-to-sign ein Zeichenfeld (`signature_pad`); Tablet/Touch
  zeichnen mit Pointer Events; klare Tastatur-Alternative; Status-Feedback
  `aria-live`; abgelaufener/entzogener Link zeigt definierten Endzustand.
- **Intern** (Finalise-Sektion): Signatur-Request-Liste mit Status
  (`pending/signed/expired/withdrawn/revoked_by_customer`), View-Count +
  Erstöffnung, TTL, Erzeugen/Withdraw/Analog-Upload; ehrliche Kennzeichnung
  „vorbereitet · nicht versendet" bis zur Send-/Issued-Freigabe (Microcopy analog
  `M203B1`).
- Konflikt-/Fehlerzustand bewahrt Entwurf und Fokus (Muster M1-10).
- Kein Farbsignal ohne Text/Icon; Touchziele ≥ 44 px; kein horizontaler Overflow
  bei 320/375 px; `aria-live` für Ergebnis; Reduced-Motion respektiert.

## 10. Testmatrix

### 10.1 Unit/Contract

- `M204-CONTRACT-01`: Click-to-sign-Command + Bestätigungstext (gültig/ungültig).
- `M204-CONTRACT-02`: Zeichnen-Payload (PNG, Größenlimit, leere/malformierte
  Daten abgelehnt).
- `M204-CONTRACT-03`: §356a-Fenster (nur aus `signed`, innerhalb Fenster,
  einmalig; außerhalb → `denied`).
- `M204-CONTRACT-04`: Analog-Upload (MIME-Magic PDF/JPG, Größenlimit, Malware-Check,
  Signierdatum ≤ 1 Tag Zukunft).
- `M204-CONTRACT-05`: TTL-Validierung (1–60 Tage; Default 14; 0/61 abgelehnt).
- `M204-SVC-01…06`: Command-Allowlists + Fehlerklassen (invalid/not_found/
  conflict/expired/withdrawn/revoked/already_signed/denied).

### 10.2 DB (echtes PostgreSQL)

- `M204-DB-01`: Migration frisch + idempotent; Status-CHECK + Guards greifen.
- `M204-DB-02`: `expires_at`-Ableitung/Ablaufgrenze (DB-Zeit, kein Client).
- `M204-DB-03`: terminale Übergänge nicht umkehrbar; Withdraw nur aus `pending`.
- `M204-DB-04`: Content-Hash-Bindung + Rehash der Ausstellungsbytes.

### 10.3 RLS/RBAC (negativ)

- `M204-RBAC-01`: Viewer/External/Fremdmandant/Worker lesen/mutieren nicht
  (SQL- und Action-Ebene), ohne Event-/Audit-Zeile.
- `M204-RBAC-02`: Token-Route nur lesend/signierend; kein Zugriff auf fremde
  Requests über erratene Token; Denied ohne Offer-Orakel.

### 10.4 Race

- `M204-RACE-01`: Signieren vs. Ablauf — genau ein Terminal gewinnt.
- `M204-RACE-02`: Signieren vs. Withdraw — genau einer gewinnt, anderer `conflict`.
- `M204-RACE-03`: doppeltes Signieren (Replay) — idempotent, keine zweite
  Attestierung.

### 10.5 Erasure

- `M204-ERASURE-01`: vollständiger Erasure-Lauf scrubbt Signaturbild, Analog-PDF,
  View-Zeitstempel, Signer-Name; Tombstone ID-only bleibt.
- `M204-ERASURE-02`: quellgepinnte Erweiterung bricht bei Drift ab; Graph-/
  Replay bleibt gültig.

### 10.6 Chromium-E2E / A11y

- `M204-E2E-01`: Request erzeugen → öffentlichen Link öffnen → View-Event.
- `M204-E2E-02`: Click-to-sign Happy Path → `signed` + Attestierung sichtbar.
- `M204-E2E-03`: Zeichnen (Maus + Pointer) → `signed` mit PNG-Artefakt.
- `M204-E2E-04`: intern Withdraw → Link tot (Endzustand).
- `M204-E2E-05`: Analog-Upload (PDF) → `signed` (analog).
- `M204-E2E-06`: Tablet/Touch-Signatur (Viewport/Pointer) → `signed` (draw).
- `M204-A11Y-01`: Axe, Tastatur, 375 px, Touchziele, `aria-live`, Reduced-Motion.

## 11. Abschlussgates

- `npm run check` (Vitest, alle Dateien grün) inkl. M2-04-Fälle.
- Rollenprobe + PG18-Proben (nach Lane-Integration ggf. neue Zählung).
- `db:generate` ohne Drift; Fresh- + Legacy-Migrationspfad.
- Production-Build, TypeScript, ESLint, Dependency-Cruiser, `git diff --check`,
  Secret-Scan.
- Unabhängiger Security-/Race-/Privacy-Review ohne offene P0–P2 (besonders:
  Token-Entropie, Token-Hash, kein Fingerprinting, Malware-/Typ-Check,
  Erasure-Graph).
- Chromium-E2E inkl. Axe; Visual bleibt bis Mikails Freigabe `INCONCLUSIVE`
  (`M204-VISUAL-01`).
- **Kein** Push, Deploy, E-Mail-Versand, `issued`/`Won`-Claim oder
  Provider-Aktion ohne Freigabe.

## 12. Nichtziele (NON-GOALS)

- E-Mail-Versandkette (Resend/Notify, SMTP/Resend) — eigener Slice.
- Echter Rechtsdienstleister-/Zertifikatsdienst (QES/FES, Zeitstempeldienst) —
  die Attestierung ist eine eigene technische Aufzeichnung, kein Rechtsclaim.
- Portal-White-Label (F10) — Kundenportal-Signatur ist ein eigener Slice.
- Change Order / Fork nach Signatur (eigener Slice).
- Automatischer `Won`-Übergang + Umzug aufs Installations-Board — M2-04 endet
  bei `signed` und emittiert nur `signature.signed`.
- Mehr-Varianten-/Mehr-Zahlarten-Auswahl in einem Request (`offerDocuments[]`
  mit >1 Dokument) — M2-04 bindet genau eine freigegebene Variante.
- „from where"-Geolokalisierung/IP-Erfassung (Fingerprinting) — bewusst nicht
  repliziert.
- Keine öffentliche REST-API (kein `POST …/signatureRequests/create`-Äquivalent).
- Keine Reonic-Texte, UI, Assets, Taxonomie oder private Implementierungsdetails.

## 13. DECIDED

| ID | Entscheidung | Ablage |
|---|---|---|
| `DEC-M204-01` | Content-Hash bindet an Ausstellungsfassungs-Bytes (nicht Candidate) | ADR 0022 (E1) |
| `DEC-M204-02` | TTL serverseitig `expires_at`, Default 14 Tage, Bereich 1–60 | ADR 0022 (E2) |
| `DEC-M204-03` | 5-Zustands-Modell (API-Enum exakt), Team- vs. Kunden-Widerruf getrennt | ADR 0022 (E3) |
| `DEC-M204-04` | Vorbereitungs-Gate: kein `issued`/`sent` ohne M2-03b2-Gate; interne Kennzeichnung „vorbereitet · nicht versendet" | ADR 0022 (E4) |
| `DEC-M204-05` | View-Tracking = Zeitstempel + Zähler, kein IP/UA/Referrer | ADR 0022 (E5) |
| `DEC-M204-06` | Attestierung = Signer + Zeit + Content-Hash + Modus; „from where" nicht repliziert | ADR 0022 (E6) |
| `DEC-M204-07` | Token nur als `token_hash` (SHA-256, salted) gespeichert | §5 |
| `DEC-M204-08` | `signed` ist M2-04-Endzustand; `Won`/Installation über `signature.signed`-Event (NICHTZIEL) | §12 |
| `DEC-M204-09` | Analog akzeptiert PDF **und** JPG (JPG = WMEE-Erweiterung für Scans; Doku belegt nur PDF) | §2/§5 |

## 14. Verbleibende UNKNOWN (zur Root-Integrator-/Owner-Klärung)

1. `UNK-M204-01` (INTEGRATION): M2-03b1 `a06f961` ist nicht in `tooling`/`main`
   integriert; die `offer_issuance`-Tabellen existieren nur im Worktree. Wann
   und in welcher Reihenfolge wird M2-03b vor M2-04 integriert? (M2-04 hängt an
   `issuance_id`/`content_sha256`.)
2. `UNK-M204-02` (TTL-DEFAULT): Die öffentliche Doku belegt keinen Einzelwert für
   den Link-Gültigkeits-Default („typisch 14/30/60"). `DEC-M204-02` setzt 14 Tage
   als ESTIMATE-ähnlichen Startwert — Owner-Freigabe erbeten.
3. `UNK-M204-03` (AUSLIEFERUNG): Darf die öffentliche Token-Route bereits vor dem
   M2-03b2-`issued`-Gate „live" erreichbar sein (reine Test-/Preview-Nutzung),
   oder muss auch die Routen-Aktivierung hinter dem Send-/Issued-Gate warten?
   `DEC-M204-04` nimmt die konservative Variante an.
4. `UNK-M204-04` (WON): Soll der automatische `Won`-Übergang in einem
   Folge-Slice an `signature.signed` andocken oder — wegen `MODKAT:F2.8`
   „setzt automatisch Won" — doch noch in M2-04 aufgenommen werden? Scope steht
   aktuell auf NICHTZIEL.
5. `UNK-M204-05` (MIGRATIONSNUMMER): exakte Migrationsnummer (frühestens `0043`)
   hängt von der M2-03b-/M1-wave-01-Integrationsreihenfolge ab — Root-Fix
   erbeten (Muster `UNK-M114-04`).

## Root-Entscheidungen (2026-09-02)

- **ADR-Nummer:** `0022` (die M1-15-Lane belegte `0021` bereits; Kollision
  aufgelöst, beide Referenzen aktualisiert).
- **Won-Übergang:** NICHT in M2-04 (Folge-Slice an `signature.signed`
  andocken; Scope bleibt schlank).
- **Token-Route `/s/[token]`:** nur interne Vorschau/Test erreichbar; kein
  öffentlicher Zugriff vor M2-03b2-`issued` und Resend-Freigabe.
- **Migration:** `0044` (nach M1-Welle 0040–0042 und M1-15 `0043`);
  endgültig bei Integration gegen die reale Journal-Reihenfolge prüfen.
- **JPG-Analog-Upload:** bestätigt als WMEE-Erweiterung (PDF bleibt
  API-dokumentiertes Minimum).
