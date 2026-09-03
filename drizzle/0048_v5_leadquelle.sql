ALTER TABLE "inbound_receipt" DROP CONSTRAINT "inbound_receipt_producer_ck";--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_producer_ck" CHECK ("inbound_receipt"."producer_application" in ('wmee-rechner-v3', 'wmee-rechner-v5')
        and "inbound_receipt"."producer_git_revision" ~ '^[0-9a-f]{40}$'
        and "inbound_receipt"."producer_environment" in ('production', 'preview', 'development')
        and "inbound_receipt"."calculator_engine" = 'wmee-solar.v1');