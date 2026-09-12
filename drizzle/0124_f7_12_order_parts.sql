CREATE TABLE "order_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"line_domain_id" text NOT NULL,
	"quantity_milli" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_part_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "order_part_status_ck" CHECK ("order_part"."status" in ('open', 'ordered', 'delivered', 'cancelled')),
	CONSTRAINT "order_part_quantity_ck" CHECK ("order_part"."quantity_milli" >= 1000 and "order_part"."quantity_milli" % 1000 = 0),
	CONSTRAINT "order_part_note_ck" CHECK ("order_part"."note" is null or (char_length("order_part"."note") between 1 and 500)),
	CONSTRAINT "order_part_timestamps_ck" CHECK ("order_part"."updated_at" >= "order_part"."created_at" and pg_catalog.isfinite("order_part"."created_at") and pg_catalog.isfinite("order_part"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "order_part_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_part_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_part_message_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "order_part_message_body_ck" CHECK (char_length("order_part_message"."body") between 1 and 2000),
	CONSTRAINT "order_part_message_created_ck" CHECK (pg_catalog.isfinite("order_part_message"."created_at"))
);
--> statement-breakpoint
DROP INDEX "installation_ws_id_uq";--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_ws_id_uq" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "order_part" ADD CONSTRAINT "order_part_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_part" ADD CONSTRAINT "order_part_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."installation"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_part_message" ADD CONSTRAINT "order_part_message_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_part_message" ADD CONSTRAINT "order_part_message_part_fk" FOREIGN KEY ("workspace_id","order_part_id") REFERENCES "public"."order_part"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_part_ws_installation_idx" ON "order_part" USING btree ("workspace_id","installation_id","status");--> statement-breakpoint
CREATE INDEX "order_part_message_ws_part_idx" ON "order_part_message" USING btree ("workspace_id","order_part_id","created_at","id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-12: RLS-Vertrag im F13-11/F13-01-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.order_part ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_part FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_part
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.order_part_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.order_part_message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.order_part_message
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);