ALTER TABLE "commercial_document_partial" DROP CONSTRAINT "commercial_document_partial_mode_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_mode_ck" CHECK ("commercial_document_partial"."mode" in ('percent', 'lines', 'scheme', 'closing', 'remainder'));--> statement-breakpoint
ALTER TABLE "commercial_document_partial" DROP CONSTRAINT "commercial_document_partial_percent_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_percent_ck" CHECK ((
        ("commercial_document_partial"."mode" = 'percent' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'lines' and "commercial_document_partial"."percent_bps" is null)
        or ("commercial_document_partial"."mode" = 'scheme' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'closing' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'remainder' and "commercial_document_partial"."percent_bps" between 1 and 9999)
      ));--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F8-12 Teil-Rest (Prozent vom Ketten-Rest): mode-CHECK um 'remainder'
-- (beantragter Rest-Anteil 1..9999 bps; 100 % bleibt F8-08-closing).
-- Keine neue Tabelle, keine Grants, RLS unverändert.
-- ═══════════════════════════════════════════════════════════════════════
