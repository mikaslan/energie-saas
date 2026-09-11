ALTER TABLE "kanban_column" ADD COLUMN "conversion_ratio_bps" integer;--> statement-breakpoint
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_conversion_ratio_ck" CHECK ("conversion_ratio_bps" is null or ("conversion_ratio_bps" between 0 and 10000));--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-05b Conversion-Ratio: optionale Gewichtung je Spalte (NULL = keine
-- Ratio, Spalte zählt nicht zur gewichteten Pipeline). Kein neuer Grant
-- nötig (gleiche Tabelle wie 0099), keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
