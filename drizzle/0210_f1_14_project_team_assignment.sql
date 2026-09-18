-- ═══════════════════════════════════════════════════════════════════════
-- F1-14 Projekt-Team-Zuweisung (Katalog M1: "genau 1 Key Account
-- Manager + n User + n Teams"): operative Team-Anbindung je Projekt
-- (informativ, KEINE Sichtvererbung — Folgeslice). Eigene
-- Revisions-Spalte team_assignment_revision mit CAS (M1-09-Muster,
-- entkoppelt von assignment_revision); Cap 50 je Projekt im Service.
-- Team-FK RESTRICT (kein stilles Loesen, Archiv nutzen).
-- Rechte: project.assign/project.read im Service-Layer (keine neue
-- Permission); External-View unberuehrt.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "project_team_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_team_assignment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_team_assignment_ws_project_team_uq" UNIQUE("workspace_id","project_id","team_id"),
	CONSTRAINT "project_team_assignment_time_ck" CHECK (pg_catalog.isfinite("project_team_assignment"."assigned_at"))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "team_assignment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_team_assignment" ADD CONSTRAINT "project_team_assignment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_team_assignment" ADD CONSTRAINT "project_team_assignment_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_team_assignment" ADD CONSTRAINT "project_team_assignment_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_team_assignment_ws_team_project_idx" ON "project_team_assignment" USING btree ("workspace_id","team_id","project_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_team_assignment_revision_ck" CHECK ("project"."team_assignment_revision" between 0 and 2147483647);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-14: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: project.assign/project.read im Service-Layer (keine neue
-- Permission, kein UPDATE-Grant).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_team_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_team_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_team_assignment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);