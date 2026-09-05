CREATE TABLE "payment_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_option_key_ck" CHECK ("payment_option"."key" in ('purchase', 'financing_classic', 'leasing')),
	CONSTRAINT "payment_option_label_ck" CHECK ("payment_option"."label" ~ '^[^[:space:]].*$' and pg_catalog.length("payment_option"."label") <= 120 and "payment_option"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "payment_option_kind_ck" CHECK ("payment_option"."kind" in ('purchase', 'financing', 'leasing')),
	CONSTRAINT "payment_option_key_kind_ck" CHECK (("payment_option"."key" = 'purchase' and "payment_option"."kind" = 'purchase') or ("payment_option"."key" = 'financing_classic' and "payment_option"."kind" = 'financing') or ("payment_option"."key" = 'leasing' and "payment_option"."kind" = 'leasing')),
	CONSTRAINT "payment_option_timestamps_ck" CHECK ("payment_option"."updated_at" >= "payment_option"."created_at" and pg_catalog.isfinite("payment_option"."created_at") and pg_catalog.isfinite("payment_option"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "payment_option" ADD CONSTRAINT "payment_option_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_option_ws_idx" ON "payment_option" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_option_ws_id_uq" ON "payment_option" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_option_ws_active_key_uq" ON "payment_option" USING btree ("workspace_id","key") WHERE "payment_option"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD COLUMN "payment_option_id" uuid;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_payment_option_fk" FOREIGN KEY ("workspace_id","payment_option_id") REFERENCES "public"."payment_option"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_variant_ws_payment_option_idx" ON "offer_variant" USING btree ("workspace_id","payment_option_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F2.5 Slice A: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Reine Anzeige-Stammdaten ohne Geldfluss: keine Actor-Policies.
-- Policy-Formulierung bytegleich zu 0060 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.payment_option ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payment_option FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.payment_option
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
