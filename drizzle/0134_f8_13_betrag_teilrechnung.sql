ALTER TABLE "commercial_document_partial" DROP CONSTRAINT "commercial_document_partial_mode_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_mode_ck" CHECK ("commercial_document_partial"."mode" in ('percent', 'lines', 'scheme', 'closing', 'remainder', 'amount'));--> statement-breakpoint
ALTER TABLE "commercial_document_partial" DROP CONSTRAINT "commercial_document_partial_percent_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_percent_ck" CHECK ((
        ("commercial_document_partial"."mode" = 'percent' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'lines' and "commercial_document_partial"."percent_bps" is null)
        or ("commercial_document_partial"."mode" = 'scheme' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'closing' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'remainder' and "commercial_document_partial"."percent_bps" between 1 and 9999)
        or ("commercial_document_partial"."mode" = 'amount' and "commercial_document_partial"."percent_bps" between 1 and 10000)
      ));--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F8-13 Betrag-Teilrechnung (fester Netto-Betrag): mode-CHECK um
-- 'amount' (gespeicherte percent_bps = nomineller Auftrags-Anteil,
-- Anzeige läuft über Linien-Summen). Keine neue Tabelle, keine
-- Grants, RLS unverändert.
-- ═══════════════════════════════════════════════════════════════════════
