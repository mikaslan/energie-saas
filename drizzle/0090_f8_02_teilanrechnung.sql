ALTER TABLE "commercial_document_link" ADD COLUMN "applied_cents" bigint;--> statement-breakpoint
-- F8-02: Bestand rueckt auf volles Anzahlungs-Brutto (F8-01-Verhalten bleibt).
UPDATE "commercial_document_link" link_row
   SET "applied_cents" = deposit."gross_cents"
  FROM "commercial_document" deposit
 WHERE deposit."workspace_id" = link_row."workspace_id"
   AND deposit."id" = link_row."deposit_id";--> statement-breakpoint
ALTER TABLE "commercial_document_link" ALTER COLUMN "applied_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_link" ADD CONSTRAINT "commercial_document_link_applied_ck" CHECK ("commercial_document_link"."applied_cents" between 0 and 9000000000000000);
