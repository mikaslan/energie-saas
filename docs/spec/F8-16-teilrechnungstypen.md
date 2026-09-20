# F8-16 Teilrechnungstypen-Kennung (Katalog F8.1)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/muse-fleet-4-rechnungen` · Migration **0190** · Stand 2026-09-17 (Contract 8/8, DB 2/2, E2E 1/1 mit 375/768/1440 + Axe, F8-Nachbar-E2E 26/26, tsc/eslint/depcruise/catalog grün, Rollen 88/88 + PG18 5/5, Build grün, 3× Schwarm-Review + codex GO ohne P0/P1)

Ziel: Die vier Katalog-Teilrechnungstypen (Anzahlung/Abschlag/Teil/
Schluss) als explizite, revisionssichere Kennung je Rechnung schließen.
Heute sind Anzahlung (F8-01-Link) und Teilrechnung (F8-05-Kette) nur
implizit über Relationen erkennbar; Abschlag vs. Teil vs. Schluss ist
am Beleg gar nicht unterscheidbar. Die Kennung ist ein optionales,
rechnungsgebundenes Label mit Draft-Editierbarkeit und
Ausstellungs-Freeze (GoBD-Parität zu `credit_note_type`).

## ESTIMATE (reversibel, Referenzfrage offen)

- Vier Werte, deutsche DB-Codes wie `credit_note_type`-Präzedenz:
  `anzahlung`, `abschlag`, `teilrechnung`, `schlussrechnung`.
  Exakte Reonic-Typnamen/-semantik UNKNOWN.
- KEIN Auto-Copy bei Anlage aus AB/Duplikat/Angebots-Import/Teilkette
  (Skonto-Präzedenz F8-05/06/07/08/12/13/14): neues Dokument startet
  mit `invoice_kind = null` („einfache Rechnung“).
- KEINE Kopplung an Ketten-/Link-Relationen: Die Kennung ist ein
  freies Label, kein abgeleiteter Zustand. Ob eine Schlussrechnung
  eine Kette schließen muss, bleibt bewusst offen (kein Verhalten,
  das existierende F8-01..F8-15-Tests brechen könnte).
- Snapshot-Siegel steigt `document-snapshot.v2` → `v3` und nimmt
  `invoiceKind` auf. v1/v2-Snapshots bleiben unverändert lesbar
  (kein Snapshot-Reader im Code; Siegel ist Write-only + Hash).

## CONTRACTED (bindend)

- DB (0190, additiv, Legacy-null-sicher):
  `commercial_document.invoice_kind text null`,
  `commercial_document_invoice_kind_ck` (null oder 4 Werte),
  `commercial_document_invoice_kind_scope_ck` (null oder
  `type = 'invoice'`), Guard-Replace
  `_m301_guard_issued_immutable` + `NEW.invoice_kind`-Freeze-Zeile.
  Kein Backfill (null = einfache Rechnung). Kein RLS-/Policy-Delta,
  keine neue Permission (bestehende `invoicing.read/write`).
- Zod (`lib/integrations/invoicing/contract.ts`):
  `commercialInvoiceKinds` + `commercialInvoiceKindSchema`;
  Draft-Input optional `invoiceKind` (invoice-only-Refine, sonst
  `invalid`); `commercialDocumentV1Schema` + Detail/Liste liefern
  `invoiceKind` (nullable); neues
  `COMMERCIAL_DOCUMENT_INVOICE_KIND_COMMAND_VERSION`
  (`documentId` + `invoiceKind` nullable = Löschen im Entwurf);
  Listenfilter `invoiceKind` (Scope nur `type = invoice`).
- Service (`modules/invoicing/service.ts`):
  `createDocument` speichert die Kennung; `setInvoiceKind`
  (draft-only + invoice-only + `invoicing.write`, sonst
  `Conflict`/`Validation`/`Denied`); `issueDocument` siegelt die
  Kennung in Snapshot-v3 + Hash; Void behält die Kennung
  (eingefroren); Geldspalten bleiben bei Kennungswechsel bit-identisch.
- Events/Audit nur IDs + Kennung (Event
  `commercial_document.kind_set`, Audit-Action `document.kind_set`;
  Anlage-Evidence traegt die Kennung mit, kein PII).
- UI: Erstelldialog Kennungs-Select (nur Typ Rechnung), Detail-
  Kopf-Badge, Listenfilter; Labels in `labels.ts`
  (`INVOICE_KIND_LABELS`: Anzahlung/Abschlag/Teilrechnung/
  Schlussrechnung).

## Geschlossene Testmatrix

- `F816-DB-01`: Rechnung mit `teilrechnung` anlegen → ausstellen →
  Siegel-v3 enthält die Kennung, 32-Byte-`snapshot_sha256` vorhanden,
  direktes SQL-UPDATE der Kennung → `23514`, Void behält die Kennung,
  Geld unverändert. Die Hash-Rekonstruktion über die v3-Form beweist
  `M301-ISSUE-06` (kanonischer Feldspiegel inkl. Kennung).
- `F816-DB-02`: Kennung an Gutschrift → `Validation`; Setzen an
  ausgestellter Rechnung → `Conflict`; Löschen im Entwurf → null;
  Viewer-denied; Fremdtenant-NotFound; Listenfilter findet nur
  passende Kennung; Duplikat/Teilkette starten mit null
  (Angebots-Import per Review: eigenes INSERT ohne Spalte → Default
  null — Offer-Graph-Fixture für eine Null-Assertion zu schwer).
- `F816-CONTRACT-01`: Zod-Formen (Draft-Refine invoice-only,
  Kind-Kommando nullable, Listenfilter-Scope, DTO-Roundtrip).
- `F816-E2E-01`: Rechnung mit Kennung Anzahlung anlegen → Detail
  zeigt Badge → Listenfilter findet sie → ausstellen → kein
  Edit-Control mehr (eingefroren). Viewports 375/768/1440 + Axe.

## Bewusst offen

- Ketten-/Schluss-Regeln (Schluss schließt Kette?), Portal-Sicht
  der Kennung, Berichte-Gruppierung je Kennung, Reonic-Typnamen.
