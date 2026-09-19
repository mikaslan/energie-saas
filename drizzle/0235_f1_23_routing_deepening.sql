DROP INDEX "project_lead_routing_rule_ws_source_uq";--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ALTER COLUMN "lead_source_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "funnel_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "mode" text DEFAULT 'suggest' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "auto_on_manual" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "auto_on_intake" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_funnel_campaign_fk" FOREIGN KEY ("workspace_id","funnel_campaign_id") REFERENCES "public"."funnel_campaign"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_lead_routing_rule_ws_source_assignee_uq" ON "project_lead_routing_rule" USING btree ("workspace_id","lead_source_id","assignee_membership_id") WHERE "project_lead_routing_rule"."lead_source_id" is not null and "project_lead_routing_rule"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_lead_routing_rule_ws_campaign_assignee_uq" ON "project_lead_routing_rule" USING btree ("workspace_id","funnel_campaign_id","assignee_membership_id") WHERE "project_lead_routing_rule"."funnel_campaign_id" is not null and "project_lead_routing_rule"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_lead_routing_rule_ws_source_idx" ON "project_lead_routing_rule" USING btree ("workspace_id","lead_source_id");--> statement-breakpoint
CREATE INDEX "project_lead_routing_rule_ws_campaign_idx" ON "project_lead_routing_rule" USING btree ("workspace_id","funnel_campaign_id");--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_dimension_ck" CHECK (("project_lead_routing_rule"."lead_source_id" is null) != ("project_lead_routing_rule"."funnel_campaign_id" is null));--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_mode_ck" CHECK ("project_lead_routing_rule"."mode" in ('suggest', 'auto'));--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_priority_ck" CHECK ("project_lead_routing_rule"."priority" between 0 and 9999);--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_campaign_mode_ck" CHECK ("project_lead_routing_rule"."funnel_campaign_id" is null or "project_lead_routing_rule"."mode" = 'suggest');--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_archive_ck" CHECK ("project_lead_routing_rule"."archived_at" is null or "project_lead_routing_rule"."archived_at" >= "project_lead_routing_rule"."created_at");--> statement-breakpoint
