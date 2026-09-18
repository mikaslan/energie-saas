-- ═══════════════════════════════════════════════════════════════════════
-- F2.1 Angebotsnummernformat je Workspace (Katalog F2.1, Matrix M201-02
-- „Nummernformat-UI später“): Prefix/Padding pro Workspace (Default
-- ANG/6) gelten für neu angelegte Serien-Jahre; bestehende Serien und
-- Nummern bleiben unverändert. Alle CHECK-Weitungen sind echte
-- Obermengen (Legacy ANG/6 bleibt gültig, versiegelte Historie intakt).
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "workspace_offer_number_format" (
	"id" uuid DEFAULT gen_random_uuid(),
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"prefix" text DEFAULT 'ANG' NOT NULL,
	"padding" integer DEFAULT 6 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_offer_number_format_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_offer_number_format_prefix_ck" CHECK ("workspace_offer_number_format"."prefix" ~ '^[A-Z0-9-]{2,8}$'),
	CONSTRAINT "workspace_offer_number_format_padding_ck" CHECK ("workspace_offer_number_format"."padding" between 4 and 8),
	CONSTRAINT "workspace_offer_number_format_revision_ck" CHECK ("workspace_offer_number_format"."revision" between 1 and 2147483647),
	CONSTRAINT "workspace_offer_number_format_timestamps_ck" CHECK ("workspace_offer_number_format"."updated_at" >= "workspace_offer_number_format"."created_at"
        and isfinite("workspace_offer_number_format"."created_at")
        and isfinite("workspace_offer_number_format"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "workspace_offer_number_format" ADD CONSTRAINT "workspace_offer_number_format_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- F2.1: RLS-Vertrag im Stammdaten-Muster (tenant_isolation + FORCE, wie
-- payment_option 0068 — keine Actor-Policies, kein Geldfluss).
-- Policy-Formulierung bytegleich zu 0068 (Pin-Stabilität).
ALTER TABLE public.workspace_offer_number_format ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_offer_number_format FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.workspace_offer_number_format
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Serien-Format: Prefix/Padding konfigurierbar (Obermenge von ANG/6).
ALTER TABLE "offer_number_series" DROP CONSTRAINT "offer_number_series_format_ck";--> statement-breakpoint
ALTER TABLE "offer_number_series" ADD CONSTRAINT "offer_number_series_format_ck" CHECK ("offer_number_series"."prefix" ~ '^[A-Z0-9-]{2,8}$' and "offer_number_series"."padding" between 4 and 8);--> statement-breakpoint
-- Angebotsnummer: konfigurierte Prefixe/Padding (Obermenge, Legacy ok).
ALTER TABLE "offer" DROP CONSTRAINT "offer_number_ck";--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_number_ck" CHECK ("offer"."offer_number" ~ '^[A-Z0-9-]{2,8}-[0-9]{4}-[0-9]{4,8}$');--> statement-breakpoint
ALTER TABLE "offer" DROP CONSTRAINT "offer_number_parts_ck";--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_number_parts_ck" CHECK ("offer"."number_year" between 2000 and 9999
      and "offer"."number_sequence" between 1 and 99999999);--> statement-breakpoint
-- Freigabekandidat: Nummern-Regex gewitet (Rest bytegleich zu 0034).
ALTER TABLE "offer_release_candidate" DROP CONSTRAINT "offer_release_candidate_binding_ck";--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_binding_ck" CHECK (
      "offer_release_candidate"."variant_revision" > 0
      and "offer_release_candidate"."profile_revision" > 0
      and "offer_release_candidate"."recipient_revision" > 0
      and "offer_release_candidate"."offer_number" ~ '^[A-Z0-9-]{2,8}-[0-9]{4}-[0-9]{4,8}$'
      and "offer_release_candidate"."source_pdf_draft_state" = 'succeeded'
      and "offer_release_candidate"."source_pdf_draft_mime_type" = 'application/pdf'
      and "offer_release_candidate"."source_pdf_draft_size_bytes" between 100 and 8388608
      and octet_length("offer_release_candidate"."variant_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."source_pdf_draft_input_sha256") = 32
      and octet_length("offer_release_candidate"."source_pdf_draft_artifact_sha256") = 32
      and octet_length("offer_release_candidate"."profile_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."recipient_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."reservation_key") = 32
      and octet_length("offer_release_candidate"."input_sha256") = 32);--> statement-breakpoint
-- Ausstellung: Nummern-Regex gewitet (Rest bytegleich zu 0035).
ALTER TABLE "offer_issuance" DROP CONSTRAINT "offer_issuance_source_ck";--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_source_ck" CHECK (
      "offer_issuance"."offer_number" ~ '^[A-Z0-9-]{2,8}-[0-9]{4}-[0-9]{4,8}$'
      and "offer_issuance"."variant_revision" > 0
      and "offer_issuance"."profile_revision" > 0
      and "offer_issuance"."recipient_revision" > 0
      and "offer_issuance"."candidate_input_version" = 'offer-release-candidate-input.v1'
      and "offer_issuance"."candidate_canonicalization_version" = 'offer-jcs.v1'
      and "offer_issuance"."candidate_template_version" = 'offer-release-candidate-template.v1'
      and "offer_issuance"."candidate_renderer_recipe_version" ~
        '^offer-release-candidate-renderer-recipe\.v1-linux-amd64-pw1\.62\.1-[0-9a-f]{64}$'
      and octet_length("offer_issuance"."candidate_input_sha256") = 32
      and "offer_issuance"."candidate_approval_version" =
        'offer-release-candidate-approval.v1'
      and "offer_issuance"."candidate_approval_command_version" =
        'offer-release-approval-command.v1'
      and "offer_issuance"."candidate_artifact_mime_type" = 'application/pdf'
      and octet_length("offer_issuance"."candidate_artifact_sha256") = 32
      and "offer_issuance"."candidate_artifact_size_bytes" between 100 and 8388608
      and octet_length("offer_issuance"."variant_snapshot_sha256") = 32
      and octet_length("offer_issuance"."profile_snapshot_sha256") = 32
      and octet_length("offer_issuance"."recipient_snapshot_sha256") = 32
      and ("offer_issuance"."valid_through" - "offer_issuance"."document_date") between 1 and 60);--> statement-breakpoint
