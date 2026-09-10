CREATE TABLE "billing_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"total_minutes" integer DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_run_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "billing_run_label_ck" CHECK (pg_catalog.length(pg_catalog.btrim("billing_run"."label")) between 1 and 120 and "billing_run"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "billing_run_period_ck" CHECK ("billing_run"."period_start" <= "billing_run"."period_end" and ("billing_run"."period_end" - "billing_run"."period_start") <= 366),
	CONSTRAINT "billing_run_status_ck" CHECK ("billing_run"."status" in ('open', 'closed')),
	CONSTRAINT "billing_run_totals_ck" CHECK ("billing_run"."total_minutes" >= 0 and "billing_run"."entry_count" >= 0),
	CONSTRAINT "billing_run_closed_ck" CHECK (("billing_run"."status" = 'open' and "billing_run"."closed_at" is null and "billing_run"."closed_by" is null) or ("billing_run"."status" = 'closed' and "billing_run"."closed_at" is not null and "billing_run"."closed_by" is not null)),
	CONSTRAINT "billing_run_timestamps_ck" CHECK ("billing_run"."updated_at" >= "billing_run"."created_at" and pg_catalog.isfinite("billing_run"."created_at") and pg_catalog.isfinite("billing_run"."updated_at") and ("billing_run"."closed_at" is null or pg_catalog.isfinite("billing_run"."closed_at")))
);
--> statement-breakpoint
CREATE TABLE "billing_run_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_run_entry_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "billing_run_entry_ws_entry_uq" UNIQUE("workspace_id","time_entry_id")
);
--> statement-breakpoint
ALTER TABLE "billing_run" ADD CONSTRAINT "billing_run_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_entry" ADD CONSTRAINT "billing_run_entry_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_entry" ADD CONSTRAINT "billing_run_entry_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."billing_run"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_run_entry" ADD CONSTRAINT "billing_run_entry_entry_fk" FOREIGN KEY ("workspace_id","time_entry_id") REFERENCES "public"."time_entry"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_run_ws_status_idx" ON "billing_run" USING btree ("workspace_id","status","period_start");--> statement-breakpoint
CREATE INDEX "billing_run_entry_ws_run_idx" ON "billing_run_entry" USING btree ("workspace_id","run_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F9-07: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: time.read/time.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.billing_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.billing_run FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.billing_run
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.billing_run_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.billing_run_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.billing_run_entry
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
