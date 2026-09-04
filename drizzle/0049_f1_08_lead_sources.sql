CREATE TABLE "lead_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"project_domain" text,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_source_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "lead_source_name_ck" CHECK ("lead_source"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("lead_source"."name") <= 120),
	CONSTRAINT "lead_source_name_normalized_ck" CHECK ("lead_source"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("lead_source"."name_normalized"))),
	CONSTRAINT "lead_source_domain_ck" CHECK ("lead_source"."project_domain" is null or "lead_source"."project_domain" in ('residential', 'commercial')),
	CONSTRAINT "lead_source_color_ck" CHECK ("lead_source"."color" is null or "lead_source"."color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "lead_source_archive_ck" CHECK ("lead_source"."archived_at" is null or "lead_source"."archived_at" >= "lead_source"."created_at"),
	CONSTRAINT "lead_source_timestamps_ck" CHECK ("lead_source"."updated_at" >= "lead_source"."created_at" and pg_catalog.isfinite("lead_source"."created_at") and pg_catalog.isfinite("lead_source"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_source_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_source" ADD CONSTRAINT "lead_source_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_source_ws_idx" ON "lead_source" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_source_ws_active_name_uq" ON "lead_source" USING btree ("workspace_id","name_normalized") WHERE "lead_source"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_source_fk" FOREIGN KEY ("workspace_id","lead_source_id") REFERENCES "public"."lead_source"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_ws_lead_source_idx" ON "project" USING btree ("workspace_id","lead_source_id");
-- ═══════════════════════════════════════════════════════════════════════
-- F1.8: RLS-Vertrag im M1-CRM-Muster (contact/project, Migration 0020):
-- permissive tenant_isolation ueber app.workspace_id + FORCE. Die
-- Rollen-/Capability-Pruefung liegt im Service-Layer (lib/permissions.ts:
-- lead_source.read = Viewer, lead_source.write = Editor). Der Rechner-
-- Intake laeuft als HMAC-authentifizierter Service OHNE Membership-Actor
-- (verifiedRechnerIntakeAction → withTenant) und muss die aktive Quelle
-- aufloesen koennen — restriktive Actor-Policies (0047-Muster) waeren
-- hier ein Selbst-Blocker und sind fuer CRM-Stammdaten ohne Geldfluss
-- unverhaeltnismaessig (DECIDED, Spec F1.8 §3.4 revidiert).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.lead_source ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.lead_source FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.lead_source
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
