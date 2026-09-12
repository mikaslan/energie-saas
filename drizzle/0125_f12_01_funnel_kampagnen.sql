CREATE TABLE "funnel_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"slug" text NOT NULL,
	"slug_normalized" text NOT NULL,
	"lead_source_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnel_campaign_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "funnel_campaign_name_ck" CHECK ("funnel_campaign"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("funnel_campaign"."name") <= 120),
	CONSTRAINT "funnel_campaign_name_normalized_ck" CHECK ("funnel_campaign"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("funnel_campaign"."name_normalized"))),
	CONSTRAINT "funnel_campaign_slug_ck" CHECK ("funnel_campaign"."slug" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "funnel_campaign_slug_normalized_ck" CHECK ("funnel_campaign"."slug_normalized" = pg_catalog.lower(pg_catalog.btrim("funnel_campaign"."slug_normalized"))),
	CONSTRAINT "funnel_campaign_archive_ck" CHECK ("funnel_campaign"."archived_at" is null or "funnel_campaign"."archived_at" >= "funnel_campaign"."created_at"),
	CONSTRAINT "funnel_campaign_timestamps_ck" CHECK ("funnel_campaign"."updated_at" >= "funnel_campaign"."created_at" and pg_catalog.isfinite("funnel_campaign"."created_at") and pg_catalog.isfinite("funnel_campaign"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "funnel_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "funnel_campaign" ADD CONSTRAINT "funnel_campaign_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_campaign" ADD CONSTRAINT "funnel_campaign_lead_source_fk" FOREIGN KEY ("workspace_id","lead_source_id") REFERENCES "public"."lead_source"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funnel_campaign_ws_idx" ON "funnel_campaign" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_campaign_ws_active_name_uq" ON "funnel_campaign" USING btree ("workspace_id","name_normalized") WHERE "funnel_campaign"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_campaign_ws_active_slug_uq" ON "funnel_campaign" USING btree ("workspace_id","slug_normalized") WHERE "funnel_campaign"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_funnel_campaign_fk" FOREIGN KEY ("workspace_id","funnel_campaign_id") REFERENCES "public"."funnel_campaign"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_ws_funnel_campaign_idx" ON "project" USING btree ("workspace_id","funnel_campaign_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F12-01: RLS-Vertrag im F13-11/F7-12-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.funnel_campaign ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.funnel_campaign FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.funnel_campaign
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);