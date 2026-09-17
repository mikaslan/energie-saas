# M3-02b · Render-Input-Vertrag Rechnungs-PDF

Status: `SPECIFIED` · Zielbereich: F8 Rechnungen (M3-02b)
Stand: 2026-09-17
Vorbedingungen: M3-01 (Rechnungs-Kern), M3-02a (Zeilen-Freeze + Empfaenger-Snapshot)

## Ergebnis

Fuer genau ein ausgestelltes Belegdokument (`status = 'issued'`, Typ
`invoice` oder `credit_note`) laesst sich ein versiegelter, minimierter,
gehashter Render-Input `invoice-pdf-input.v1` anfordern. Der Input wird in
der autorisierten Transaktion aus Postgres aufgebaut, kanonisch serialisiert
und per SHA-256 gebunden; die Job-Zeile referenziert Dokument, Input-Hash und
Template-/Renderer-Versionen. Spaetere Aenderungen (Zahlstand, Stammdaten,
neue Belegrevisionen) mutieren den versiegelten Input nicht.

## Warum dieser Schnitt

M2-02 bindet exakt eine immutable Variantenrevision in einen gehashten Input,
bevor ein Worker rendert. M3-02b uebertraegt dieses Muster auf Belege:
M3-02a hat Zeilen-Freeze und Empfaenger-Snapshot versiegelt, der Render-Input
ist der naechste echte Schritt. Worker-Lebenszyklus, Chromium-Render,
Artefakt-Bytes und Download folgen in M3-02c; dieser Slice liefert nur den
versiegelten Input-Vertrag plus Job-Zeilen-Bindung.

## Nicht-Ziele und harte Grenzen

- kein Worker, kein Claim, kein Rendering, keine Artefakt-Bytes;
- keine Download-Route, kein Versand, keine E-Mail, keine Signatur;
- keine ZUGFeRD-/Factur-X-Einbettung, keine E-Rechnung (F8-10 bleibt Download);
- kein Live-Kontakt: Empfaenger kommt ausschliesslich aus `recipient_snapshot`
  (M3-02a); fehlender Snapshot → Fail-closed;
- kein Live-Zahlstand: `paid_cents`/`payment_status` sind mutabel und bleiben
  ausserhalb des Inputs (Renderer zeigt keine Zahlungshistorie);
- keine EK-, Margen-, Audit-/Event-, Actor- oder Kontakt-Leaks;
- keine Entwuerfe, keine stornierten Belege, keine Briefe (`letter`);
- keine stillen Kauefe, Deployments oder Providerzugriffe.

## Quellen und Klassifikation

- `docs/spec/M2-02-angebots-pdf-entwurf.md`: Input-Versiegelungsmuster
  (`DOCUMENTED`, lokal verifiziert).
- `docs/spec/M3-02a-siegel-voraussetzungen.md`: Zeilen-Freeze-Trigger und
  Empfaenger-Snapshot-Vertrag (`DOCUMENTED`, lokal verifiziert).
- `lib/db/schema/invoicing.ts`: `commercial_document`,
  `commercial_document_line`, `workspace_invoicing_settings`
  (`DOCUMENTED`, Code).
- Katalog F8.1/F8.5: Rechnungsarten, Ausstellung friert ein
  (`DOCUMENTED`).

## Capability-Vertrag

### M302B-01 · Render-Input anfordern

Der Client sendet ausschliesslich:

```text
workspaceId, documentId
```

Alle Belegdaten werden innerhalb der autorisierten Transaktion erneut aus
Postgres geladen. Vorbedingungen:

- authentifizierte aktive Membership im Workspace;
- nicht `external_only`;
- `invoicing.write` fuer die Mutation (gleiche Schranke wie Ausstellung);
- Dokument gehoert zum Workspace, `type in ('invoice', 'credit_note')`,
  `status = 'issued'`, Nummer gesetzt (`number`, `number_year`,
  `number_sequence`), `issued_at` gesetzt;
- `recipient_snapshot` vorhanden und gegen
  `commercialRecipientSnapshotV1Schema` (M3-02a) re-validiert;
- Positionen exakt aus `commercial_document_line`, sortiert nach `position`,
  lueckenlos ab 1, Summenarithmetic `gross = net + tax` je Zeile und
  `Σ Zeilen == Kopf` (net/tax/gross) geprueft;
- Absender-Snapshot aus `workspace_invoicing_settings` (aktuelle Revision,
  Revisionsnummer wird mitversiegelt);
- hoechstens ein Job je `(Workspace, Dokument, Template-Version,
  Renderer-Rezept)`; Replay liefert denselben Job, Parallelaufruf erzeugt nie
  zwei fachliche Jobs (UNIQUE + atomarer Insert).

### M302B-02 · Render-Input versiegeln

Der gespeicherte `invoice-pdf-input.v1` enthaelt nur:

- Dokumentart, Rechnungsart-Kennung (`invoiceKind`, nur invoice),
  Gutschrift-Typ (`creditNoteType`, nur credit_note), Belegnummer,
  Ausstellungs-/Faelligkeits-/Leistungsdatum, Skonto-Kondition;
- versiegelten Empfaenger-Snapshot (M3-02a);
- versiegelten Absender-Snapshot (Firma, Adresse, Steuer-ID/Register,
  Zahlungsverbindung, Settings-Revision);
- alle Positionen mit Position, Titel, Menge/Einheit, Netto/Steuer/Brutto,
  Steuersatz;
- Kopf-Summen in EUR (net/tax/gross cents);
- festen DB-Zeitpunkt der Vorbereitung;
- feste Dokument-, Template-, Canonicalization- und Renderer-Versionen.

Ausgeschlossen: Kontakt-IDs, Live-Kontaktdaten, `paid_cents`,
`payment_status`, Audit-/Event-Spuren, interne Hashes, Actor-IDs,
Katalog-/EK-/Margen-Daten, rohe Snapshots ausserhalb der beiden Blöcke.

### M302B-03 · Kanonisierung und Hash

- Kanonische Serialisierung: UTF-8, NFC-normalisierte Texte (M3-02a-Semantik),
  Schluessel sortiert, keine Whitespace-Varianten, feste Zahlenformate
  (Cents als Integer, bps als Integer, Daten ISO-8601);
- `input_sha256_hex = sha256(canonical_bytes)` (Hex, 64 Zeichen);
- DB-Zeile speichert `input_sha256` (bytea) + `input_json` (jsonb);
  Re-Hash bei jedem Lesen muss exakt uebereinstimmen (Tamper-Fail-closed);
- Versionskonstanten: `INVOICE_PDF_INPUT_VERSION = 'invoice-pdf-input.v1'`,
  `INVOICE_PDF_TEMPLATE_VERSION = 'invoice-pdf-template.v1'`,
  `INVOICE_PDF_CANONICALIZATION_VERSION = 'invoice-pdf-jcs.v1'` (eigene
  Konstante, kein GoBD-Import),
  `INVOICE_PDF_RENDERER_RECIPE_VERSION = 'invoice-pdf-renderer-recipe.v1'`
  (gepinnt, analog M2-02).

### M302B-04 · Job-Zeilen-Bindung (Migration 0192)

Neue Tabelle `commercial_document_render_job` (Workspace-scoped):

- `id`, `workspace_id`, `document_id` (FK auf `commercial_document`),
  `input_json` (jsonb, Pflicht), `input_sha256` (bytea, Pflicht),
  `template_version`, `renderer_recipe` (Pflicht, CHECK-gepinnt),
  `status` (`requested`, Pflicht, Default — einzige M3-02b-Stufe),
  `created_by`, `created_at`, `updated_at`;
- UNIQUE `(workspace_id, document_id, template_version, renderer_recipe)`;
- CHECKs: Status-Pinned, Template-/Rezept-Pinned, JSON-ist-Objekt,
  SHA-32-Bytes;
- RLS: Tenant-Isolation wie `commercial_document` (App-Rolle sieht nur
  eigenen Workspace; Worker-/System-Rollen in M3-02c);
- kein Update-Pfad im Service (Input immutable); DB-seitiges
  Immutabilitaets-Enforcement per Trigger folgt in M3-02c (bis dahin
  service-seitig; UPDATE bleibt fuer kuenftige Status-Uebergaenge gegrantet).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| M302B-CT-01 | Anforderung ohne `invoicing.write` / als External (`external_only`) / fremder Tenant → Fail-closed (NotFound/Forbidden, kein Job) | DB-Tests |
| M302B-CT-02 | Entwurf/storniert/Brief/fehlender Snapshot → Validation, kein Job; fehlende Nummer ist DB-unerreichbar (`issued_gate_ck`), Service-Guard ist Defense-in-depth | Contract-/DB-Tests |
| M302B-CT-03 | Lueckenhafte Positionen, Summenbruch (Zeile/Kopf), falscher Steuersatz → Validation | Contract-Tests |
| M302B-CT-04 | Sequentielles Replay + paralleler Doppelaufruf → genau ein Job (UNIQUE, kein Duplikat) | DB-Tests |
| M302B-CT-05 | Input enthaelt nur erlaubte Felder (Top-Level- + Nested-Allowlist), keine Leaks (IDs, paid, Events, live Kontakt, EK/Marge/Katalog) | Contract-Tests |
| M302B-CT-06 | Kanonisierung deterministisch (NFC, Key-Order, -0-Norm), Zyklus/Kollision/unsichere Zahlen werfen; Hash-Readback exakt; manipulierter Speicher-Input → Replay fail-closed | Contract-/DB-Tests |
| M302B-DB-01 | Migration 0192: Tabelle + UNIQUE + CHECKs + RLS; Fremd-Tenant unsichtbar; Duplikat-Insert → UNIQUE-Violation; Status-/Template-/Rezept-/JSON-/SHA-fremde Werte → CHECK-Violation | DB-Tests |
| M302B-E2E-01 | (M3-02c) Browser-Kette erst mit Worker/Download — in M3-02b kein UI-Anteil | — |

## Benannte Abweichungen (DECIDED)

- M3-01-Eingaberegeln werden am Render-Input NICHT erneut erzwungen:
  `dueDate`-Pflicht (invoice), `creditNoteType`-Pflicht (credit_note),
  Skonto-Paar-/invoice-only-Regel. Begruendung: ausgestellte Belege haben
  diese Gates bereits passiert; Render darf keine neu ablehnende Schranke
  fuer Bestandsbelege sein (Verfuegbarkeit vor Doppelpruefung).
- Leistungsdatum-Praezedenz: `delivery_date`, sonst
  `planned_service_date`, sonst null (Ist vor Plan).
- „Belegnummer" umfasst `number` + `number_year` + `number_sequence`.
- Leere Optionals koerzieren zu null (exakte M3-02a-Semantik).
- Download-Pfad (M3-02c) muss die `issuing_details.write`-Schranke
  nachziehen: der versiegelte Sender enthaelt Steuer-ID/IBAN.

## P1-Auflagen an M3-02c (BSI-Closing-Review M3-02b)

- RLS-SELECT auf `commercial_document_render_job` nutzt
  `_m301_actor_can_read_invoicing` (Viewer+), liest damit `input_json`
  inkl. Steuer-ID/IBAN — M3-01 schwaerzt dieselben Felder ohne
  `issuing_details.write` (`modules/invoicing/service.ts:199-217`).
  M3-02c muss mit dem Download-Pfad entscheiden: SELECT-Policy
  verschaerfen (Write-/Issuing-Schranke) und Download-Auth auf
  `issuing_details.write` heben. Bis dahin kein App-Lesepfad (nur
  DB-direkt sichtbar).
- DB-Immutability-Trigger fuer `input_json`/`input_sha256` (schliesst
  konsistenten Hash-Tamper; Spec M302B-04).

## Offene Schaetzung (ESTIMATE)

- Template-Version `invoice-pdf-template.v1`, Renderer-Rezept-Pin und
  Canonicalization-Version sind neue Konstanten ohne Live-Referenz.
- Absender-Snapshot-Umfang (Steuer-ID/Register/Zahlung) folgt den
  M3-00-Feldern; Pflichtangaben-Pruefung bleibt Fach-Folgeslice.
