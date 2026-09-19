-- ═══════════════════════════════════════════════════════════════════════
-- F8-22: Steuerbehandlung je Belegzeile (0-%-Faelle + §13b).
-- Bestand wird abgeleitet (1900 bps → standard_19, 0 bps → zero_12_3;
-- §13b war nie ausstellbar, also keine Fehlklassifikation), danach
-- NOT NULL + CHECK-Kopplung an tax_rate_bps.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "commercial_document_line" ADD COLUMN "tax_treatment" text;--> statement-breakpoint
UPDATE "commercial_document_line" SET "tax_treatment" = CASE WHEN "tax_rate_bps" = 1900 THEN 'standard_19' ELSE 'zero_12_3' END WHERE "tax_treatment" IS NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_line" ALTER COLUMN "tax_treatment" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_line" ADD CONSTRAINT "commercial_document_line_tax_treatment_ck" CHECK (("commercial_document_line"."tax_rate_bps" = 1900 and "commercial_document_line"."tax_treatment" = 'standard_19') or ("commercial_document_line"."tax_rate_bps" = 0 and "commercial_document_line"."tax_treatment" in ('zero_12_3', 'reverse_13b')));
