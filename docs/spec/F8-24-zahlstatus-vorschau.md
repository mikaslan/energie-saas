# F8-24 — F8.3/F8.4/F8.5-Rest (Overdue-Auto, Eltern-Zahlstatus, Draft-Vorschau)

Schlussslice Track F (Verifikation F2 bestaetigt): Katalog F8.3
„Overdue(auto)", F8.5 „Eltern-Zahlungsstatus berechnet", F8.4
„Live-PDF-Preview". Auto-Save ist verifiziert N/A (s. Nicht-Umfang).

## Umfang

### F8-24a Overdue-Sweep (F8.3)

- `sweepOverdueDocuments(tx, ctx)` in neuem
  `modules/invoicing/overdue-service.ts`: alle `issued`-Belege mit
  `payment_status IN (unpaid, partially_paid)` und
  `due_date < heute (Europe/Berlin)` → `overdue` + Event
  `commercial_document.payment_updated` + Audit `document.payment.write`.
  Idempotent (bereits overdue → kein Rewrite, kein Event);
  `paid`/`uncollectable`/Entwuerfe/stornierte Belege nie beruehrt
  (DECIDED — Auto Uebergang nur aus unbezahlten Achsen).
- Worker-Queue `overdue.sweep` (Muster `invoice-pdf.render`, eigene
  Queue/Handler/Recovery/Shutdown): Handler ruft den Service mit
  Worker-Principal; `boss.schedule('overdue.sweep', '0 6 * * *', …,
  { tz: 'Europe/Berlin' })` im Bootstrap (pg-boss 12.28 `schedule`
  verifiziert vorhanden). Kein pgboss-Dispatch (Sweep ist lesend +
  Status-Update, kein Render-Job), keine Migration.
- Buckets/Detail lesen weiter `payment_status` (keine
  computed-on-read-Zweitwahrheit, DECIDED — eine Wahrheit).

### F8-24b Eltern-Zahlungsstatus (F8.5)

- `listPartialInvoices` projiziert zusaetzlich (rein lesend, kein
  Schema): `paidGrossCents` (Σ `paid_cents` nicht-stornierter Kinder),
  `openGrossCents` (max(billed − paid, 0)), `parentPaymentStatus`
  (`paid` wenn billed > 0 und open = 0; `partially_paid` wenn paid > 0;
  sonst `unpaid`; DECIDED — Spiegel recordPayment-Ableitung M301-05,
  0-EUR-Ketten bleiben `unpaid`).
- Anzeige in `partial-invoice-panel.tsx` (Ketten-Kopf: „Offen X € /
  bezahlt Y €", Status-Label). Keine Aenderung der Eltern-Sperre.

### F8-24c Draft-Vorschau ENTWURF (F8.4)

- Drittes Render-Paar auf `commercial_document_render_job`
  (Migration 0198: `draft-pdf-template.v1` /
  `draft-pdf-renderer-recipe.v1` in pair/template/recipe-CHECKs;
  kein Dispatch-Gate — Vorschau ist on-demand, kein Versand-Artefakt).
- Worker-Queue `draft-pdf.render` (Muster invoice-pdf, eigener
  Handler): rendert den AKTUELLEN Draft-Stand (Kopf + Zeilen +
  Summen, Nummern-/Datums-Luecken als „–"), Template
  `draft-template.ts` (Spiegel pdf-template, fettes
  ENTWURF-Wasserzeichen je Seite, kein Siegel-Claim, keine
  Nummern-/Ausstellungs-Zeile).
- Action `requestDraftPdfAction` (Muster pdf-actions,
  `invoicing.write`, nur `draft`, Credit-Note ok, Letter fail-closed)
  + Panel auf der Draft-Detailseite + Download ueber die bestehende
  jobId-Route (Dateiname `<name>-entwurf.pdf` via Safe-Pattern,
  DECIDED — Drafts haben keine Nummer).
- Kein Siegel, keine Hash-Aussage, kein Versand-Bezug
  (F819-Gating verlangt Invoice-Template — Draft-Jobs sind davon
  ausgeschlossen per Template, DECIDED).

## Nicht-Umfang

- Auto-Save: verifiziert N/A — es existiert keine Edit-UI-Flaeche
  (actions.ts: nur create/issue/send/terms/kind/void/archive/link/
  partial/duplicate, kein Update; create-document-dialog.tsx
  single-shot; service.ts ohne Dokument-/Zeilen-Update). Nichts zu
  speichern → nichts zu bauen (Beleg statt Annahme).
- Kein Mahnwesen (F8.7), keine Bucket-Semantik-Aenderung ausser der
  automatischen Statusquelle, kein Re-Sweep-Backfill (Bestand wird
  beim ersten Sweep uebernommen, kein Migrations-Update).
- Keine E2E fuer Sweep/Eltern (Zeit-/Ketten-Logik per DB-Tests;
  E2E nur Draft-Vorschau-Kette).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F824A-CT-01 | Sweep: nur issued+unbezahlt+faellig → overdue + Event/Audit; Rest unberuehrt; idempotent | DB-/Unit-Tests |
| F824A-CT-02 | Queue + Schedule registriert (Bootstrap-Pin wie M3-02c) | Worker-Contract-Tests |
| F824B-CT-01 | Chain-Projektion: paid/open/Status korrekt (inkl. Storno-Kinder, 0-EUR) | DB-/Contract-Tests |
| F824B-CT-02 | Panel zeigt Offen/Bezahlt/Status | UI-Contract-Tests |
| F824C-CT-01 | Draft-Job: nur draft, Template-Paar, ENTWURF-Bytes, kein Siegel | Contract-/Unit-/DB-Tests |
| F824C-CT-02 | Action/Panel/Route: Parsing, Capability, `-entwurf.pdf`, no-store | Contract-Tests |
| F824-E2E-01 | Draft → Vorschau anfordern → Download → ENTWURF-Bytes stimmen | E2E-Test |

## Module

- Neu: `modules/invoicing/overdue-service.ts`,
  `lib/integrations/invoicing/draft-template.ts`,
  `worker/draft-pdf.ts`, `worker/draft-pdf-database.ts`,
  `worker/draft-pdf-renderer.ts` (Muster invoice-pdf-Tripel, schlank),
  `app/.../draft-actions.ts`, `draft-pdf-panel.tsx`.
- Angefasst: `worker/index.ts` (2 Queues + Schedule + Shutdown),
  `modules/invoicing/partial-service.ts` (Projektion),
  `partial-invoice-panel.tsx`, `[documentId]/page.tsx`,
  `modules/invoicing/index.ts`, Migration 0198.
- Tests: `tests/unit/f824-*.test.ts`,
  `tests/contracts/f824-*.test.ts`, `tests/db/f824-*.test.ts`,
  `tests/e2e/f8-24-draft-preview.spec.ts`.

## DECIDED

- Sweep täglich 06:00 Berlin; eine Statuswahrheit (kein computed overdue).
- Eltern-Status spiegelt M301-05-Ableitung (0 EUR → unpaid).
- Draft-Vorschau als Worker-Job (Chromium nur im Worker garantiert),
  drittes Render-Paar, kein Siegel, kein Versand-Bezug.
- Auto-Save N/A mit Beleg (keine Edit-Flaeche).

## Offene Schaetzung (ESTIMATE)

- Sweep-Cron weit vor Geschäftsstart (06:00) + Handler-Laufzeit < 60 s
  (Mengen-Cap 10.000, Rest Folgetag mit Hinweis im Health-Log).
- Draft-Template-Layout folgt pdf-template (reduziert: Kopf/Zeilen/
  Summen + Wasserzeichen, keine Steuer-/Zahlungs-Seiten).
- `sendDocumentAction`-Rueckwaertskompat unberuehrt (Nicht-PDF-Typen).
