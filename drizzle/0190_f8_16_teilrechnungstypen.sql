-- ═══════════════════════════════════════════════════════════════════════
-- F8-16 Teilrechnungstypen-Kennung (Katalog F8.1): optionale Kennung je
-- Rechnung (anzahlung/abschlag/teilrechnung/schlussrechnung), invoice-only,
-- Legacy-null-sicher (null = einfache Rechnung). Der M301-Guard friert die
-- Kennung ab Ausstellung ein (GoBD-Paritaet zu
-- credit_note_type). Keine neue Tabelle, keine Grants, RLS unveraendert.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "commercial_document" ADD COLUMN "invoice_kind" text;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_invoice_kind_ck" CHECK ("commercial_document"."invoice_kind" is null
        or "commercial_document"."invoice_kind" in ('anzahlung', 'abschlag', 'teilrechnung', 'schlussrechnung'));--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_invoice_kind_scope_ck" CHECK ("commercial_document"."invoice_kind" is null or "commercial_document"."type" = 'invoice');--> statement-breakpoint
CREATE OR REPLACE FUNCTION public._m301_guard_issued_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m301_issued_immutable$
BEGIN
  -- Kimi-P1-3: Statusmaschine draft -> issued -> voided ist die einzige
  -- erlaubte Kantenfolge; voided ist terminal, issued nur nach voided.
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'issued', 'voided') THEN
    RAISE EXCEPTION 'invalid_document_status_transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'issued' AND NEW.status NOT IN ('issued', 'voided') THEN
    RAISE EXCEPTION 'invalid_document_status_transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'invalid_document_status_transition' USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('issued', 'voided') THEN
    -- Status ist NICHT Teil des Content-Freezes: die erlaubten Kanten
    -- (issued→voided) regeln die Transition-Checks oben.
    IF NEW.type IS DISTINCT FROM OLD.type
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.number_year IS DISTINCT FROM OLD.number_year
       OR NEW.number_sequence IS DISTINCT FROM OLD.number_sequence
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.credit_note_type IS DISTINCT FROM OLD.credit_note_type
       OR NEW.invoice_kind IS DISTINCT FROM OLD.invoice_kind
       OR NEW.goebd_retention_until IS DISTINCT FROM OLD.goebd_retention_until
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.net_cents IS DISTINCT FROM OLD.net_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.gross_cents IS DISTINCT FROM OLD.gross_cents
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.skonto_percent_bps IS DISTINCT FROM OLD.skonto_percent_bps
       OR NEW.skonto_days IS DISTINCT FROM OLD.skonto_days
       OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date
       OR NEW.validity_date IS DISTINCT FROM OLD.validity_date
       OR NEW.planned_delivery_date IS DISTINCT FROM OLD.planned_delivery_date
       OR NEW.planned_service_date IS DISTINCT FROM OLD.planned_service_date
       OR NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot
       OR NEW.issued_snapshot IS DISTINCT FROM OLD.issued_snapshot
       OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'issued_document_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$m301_issued_immutable$;
