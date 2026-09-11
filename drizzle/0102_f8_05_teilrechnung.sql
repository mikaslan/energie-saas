CREATE TABLE "commercial_document_partial" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_order_id" uuid NOT NULL,
	"partial_invoice_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"percent_bps" integer,
	"ordinal" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_partial_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_partial_ws_invoice_uq" UNIQUE("workspace_id","partial_invoice_id"),
	CONSTRAINT "commercial_document_partial_mode_ck" CHECK ("commercial_document_partial"."mode" in ('percent', 'lines')),
	CONSTRAINT "commercial_document_partial_percent_ck" CHECK ((
        ("commercial_document_partial"."mode" = 'percent' and "commercial_document_partial"."percent_bps" between 1 and 10000)
        or ("commercial_document_partial"."mode" = 'lines' and "commercial_document_partial"."percent_bps" is null)
      )),
	CONSTRAINT "commercial_document_partial_ordinal_ck" CHECK ("commercial_document_partial"."ordinal" > 0),
	CONSTRAINT "commercial_document_partial_no_self_ck" CHECK ("commercial_document_partial"."source_order_id" <> "commercial_document_partial"."partial_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "commercial_document_partial_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"partial_id" uuid NOT NULL,
	"source_line_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_partial_line_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_source_order_fk" FOREIGN KEY ("workspace_id","source_order_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_invoice_fk" FOREIGN KEY ("workspace_id","partial_invoice_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial" ADD CONSTRAINT "commercial_document_partial_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial_line" ADD CONSTRAINT "commercial_document_partial_line_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial_line" ADD CONSTRAINT "commercial_document_partial_line_partial_fk" FOREIGN KEY ("workspace_id","partial_id") REFERENCES "public"."commercial_document_partial"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_partial_line" ADD CONSTRAINT "commercial_document_partial_line_source_line_fk" FOREIGN KEY ("workspace_id","source_line_id") REFERENCES "public"."commercial_document_line"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_document_partial_ws_order_idx" ON "commercial_document_partial" USING btree ("workspace_id","source_order_id","ordinal","id");--> statement-breakpoint
CREATE INDEX "commercial_document_partial_line_ws_partial_idx" ON "commercial_document_partial_line" USING btree ("workspace_id","partial_id","source_line_id");--> statement-breakpoint
CREATE INDEX "commercial_document_partial_line_ws_source_idx" ON "commercial_document_partial_line" USING btree ("workspace_id","source_line_id");--> statement-breakpoint
ALTER TABLE public.commercial_document_partial ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_partial FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_partial
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.commercial_document_partial_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_partial_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_partial_line
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F8-05 Teilrechnungen: Kettentabellen AB → Teilrechnung (Modi
-- percent/lines, Caps gegen AB-Brutto, Storno befreit Budget).
-- RLS-Vertrag tenant_isolation + FORCE (Muster 0094). Rechte:
-- invoicing.read/invoicing.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0094).
-- ═══════════════════════════════════════════════════════════════════════
