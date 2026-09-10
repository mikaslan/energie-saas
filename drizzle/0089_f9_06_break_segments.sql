CREATE TABLE "time_break_segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_break_segment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "time_break_segment_order_ck" CHECK ("time_break_segment"."ended_at" is null or "time_break_segment"."ended_at" >= "time_break_segment"."started_at")
);
--> statement-breakpoint
ALTER TABLE "time_break_segment" ADD CONSTRAINT "time_break_segment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_break_segment" ADD CONSTRAINT "time_break_segment_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."time_entry"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_break_segment_ws_entry_idx" ON "time_break_segment" USING btree ("workspace_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_break_segment_ws_entry_open_uq" ON "time_break_segment" USING btree ("workspace_id","entry_id") WHERE "time_break_segment"."ended_at" is null;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F9-06: RLS-Vertrag im Zeit-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0050 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.time_break_segment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.time_break_segment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.time_break_segment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);