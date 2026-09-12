-- F16-09 Förder-Preset-Kopplung: offer_template trägt optional eine
-- Förder-Vorlage (dritter Preset-Zweig neben Zahlart/Rabatt).
ALTER TABLE "offer_template" DROP CONSTRAINT "offer_template_preset_ck";--> statement-breakpoint
ALTER TABLE "offer_template" ADD COLUMN "subsidy_template_id" uuid;--> statement-breakpoint
ALTER TABLE "offer_template" ADD CONSTRAINT "offer_template_subsidy_template_id_fk" FOREIGN KEY ("workspace_id","subsidy_template_id") REFERENCES "public"."subsidy_template"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_template" ADD CONSTRAINT "offer_template_preset_ck" CHECK ("offer_template"."payment_option_id" is not null or "offer_template"."discount_template_id" is not null or "offer_template"."subsidy_template_id" is not null);