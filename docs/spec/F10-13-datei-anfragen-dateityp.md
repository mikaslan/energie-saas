# F10-13 Datei-Anfragen: Dateityp je Vorlage/Anfrage (Katalog F10.2)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/muse-fleet-3-portal-install` · Stand 2026-09-17
Basis: Modulkatalog F10.2 („File Requests (Templates: Titel, Dateityp, „Allow many")")
Beleg: `npm run check` exit 0 (406 Dateien, 2886 bestanden/1 skipped,
Rollen 88/88, PG18 5/5), F1013 DB 3/3 + Contract 2/2, E2E F10-13 1/1
(375/768/1440 + Axe, pdf+image je ok/ungueltig, QR, Download
byte-identisch), Nachbar-E2E f10-04/f10-10/f16-07 gruen, Build gruen,
2 unabhaengige Reviews GO ohne offene P0–P2 (P1-Auflagen geschlossen)

## Ziel und Abgrenzung

Offener Rest aus F10-04/F10-10/F16-07: Weder Vorlage noch Anfrage kennen
eine Dateityp-Einschraenkung. Das Portal verdrahtet
`accept=".pdf,.jpg,.jpeg,.png"` fix (`app/p/[token]/page.tsx`), der
anonyme Upload prueft nur den globalen Vorrat (PDF/JPEG/PNG, 10 MiB).
Dieser Slice macht den Dateityp durchgaengig: Auswahl bei Vorlage und
Anfrage → Persistenz → Portal-Projektion mit dynamischem `accept` →
**serverseitiger** Guard im anonymen Upload-Pfad (Erst- und Folge-Beleg).

Nicht in diesem Slice: neue globale Dateiformate (Office/Zip/HEIC),
Virenscan, Portal-Download, „Visible to customer"-Flag (F10-14-Kandidat),
KfW-Upload-Kontext (F10-15).

## ESTIMATE (reversibel, Referenzfrage offen)

- Wertvorrat: `'any' | 'pdf' | 'image'` — `pdf` = nur
  `application/pdf`; `image` = JPEG/PNG (`image/jpeg`, `image/png`);
  `any` = globaler Vorrat wie bisher. Feinere Stufen (nur JPG, nur PNG)
  sind ohne Reonic-Beleg nicht vorgesehen; Erweiterung bleibt reversibel
  (neuer CHECK-Wert + Projektion, kein Umbau).
- Die exakte Reonic-Dateityp-Semantik ist ohne Live-Referenz UNKNOWN;
  Wortschatz und Fail-closed-Regeln unten sind eigene reversible Naeherung.
- Dateityp ist Anlage-Attribut (immutable): kein Update-Pfad, kein
  Template-Re-Apply auf bestehende Anfragen (Muster allowMany).

## Vertrag

- Spalte `file_type text NOT NULL DEFAULT 'any'` auf `file_request`
  und `file_request_template`, CHECK `file_type in ('any','pdf','image')`.
  Bestand faellt auf `'any'` (verhaltenserhaltend).
- `createFileRequest` akzeptiert `fileType` (strikt, Default `'any'`);
  Template-Create/Update/Apply transportieren `fileType` 1:1
  (Template-Contract V3, `schemaVersion: 3`).
- Internes DTO (`FileRequestDto`, Template-DTO) traegt `fileType`;
  Akte-Sektion zeigt den Typ je Anfrage (Label), Anlage-Formular und
  Template-Manager bieten eine Auswahl (Default „Alle").
- Portal-Projektion `portalFileRequestSchema` erhaelt `fileType`
  (Pflicht nach tolerantem Parse; fehlend = Alt-Projektion → `'any'`,
  Muster allowMany). Minimiert: nur das Wort, keine Interna.
- Portal-Dateien-Tab: `accept`-Attribut je Anfrage aus `fileType`
  (`any` → `.pdf,.jpg,.jpeg,.png`; `pdf` → `.pdf`;
  `image` → `.jpg,.jpeg,.png`) plus sprachneutraler Hinweis aus dem
  Dateityp selbst (keine neuen Woerterbuecher in 11 Sprachen).
- Serverseitiger Guard (autoritative Ebene, Race-sicher, da immutable):
  - `fulfillFileRequestByToken` liest `fileType` aus der bereits
    aufgeloesten Portal-Sicht (kein Extra-Query) und verweigert
    unpassende Content-Types/Endungen VOR dem Storage-Put
    (`FileRequestValidationError` → Route meldet `ungueltig`).
  - DEFINER `fulfill_file_request` / `fulfill_file_request_followup`
    pruefen `file_type` zusaetzlich in der DB (`'invalid'` bei
    Fehltyp — Defense in Depth gegen direkte Kapsel-Aufrufe).
    Semantik sonst unveraendert (`ok`/`conflict`/`not_found`/`invalid`).
- Rechte: Bestand (`project.read`/`project.write`), KEINE neuen Keys.
  Portal-Pfad bleibt Token-DEFINER ohne Session-Kontext.
- Events/Audit: keine neuen Typen; `file_request.created` unveraendert
  (kein Typ in Payload — kein neuer PII-/Volumenpfad).

## Datenmodell (Migration 0170, additiv)

- Generator-Anteil: `file_request.file_type` (Schema-TS +
  `db:generate`, danach auf 0170 umnummeriert, Re-Run ohne Drift).
- Hand-Anteil: `file_request_template.file_type` (+ CHECK),
  `CREATE OR REPLACE resolve_portal_public_view` (beide Ruempfe:
  `'fileType'` in `file_request_list`), `CREATE OR REPLACE` beider
  Fulfill-Kapseln (Typ-Guard, Signatur unveraendert — Grants bleiben).
- Rollenvertrag (`scripts/db-role-contract.mts`): neue Spalten-Marke
  `hasFileRequestFileType` (atomar beide Spalten, Muster
  `hasInvoiceSkontoTerms`); bedingte Prosrc-Pins fuer alle drei
  geaenderten Funktionen (Hashes per Embedded-Probe geerntet, alte
  Prefixe bleiben gruen).
- Journal-/Upgrade-Pins: `TOTAL_MIGRATION_COUNT` 149 → 150, End-Eintrag
  `0170_...` in `m111a-project-outcome-migration-upgrade.test.ts` und
  `m111a-project-outcome-database.test.ts` (Erweiterung, kein Umbau).

## Geschlossene Testmatrix

- `F1013-DB-01`: Anlage mit Typ (Request + Vorlage + Apply-Transport),
  Default `'any'`, Fremdtyp-Verweigerung, Viewer liest, Fremdzugriff
  fail-closed.
- `F1013-DB-02`: Token-Erfuellung je Typ (pdf nimmt PDF, verweigert JPG;
  image nimmt JPG/PNG, verweigert PDF; any wie bisher), Folge-Beleg
  (Allow-many) respektiert den Typ, Direkt-Kapsel mit Fehltyp → `invalid`.
- `F1013-DB-03`: Portal-Projektion traegt `fileType`; Alt-Parse ohne
  Schluessel → `'any'` (Contract-Ebene).
- `F1013-CONTRACT-01`: `portalFileRequestSchema` + toleranter Parse
  (fremde Typen fail-closed, Alt-Projektion ehrlich).
- `F1013-E2E-01`: Akte → Anlage mit Typ „Nur PDF" → Portal-Link →
  `accept`-Attribut + Hinweis → PDF-Upload ok → JPG-Upload `ungueltig` →
  QR + Download byte-identisch → Erledigt. Viewports 375/768/1440 + Axe,
  als anonymer Kunde.

## Bewusst offen

- Feinere Typen (nur JPG/PNG einzeln), zusaetzliche Formate.
- Typ-Aenderung an bestehenden Anfragen/Vorlagen-Versionierung.
- F10-08-Versandtext mit Typ-Hinweis (Provider-Blocker wie bisher).
