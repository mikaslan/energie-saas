-- ═══════════════════════════════════════════════════════════════════════
-- F1-26 Team-Mentions (`@team:slug` in Notizen): eigene Tabelle +
-- dynamische Auflösung (kein Fan-Out, kein Cap-Bomb; Muster F1-20/F7-11:
-- note-FK CASCADE, team-FK RESTRICT).
-- Rechte: note.write (Erwähnen), note.read (Lesen/Chips); keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "project_note_team_mention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_note_team_mention_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_note_team_mention_ws_note_team_uq" UNIQUE("workspace_id","note_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "project_note_team_mention" ADD CONSTRAINT "project_note_team_mention_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_team_mention" ADD CONSTRAINT "project_note_team_mention_note_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."project_note"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_team_mention" ADD CONSTRAINT "project_note_team_mention_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_note_team_mention_ws_team_note_idx" ON "project_note_team_mention" USING btree ("workspace_id","team_id","note_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-26: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- ACLs vergibt der Rollenvertrag (keine Grants in der Migration).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_note_team_mention ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_note_team_mention FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_note_team_mention
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
