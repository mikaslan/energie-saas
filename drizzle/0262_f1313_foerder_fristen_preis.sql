CREATE TABLE "subsidy_case_fee_setting" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"fee_cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subsidy_case_fee_setting_fee_ck" CHECK ("subsidy_case_fee_setting"."fee_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD COLUMN "fee_cents" integer;--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD COLUMN "bza_due_date" date;--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD COLUMN "bnd_due_date" date;--> statement-breakpoint
ALTER TABLE "subsidy_case_fee_setting" ADD CONSTRAINT "subsidy_case_fee_setting_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- F13-13 §1 Backfill (generate kann kein Backfill): Bestandsakten erhalten
-- den Default-Snapshot 21000 (Altschutz — spätere Stammdaten-Änderungen
-- wirken nur auf neue Akten). Fälligkeiten bleiben NULL (kein Rückrechnen).
UPDATE "subsidy_case" SET "fee_cents" = 21000 WHERE "fee_cents" IS NULL;--> statement-breakpoint
ALTER TABLE "subsidy_case" ALTER COLUMN "fee_cents" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subsidy_case" ALTER COLUMN "fee_cents" SET DEFAULT 21000;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-13: RLS-Vertrag im F13-03-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0105 (Pin-Stabilität). Rechte:
-- installation.read/installation.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0105).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.subsidy_case_fee_setting ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.subsidy_case_fee_setting FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subsidy_case_fee_setting
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-13 Förder-Fristen-Preis (Katalog F13.2-Rest): Workspace-Stammdatum
-- „Förderservice-Preis" (Cent, Default 21000 nur im Service) + Snapshot
-- an der Akte + AT-Fälligkeiten je Phase (BzA +3 AT, BnD +5 AT ab
-- Versand, Feiertagsquelle Bund). KEINE Auto-F8-Rechnung, KEINE
-- Transitionssperren, KEIN Portal (reine Anzeige-Badges).
-- ═══════════════════════════════════════════════════════════════════════
