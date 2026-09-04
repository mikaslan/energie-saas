CREATE TABLE "time_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"type_id" uuid,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"working_time_minutes" integer NOT NULL,
	"break_duration_minutes" integer DEFAULT 0 NOT NULL,
	"comment" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entry_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "time_entry_interval_ck" CHECK ("time_entry"."end_at" >= "time_entry"."start_at" and pg_catalog.isfinite("time_entry"."start_at") and pg_catalog.isfinite("time_entry"."end_at")),
	CONSTRAINT "time_entry_minutes_ck" CHECK ("time_entry"."working_time_minutes" between 0 and 1440),
	CONSTRAINT "time_entry_break_ck" CHECK ("time_entry"."break_duration_minutes" between 0 and 1440 and "time_entry"."break_duration_minutes" <= "time_entry"."working_time_minutes"),
	CONSTRAINT "time_entry_comment_ck" CHECK ("time_entry"."comment" is null or (
      pg_catalog.length("time_entry"."comment") between 1 and 500
      and "time_entry"."comment" = pg_catalog.btrim("time_entry"."comment")
      and "time_entry"."comment" !~ '[[:cntrl:]]'
    )),
	CONSTRAINT "time_entry_timestamps_ck" CHECK ("time_entry"."updated_at" >= "time_entry"."created_at" and pg_catalog.isfinite("time_entry"."created_at") and pg_catalog.isfinite("time_entry"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "time_event_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"text_color" text,
	"background_color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_event_type_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "time_event_type_name_ck" CHECK ("time_event_type"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("time_event_type"."name") <= 120),
	CONSTRAINT "time_event_type_name_normalized_ck" CHECK ("time_event_type"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("time_event_type"."name_normalized"))),
	CONSTRAINT "time_event_type_position_ck" CHECK ("time_event_type"."position" >= 0),
	CONSTRAINT "time_event_type_colors_ck" CHECK (("time_event_type"."text_color" is null or "time_event_type"."text_color" ~ '^#[0-9A-Fa-f]{6}$') and ("time_event_type"."background_color" is null or "time_event_type"."background_color" ~ '^#[0-9A-Fa-f]{6}$')),
	CONSTRAINT "time_event_type_timestamps_ck" CHECK ("time_event_type"."updated_at" >= "time_event_type"."created_at" and pg_catalog.isfinite("time_event_type"."created_at") and pg_catalog.isfinite("time_event_type"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_type_fk" FOREIGN KEY ("workspace_id","type_id") REFERENCES "public"."time_event_type"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_event_type" ADD CONSTRAINT "time_event_type_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entry_ws_project_idx" ON "time_entry" USING btree ("workspace_id","project_id","start_at");--> statement-breakpoint
CREATE INDEX "time_event_type_ws_idx" ON "time_event_type" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "time_event_type_ws_active_name_uq" ON "time_event_type" USING btree ("workspace_id","name_normalized") WHERE "time_event_type"."archived_at" is null;
-- ═══════════════════════════════════════════════════════════════════════
-- F9.1: RLS-Vertrag im M1-CRM-Muster (contact/project/project_task):
-- permissive tenant_isolation ueber app.workspace_id + FORCE. Rollen-
-- Pruefung im Service-Layer (time.read = Viewer, time.write = Editor).
-- Zeiterfassung ist operative CRM-Arbeit ohne Geldfluss — restriktive
-- Actor-Policies (0047-Muster) sind hier nicht angezeigt (DECIDED,
-- konsistent mit F1.8 Lead-Sources).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.time_event_type ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.time_event_type FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.time_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.time_entry FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.time_event_type
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.time_entry
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
