CREATE TABLE "project_checklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"blocks" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_checklist_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_checklist_ws_project_uq" UNIQUE("workspace_id","project_id"),
	CONSTRAINT "project_checklist_blocks_ck" CHECK (pg_catalog.jsonb_typeof("project_checklist"."blocks") = 'array'),
	CONSTRAINT "project_checklist_version_ck" CHECK ("project_checklist"."version" between 1 and 2147483647),
	CONSTRAINT "project_checklist_timestamps_ck" CHECK ("project_checklist"."updated_at" >= "project_checklist"."created_at" and pg_catalog.isfinite("project_checklist"."created_at") and pg_catalog.isfinite("project_checklist"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "project_checklist" ADD CONSTRAINT "project_checklist_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checklist" ADD CONSTRAINT "project_checklist_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_checklist_ws_project_idx" ON "project_checklist" USING btree ("workspace_id","project_id");
-- ═══════════════════════════════════════════════════════════════════════
-- F7.2: RLS-Vertrag im M1-CRM-Muster (contact/project/time_entry):
-- permissive tenant_isolation ueber app.workspace_id + FORCE. Rollen-
-- Pruefung im Service-Layer (checklist.read = Viewer, checklist.write =
-- Editor). Operative Projektarbeit ohne Geldfluss (DECIDED, konsistent
-- mit F1.8/F9.1).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_checklist ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_checklist FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.project_checklist
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
