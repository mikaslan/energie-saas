CREATE TABLE "planning_request_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"planning_request_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	CONSTRAINT "planning_request_revision_note_ck" CHECK ("planning_request_revision"."note" = pg_catalog.btrim("planning_request_revision"."note") and pg_catalog.length("planning_request_revision"."note") between 1 and 2000 and "planning_request_revision"."note" !~ '[[:cntrl:]]'),
	CONSTRAINT "planning_request_revision_signed_ck" CHECK ("planning_request_revision"."signed_at" is null or ("planning_request_revision"."signed_at" >= "planning_request_revision"."created_at" and pg_catalog.isfinite("planning_request_revision"."signed_at")))
);
--> statement-breakpoint
ALTER TABLE "planning_request" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "planning_request_revision" ADD CONSTRAINT "planning_request_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_request_revision" ADD CONSTRAINT "planning_request_revision_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_request_revision" ADD CONSTRAINT "planning_request_revision_request_fk" FOREIGN KEY ("workspace_id","planning_request_id") REFERENCES "public"."planning_request"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_request_revision_ws_id_uq" ON "planning_request_revision" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_request_revision_ws_request_idx" ON "planning_request_revision" USING btree ("workspace_id","planning_request_id","created_at","id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-14: RLS-Vertrag im F13-11-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0123 (Pin-Stabilität). Rechte:
-- installation.read/installation.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0123).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_request_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_request_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_request_revision
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);