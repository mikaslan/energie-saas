CREATE TABLE "email_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_key_ck" CHECK ("email_template"."key" in ('new_lead','need_information','new_proposal','edited_proposal','file_request','signature_completed','portal_link','cannot_fulfil')),
	CONSTRAINT "email_template_subject_ck" CHECK (pg_catalog.length(pg_catalog.btrim("email_template"."subject")) between 1 and 200 and "email_template"."subject" !~ '[[:cntrl:]]'),
	CONSTRAINT "email_template_body_ck" CHECK (pg_catalog.length(pg_catalog.btrim("email_template"."body")) between 1 and 10000),
	CONSTRAINT "email_template_timestamps_ck" CHECK ("email_template"."updated_at" >= "email_template"."created_at" and pg_catalog.isfinite("email_template"."created_at") and pg_catalog.isfinite("email_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_template_ws_idx" ON "email_template" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_ws_id_uq" ON "email_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_ws_key_uq" ON "email_template" USING btree ("workspace_id","key");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-10: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: project.read/project.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.email_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.email_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.email_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
