-- ═══════════════════════════════════════════════════════════════════════
-- F7-16 Projekt-Dateien (Katalog F7.1/F10.2-Vorstufe): interne Dateiablage
-- je Projekt (PDF/JPEG/PNG, 25 MiB, WORM unter immutable/<projekt>/
-- project-files/). Zeilen sind immutabel (kein updated_at, kein UPDATE-
-- Pfad — file_request_upload-Muster 0120); Liste newest-first. Kein
-- Portal, kein Visible-Flag, kein Loeschen (Folgeslices).
-- RLS-Vertrag tenant_isolation + FORCE (Muster 0104/0124). Rechte:
-- project.read/project.write plus intern-nur-Gate im Service-Layer
-- (keine neue Permission, keine Grants — Rollenvertrag wie 0104).
-- KEIN Owner-Tanz: nur DEFINER-Funktionen brauchen ihn (0104 Z.166ff),
-- 0181 hat keine Funktion (plain INSERT/SELECT via TenantTx).
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "project_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"original_filename" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_file_name_ck" CHECK (char_length(btrim("project_file"."original_filename")) between 1 and 180),
	CONSTRAINT "project_file_content_type_ck" CHECK ("project_file"."content_type" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "project_file_byte_size_ck" CHECK ("project_file"."byte_size" between 1 and 26214400),
	CONSTRAINT "project_file_sha256_ck" CHECK ("project_file"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_file_storage_key_ck" CHECK (char_length("project_file"."storage_key") <= 512 and "project_file"."storage_key" ~ '^immutable/[0-9a-f-]{36}/project-files/[0-9a-f-]{36}_[0-9a-f]{8}\.(pdf|jpg|jpeg|png)$')
);
--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_file_ws_id_uq" ON "project_file" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "project_file_ws_project_idx" ON "project_file" USING btree ("workspace_id","project_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE public.project_file ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_file FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_file
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);