-- ═══════════════════════════════════════════════════════════════════════
-- F7-05b Block-Team-Zuweisung (Katalog F7.5, Block-Ebene): mehrere Teams
-- je Checklisten-Block (parallele Zuweisung). Seitentabelle zu
-- project_checklist ( Ghost-Zeilen gelöschter Blöcke bleiben unsichtbar,
-- Completion-Präzedenz); Team-FK composite wie project_appointment.
-- Teams sind archiv-only (F1-12) — nur AKTIVE Teams sind zuweisbar
-- (Service-Guard wie Kalender-validateTeam); archivierte bleiben lesbar.
-- Rechte: checklist.write (Assign/Unassign), checklist.read (Projektion);
-- calendar.read (Team-Optionen) — keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "project_checklist_block_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_checklist_block_assignment_time_ck" CHECK (pg_catalog.isfinite("project_checklist_block_assignment"."assigned_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_checklist_block_assignment_ws_id_uq" ON "project_checklist_block_assignment" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_checklist_block_assignment_ws_checklist_block_team_uq" ON "project_checklist_block_assignment" USING btree ("workspace_id","checklist_id","block_id","team_id");--> statement-breakpoint
CREATE INDEX "project_checklist_block_assignment_ws_checklist_block_idx" ON "project_checklist_block_assignment" USING btree ("workspace_id","checklist_id","block_id");--> statement-breakpoint
ALTER TABLE "project_checklist_block_assignment" ADD CONSTRAINT "project_checklist_block_assignment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checklist_block_assignment" ADD CONSTRAINT "project_checklist_block_assignment_checklist_fk" FOREIGN KEY ("workspace_id","checklist_id") REFERENCES "public"."project_checklist"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checklist_block_assignment" ADD CONSTRAINT "project_checklist_block_assignment_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-05b: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- ACLs (SELECT/INSERT/DELETE für app_runtime) vergibt der Rollenvertrag
-- (0114-Präzedenz: keine Grants in der Migration).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_checklist_block_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_checklist_block_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_checklist_block_assignment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
