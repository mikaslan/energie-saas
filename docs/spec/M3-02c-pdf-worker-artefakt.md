# M3-02c · Rechnungs-PDF-Worker und Artefakt

Status: `SPECIFIED` · Zielbereich: F8 Rechnungen (M3-02c)
Stand: 2026-09-17
Vorbedingungen: M3-02b (versiegelter Render-Input + Job-Zeile, Migration 0192)

## Ergebnis

Der in M3-02b versiegelte `invoice-pdf-input.v1` wird von einem
Least-Privilege-Worker unter einem gepinnten Renderer-Rezept in exakte
PDF-Bytes gerendert. Der Job durchlaeuft
`requested → queued → running → retry_wait / succeeded / failed_final`;
das Artefakt (PDF-Bytes + SHA-256 + Groesse, bis 8 MiB) wird
tenantgeschuetzt in Postgres gestaged. Download-Route, UI und
Browser-Kette folgen in M3-02d; dieser Slice liefert Worker, Template,
Artefakt und die P1-Tabellenhaertung aus M3-02b.

## Warum dieser Schnitt

M2-02 beweist das Muster (ID-only-Job, Lease-Claim, offline/sandboxed
Chromium, Byte-/Hash-Pruefung). M3-02c uebertraegt es auf finale
Rechnungs-PDFs — mit einem Unterschied: Rechnungen sind bereits
ausgestellt, das PDF ist kein Entwurf (kein Entwurfs-Wasserzeichen).
Worker und Template sind untrennbar (Container-Smoke rendert das echte
Template); Download/UI/E2E sind der getrennte Folgeslice M3-02d.

## Nicht-Ziele und harte Grenzen

- keine Download-Route, kein UI-Panel, keine E2E-Kette (M3-02d);
- kein Versand, keine E-Mail, keine Signatur, kein Portal-Zugriff;
- keine ZUGFeRD-/Factur-X-Einbettung;
- kein Remote-HTML, kein URL-Render, keine externen Fonts/Bilder/CSS;
- kein Worker-Schreibzugriff ausserhalb Claim/Finalize (least privilege);
- keine stillen Kauefe, Deployments oder Providerzugriffe.

## P1-Auflagen aus M3-02b (werden hier geschlossen)

1. RLS-SELECT verschaerfen: `input_json` enthaelt Steuer-ID/IBAN
   (M3-01 schwaerzt ohne `issuing_details.write`). SELECT-Policy auf
   `_m301_actor_can_write_invoicing` heben (Write-Schranke statt
   Viewer+); Download-Auth (M3-02d) zieht `issuing_details.write` nach.
   Tenant-Invarianten-Test um Editor-Scoped-Zaehlung erweitern.
2. DB-Immutability-Trigger `_m302c_guard_render_input_immutable()`:
   `input_json`/`input_sha256`/`template_version`/`renderer_recipe`/
   `document_id` nach Insert unveraenderlich; Status-/Artefakt-/
   Lease-Spalten folgen der Zustandsmaschine.

## Capability-Vertrag

### M302C-01 · Dispatch und Claim

- `requestInvoicePdfInput` (M3-02b) stellt zusaetzlich zu: neuer Job
  wird per `pgboss.enqueue_invoice_pdf_render(workspace_id, job_id)`
  dispatched (eigene Funktion + Grant an `app_runtime`, Muster
  `enqueue_offer_pdf_draft`); Test-Skip ohne pgboss wie M2-02.
- Claim (Worker, `app_worker`): genau ein `queued`/`retry_wait`-faelliger
  Job per `FOR UPDATE SKIP LOCKED`, Lease-Token + Ablauf, `attempt_count`
  1..3, `running`; Doppel-Claim unmoeglich (Lease-Besitz).
- Eingangspruefung wie M2-02: Input re-validieren, Versions-Pins
  (Input/Template/Rezept/Kanonisierung) gegen Zeile pruefen, Re-Hash
  exakt — sonst `failed_final` (nicht retryable).

### M302C-02 · Render und Finalize

- Renderer: offline/sandboxed Chromium, `linux/amd64`, gepinnte
  Playwright-Version, Digest-gepinntes Container-Rezept (Name
  `invoice-pdf-renderer-recipe.v1` aus M3-02b bleibt Zeilen-Pin).
  DECIDED: Der Invoice-Renderer laeuft im selben Worker-Container wie
  Offer-PDF (kein neues Image); Digest-Bindung =
  `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac`
  (`worker/Dockerfile:33`), verifiziert im Container-Smoke plus
  `scripts/verify-invoice-pdf-renderer.mts` (Spiegel des
  Offer-Skripts, Dockerfile-Bundling-Zeile).
- Template `invoice-pdf-template.v1`: finale Rechnung (kein Entwurf),
  Absender-/Empfaenger-Bloecke aus versiegeltem Input, Positionen,
  Summen, Nummern/Daten/Skonto; keine Live-Daten, keine Leaks.
- Finalize: Artefakt-Bytes + SHA-256 + Groesse + MIME
  (`application/pdf`) atomar schreiben, `succeeded`; Byte-/Hash-Readback
  exakt. `retry_wait` mit `next_attempt_at` bei retryable Fehlern,
  `failed_final` nach 3 Versuchen oder fatalem Fehler.

### M302C-03 · Migration 0193

- `commercial_document_render_job`: Status-CHECK auf
  `requested/queued/running/retry_wait/succeeded/failed_final`
  erweitern; Spalten `attempt_count`, `next_attempt_at`,
  `lease_token`, `lease_expires_at`, `started_at`, `finished_at`,
  `error_code`, `error_retryable`, `artifact_mime_type`,
  `artifact_sha256`, `artifact_bytes`, `artifact_size_bytes`;
  Shape-CHECKs je Status (Artefakt nur bei `succeeded`, Lease nur bei
  `running`/`retry_wait`); Immutability-Trigger (s. P1-2);
  SELECT-Policy verschaerfen (s. P1-1).
- `pgboss.enqueue_invoice_pdf_render(uuid, uuid)` + Grant.
- Rollenvertrag: Trigger-/Policy-Pins ernten, `app_worker`
  Claim/Finalize-Grants (least privilege, Muster M2-02).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| M302C-CT-01 | Dispatch bei Anforderung; ohne pgboss Test-Skip, sonst Worker-Fehler | DB-Tests |
| M302C-CT-02 | Claim: genau ein Job, Lease exklusiv, Doppel-Claim unmoeglich | DB-Tests |
| M302C-CT-03 | Eingangspruefung: Version-/Hash-Drift → `failed_final`, nicht retryable | DB-Tests |
| M302C-CT-04 | Finalize: Bytes+SHA+Groesse+MIME atomar, Readback exakt; Retry 3×, dann `failed_final` | DB-Tests |
| M302C-CT-05 | Template rendert nur versiegelten Input (keine Live-/Leak-Felder) | Contract-/Unit-Tests |
| M302C-CT-06 | Container-Smoke: gepinntes Rezept rendert deterministisch (Seitenzahl + Hash-Stabilitaet) | Container-Test |
| M302C-DB-01 | Migration 0193: Status-/Shape-CHECKs, Trigger (Input-Spalten immutable, Status-Pfad offen), RLS-SELECT Write-Schranke, Worker-Grants least-privilege | DB-Tests |
| M302C-E2E-01 | (M3-02d) Browser-Kette erst mit Download/UI | — |

## Offene Schaetzung (ESTIMATE)

- Container-Digest und Playwright-Pin folgen dem Offer-PDF-Rezept,
  sofern der Renderer es byte-identisch wiederverwendet.
- PDF-Layout (finale Rechnung) ohne Live-Referenz; GoBD-Aufbewahrung
  der Artefakte bleibt WORM-/Retention-Gate.
