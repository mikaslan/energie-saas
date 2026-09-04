CREATE TABLE "checklist_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_template_name_ck" CHECK ("checklist_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("checklist_template"."name") <= 200 and "checklist_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "checklist_template_name_normalized_ck" CHECK ("checklist_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("checklist_template"."name_normalized"))),
	CONSTRAINT "checklist_template_description_ck" CHECK ("checklist_template"."description" is null or (
      pg_catalog.length("checklist_template"."description") between 1 and 2000
      and "checklist_template"."description" = pg_catalog.btrim("checklist_template"."description")
      and "checklist_template"."description" !~ '[[:cntrl:]]'
    )),
	CONSTRAINT "checklist_template_position_ck" CHECK ("checklist_template"."position" >= 0),
	CONSTRAINT "checklist_template_targets_ck" CHECK (pg_catalog.jsonb_typeof("checklist_template"."targets") = 'array'),
	CONSTRAINT "checklist_template_items_ck" CHECK (pg_catalog.jsonb_typeof("checklist_template"."items") = 'array'),
	CONSTRAINT "checklist_template_timestamps_ck" CHECK ("checklist_template"."updated_at" >= "checklist_template"."created_at" and pg_catalog.isfinite("checklist_template"."created_at") and pg_catalog.isfinite("checklist_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "checklist_template" ADD CONSTRAINT "checklist_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_template_ws_idx" ON "checklist_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_template_ws_id_uq" ON "checklist_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_template_ws_active_name_uq" ON "checklist_template" USING btree ("workspace_id","name_normalized") WHERE "checklist_template"."active";
-- ═══════════════════════════════════════════════════════════════════════
-- F7.3: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: checklist.read/write (Service-Layer, wie F7.2).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.checklist_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.checklist_template FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.checklist_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
