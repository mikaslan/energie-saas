CREATE TABLE "installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"offer_id" uuid,
	"variant_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_source_ck" CHECK ("installation"."source" in ('direct', 'signature')),
	CONSTRAINT "installation_status_ck" CHECK ("installation"."status" in ('active', 'completed')),
	CONSTRAINT "installation_completed_ck" CHECK (("installation"."status" = 'completed' and "installation"."completed_at" is not null) or ("installation"."status" = 'active' and "installation"."completed_at" is null)),
	CONSTRAINT "installation_variant_needs_offer_ck" CHECK ("installation"."variant_id" is null or "installation"."offer_id" is not null),
	CONSTRAINT "installation_timestamps_ck" CHECK ("installation"."updated_at" >= "installation"."created_at" and pg_catalog.isfinite("installation"."created_at") and pg_catalog.isfinite("installation"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "installation_ws_project_uq" ON "installation" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "installation_ws_status_idx" ON "installation" USING btree ("workspace_id","status");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7.1 Slice A: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0060 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.installation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.installation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.installation
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
