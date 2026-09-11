CREATE TABLE "offer_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"payment_option_id" uuid,
	"discount_template_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_template_name_ck" CHECK ("offer_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("offer_template"."name") <= 200 and "offer_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "offer_template_name_normalized_ck" CHECK ("offer_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("offer_template"."name_normalized"))),
	CONSTRAINT "offer_template_preset_ck" CHECK ("offer_template"."payment_option_id" is not null or "offer_template"."discount_template_id" is not null),
	CONSTRAINT "offer_template_position_ck" CHECK ("offer_template"."position" >= 0),
	CONSTRAINT "offer_template_timestamps_ck" CHECK ("offer_template"."updated_at" >= "offer_template"."created_at" and pg_catalog.isfinite("offer_template"."created_at") and pg_catalog.isfinite("offer_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "offer_template" ADD CONSTRAINT "offer_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_template" ADD CONSTRAINT "offer_template_payment_option_id_fk" FOREIGN KEY ("workspace_id","payment_option_id") REFERENCES "public"."payment_option"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_template" ADD CONSTRAINT "offer_template_discount_template_id_fk" FOREIGN KEY ("workspace_id","discount_template_id") REFERENCES "public"."discount_template"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_template_ws_idx" ON "offer_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_template_ws_id_uq" ON "offer_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_template_ws_active_name_uq" ON "offer_template" USING btree ("workspace_id","name_normalized") WHERE "offer_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-06: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: discount_template.read/discount_template.write im Service-Layer
-- (keine neue Permission; Angebotsschreibschutz prueft der Angebots-Pfad).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.offer_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.offer_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);