ALTER TABLE "accounting_sync_record" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_sync_record" ADD CONSTRAINT "accounting_sync_record_ws_id_uq" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_ws_id_uq" UNIQUE("workspace_id","id");