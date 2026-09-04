CREATE TABLE "discount_template" (
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
	CONSTRAINT "discount_template_name_ck" CHECK ("discount_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("discount_template"."name") <= 200 and "discount_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "discount_template_name_normalized_ck" CHECK ("discount_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("discount_template"."name_normalized"))),
	CONSTRAINT "discount_template_kind_ck" CHECK ("discount_template"."kind" in ('fix_cents', 'percent_bps')),
	CONSTRAINT "discount_template_fix_ck" CHECK (("discount_template"."kind" <> 'fix_cents') or ("discount_template"."amount_cents" is not null and "discount_template"."amount_cents" >= 0 and "discount_template"."percent_bps" is null)),
	CONSTRAINT "discount_template_percent_ck" CHECK (("discount_template"."kind" <> 'percent_bps') or ("discount_template"."percent_bps" is not null and "discount_template"."percent_bps" between 1 and 10000 and "discount_template"."amount_cents" is null)),
	CONSTRAINT "discount_template_cap_ck" CHECK ("discount_template"."cap_cents" is null or ("discount_template"."kind" = 'percent_bps' and "discount_template"."cap_cents" >= 0)),
	CONSTRAINT "discount_template_position_ck" CHECK ("discount_template"."position" >= 0),
	CONSTRAINT "discount_template_timestamps_ck" CHECK ("discount_template"."updated_at" >= "discount_template"."created_at" and pg_catalog.isfinite("discount_template"."created_at") and pg_catalog.isfinite("discount_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "discount_template" ADD CONSTRAINT "discount_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_template_ws_idx" ON "discount_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_template_ws_id_uq" ON "discount_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_template_ws_active_name_uq" ON "discount_template" USING btree ("workspace_id","name_normalized") WHERE "discount_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16.3 Slice A: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: discount_template.read/write (Service-Layer, wie F7.3).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.discount_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.discount_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.discount_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
