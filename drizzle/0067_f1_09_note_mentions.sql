CREATE TABLE "project_note_mention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"mentioned_identity_id" uuid NOT NULL,
	"email_lower" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_note_mention_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_note_mention_ws_note_identity_uq" UNIQUE("workspace_id","note_id","mentioned_identity_id"),
	CONSTRAINT "project_note_mention_email_ck" CHECK (length("project_note_mention"."email_lower") between 3 and 254),
	CONSTRAINT "project_note_mention_revision_ck" CHECK ("project_note_mention"."revision" between 1 and 2147483647)
);
--> statement-breakpoint
ALTER TABLE "project_note_mention" ADD CONSTRAINT "project_note_mention_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_mention" ADD CONSTRAINT "project_note_mention_note_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."project_note"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note_mention" ADD CONSTRAINT "project_note_mention_identity_fk" FOREIGN KEY ("mentioned_identity_id") REFERENCES "public"."user_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_note_mention_ws_note_idx" ON "project_note_mention" USING btree ("workspace_id","note_id");--> statement-breakpoint
-- F1-09: RLS-Vertrag im 0050/0057-Muster (permissive tenant_isolation
-- ueber app.workspace_id + FORCE). Rollen-Pruefung im Service-Layer
-- (note.read/note.write wie project_note).
ALTER TABLE public.project_note_mention ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_note_mention FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_note_mention
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
