CREATE TABLE "subsidy_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer,
	"percent_bps" integer,
	"cap_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subsidy_template_name_ck" CHECK ("subsidy_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("subsidy_template"."name") <= 200 and "subsidy_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "subsidy_template_name_normalized_ck" CHECK ("subsidy_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("subsidy_template"."name_normalized"))),
	CONSTRAINT "subsidy_template_kind_ck" CHECK ("subsidy_template"."kind" in ('fix_cents', 'percent_bps')),
	CONSTRAINT "subsidy_template_fix_ck" CHECK (("subsidy_template"."kind" <> 'fix_cents') or ("subsidy_template"."amount_cents" is not null and "subsidy_template"."amount_cents" >= 0 and "subsidy_template"."percent_bps" is null)),
	CONSTRAINT "subsidy_template_percent_ck" CHECK (("subsidy_template"."kind" <> 'percent_bps') or ("subsidy_template"."percent_bps" is not null and "subsidy_template"."percent_bps" between 1 and 10000 and "subsidy_template"."amount_cents" is null)),
	CONSTRAINT "subsidy_template_cap_ck" CHECK ("subsidy_template"."cap_cents" is null or ("subsidy_template"."kind" = 'percent_bps' and "subsidy_template"."cap_cents" >= 0)),
	CONSTRAINT "subsidy_template_position_ck" CHECK ("subsidy_template"."position" >= 0),
	CONSTRAINT "subsidy_template_timestamps_ck" CHECK ("subsidy_template"."updated_at" >= "subsidy_template"."created_at" and pg_catalog.isfinite("subsidy_template"."created_at") and pg_catalog.isfinite("subsidy_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "subsidy_template" ADD CONSTRAINT "subsidy_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subsidy_template_ws_idx" ON "subsidy_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "subsidy_template_ws_id_uq" ON "subsidy_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subsidy_template_ws_active_name_uq" ON "subsidy_template" USING btree ("workspace_id","name_normalized") WHERE "subsidy_template"."active";
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16.3 Slice B: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: subsidy_template.read/write (Service-Layer, wie F16.3-A).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.subsidy_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.subsidy_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.subsidy_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
