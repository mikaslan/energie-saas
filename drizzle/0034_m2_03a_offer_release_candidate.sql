CREATE TABLE "offer_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_recipient_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_recipient_ws_offer_uq" UNIQUE("workspace_id","offer_id"),
	CONSTRAINT "offer_recipient_ws_offer_id_uq" UNIQUE("workspace_id","offer_id","id"),
	CONSTRAINT "offer_recipient_revision_ck" CHECK ("offer_recipient"."current_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offer_recipient_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_recipient_revision_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_recipient_revision_ws_recipient_revision_uq" UNIQUE("workspace_id","recipient_id","revision"),
	CONSTRAINT "offer_recipient_revision_ws_binding_uq" UNIQUE("workspace_id","id","recipient_id","offer_id","revision","snapshot_sha256"),
	CONSTRAINT "offer_recipient_revision_revision_ck" CHECK ("offer_recipient_revision"."revision" > 0),
	CONSTRAINT "offer_recipient_revision_version_ck" CHECK (
      "offer_recipient_revision"."schema_version" = 'offer-recipient-snapshot.v1'
      and "offer_recipient_revision"."canonicalization_version" = 'offer-jcs.v1'),
	CONSTRAINT "offer_recipient_revision_hash_ck" CHECK (
      octet_length("offer_recipient_revision"."snapshot_sha256") = 32
      and "offer_recipient_revision"."snapshot_sha256" = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1("offer_recipient_revision"."snapshot" - 'snapshotSha256'),
        'UTF8'
      ))),
	CONSTRAINT "offer_recipient_revision_json_ck" CHECK (
      jsonb_typeof("offer_recipient_revision"."snapshot") = 'object'
      and ("offer_recipient_revision"."snapshot" - array[
        'schemaVersion', 'canonicalizationVersion', 'recipientRevisionId',
        'workspaceId', 'offerId', 'revision', 'displayName', 'company',
        'email', 'billingAddress', 'confirmation', 'createdBy', 'createdAt',
        'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and "offer_recipient_revision"."snapshot"->>'schemaVersion' = "offer_recipient_revision"."schema_version"
      and "offer_recipient_revision"."snapshot"->>'canonicalizationVersion' = "offer_recipient_revision"."canonicalization_version"
      and "offer_recipient_revision"."snapshot"->>'workspaceId' = "offer_recipient_revision"."workspace_id"::text
      and "offer_recipient_revision"."snapshot"->>'offerId' = "offer_recipient_revision"."offer_id"::text
      and "offer_recipient_revision"."snapshot"->>'recipientRevisionId' = "offer_recipient_revision"."id"::text
      and ("offer_recipient_revision"."snapshot"->>'revision')::integer = "offer_recipient_revision"."revision"
      and "offer_recipient_revision"."snapshot"->>'createdBy' = "offer_recipient_revision"."created_by"::text
      and ("offer_recipient_revision"."snapshot"->>'createdAt')::timestamptz = "offer_recipient_revision"."created_at"
      and "offer_recipient_revision"."snapshot"->>'snapshotSha256' = encode("offer_recipient_revision"."snapshot_sha256", 'hex')
      and jsonb_typeof("offer_recipient_revision"."snapshot"->'billingAddress') = 'object'
      and jsonb_typeof("offer_recipient_revision"."snapshot"->'confirmation') = 'object'
      and "offer_recipient_revision"."snapshot"->'confirmation'->>'code' = 'recipient_billing_operator_confirmed'
      and ("offer_recipient_revision"."snapshot"->'confirmation'->>'confirmed')::boolean = true
      and "offer_recipient_revision"."snapshot"->'confirmation'->>'confirmedBy' = "offer_recipient_revision"."created_by"::text
      and ("offer_recipient_revision"."snapshot"->'confirmation'->>'confirmedAt')::timestamptz = "offer_recipient_revision"."created_at")
);
--> statement-breakpoint
CREATE TABLE "offer_release_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_number" text NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_revision_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"variant_snapshot_sha256" "bytea" NOT NULL,
	"source_pdf_draft_id" uuid NOT NULL,
	"source_pdf_draft_state" text NOT NULL,
	"source_pdf_draft_input_sha256" "bytea" NOT NULL,
	"source_pdf_draft_mime_type" text NOT NULL,
	"source_pdf_draft_artifact_sha256" "bytea" NOT NULL,
	"source_pdf_draft_size_bytes" integer NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"profile_snapshot_sha256" "bytea" NOT NULL,
	"profile_activation_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_revision_id" uuid NOT NULL,
	"recipient_revision" integer NOT NULL,
	"recipient_snapshot_sha256" "bytea" NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_date" date NOT NULL,
	"valid_through" date NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
	"publication_status" text DEFAULT 'not_issued' NOT NULL,
	"reservation_key" "bytea" NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"has_zero_tax_treatment" boolean NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"error_retryable" boolean,
	"artifact_mime_type" text,
	"artifact_sha256" "bytea",
	"artifact_size_bytes" integer,
	"artifact_bytes" "bytea",
	"artifact_version" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "offer_release_candidate_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_release_candidate_ws_reservation_uq" UNIQUE("workspace_id","reservation_key"),
	CONSTRAINT "offer_release_candidate_ws_approval_binding_uq" UNIQUE("workspace_id","id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","source_pdf_draft_id","source_pdf_draft_input_sha256","source_pdf_draft_artifact_sha256","profile_activation_id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256","recipient_id","recipient_revision_id","recipient_revision","recipient_snapshot_sha256","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","publication_status","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version"),
	CONSTRAINT "offer_release_candidate_binding_ck" CHECK (
      "offer_release_candidate"."variant_revision" > 0
      and "offer_release_candidate"."profile_revision" > 0
      and "offer_release_candidate"."recipient_revision" > 0
      and "offer_release_candidate"."offer_number" ~ '^ANG-[0-9]{4}-[0-9]{6}$'
      and "offer_release_candidate"."source_pdf_draft_state" = 'succeeded'
      and "offer_release_candidate"."source_pdf_draft_mime_type" = 'application/pdf'
      and "offer_release_candidate"."source_pdf_draft_size_bytes" between 100 and 8388608
      and octet_length("offer_release_candidate"."variant_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."source_pdf_draft_input_sha256") = 32
      and octet_length("offer_release_candidate"."source_pdf_draft_artifact_sha256") = 32
      and octet_length("offer_release_candidate"."profile_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."recipient_snapshot_sha256") = 32
      and octet_length("offer_release_candidate"."reservation_key") = 32
      and octet_length("offer_release_candidate"."input_sha256") = 32),
	CONSTRAINT "offer_release_candidate_versions_ck" CHECK (
      "offer_release_candidate"."input_version" = 'offer-release-candidate-input.v1'
      and "offer_release_candidate"."canonicalization_version" = 'offer-jcs.v1'
      and "offer_release_candidate"."template_version" = 'offer-release-candidate-template.v1'
      and "offer_release_candidate"."renderer_recipe_version" = 'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'),
	CONSTRAINT "offer_release_candidate_publication_ck" CHECK (
      "offer_release_candidate"."publication_status" = 'not_issued'),
	CONSTRAINT "offer_release_candidate_dates_ck" CHECK (
      "offer_release_candidate"."prepared_at" = "offer_release_candidate"."created_at"
      and ("offer_release_candidate"."prepared_at" at time zone 'Europe/Berlin')::date = "offer_release_candidate"."document_date"
      and ("offer_release_candidate"."valid_through" - "offer_release_candidate"."document_date") between 1 and 60),
	CONSTRAINT "offer_release_candidate_input_ck" CHECK (
      jsonb_typeof("offer_release_candidate"."input_snapshot") = 'object'
      and ("offer_release_candidate"."input_snapshot" - array[
        'schemaVersion', 'canonicalizationVersion', 'templateVersion',
        'rendererRecipeVersion', 'documentStatus', 'preparedAt',
        'documentDate', 'validThrough', 'offerNumber', 'profile', 'sender',
        'recipient', 'installationSite', 'variant', 'commercialTerms',
        'sections', 'totals', 'legalDocuments'
      ]::text[]) = '{}'::jsonb
      and "offer_release_candidate"."input_snapshot"->>'schemaVersion' = "offer_release_candidate"."input_version"
      and "offer_release_candidate"."input_snapshot"->>'canonicalizationVersion' = "offer_release_candidate"."canonicalization_version"
      and "offer_release_candidate"."input_snapshot"->>'templateVersion' = "offer_release_candidate"."template_version"
      and "offer_release_candidate"."input_snapshot"->>'rendererRecipeVersion' = "offer_release_candidate"."renderer_recipe_version"
      and "offer_release_candidate"."input_snapshot"->>'documentStatus' = "offer_release_candidate"."publication_status"
      and ("offer_release_candidate"."input_snapshot"->>'preparedAt')::timestamptz = "offer_release_candidate"."prepared_at"
      and ("offer_release_candidate"."input_snapshot"->>'documentDate')::date = "offer_release_candidate"."document_date"
      and ("offer_release_candidate"."input_snapshot"->>'validThrough')::date = "offer_release_candidate"."valid_through"
      and "offer_release_candidate"."input_snapshot"->>'offerNumber' = "offer_release_candidate"."offer_number"
      and ("offer_release_candidate"."input_snapshot"->'profile'->>'revision')::integer = "offer_release_candidate"."profile_revision"
      and ("offer_release_candidate"."input_snapshot"->'variant'->>'revision')::integer = "offer_release_candidate"."variant_revision"
      and jsonb_typeof("offer_release_candidate"."input_snapshot"->'sections') = 'array'
      and jsonb_array_length("offer_release_candidate"."input_snapshot"->'sections') between 1 and 25
      and "offer_release_candidate"."has_zero_tax_treatment" = jsonb_path_exists(
        "offer_release_candidate"."input_snapshot",
        '$.sections[*].lines[*] ? (@.taxRateBps == 0)'::jsonpath
      )),
	CONSTRAINT "offer_release_candidate_input_hash_ck" CHECK (
      "offer_release_candidate"."input_sha256" = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1("offer_release_candidate"."input_snapshot"),
        'UTF8'
      ))),
	CONSTRAINT "offer_release_candidate_state_ck" CHECK ("offer_release_candidate"."state" in (
      'queued', 'running', 'retry_wait', 'ready_for_approval', 'failed_final'
    )),
	CONSTRAINT "offer_release_candidate_attempt_ck" CHECK ("offer_release_candidate"."attempt_count" between 0 and 3),
	CONSTRAINT "offer_release_candidate_error_ck" CHECK ((
      "offer_release_candidate"."error_code" is null and "offer_release_candidate"."error_retryable" is null
    ) or (
      "offer_release_candidate"."error_code" ~ '^[a-z][a-z0-9_]{0,79}$' and "offer_release_candidate"."error_retryable" is not null
    )),
	CONSTRAINT "offer_release_candidate_artifact_ck" CHECK ((
      "offer_release_candidate"."artifact_mime_type" is null
      and "offer_release_candidate"."artifact_sha256" is null
      and "offer_release_candidate"."artifact_size_bytes" is null
      and "offer_release_candidate"."artifact_bytes" is null
      and "offer_release_candidate"."artifact_version" is null
    ) or (
      "offer_release_candidate"."artifact_mime_type" = 'application/pdf'
      and octet_length("offer_release_candidate"."artifact_sha256") = 32
      and "offer_release_candidate"."artifact_size_bytes" between 100 and 8388608
      and octet_length("offer_release_candidate"."artifact_bytes") = "offer_release_candidate"."artifact_size_bytes"
      and "offer_release_candidate"."artifact_sha256" = pg_catalog.sha256("offer_release_candidate"."artifact_bytes")
      and "offer_release_candidate"."artifact_version" is not null
    )),
	CONSTRAINT "offer_release_candidate_shape_ck" CHECK (case "offer_release_candidate"."state"
      when 'queued' then
        "offer_release_candidate"."lease_token" is null and "offer_release_candidate"."lease_expires_at" is null
        and "offer_release_candidate"."finished_at" is null and "offer_release_candidate"."error_code" is null
        and "offer_release_candidate"."error_retryable" is null and "offer_release_candidate"."artifact_bytes" is null
        and "offer_release_candidate"."artifact_version" is null
      when 'running' then
        "offer_release_candidate"."lease_token" is not null and "offer_release_candidate"."lease_expires_at" is not null
        and "offer_release_candidate"."started_at" is not null and "offer_release_candidate"."finished_at" is null
        and "offer_release_candidate"."error_code" is null and "offer_release_candidate"."error_retryable" is null
        and "offer_release_candidate"."artifact_bytes" is null and "offer_release_candidate"."artifact_version" is null
      when 'retry_wait' then
        "offer_release_candidate"."lease_token" is null and "offer_release_candidate"."lease_expires_at" is null
        and "offer_release_candidate"."started_at" is not null and "offer_release_candidate"."finished_at" is null
        and "offer_release_candidate"."error_code" is not null and "offer_release_candidate"."error_retryable" = true
        and "offer_release_candidate"."artifact_bytes" is null and "offer_release_candidate"."artifact_version" is null
      when 'ready_for_approval' then
        "offer_release_candidate"."lease_token" is null and "offer_release_candidate"."lease_expires_at" is null
        and "offer_release_candidate"."started_at" is not null and "offer_release_candidate"."finished_at" is not null
        and "offer_release_candidate"."error_code" is null and "offer_release_candidate"."error_retryable" is null
        and "offer_release_candidate"."artifact_bytes" is not null and "offer_release_candidate"."artifact_version" is not null
      when 'failed_final' then
        "offer_release_candidate"."lease_token" is null and "offer_release_candidate"."lease_expires_at" is null
        and "offer_release_candidate"."started_at" is not null and "offer_release_candidate"."finished_at" is not null
        and "offer_release_candidate"."error_code" is not null and "offer_release_candidate"."error_retryable" = false
        and "offer_release_candidate"."artifact_bytes" is null and "offer_release_candidate"."artifact_version" is null
      else false end)
);
--> statement-breakpoint
CREATE TABLE "offer_release_candidate_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_revision_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"variant_snapshot_sha256" "bytea" NOT NULL,
	"source_pdf_draft_id" uuid NOT NULL,
	"source_pdf_draft_input_sha256" "bytea" NOT NULL,
	"source_pdf_draft_artifact_sha256" "bytea" NOT NULL,
	"profile_activation_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"profile_snapshot_sha256" "bytea" NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_revision_id" uuid NOT NULL,
	"recipient_revision" integer NOT NULL,
	"recipient_snapshot_sha256" "bytea" NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"publication_status" text NOT NULL,
	"has_zero_tax_treatment" boolean NOT NULL,
	"artifact_mime_type" text NOT NULL,
	"artifact_sha256" "bytea" NOT NULL,
	"artifact_size_bytes" integer NOT NULL,
	"artifact_version" uuid NOT NULL,
	"approval_version" text NOT NULL,
	"approval_command_version" text NOT NULL,
	"approval_command" jsonb NOT NULL,
	"recipient_billing_reviewed" boolean NOT NULL,
	"commercial_content_reviewed" boolean NOT NULL,
	"active_profile_reviewed" boolean NOT NULL,
	"not_issued_status_understood" boolean NOT NULL,
	"zero_tax_treatment_reviewed" boolean,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_release_candidate_approval_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_release_candidate_approval_ws_candidate_uq" UNIQUE("workspace_id","candidate_id"),
	CONSTRAINT "offer_release_candidate_approval_binding_ck" CHECK (
      "offer_release_candidate_approval"."approval_version" = 'offer-release-candidate-approval.v1'
      and "offer_release_candidate_approval"."approval_command_version" = 'offer-release-approval-command.v1'
      and "offer_release_candidate_approval"."publication_status" = 'not_issued'
      and "offer_release_candidate_approval"."variant_revision" > 0
      and "offer_release_candidate_approval"."profile_revision" > 0
      and "offer_release_candidate_approval"."recipient_revision" > 0
      and octet_length("offer_release_candidate_approval"."variant_snapshot_sha256") = 32
      and octet_length("offer_release_candidate_approval"."source_pdf_draft_input_sha256") = 32
      and octet_length("offer_release_candidate_approval"."source_pdf_draft_artifact_sha256") = 32
      and octet_length("offer_release_candidate_approval"."profile_snapshot_sha256") = 32
      and octet_length("offer_release_candidate_approval"."recipient_snapshot_sha256") = 32
      and octet_length("offer_release_candidate_approval"."input_sha256") = 32
      and "offer_release_candidate_approval"."artifact_mime_type" = 'application/pdf'
      and octet_length("offer_release_candidate_approval"."artifact_sha256") = 32
      and "offer_release_candidate_approval"."artifact_size_bytes" between 100 and 8388608
      and "offer_release_candidate_approval"."artifact_version" is not null),
	CONSTRAINT "offer_release_candidate_approval_ack_ck" CHECK (
      "offer_release_candidate_approval"."recipient_billing_reviewed" = true
      and "offer_release_candidate_approval"."commercial_content_reviewed" = true
      and "offer_release_candidate_approval"."active_profile_reviewed" = true
      and "offer_release_candidate_approval"."not_issued_status_understood" = true),
	CONSTRAINT "offer_release_candidate_approval_zero_tax_ck" CHECK ((
      "offer_release_candidate_approval"."has_zero_tax_treatment" = true
      and "offer_release_candidate_approval"."zero_tax_treatment_reviewed" = true
      and "offer_release_candidate_approval"."approval_command" ? 'zeroTaxTreatmentReviewed'
    ) or (
      "offer_release_candidate_approval"."has_zero_tax_treatment" = false
      and "offer_release_candidate_approval"."zero_tax_treatment_reviewed" is null
      and not ("offer_release_candidate_approval"."approval_command" ? 'zeroTaxTreatmentReviewed')
    )),
	CONSTRAINT "offer_release_candidate_approval_json_ck" CHECK (
      jsonb_typeof("offer_release_candidate_approval"."approval_command") = 'object'
      and ("offer_release_candidate_approval"."approval_command" - array[
        'schemaVersion', 'workspaceId', 'offerId', 'candidateId',
        'expectedArtifactVersion',
        'recipientBillingReviewed', 'commercialContentReviewed',
        'activeProfileReviewed', 'notIssuedStatusUnderstood',
        'zeroTaxTreatmentReviewed'
      ]::text[]) = '{}'::jsonb
      and "offer_release_candidate_approval"."approval_command"->>'schemaVersion' = "offer_release_candidate_approval"."approval_command_version"
      and "offer_release_candidate_approval"."approval_command"->>'workspaceId' = "offer_release_candidate_approval"."workspace_id"::text
      and "offer_release_candidate_approval"."approval_command"->>'offerId' = "offer_release_candidate_approval"."offer_id"::text
      and "offer_release_candidate_approval"."approval_command"->>'candidateId' = "offer_release_candidate_approval"."candidate_id"::text
      and "offer_release_candidate_approval"."approval_command"->>'expectedArtifactVersion' = "offer_release_candidate_approval"."artifact_version"::text
      and ("offer_release_candidate_approval"."approval_command"->>'recipientBillingReviewed')::boolean = "offer_release_candidate_approval"."recipient_billing_reviewed"
      and ("offer_release_candidate_approval"."approval_command"->>'commercialContentReviewed')::boolean = "offer_release_candidate_approval"."commercial_content_reviewed"
      and ("offer_release_candidate_approval"."approval_command"->>'activeProfileReviewed')::boolean = "offer_release_candidate_approval"."active_profile_reviewed"
      and ("offer_release_candidate_approval"."approval_command"->>'notIssuedStatusUnderstood')::boolean = "offer_release_candidate_approval"."not_issued_status_understood"
      and case when "offer_release_candidate_approval"."has_zero_tax_treatment"
        then ("offer_release_candidate_approval"."approval_command"->>'zeroTaxTreatmentReviewed')::boolean = "offer_release_candidate_approval"."zero_tax_treatment_reviewed"
        else not ("offer_release_candidate_approval"."approval_command" ? 'zeroTaxTreatmentReviewed')
      end)
);
--> statement-breakpoint
CREATE TABLE "offer_release_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"active_activation_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_release_profile_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_release_profile_workspace_uq" UNIQUE("workspace_id"),
	CONSTRAINT "offer_release_profile_revision_ck" CHECK ("offer_release_profile"."current_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offer_release_profile_activation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"profile_snapshot_sha256" "bytea" NOT NULL,
	"review_state" text NOT NULL,
	"activated_by" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_release_profile_activation_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_release_profile_activation_ws_profile_revision_uq" UNIQUE("workspace_id","profile_id","profile_revision"),
	CONSTRAINT "offer_release_profile_activation_ws_binding_uq" UNIQUE("workspace_id","id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256"),
	CONSTRAINT "offer_release_profile_activation_review_ck" CHECK (
      "offer_release_profile_activation"."review_state" = 'operator_reviewed'
      and "offer_release_profile_activation"."profile_revision" > 0
      and octet_length("offer_release_profile_activation"."profile_snapshot_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "offer_release_profile_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_release_profile_revision_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_release_profile_revision_ws_profile_revision_uq" UNIQUE("workspace_id","profile_id","revision"),
	CONSTRAINT "offer_release_profile_revision_ws_binding_uq" UNIQUE("workspace_id","id","profile_id","revision","snapshot_sha256"),
	CONSTRAINT "offer_release_profile_revision_revision_ck" CHECK ("offer_release_profile_revision"."revision" > 0),
	CONSTRAINT "offer_release_profile_revision_version_ck" CHECK (
      "offer_release_profile_revision"."schema_version" = 'offer-release-profile-snapshot.v1'
      and "offer_release_profile_revision"."canonicalization_version" = 'offer-jcs.v1'),
	CONSTRAINT "offer_release_profile_revision_hash_ck" CHECK (
      octet_length("offer_release_profile_revision"."snapshot_sha256") = 32
      and "offer_release_profile_revision"."snapshot_sha256" = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1("offer_release_profile_revision"."snapshot" - 'snapshotSha256'),
        'UTF8'
      ))),
	CONSTRAINT "offer_release_profile_revision_json_ck" CHECK (
      jsonb_typeof("offer_release_profile_revision"."snapshot") = 'object'
      and ("offer_release_profile_revision"."snapshot" - array[
        'schemaVersion', 'canonicalizationVersion', 'profileId',
        'profileRevisionId', 'workspaceId', 'revision', 'profileName',
        'locale', 'currency', 'sender', 'legalDocuments', 'createdBy',
        'createdAt', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and "offer_release_profile_revision"."snapshot"->>'schemaVersion' = "offer_release_profile_revision"."schema_version"
      and "offer_release_profile_revision"."snapshot"->>'canonicalizationVersion' = "offer_release_profile_revision"."canonicalization_version"
      and "offer_release_profile_revision"."snapshot"->>'workspaceId' = "offer_release_profile_revision"."workspace_id"::text
      and "offer_release_profile_revision"."snapshot"->>'profileId' = "offer_release_profile_revision"."profile_id"::text
      and "offer_release_profile_revision"."snapshot"->>'profileRevisionId' = "offer_release_profile_revision"."id"::text
      and ("offer_release_profile_revision"."snapshot"->>'revision')::integer = "offer_release_profile_revision"."revision"
      and "offer_release_profile_revision"."snapshot"->>'createdBy' = "offer_release_profile_revision"."created_by"::text
      and ("offer_release_profile_revision"."snapshot"->>'createdAt')::timestamptz = "offer_release_profile_revision"."created_at"
      and "offer_release_profile_revision"."snapshot"->>'snapshotSha256' = encode("offer_release_profile_revision"."snapshot_sha256", 'hex')
      and "offer_release_profile_revision"."snapshot"->>'locale' = 'de-DE'
      and "offer_release_profile_revision"."snapshot"->>'currency' = 'EUR'
      and jsonb_typeof("offer_release_profile_revision"."snapshot"->'sender') = 'object'
      and jsonb_typeof("offer_release_profile_revision"."snapshot"->'legalDocuments') = 'object')
);
--> statement-breakpoint
ALTER TABLE "offer_recipient" ADD CONSTRAINT "offer_recipient_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_recipient" ADD CONSTRAINT "offer_recipient_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_recipient" ADD CONSTRAINT "offer_recipient_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_recipient_revision" ADD CONSTRAINT "offer_recipient_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_recipient_revision" ADD CONSTRAINT "offer_recipient_revision_head_fk" FOREIGN KEY ("workspace_id","offer_id","recipient_id") REFERENCES "public"."offer_recipient"("workspace_id","offer_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_recipient_revision" ADD CONSTRAINT "offer_recipient_revision_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_variant_revision_fk" FOREIGN KEY ("workspace_id","variant_revision_id","offer_id","variant_id","project_id","variant_revision","variant_snapshot_sha256") REFERENCES "public"."offer_variant_revision"("workspace_id","id","offer_id","variant_id","project_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_pdf_draft" ADD CONSTRAINT "offer_pdf_draft_ws_release_source_uq" UNIQUE("workspace_id","id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","state","input_sha256","artifact_mime_type","artifact_sha256","artifact_size_bytes");--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_source_draft_fk" FOREIGN KEY ("workspace_id","source_pdf_draft_id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","source_pdf_draft_state","source_pdf_draft_input_sha256","source_pdf_draft_mime_type","source_pdf_draft_artifact_sha256","source_pdf_draft_size_bytes") REFERENCES "public"."offer_pdf_draft"("workspace_id","id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","state","input_sha256","artifact_mime_type","artifact_sha256","artifact_size_bytes") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_profile_activation_fk" FOREIGN KEY ("workspace_id","profile_activation_id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256") REFERENCES "public"."offer_release_profile_activation"("workspace_id","id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_recipient_revision_fk" FOREIGN KEY ("workspace_id","recipient_revision_id","recipient_id","offer_id","recipient_revision","recipient_snapshot_sha256") REFERENCES "public"."offer_recipient_revision"("workspace_id","id","recipient_id","offer_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate" ADD CONSTRAINT "offer_release_candidate_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate_approval" ADD CONSTRAINT "offer_release_candidate_approval_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate_approval" ADD CONSTRAINT "offer_release_candidate_approval_candidate_fk" FOREIGN KEY ("workspace_id","candidate_id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","source_pdf_draft_id","source_pdf_draft_input_sha256","source_pdf_draft_artifact_sha256","profile_activation_id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256","recipient_id","recipient_revision_id","recipient_revision","recipient_snapshot_sha256","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","publication_status","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version") REFERENCES "public"."offer_release_candidate"("workspace_id","id","project_id","offer_id","variant_id","variant_revision_id","variant_revision","variant_snapshot_sha256","source_pdf_draft_id","source_pdf_draft_input_sha256","source_pdf_draft_artifact_sha256","profile_activation_id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256","recipient_id","recipient_revision_id","recipient_revision","recipient_snapshot_sha256","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","publication_status","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_candidate_approval" ADD CONSTRAINT "offer_release_candidate_approval_approved_by_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile" ADD CONSTRAINT "offer_release_profile_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile" ADD CONSTRAINT "offer_release_profile_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_activation" ADD CONSTRAINT "offer_release_profile_activation_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_activation" ADD CONSTRAINT "offer_release_profile_activation_revision_fk" FOREIGN KEY ("workspace_id","profile_revision_id","profile_id","profile_revision","profile_snapshot_sha256") REFERENCES "public"."offer_release_profile_revision"("workspace_id","id","profile_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_activation" ADD CONSTRAINT "offer_release_profile_activation_activated_by_fk" FOREIGN KEY ("workspace_id","activated_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_revision" ADD CONSTRAINT "offer_release_profile_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_revision" ADD CONSTRAINT "offer_release_profile_revision_profile_fk" FOREIGN KEY ("workspace_id","profile_id") REFERENCES "public"."offer_release_profile"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_release_profile_revision" ADD CONSTRAINT "offer_release_profile_revision_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_recipient_ws_updated_idx" ON "offer_recipient" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "offer_recipient_revision_ws_offer_idx" ON "offer_recipient_revision" USING btree ("workspace_id","offer_id","revision");--> statement-breakpoint
CREATE INDEX "offer_release_candidate_ws_offer_idx" ON "offer_release_candidate" USING btree ("workspace_id","offer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "offer_release_candidate_due_idx" ON "offer_release_candidate" USING btree ("workspace_id","state","next_attempt_at","created_at","id");--> statement-breakpoint
CREATE INDEX "offer_release_candidate_approval_ws_offer_idx" ON "offer_release_candidate_approval" USING btree ("workspace_id","offer_id","approved_at","id");--> statement-breakpoint
CREATE INDEX "offer_release_profile_ws_updated_idx" ON "offer_release_profile" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "offer_release_profile_activation_ws_profile_idx" ON "offer_release_profile_activation" USING btree ("workspace_id","profile_id","activated_at","id");--> statement-breakpoint
CREATE INDEX "offer_release_profile_revision_ws_profile_idx" ON "offer_release_profile_revision" USING btree ("workspace_id","profile_id","revision");
--> statement-breakpoint

-- M2-03a ergaenzt die generierte Drizzle-DDL ausschliesslich additiv um den
-- produktiven SQL-Sicherheitsvertrag. Die Aktivierungsreferenz bleibt nullable,
-- bindet im gesetzten Fall aber Workspace, Activation und denselben Profilkopf
-- gemeinsam. DEFERRABLE ermoeglicht die atomare Activation->Head-Umschaltung.
ALTER TABLE public.offer_release_profile_activation
  ADD CONSTRAINT offer_release_profile_activation_ws_head_uq
  UNIQUE (workspace_id, id, profile_id);--> statement-breakpoint
ALTER TABLE public.offer_release_profile
  ADD CONSTRAINT offer_release_profile_active_activation_fk
  FOREIGN KEY (workspace_id, active_activation_id, id)
  REFERENCES public.offer_release_profile_activation (
    workspace_id, id, profile_id
  )
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

ALTER TABLE public.offer_recipient ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_recipient FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_recipient
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_recipient_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_recipient_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_recipient_revision
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_release_candidate ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_release_candidate FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_release_candidate
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_release_candidate_approval ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_release_candidate_approval FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_release_candidate_approval
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_release_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_release_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_release_profile
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_release_profile_activation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_release_profile_activation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_release_profile_activation
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.offer_release_profile_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_release_profile_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_release_profile_revision
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

-- Append-only-/Head-/Queue-Guards greifen auch gegen direkte Owner-SQL. Ein
-- spaeterer Erasure-Slice muss DELETE bewusst tombstone-gebunden oeffnen;
-- bis dahin bleibt die sichere Voreinstellung ausnahmslos geschlossen.
CREATE FUNCTION public._m203a_guard_offer_release_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_append_only$
BEGIN
  RAISE EXCEPTION '% ist append-only; % ist verboten', TG_TABLE_NAME, TG_OP;
END
$m203a_append_only$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_release_append_only()
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_guard_offer_release_profile_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_profile_head$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_release_profile ist immutable; % ist verboten', TG_OP;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY[
        'current_revision', 'active_activation_id', 'updated_at'
      ]::text[])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY[
        'current_revision', 'active_activation_id', 'updated_at'
      ]::text[]) THEN
    RAISE EXCEPTION 'offer_release_profile: stabile Identitaet ist immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'offer_release_profile.updated_at muss monoton sein';
  END IF;
  IF NEW.current_revision = OLD.current_revision + 1
     AND NEW.active_activation_id IS NOT DISTINCT FROM OLD.active_activation_id THEN
    RETURN NEW;
  END IF;
  IF NEW.current_revision = OLD.current_revision
     AND NEW.active_activation_id IS DISTINCT FROM OLD.active_activation_id
     AND NEW.active_activation_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'offer_release_profile Head muss monoton und atomar fortschreiten';
END
$m203a_profile_head$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_release_profile_head()
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_guard_offer_recipient_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_recipient_head$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_recipient ist immutable; % ist verboten', TG_OP;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['current_revision', 'updated_at']::text[])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY['current_revision', 'updated_at']::text[])
     OR NEW.current_revision <> OLD.current_revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'offer_recipient Head muss monoton um eins fortschreiten';
  END IF;
  RETURN NEW;
END
$m203a_recipient_head$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_recipient_head()
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_guard_offer_release_candidate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_candidate_guard$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_release_candidate ist append-only; % ist verboten', TG_OP;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY[
        'state', 'attempt_count', 'next_attempt_at', 'lease_token',
        'lease_expires_at', 'error_code', 'error_retryable',
        'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
        'artifact_bytes', 'artifact_version', 'updated_at', 'started_at',
        'finished_at'
      ]::text[])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY[
        'state', 'attempt_count', 'next_attempt_at', 'lease_token',
        'lease_expires_at', 'error_code', 'error_retryable',
        'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
        'artifact_bytes', 'artifact_version', 'updated_at', 'started_at',
        'finished_at'
      ]::text[]) THEN
    RAISE EXCEPTION 'offer_release_candidate: versiegelte Bindung ist immutable';
  END IF;
  IF OLD.state IN ('ready_for_approval', 'failed_final') THEN
    RAISE EXCEPTION 'offer_release_candidate: terminaler Zustand ist immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'offer_release_candidate: monotone Queuewerte verletzt';
  END IF;
  IF OLD.started_at IS NOT NULL
     AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'offer_release_candidate.started_at ist immutable';
  END IF;

  IF NEW.state = 'running' THEN
    IF OLD.state NOT IN ('queued', 'retry_wait', 'running')
       OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Claim-Uebergang';
    END IF;
    IF OLD.state = 'running'
       AND OLD.lease_expires_at > pg_catalog.statement_timestamp() THEN
      RAISE EXCEPTION 'offer_release_candidate: aktive Lease darf nicht uebernommen werden';
    END IF;
  ELSIF NEW.state IN ('retry_wait', 'ready_for_approval', 'failed_final') THEN
    IF OLD.state <> 'running'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Abschluss-Uebergang';
    END IF;
  ELSIF NEW.state = 'queued' THEN
    IF OLD.state <> 'retry_wait'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Requeue-Uebergang';
    END IF;
  ELSE
    RAISE EXCEPTION 'offer_release_candidate: ungueltiger Zustandsuebergang';
  END IF;

  IF NEW.state = 'ready_for_approval' THEN
    IF OLD.artifact_bytes IS NOT NULL OR NEW.artifact_bytes IS NULL
       OR OLD.artifact_version IS NOT NULL OR NEW.artifact_version IS NULL THEN
      RAISE EXCEPTION 'offer_release_candidate: Artefakt darf nur einmal gesetzt werden';
    END IF;
  ELSIF NEW.artifact_mime_type IS DISTINCT FROM OLD.artifact_mime_type
     OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
     OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
     OR NEW.artifact_bytes IS DISTINCT FROM OLD.artifact_bytes
     OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version THEN
    RAISE EXCEPTION 'offer_release_candidate: Artefaktmutation ausserhalb Erfolg verboten';
  END IF;
  RETURN NEW;
END
$m203a_candidate_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_release_candidate()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER offer_release_profile_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_release_profile
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_profile_head();--> statement-breakpoint
CREATE TRIGGER offer_release_profile_no_truncate
  BEFORE TRUNCATE ON public.offer_release_profile
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_release_profile_revision_immutable
  BEFORE UPDATE OR DELETE ON public.offer_release_profile_revision
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_append_only();--> statement-breakpoint
CREATE TRIGGER offer_release_profile_revision_no_truncate
  BEFORE TRUNCATE ON public.offer_release_profile_revision
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_release_profile_activation_immutable
  BEFORE UPDATE OR DELETE ON public.offer_release_profile_activation
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_append_only();--> statement-breakpoint
CREATE TRIGGER offer_release_profile_activation_no_truncate
  BEFORE TRUNCATE ON public.offer_release_profile_activation
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_recipient_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_recipient
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_recipient_head();--> statement-breakpoint
CREATE TRIGGER offer_recipient_no_truncate
  BEFORE TRUNCATE ON public.offer_recipient
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_recipient_revision_immutable
  BEFORE UPDATE OR DELETE ON public.offer_recipient_revision
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_append_only();--> statement-breakpoint
CREATE TRIGGER offer_recipient_revision_no_truncate
  BEFORE TRUNCATE ON public.offer_recipient_revision
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_release_candidate_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_release_candidate
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_candidate();--> statement-breakpoint
CREATE TRIGGER offer_release_candidate_no_truncate
  BEFORE TRUNCATE ON public.offer_release_candidate
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_release_candidate_approval_immutable
  BEFORE UPDATE OR DELETE ON public.offer_release_candidate_approval
  FOR EACH ROW EXECUTE FUNCTION public._m203a_guard_offer_release_append_only();--> statement-breakpoint
CREATE TRIGGER offer_release_candidate_approval_no_truncate
  BEFORE TRUNCATE ON public.offer_release_candidate_approval
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- Interne, nicht aufrufbare Normalisierer halten die Definer-Grenzen klein.
-- PostgreSQL-UTF8 schliesst NUL/ungueltige Surrogate bereits vor der
-- Funktion aus; NFC, CRLF, Laengen und strikte JSON-Keysets werden hier
-- bytegleich zum TypeScript-Vertrag erzwungen.
CREATE FUNCTION public._m203a_normalize_offer_release_text(
  raw_value text,
  maximum_length integer,
  multiline boolean
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_text$
DECLARE
  normalized_value text;
BEGIN
  IF maximum_length < 1 OR maximum_length > 40000 THEN
    RAISE EXCEPTION 'ungueltige Textgrenze' USING ERRCODE = '22023';
  END IF;
  normalized_value := pg_catalog.normalize(raw_value);
  IF multiline THEN
    normalized_value := pg_catalog.replace(normalized_value, E'\r\n', E'\n');
  END IF;
  normalized_value := pg_catalog.btrim(normalized_value);
  IF pg_catalog.char_length(normalized_value) NOT BETWEEN 1 AND maximum_length THEN
    RAISE EXCEPTION 'ungueltiger Angebotstext' USING ERRCODE = '22023';
  END IF;
  RETURN normalized_value;
END
$m203a_text$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_normalize_offer_release_text(
  text, integer, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_normalize_offer_release_address(raw_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_address$
DECLARE
  normalized_value jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(raw_value) <> 'object'
     OR NOT raw_value ?& ARRAY[
       'street', 'houseNumber', 'postalCode', 'city', 'country'
     ]::text[]
     OR raw_value - ARRAY[
       'street', 'houseNumber', 'postalCode', 'city', 'country'
     ]::text[] <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(raw_value->'street') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'houseNumber') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'postalCode') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'city') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'country') <> 'string' THEN
    RAISE EXCEPTION 'ungueltige Rechnungsadresse' USING ERRCODE = '22023';
  END IF;
  normalized_value := pg_catalog.jsonb_build_object(
    'street', public._m203a_normalize_offer_release_text(
      raw_value->>'street', 160, false
    ),
    'houseNumber', public._m203a_normalize_offer_release_text(
      raw_value->>'houseNumber', 32, false
    ),
    'postalCode', public._m203a_normalize_offer_release_text(
      raw_value->>'postalCode', 16, false
    ),
    'city', public._m203a_normalize_offer_release_text(
      raw_value->>'city', 160, false
    ),
    'country', raw_value->>'country'
  );
  IF normalized_value->>'postalCode' !~ '^[0-9]{5}$'
     OR normalized_value->>'country' <> 'DE' THEN
    RAISE EXCEPTION 'ungueltige Rechnungsadresse' USING ERRCODE = '22023';
  END IF;
  RETURN normalized_value;
END
$m203a_address$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_normalize_offer_release_address(jsonb)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_normalize_offer_release_sender(raw_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_sender$
DECLARE
  normalized_email text;
  normalized_phone text;
  normalized_website text;
  normalized_register_court text;
  normalized_register_number text;
BEGIN
  IF pg_catalog.jsonb_typeof(raw_value) <> 'object'
     OR NOT raw_value ?& ARRAY[
       'legalName', 'tradingName', 'representedBy', 'address', 'email',
       'phoneE164', 'websiteHttpsUrl', 'registerCourt', 'registerNumber',
       'vatId'
     ]::text[]
     OR raw_value - ARRAY[
       'legalName', 'tradingName', 'representedBy', 'address', 'email',
       'phoneE164', 'websiteHttpsUrl', 'registerCourt', 'registerNumber',
       'vatId'
     ]::text[] <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(raw_value->'legalName') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'representedBy') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'address') <> 'object'
     OR pg_catalog.jsonb_typeof(raw_value->'email') <> 'string'
     OR NOT (
       raw_value->'tradingName' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'tradingName') = 'string'
     )
     OR NOT (
       raw_value->'phoneE164' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'phoneE164') = 'string'
     )
     OR NOT (
       raw_value->'websiteHttpsUrl' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'websiteHttpsUrl') = 'string'
     )
     OR NOT (
       raw_value->'registerCourt' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'registerCourt') = 'string'
     )
     OR NOT (
       raw_value->'registerNumber' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'registerNumber') = 'string'
     )
     OR NOT (
       raw_value->'vatId' = 'null'::jsonb
       OR pg_catalog.jsonb_typeof(raw_value->'vatId') = 'string'
     ) THEN
    RAISE EXCEPTION 'ungueltiges Ausstellerprofil' USING ERRCODE = '22023';
  END IF;

  normalized_email := pg_catalog.lower(
    public._m203a_normalize_offer_release_text(raw_value->>'email', 254, false)
  );
  IF normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'ungueltige Aussteller-E-Mail' USING ERRCODE = '22023';
  END IF;
  normalized_phone := CASE WHEN raw_value->'phoneE164' = 'null'::jsonb THEN NULL
    ELSE public._m203a_normalize_offer_release_text(
      raw_value->>'phoneE164', 32, false
    ) END;
  IF normalized_phone IS NOT NULL
     AND normalized_phone !~ '^\+[1-9][0-9]{1,14}$' THEN
    RAISE EXCEPTION 'ungueltige Aussteller-Telefonnummer' USING ERRCODE = '22023';
  END IF;
  normalized_website := CASE
    WHEN raw_value->'websiteHttpsUrl' = 'null'::jsonb THEN NULL
    ELSE public._m203a_normalize_offer_release_text(
      raw_value->>'websiteHttpsUrl', 500, false
    ) END;
  IF normalized_website IS NOT NULL AND (
       normalized_website !~ '^https://[^[:space:]/?#]+(?:[^[:space:]#]*)?$'
       OR pg_catalog.split_part(
         pg_catalog.split_part(normalized_website, '://', 2), '/', 1
       ) LIKE '%@%'
       OR normalized_website LIKE '%#%'
     ) THEN
    RAISE EXCEPTION 'ungueltige HTTPS-URL' USING ERRCODE = '22023';
  END IF;
  normalized_register_court := CASE
    WHEN raw_value->'registerCourt' = 'null'::jsonb THEN NULL
    ELSE public._m203a_normalize_offer_release_text(
      raw_value->>'registerCourt', 200, false
    ) END;
  normalized_register_number := CASE
    WHEN raw_value->'registerNumber' = 'null'::jsonb THEN NULL
    ELSE public._m203a_normalize_offer_release_text(
      raw_value->>'registerNumber', 100, false
    ) END;
  IF (normalized_register_court IS NULL)
       IS DISTINCT FROM (normalized_register_number IS NULL) THEN
    RAISE EXCEPTION 'Registergericht und Registernummer muessen gemeinsam gesetzt sein'
      USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'legalName', public._m203a_normalize_offer_release_text(
      raw_value->>'legalName', 200, false
    ),
    'tradingName', CASE WHEN raw_value->'tradingName' = 'null'::jsonb THEN NULL
      ELSE public._m203a_normalize_offer_release_text(
        raw_value->>'tradingName', 120, false
      ) END,
    'representedBy', public._m203a_normalize_offer_release_text(
      raw_value->>'representedBy', 200, false
    ),
    'address', public._m203a_normalize_offer_release_address(
      raw_value->'address'
    ),
    'email', normalized_email,
    'phoneE164', normalized_phone,
    'websiteHttpsUrl', normalized_website,
    'registerCourt', normalized_register_court,
    'registerNumber', normalized_register_number,
    'vatId', CASE WHEN raw_value->'vatId' = 'null'::jsonb THEN NULL
      ELSE public._m203a_normalize_offer_release_text(
        raw_value->>'vatId', 32, false
      ) END
  );
END
$m203a_sender$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_normalize_offer_release_sender(jsonb)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_normalize_offer_release_legal_document(raw_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_legal_document$
BEGIN
  IF pg_catalog.jsonb_typeof(raw_value) <> 'object'
     OR NOT raw_value ?& ARRAY['title', 'plainText']::text[]
     OR raw_value - ARRAY['title', 'plainText']::text[] <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(raw_value->'title') <> 'string'
     OR pg_catalog.jsonb_typeof(raw_value->'plainText') <> 'string' THEN
    RAISE EXCEPTION 'ungueltiger Rechtstext' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'title', public._m203a_normalize_offer_release_text(
      raw_value->>'title', 120, false
    ),
    'plainText', public._m203a_normalize_offer_release_text(
      raw_value->>'plainText', 40000, true
    )
  );
END
$m203a_legal_document$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_normalize_offer_release_legal_document(jsonb)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_normalize_offer_release_legal_documents(raw_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_legal_documents$
BEGIN
  IF pg_catalog.jsonb_typeof(raw_value) <> 'object'
     OR NOT raw_value ?& ARRAY[
       'terms', 'withdrawalInformation', 'privacyNotice'
     ]::text[]
     OR raw_value - ARRAY[
       'terms', 'withdrawalInformation', 'privacyNotice'
     ]::text[] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'ungueltige Rechtstexte' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'terms', public._m203a_normalize_offer_release_legal_document(
      raw_value->'terms'
    ),
    'withdrawalInformation',
      public._m203a_normalize_offer_release_legal_document(
        raw_value->'withdrawalInformation'
      ),
    'privacyNotice', public._m203a_normalize_offer_release_legal_document(
      raw_value->'privacyNotice'
    )
  );
END
$m203a_legal_documents$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_normalize_offer_release_legal_documents(jsonb)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_offer_release_instant(value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203a_instant$
  SELECT pg_catalog.to_char(
    value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$m203a_instant$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_offer_release_instant(timestamptz)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_authorize_offer_release(
  requested_workspace_id uuid,
  minimum_role text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_authorize$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer release context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL
     OR minimum_role NOT IN ('admin', 'prepare', 'approve') THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  -- Derselbe Workspace-Lock serialisiert Membership-DML (M1-02),
  -- Singleton-Profilanlage und alle nachfolgenden Head-Locks.
  PERFORM 1
    FROM public.workspace AS workspace_record
   WHERE workspace_record.id = requested_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role IS NULL
     OR actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
     WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
  ) OR (
    actor_capabilities ? 'external_only'
    AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
  ) OR (
    minimum_role = 'admin' AND actor_role <> 'admin'
  ) OR (
    minimum_role = 'prepare'
    AND actor_role <> 'admin'
    AND actor_capabilities->'prepare_offer_documents' IS DISTINCT FROM 'true'::jsonb
  ) OR (
    minimum_role = 'approve'
    AND actor_role <> 'admin'
    AND actor_capabilities->'approve_offer_documents' IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_id;
END
$m203a_authorize$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_authorize_offer_release(uuid, text)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.revise_offer_release_profile(
  requested_workspace_id uuid,
  expected_current_revision integer,
  requested_profile_name text,
  requested_sender jsonb,
  requested_legal_documents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_revise_profile$
DECLARE
  actor_id uuid;
  profile_head public.offer_release_profile%ROWTYPE;
  profile_revision_id uuid;
  next_revision integer;
  created_time timestamptz;
  created_time_text text;
  normalized_profile_name text;
  normalized_sender jsonb;
  normalized_legal_documents jsonb;
  snapshot_payload jsonb;
  snapshot_document jsonb;
  snapshot_digest bytea;
BEGIN
  actor_id := public._m203a_authorize_offer_release(
    requested_workspace_id, 'admin'
  );
  IF expected_current_revision IS NULL OR expected_current_revision < 0
     OR requested_profile_name IS NULL
     OR requested_sender IS NULL
     OR requested_legal_documents IS NULL THEN
    RAISE EXCEPTION 'ungueltiger Profilbefehl' USING ERRCODE = '22023';
  END IF;
  normalized_profile_name := public._m203a_normalize_offer_release_text(
    requested_profile_name, 120, false
  );
  normalized_sender := public._m203a_normalize_offer_release_sender(
    requested_sender
  );
  normalized_legal_documents :=
    public._m203a_normalize_offer_release_legal_documents(
      requested_legal_documents
    );
  created_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.transaction_timestamp()
  );
  created_time_text := public._m203a_offer_release_instant(created_time);

  SELECT profile_record.* INTO profile_head
    FROM public.offer_release_profile AS profile_record
   WHERE profile_record.workspace_id = requested_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    IF expected_current_revision <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
    profile_head.id := pg_catalog.gen_random_uuid();
    profile_head.workspace_id := requested_workspace_id;
    profile_head.current_revision := 0;
    profile_head.active_activation_id := NULL;
    profile_head.created_by := actor_id;
    profile_head.created_at := created_time;
    profile_head.updated_at := created_time;
    INSERT INTO public.offer_release_profile (
      id, workspace_id, current_revision, active_activation_id,
      created_by, created_at, updated_at
    ) VALUES (
      profile_head.id, profile_head.workspace_id,
      profile_head.current_revision, profile_head.active_activation_id,
      profile_head.created_by, profile_head.created_at, profile_head.updated_at
    );
  ELSIF profile_head.current_revision <> expected_current_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'currentRevision', profile_head.current_revision
    );
  END IF;

  -- Nach der Singleton-Anlage wird dieselbe erwartete Revision erneut gegen
  -- den autoritativen Head geprueft. Damit existiert kein Insert-Sonderpfad.
  IF profile_head.current_revision <> expected_current_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'currentRevision', profile_head.current_revision
    );
  END IF;
  next_revision := profile_head.current_revision + 1;
  profile_revision_id := pg_catalog.gen_random_uuid();
  snapshot_payload := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-release-profile-snapshot.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'profileId', profile_head.id::text,
    'profileRevisionId', profile_revision_id::text,
    'workspaceId', requested_workspace_id::text,
    'revision', next_revision,
    'profileName', normalized_profile_name,
    'locale', 'de-DE',
    'currency', 'EUR',
    'sender', normalized_sender,
    'legalDocuments', normalized_legal_documents,
    'createdBy', actor_id::text,
    'createdAt', created_time_text
  );
  snapshot_digest := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(snapshot_payload), 'UTF8'
  ));
  snapshot_document := snapshot_payload || pg_catalog.jsonb_build_object(
    'snapshotSha256', pg_catalog.encode(snapshot_digest, 'hex')
  );

  INSERT INTO public.offer_release_profile_revision (
    id, workspace_id, profile_id, revision, schema_version,
    canonicalization_version, snapshot, snapshot_sha256,
    created_by, created_at
  ) VALUES (
    profile_revision_id, requested_workspace_id, profile_head.id,
    next_revision, 'offer-release-profile-snapshot.v1', 'offer-jcs.v1',
    snapshot_document, snapshot_digest, actor_id, created_time
  );
  UPDATE public.offer_release_profile AS profile_record
     SET current_revision = next_revision,
         updated_at = created_time
   WHERE profile_record.workspace_id = requested_workspace_id
     AND profile_record.id = profile_head.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'revised',
    'workspaceId', requested_workspace_id::text,
    'profileId', profile_head.id::text,
    'profileRevisionId', profile_revision_id::text,
    'revision', next_revision,
    'snapshot', snapshot_document,
    'snapshotSha256', pg_catalog.encode(snapshot_digest, 'hex'),
    'createdBy', actor_id::text,
    'createdAt', created_time_text
  );
END
$m203a_revise_profile$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revise_offer_release_profile(
  uuid, integer, text, jsonb, jsonb
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.activate_offer_release_profile(
  requested_workspace_id uuid,
  requested_profile_id uuid,
  requested_profile_revision_id uuid,
  expected_profile_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_activate_profile$
DECLARE
  actor_id uuid;
  profile_head public.offer_release_profile%ROWTYPE;
  profile_revision public.offer_release_profile_revision%ROWTYPE;
  existing_activation public.offer_release_profile_activation%ROWTYPE;
  activation_id uuid;
  activated_time timestamptz;
  activated_time_text text;
BEGIN
  actor_id := public._m203a_authorize_offer_release(
    requested_workspace_id, 'admin'
  );
  IF requested_profile_id IS NULL
     OR requested_profile_revision_id IS NULL
     OR expected_profile_revision IS NULL
     OR expected_profile_revision < 1 THEN
    RAISE EXCEPTION 'ungueltiger Aktivierungsbefehl' USING ERRCODE = '22023';
  END IF;

  SELECT profile_record.* INTO profile_head
    FROM public.offer_release_profile AS profile_record
   WHERE profile_record.workspace_id = requested_workspace_id
     AND profile_record.id = requested_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF profile_head.current_revision <> expected_profile_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'currentRevision', profile_head.current_revision
    );
  END IF;

  SELECT revision_record.* INTO profile_revision
    FROM public.offer_release_profile_revision AS revision_record
   WHERE revision_record.workspace_id = requested_workspace_id
     AND revision_record.profile_id = requested_profile_id
     AND revision_record.id = requested_profile_revision_id
     AND revision_record.revision = expected_profile_revision;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF profile_revision.snapshot_sha256 IS DISTINCT FROM
       pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(
           profile_revision.snapshot - 'snapshotSha256'
         ),
         'UTF8'
       ))
     OR profile_revision.snapshot->>'snapshotSha256' IS DISTINCT FROM
       pg_catalog.encode(profile_revision.snapshot_sha256, 'hex') THEN
    RAISE EXCEPTION 'Profilrevision verletzt den Hashvertrag'
      USING ERRCODE = '23514';
  END IF;

  SELECT activation_record.* INTO existing_activation
    FROM public.offer_release_profile_activation AS activation_record
   WHERE activation_record.workspace_id = requested_workspace_id
     AND activation_record.profile_id = requested_profile_id
     AND activation_record.profile_revision = expected_profile_revision;
  IF FOUND THEN
    IF profile_head.active_activation_id IS DISTINCT FROM existing_activation.id
       OR existing_activation.profile_revision_id IS DISTINCT FROM
            requested_profile_revision_id
       OR existing_activation.activated_by IS DISTINCT FROM actor_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict',
        'currentRevision', profile_head.current_revision
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'activated',
      'workspaceId', requested_workspace_id::text,
      'activationId', existing_activation.id::text,
      'profileId', requested_profile_id::text,
      'profileRevisionId', requested_profile_revision_id::text,
      'profileRevision', expected_profile_revision,
      'profileSnapshotSha256', pg_catalog.encode(
        profile_revision.snapshot_sha256, 'hex'
      ),
      'reviewState', 'operator_reviewed',
      'reviewedBy', existing_activation.activated_by::text,
      'reviewedAt', public._m203a_offer_release_instant(
        existing_activation.activated_at
      ),
      'snapshot', profile_revision.snapshot
    );
  END IF;

  activation_id := pg_catalog.gen_random_uuid();
  activated_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.transaction_timestamp()
  );
  activated_time_text := public._m203a_offer_release_instant(activated_time);
  INSERT INTO public.offer_release_profile_activation (
    id, workspace_id, profile_id, profile_revision_id, profile_revision,
    profile_snapshot_sha256, review_state, activated_by, activated_at
  ) VALUES (
    activation_id, requested_workspace_id, requested_profile_id,
    requested_profile_revision_id, expected_profile_revision,
    profile_revision.snapshot_sha256, 'operator_reviewed', actor_id,
    activated_time
  );
  UPDATE public.offer_release_profile AS profile_record
     SET active_activation_id = activation_id,
         updated_at = activated_time
   WHERE profile_record.workspace_id = requested_workspace_id
     AND profile_record.id = requested_profile_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'activated',
    'workspaceId', requested_workspace_id::text,
    'activationId', activation_id::text,
    'profileId', requested_profile_id::text,
    'profileRevisionId', requested_profile_revision_id::text,
    'profileRevision', expected_profile_revision,
    'profileSnapshotSha256', pg_catalog.encode(
      profile_revision.snapshot_sha256, 'hex'
    ),
    'reviewState', 'operator_reviewed',
    'reviewedBy', actor_id::text,
    'reviewedAt', activated_time_text,
    'snapshot', profile_revision.snapshot
  );
END
$m203a_activate_profile$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activate_offer_release_profile(
  uuid, uuid, uuid, integer
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.revise_offer_recipient(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  expected_current_revision integer,
  requested_display_name text,
  requested_company text,
  requested_email text,
  requested_billing_address jsonb,
  billing_details_confirmed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_revise_recipient$
DECLARE
  actor_id uuid;
  recipient_head public.offer_recipient%ROWTYPE;
  recipient_revision_id uuid;
  next_revision integer;
  created_time timestamptz;
  created_time_text text;
  normalized_display_name text;
  normalized_company text;
  normalized_email text;
  normalized_billing_address jsonb;
  snapshot_payload jsonb;
  snapshot_document jsonb;
  snapshot_digest bytea;
BEGIN
  actor_id := public._m203a_authorize_offer_release(
    requested_workspace_id, 'prepare'
  );
  IF requested_offer_id IS NULL
     OR expected_current_revision IS NULL
     OR expected_current_revision < 0
     OR requested_display_name IS NULL
     OR requested_email IS NULL
     OR requested_billing_address IS NULL
     OR billing_details_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ungueltiger Empfaengerbefehl' USING ERRCODE = '22023';
  END IF;
  normalized_display_name := public._m203a_normalize_offer_release_text(
    requested_display_name, 200, false
  );
  normalized_company := CASE WHEN requested_company IS NULL THEN NULL
    ELSE public._m203a_normalize_offer_release_text(
      requested_company, 200, false
    ) END;
  normalized_email := pg_catalog.lower(
    public._m203a_normalize_offer_release_text(
      requested_email, 254, false
    )
  );
  IF normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'ungueltige Empfaenger-E-Mail' USING ERRCODE = '22023';
  END IF;
  normalized_billing_address :=
    public._m203a_normalize_offer_release_address(
      requested_billing_address
    );
  created_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.transaction_timestamp()
  );
  created_time_text := public._m203a_offer_release_instant(created_time);

  -- Der Offer-Lock serialisiert Erst- und Folgerevisionen mit allen
  -- kommerziellen Offer-Mutationen. Eine Installationsadresse wird nirgends
  -- gelesen und kann deshalb niemals still als Rechnungsadresse einspringen.
  PERFORM 1
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id = requested_offer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT recipient_record.* INTO recipient_head
    FROM public.offer_recipient AS recipient_record
   WHERE recipient_record.workspace_id = requested_workspace_id
     AND recipient_record.offer_id = requested_offer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    IF expected_current_revision <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
    recipient_head.id := pg_catalog.gen_random_uuid();
    recipient_head.workspace_id := requested_workspace_id;
    recipient_head.offer_id := requested_offer_id;
    recipient_head.current_revision := 0;
    recipient_head.created_by := actor_id;
    recipient_head.created_at := created_time;
    recipient_head.updated_at := created_time;
    INSERT INTO public.offer_recipient (
      id, workspace_id, offer_id, current_revision,
      created_by, created_at, updated_at
    ) VALUES (
      recipient_head.id, recipient_head.workspace_id, recipient_head.offer_id,
      recipient_head.current_revision, recipient_head.created_by,
      recipient_head.created_at, recipient_head.updated_at
    );
  ELSIF recipient_head.current_revision <> expected_current_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'currentRevision', recipient_head.current_revision
    );
  END IF;
  IF recipient_head.current_revision <> expected_current_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'currentRevision', recipient_head.current_revision
    );
  END IF;

  next_revision := recipient_head.current_revision + 1;
  recipient_revision_id := pg_catalog.gen_random_uuid();
  snapshot_payload := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-recipient-snapshot.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'recipientRevisionId', recipient_revision_id::text,
    'workspaceId', requested_workspace_id::text,
    'offerId', requested_offer_id::text,
    'revision', next_revision,
    'displayName', normalized_display_name,
    'company', normalized_company,
    'email', normalized_email,
    'billingAddress', normalized_billing_address,
    'confirmation', pg_catalog.jsonb_build_object(
      'code', 'recipient_billing_operator_confirmed',
      'confirmed', true,
      'confirmedBy', actor_id::text,
      'confirmedAt', created_time_text
    ),
    'createdBy', actor_id::text,
    'createdAt', created_time_text
  );
  snapshot_digest := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(snapshot_payload), 'UTF8'
  ));
  snapshot_document := snapshot_payload || pg_catalog.jsonb_build_object(
    'snapshotSha256', pg_catalog.encode(snapshot_digest, 'hex')
  );
  INSERT INTO public.offer_recipient_revision (
    id, workspace_id, recipient_id, offer_id, revision,
    schema_version, canonicalization_version, snapshot, snapshot_sha256,
    created_by, created_at
  ) VALUES (
    recipient_revision_id, requested_workspace_id, recipient_head.id,
    requested_offer_id, next_revision, 'offer-recipient-snapshot.v1',
    'offer-jcs.v1', snapshot_document, snapshot_digest, actor_id, created_time
  );
  UPDATE public.offer_recipient AS recipient_record
     SET current_revision = next_revision,
         updated_at = created_time
   WHERE recipient_record.workspace_id = requested_workspace_id
     AND recipient_record.offer_id = requested_offer_id
     AND recipient_record.id = recipient_head.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'revised',
    'workspaceId', requested_workspace_id::text,
    'offerId', requested_offer_id::text,
    'recipientId', recipient_head.id::text,
    'recipientRevisionId', recipient_revision_id::text,
    'revision', next_revision,
    'snapshot', snapshot_document,
    'snapshotSha256', pg_catalog.encode(snapshot_digest, 'hex'),
    'createdBy', actor_id::text,
    'createdAt', created_time_text
  );
END
$m203a_revise_recipient$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revise_offer_recipient(
  uuid, uuid, integer, text, text, text, jsonb, boolean
) FROM PUBLIC;--> statement-breakpoint

-- Explizite Allowlist: neue Objekte beginnen unabhaengig von provider- oder
-- migrationsspezifischen Default-ACLs geschlossen. Runtime liest tenantlokal
-- und mutiert beziehungsweise liest sensible Candidate-Daten ausschliesslich
-- ueber enge Definer-Funktionen. Der Worker
-- sieht genau den versiegelten, minimierten Renderinput inklusive der fuer das
-- Dokument notwendigen Empfaenger-/Rechnungsdaten, aber keine breiteren
-- Quelldatensaetze oder Protokoll-Payloads; er besitzt nur den Candidate-CAS.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  public.offer_recipient,
  public.offer_recipient_revision,
  public.offer_release_candidate,
  public.offer_release_candidate_approval,
  public.offer_release_profile,
  public.offer_release_profile_activation,
  public.offer_release_profile_revision
FROM PUBLIC;--> statement-breakpoint

DO $m203a_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role_record
       WHERE role_record.rolname = principal_name
    ) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE '
        'public.offer_recipient, public.offer_recipient_revision, '
        'public.offer_release_candidate, '
        'public.offer_release_candidate_approval, '
        'public.offer_release_profile, '
        'public.offer_release_profile_activation, '
        'public.offer_release_profile_revision FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m203a_guard_offer_release_append_only(), '
        'public._m203a_guard_offer_release_profile_head(), '
        'public._m203a_guard_offer_recipient_head(), '
        'public._m203a_guard_offer_release_candidate(), '
        'public._m203a_normalize_offer_release_text(text,integer,boolean), '
        'public._m203a_normalize_offer_release_address(jsonb), '
        'public._m203a_normalize_offer_release_sender(jsonb), '
        'public._m203a_normalize_offer_release_legal_document(jsonb), '
        'public._m203a_normalize_offer_release_legal_documents(jsonb), '
        'public._m203a_offer_release_instant(timestamptz), '
        'public._m203a_authorize_offer_release(uuid,text), '
        'public.revise_offer_release_profile(uuid,integer,text,jsonb,jsonb), '
        'public.activate_offer_release_profile(uuid,uuid,uuid,integer), '
        'public.revise_offer_recipient('
          'uuid,uuid,integer,text,text,text,jsonb,boolean) FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE CREATE ON SCHEMA public FROM %I', principal_name
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role_record
     WHERE role_record.rolname = 'app_runtime'
  ) THEN
    GRANT USAGE ON SCHEMA public TO app_runtime;
    GRANT SELECT ON
      public.offer_recipient,
      public.offer_recipient_revision,
      public.offer_release_profile,
      public.offer_release_profile_activation,
      public.offer_release_profile_revision
    TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public.revise_offer_release_profile(uuid, integer, text, jsonb, jsonb),
      public.activate_offer_release_profile(uuid, uuid, uuid, integer),
      public.revise_offer_recipient(
        uuid, uuid, integer, text, text, text, jsonb, boolean
      )
    TO app_runtime;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role_record
     WHERE role_record.rolname = 'app_worker'
  ) THEN
    GRANT USAGE ON SCHEMA public TO app_worker;
    GRANT SELECT ON public.offer_release_candidate TO app_worker;
    GRANT UPDATE (
      state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
      error_code, error_retryable, artifact_mime_type, artifact_sha256,
      artifact_size_bytes, artifact_bytes, artifact_version, updated_at,
      started_at, finished_at
    ) ON public.offer_release_candidate TO app_worker;
    -- Der Input-Hash-CHECK wird bei jedem Worker-CAS erneut ausgewertet.
    GRANT EXECUTE ON FUNCTION public.canonicalize_offer_json_v1(jsonb)
      TO app_worker;
  END IF;
END
$m203a_acl$;
--> statement-breakpoint

-- Die beiden internen Result-Projektionen liefern ausschliesslich die vom
-- Service validierten JSON-Envelopes. Sie bleiben fuer alle Anwendungsrollen
-- unaufrufbar; nur die app_owner-Definer duerfen sie nutzen.
CREATE FUNCTION public._m203a_prepared_candidate_result(
  requested_workspace_id uuid,
  requested_candidate_id uuid,
  was_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m203a_prepared_result$
  SELECT pg_catalog.jsonb_build_object(
    'status', 'prepared',
    'workspaceId', candidate.workspace_id::text,
    'candidateId', candidate.id::text,
    'projectId', candidate.project_id::text,
    'offerId', candidate.offer_id::text,
    'variantId', candidate.variant_id::text,
    'variantRevisionId', candidate.variant_revision_id::text,
    'variantRevision', candidate.variant_revision,
    'variantSnapshotSha256', pg_catalog.encode(
      candidate.variant_snapshot_sha256, 'hex'
    ),
    'sourcePdfDraftId', candidate.source_pdf_draft_id::text,
    'sourcePdfDraftInputSha256', pg_catalog.encode(
      candidate.source_pdf_draft_input_sha256, 'hex'
    ),
    'sourcePdfDraftArtifactSha256', pg_catalog.encode(
      candidate.source_pdf_draft_artifact_sha256, 'hex'
    ),
    'profileActivationId', candidate.profile_activation_id::text,
    'profileId', candidate.profile_id::text,
    'profileRevisionId', candidate.profile_revision_id::text,
    'profileRevision', candidate.profile_revision,
    'profileSnapshotSha256', pg_catalog.encode(
      candidate.profile_snapshot_sha256, 'hex'
    ),
    'recipientId', candidate.recipient_id::text,
    'recipientRevisionId', candidate.recipient_revision_id::text,
    'recipientRevision', candidate.recipient_revision,
    'recipientSnapshotSha256', pg_catalog.encode(
      candidate.recipient_snapshot_sha256, 'hex'
    ),
    'inputVersion', candidate.input_version,
    'canonicalizationVersion', candidate.canonicalization_version,
    'templateVersion', candidate.template_version,
    'rendererRecipeVersion', candidate.renderer_recipe_version,
    'reservationKeySha256', pg_catalog.encode(
      candidate.reservation_key, 'hex'
    ),
    'inputSnapshot', candidate.input_snapshot,
    'inputSha256', pg_catalog.encode(candidate.input_sha256, 'hex'),
    'publicationStatus', candidate.publication_status,
    'hasZeroTaxTreatment', candidate.has_zero_tax_treatment,
    'state', candidate.state,
    'attemptCount', candidate.attempt_count,
    'nextAttemptAt', public._m203a_offer_release_instant(
      candidate.next_attempt_at
    ),
    'createdBy', candidate.created_by::text,
    'createdAt', public._m203a_offer_release_instant(candidate.created_at),
    'startedAt', CASE WHEN candidate.started_at IS NULL THEN NULL
      ELSE public._m203a_offer_release_instant(candidate.started_at) END,
    'finishedAt', CASE WHEN candidate.finished_at IS NULL THEN NULL
      ELSE public._m203a_offer_release_instant(candidate.finished_at) END,
    'errorCode', candidate.error_code,
    'replayed', was_replayed
  )
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id = requested_candidate_id
$m203a_prepared_result$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_prepared_candidate_result(
  uuid, uuid, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203a_approved_candidate_result(
  requested_workspace_id uuid,
  requested_candidate_id uuid,
  was_replayed boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m203a_approved_result$
  SELECT pg_catalog.jsonb_build_object(
    'status', 'approved',
    'workspaceId', candidate.workspace_id::text,
    'candidateId', candidate.id::text,
    'projectId', candidate.project_id::text,
    'offerId', candidate.offer_id::text,
    'variantId', candidate.variant_id::text,
    'variantRevisionId', candidate.variant_revision_id::text,
    'variantRevision', candidate.variant_revision,
    'variantSnapshotSha256', pg_catalog.encode(
      candidate.variant_snapshot_sha256, 'hex'
    ),
    'sourcePdfDraftId', candidate.source_pdf_draft_id::text,
    'sourcePdfDraftInputSha256', pg_catalog.encode(
      candidate.source_pdf_draft_input_sha256, 'hex'
    ),
    'sourcePdfDraftArtifactSha256', pg_catalog.encode(
      candidate.source_pdf_draft_artifact_sha256, 'hex'
    ),
    'profileActivationId', candidate.profile_activation_id::text,
    'profileId', candidate.profile_id::text,
    'profileRevisionId', candidate.profile_revision_id::text,
    'profileRevision', candidate.profile_revision,
    'profileSnapshotSha256', pg_catalog.encode(
      candidate.profile_snapshot_sha256, 'hex'
    ),
    'recipientId', candidate.recipient_id::text,
    'recipientRevisionId', candidate.recipient_revision_id::text,
    'recipientRevision', candidate.recipient_revision,
    'recipientSnapshotSha256', pg_catalog.encode(
      candidate.recipient_snapshot_sha256, 'hex'
    ),
    'inputVersion', candidate.input_version,
    'canonicalizationVersion', candidate.canonicalization_version,
    'templateVersion', candidate.template_version,
    'rendererRecipeVersion', candidate.renderer_recipe_version,
    'inputSnapshot', candidate.input_snapshot,
    'inputSha256', pg_catalog.encode(candidate.input_sha256, 'hex'),
    'publicationStatus', candidate.publication_status,
    'hasZeroTaxTreatment', candidate.has_zero_tax_treatment,
    'approvalId', approval.id::text,
    'candidateState', candidate.state,
    'candidateCreatedAt', public._m203a_offer_release_instant(
      candidate.created_at
    ),
    'candidateFinishedAt', public._m203a_offer_release_instant(
      candidate.finished_at
    ),
    'artifactMimeType', candidate.artifact_mime_type,
    'artifactSha256', pg_catalog.encode(candidate.artifact_sha256, 'hex'),
    'artifactSizeBytes', candidate.artifact_size_bytes,
    'artifactVersion', approval.artifact_version::text,
    'approvalVersion', approval.approval_version,
    'approvalCommandVersion', approval.approval_command_version,
    'approvalCommand', approval.approval_command,
    'approvedBy', approval.approved_by::text,
    'approvedAt', public._m203a_offer_release_instant(approval.approved_at),
    'derivedState', 'approved_not_issued',
    'replayed', was_replayed
  )
    FROM public.offer_release_candidate AS candidate
    JOIN public.offer_release_candidate_approval AS approval
      ON approval.workspace_id = candidate.workspace_id
     AND approval.candidate_id = candidate.id
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id = requested_candidate_id
$m203a_approved_result$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_approved_candidate_result(
  uuid, uuid, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.prepare_offer_release_candidate(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_variant_id uuid,
  expected_variant_revision integer,
  requested_source_pdf_draft_id uuid,
  requested_profile_id uuid,
  requested_profile_revision_id uuid,
  expected_profile_revision integer,
  requested_recipient_revision_id uuid,
  expected_recipient_revision integer,
  requested_valid_through date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_prepare_candidate$
DECLARE
  actor_id uuid;
  discovered_project_id uuid;
  profile_head public.offer_release_profile%ROWTYPE;
  profile_activation public.offer_release_profile_activation%ROWTYPE;
  profile_revision public.offer_release_profile_revision%ROWTYPE;
  offer_record public.offer%ROWTYPE;
  recipient_head public.offer_recipient%ROWTYPE;
  recipient_revision public.offer_recipient_revision%ROWTYPE;
  variant_head public.offer_variant%ROWTYPE;
  variant_revision public.offer_variant_revision%ROWTYPE;
  source_draft public.offer_pdf_draft%ROWTYPE;
  existing_candidate public.offer_release_candidate%ROWTYPE;
  candidate_id uuid;
  prepared_time timestamptz;
  prepared_time_text text;
  document_day date;
  candidate_sections jsonb;
  candidate_input jsonb;
  candidate_input_sha256 bytea;
  reservation_material jsonb;
  reservation_digest bytea;
  zero_tax boolean;
BEGIN
  actor_id := public._m203a_authorize_offer_release(
    requested_workspace_id, 'prepare'
  );
  IF requested_offer_id IS NULL
     OR requested_variant_id IS NULL
     OR requested_source_pdf_draft_id IS NULL
     OR requested_profile_id IS NULL
     OR requested_profile_revision_id IS NULL
     OR requested_recipient_revision_id IS NULL
     OR expected_variant_revision IS NULL
     OR expected_variant_revision < 1
     OR expected_profile_revision IS NULL
     OR expected_profile_revision < 1
     OR expected_recipient_revision IS NULL
     OR expected_recipient_revision < 1
     OR requested_valid_through IS NULL THEN
    RAISE EXCEPTION 'ungueltiger Freigabekandidatenbefehl'
      USING ERRCODE = '22023';
  END IF;

  -- Globale Domaenensperren: Workspace (im Authorizer), aktives Profil,
  -- Project, Offer, offerlokaler Recipient, Variant, Revision, Source-Draft.
  SELECT profile.* INTO profile_head
    FROM public.offer_release_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id = requested_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF profile_head.current_revision <> expected_profile_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_revision_changed',
      'currentRevision', profile_head.current_revision
    );
  END IF;
  IF profile_head.active_activation_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;
  SELECT activation.* INTO profile_activation
    FROM public.offer_release_profile_activation AS activation
   WHERE activation.workspace_id = requested_workspace_id
     AND activation.id = profile_head.active_activation_id
     AND activation.profile_id = requested_profile_id
     AND activation.profile_revision_id = requested_profile_revision_id
     AND activation.profile_revision = expected_profile_revision
     AND activation.review_state = 'operator_reviewed'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;
  SELECT revision.* INTO profile_revision
    FROM public.offer_release_profile_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id = requested_profile_revision_id
     AND revision.profile_id = requested_profile_id
     AND revision.revision = expected_profile_revision
     AND revision.snapshot_sha256 = profile_activation.profile_snapshot_sha256
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;
  IF profile_revision.snapshot_sha256 IS DISTINCT FROM
       pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(
           profile_revision.snapshot - 'snapshotSha256'
         ), 'UTF8'
       ))
     OR profile_revision.snapshot->>'snapshotSha256' IS DISTINCT FROM
       pg_catalog.encode(profile_revision.snapshot_sha256, 'hex') THEN
    RAISE EXCEPTION 'aktives Angebotsprofil verletzt den Hashvertrag'
      USING ERRCODE = '23514';
  END IF;

  SELECT candidate_offer.project_id INTO discovered_project_id
    FROM public.offer AS candidate_offer
   WHERE candidate_offer.workspace_id = requested_workspace_id
     AND candidate_offer.id = requested_offer_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = discovered_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT candidate_offer.* INTO offer_record
    FROM public.offer AS candidate_offer
   WHERE candidate_offer.workspace_id = requested_workspace_id
     AND candidate_offer.id = requested_offer_id
     AND candidate_offer.project_id = discovered_project_id
     AND candidate_offer.status = 'draft'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT recipient.* INTO recipient_head
    FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.offer_id = requested_offer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF recipient_head.current_revision <> expected_recipient_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'recipient_revision_changed',
      'currentRevision', recipient_head.current_revision
    );
  END IF;
  SELECT revision.* INTO recipient_revision
    FROM public.offer_recipient_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id = requested_recipient_revision_id
     AND revision.recipient_id = recipient_head.id
     AND revision.offer_id = requested_offer_id
     AND revision.revision = expected_recipient_revision
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF recipient_revision.snapshot_sha256 IS DISTINCT FROM
       pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(
           recipient_revision.snapshot - 'snapshotSha256'
         ), 'UTF8'
       ))
     OR recipient_revision.snapshot->>'snapshotSha256' IS DISTINCT FROM
       pg_catalog.encode(recipient_revision.snapshot_sha256, 'hex') THEN
    RAISE EXCEPTION 'Empfaengerrevision verletzt den Hashvertrag'
      USING ERRCODE = '23514';
  END IF;

  SELECT variant.* INTO variant_head
    FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.offer_id = requested_offer_id
     AND variant.id = requested_variant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF variant_head.current_revision <> expected_variant_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'variant_revision_changed',
      'currentRevision', variant_head.current_revision
    );
  END IF;
  SELECT revision.* INTO variant_revision
    FROM public.offer_variant_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.offer_id = requested_offer_id
     AND revision.variant_id = requested_variant_id
     AND revision.project_id = discovered_project_id
     AND revision.revision = expected_variant_revision
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT draft.* INTO source_draft
    FROM public.offer_pdf_draft AS draft
   WHERE draft.workspace_id = requested_workspace_id
     AND draft.id = requested_source_pdf_draft_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF source_draft.project_id IS DISTINCT FROM discovered_project_id
     OR source_draft.offer_id IS DISTINCT FROM requested_offer_id
     OR source_draft.variant_id IS DISTINCT FROM requested_variant_id
     OR source_draft.variant_revision_id IS DISTINCT FROM variant_revision.id
     OR source_draft.variant_revision IS DISTINCT FROM expected_variant_revision
     OR source_draft.variant_snapshot_sha256 IS DISTINCT FROM
          variant_revision.snapshot_sha256
     OR source_draft.state <> 'succeeded'
     OR source_draft.input_version <> 'offer-pdf-draft-input.v1'
     OR source_draft.canonicalization_version <> 'offer-jcs.v1'
     OR source_draft.artifact_mime_type <> 'application/pdf'
     OR source_draft.artifact_size_bytes IS NULL
     OR source_draft.artifact_size_bytes NOT BETWEEN 100 AND 8388608
     OR source_draft.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
          pg_catalog.convert_to(
            public.canonicalize_offer_json_v1(source_draft.input_snapshot),
            'UTF8'
          )
        )
     OR source_draft.artifact_sha256 IS DISTINCT FROM
          pg_catalog.sha256(source_draft.artifact_bytes)
     OR source_draft.artifact_size_bytes IS DISTINCT FROM
          pg_catalog.octet_length(source_draft.artifact_bytes)
     OR source_draft.input_snapshot->>'offerNumber' IS DISTINCT FROM
          offer_record.offer_number THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'source_pdf_draft_changed'
    );
  END IF;
  IF EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_path_query(
           source_draft.input_snapshot,
           '$.sections[*].lines[*]'::jsonpath
         ) AS source_line(value)
        WHERE pg_catalog.jsonb_typeof(source_line.value->'isHidden')
                IS DISTINCT FROM 'boolean'
           OR source_line.value->'isHidden' IS DISTINCT FROM 'false'::jsonb
     ) OR EXISTS (
       SELECT 1
         FROM public.offer_bom_line AS source_line
        WHERE source_line.workspace_id = requested_workspace_id
          AND source_line.offer_id = requested_offer_id
          AND source_line.variant_id = requested_variant_id
          AND source_line.project_id = discovered_project_id
          AND source_line.revision_id = variant_revision.id
          AND source_line.revision = expected_variant_revision
          AND source_line.is_hidden = true
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'hidden_line_present'
    );
  END IF;

  prepared_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  prepared_time_text := public._m203a_offer_release_instant(prepared_time);
  document_day := (prepared_time AT TIME ZONE 'Europe/Berlin')::date;
  IF requested_valid_through - document_day NOT BETWEEN 1 AND 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'validity_window_changed'
    );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'position', source_section.value->'position',
      'title', source_section.value->'title',
      'discountBps', source_section.value->'discountBps',
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'position', source_line.value->'position',
            'title', source_line.value->'title',
            'description', source_line.value->'description',
            'quantityMilli', source_line.value->'quantityMilli',
            'unit', source_line.value->'unit',
            'positionType', source_line.value->'positionType',
            'salesUnitNetCents', source_line.value->'salesUnitNetCents',
            'lineDiscountBps', source_line.value->'lineDiscountBps',
            'taxRateBps', source_line.value->'taxRateBps',
            'finalNetCents', source_line.value->'finalNetCents',
            'taxCents', source_line.value->'taxCents',
            'grossCents', source_line.value->'grossCents'
          ) ORDER BY (source_line.value->>'position')::integer
        )
          FROM pg_catalog.jsonb_array_elements(
            source_section.value->'lines'
          ) AS source_line(value)
      ), '[]'::jsonb)
    ) ORDER BY (source_section.value->>'position')::integer
  ), '[]'::jsonb)
    INTO candidate_sections
    FROM pg_catalog.jsonb_array_elements(
      source_draft.input_snapshot->'sections'
    ) AS source_section(value);

  candidate_input := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-release-candidate-input.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'templateVersion', 'offer-release-candidate-template.v1',
    'rendererRecipeVersion',
      'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    'documentStatus', 'not_issued',
    'preparedAt', prepared_time_text,
    'documentDate', document_day::text,
    'validThrough', requested_valid_through::text,
    'offerNumber', offer_record.offer_number,
    'profile', pg_catalog.jsonb_build_object(
      'name', profile_revision.snapshot->'profileName',
      'revision', profile_revision.revision
    ),
    'sender', pg_catalog.jsonb_build_object(
      'legalName', profile_revision.snapshot->'sender'->'legalName',
      'tradingName', profile_revision.snapshot->'sender'->'tradingName',
      'representedBy', profile_revision.snapshot->'sender'->'representedBy',
      'address', profile_revision.snapshot->'sender'->'address',
      'contactEmail', profile_revision.snapshot->'sender'->'email',
      'contactPhone', profile_revision.snapshot->'sender'->'phoneE164',
      'website', profile_revision.snapshot->'sender'->'websiteHttpsUrl',
      'registerCourt', profile_revision.snapshot->'sender'->'registerCourt',
      'registerNumber', profile_revision.snapshot->'sender'->'registerNumber',
      'vatId', profile_revision.snapshot->'sender'->'vatId'
    ),
    'recipient', pg_catalog.jsonb_build_object(
      'displayName', recipient_revision.snapshot->'displayName',
      'company', recipient_revision.snapshot->'company',
      'billingAddress', recipient_revision.snapshot->'billingAddress' ||
        pg_catalog.jsonb_build_object(
          'formattedAddress', pg_catalog.concat(
            recipient_revision.snapshot->'billingAddress'->>'street', ' ',
            recipient_revision.snapshot->'billingAddress'->>'houseNumber',
            ', ',
            recipient_revision.snapshot->'billingAddress'->>'postalCode', ' ',
            recipient_revision.snapshot->'billingAddress'->>'city'
          )
        )
    ),
    'installationSite', source_draft.input_snapshot->'installationSite',
    'variant', source_draft.input_snapshot->'variant',
    'commercialTerms', source_draft.input_snapshot->'commercialTerms',
    'sections', candidate_sections,
    'totals', source_draft.input_snapshot->'totals',
    'legalDocuments', profile_revision.snapshot->'legalDocuments'
  );
  candidate_input_sha256 := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(candidate_input), 'UTF8'
  ));
  zero_tax := pg_catalog.jsonb_path_exists(
    candidate_input,
    '$.sections[*].lines[*] ? (@.taxRateBps == 0)'::jsonpath
  );
  reservation_material := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-release-candidate-reservation.v1',
    'workspaceId', requested_workspace_id::text,
    'offerId', requested_offer_id::text,
    'variantId', requested_variant_id::text,
    'variantRevisionId', variant_revision.id::text,
    'variantRevision', variant_revision.revision,
    'variantSnapshotSha256', pg_catalog.encode(
      variant_revision.snapshot_sha256, 'hex'
    ),
    'sourcePdfDraftId', source_draft.id::text,
    'sourcePdfDraftInputSha256', pg_catalog.encode(
      source_draft.input_sha256, 'hex'
    ),
    'sourcePdfDraftArtifactSha256', pg_catalog.encode(
      source_draft.artifact_sha256, 'hex'
    ),
    'profileActivationId', profile_activation.id::text,
    'profileRevisionId', profile_revision.id::text,
    'profileSnapshotSha256', pg_catalog.encode(
      profile_revision.snapshot_sha256, 'hex'
    ),
    'recipientRevisionId', recipient_revision.id::text,
    'recipientSnapshotSha256', pg_catalog.encode(
      recipient_revision.snapshot_sha256, 'hex'
    ),
    'validThrough', requested_valid_through::text,
    'inputVersion', 'offer-release-candidate-input.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'templateVersion', 'offer-release-candidate-template.v1',
    'rendererRecipeVersion',
      'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
  );
  reservation_digest := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(reservation_material), 'UTF8'
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    requested_workspace_id::text || ':' ||
      pg_catalog.encode(reservation_digest, 'hex'),
    1701734772
  ));

  SELECT candidate.* INTO existing_candidate
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.reservation_key = reservation_digest
   FOR UPDATE;
  IF FOUND THEN
    IF existing_candidate.offer_id IS DISTINCT FROM requested_offer_id
       OR existing_candidate.variant_revision_id IS DISTINCT FROM
            variant_revision.id
       OR existing_candidate.source_pdf_draft_id IS DISTINCT FROM
            source_draft.id
       OR existing_candidate.profile_activation_id IS DISTINCT FROM
            profile_activation.id
       OR existing_candidate.recipient_revision_id IS DISTINCT FROM
            recipient_revision.id
       OR existing_candidate.valid_through IS DISTINCT FROM
            requested_valid_through THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'candidate_source_changed'
      );
    END IF;
    RETURN public._m203a_prepared_candidate_result(
      requested_workspace_id, existing_candidate.id, true
    );
  END IF;

  candidate_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.offer_release_candidate (
    id, workspace_id, project_id, offer_id, offer_number,
    variant_id, variant_revision_id, variant_revision,
    variant_snapshot_sha256, source_pdf_draft_id, source_pdf_draft_state,
    source_pdf_draft_input_sha256, source_pdf_draft_mime_type,
    source_pdf_draft_artifact_sha256, source_pdf_draft_size_bytes,
    profile_id, profile_revision_id, profile_revision,
    profile_snapshot_sha256, profile_activation_id, recipient_id,
    recipient_revision_id, recipient_revision, recipient_snapshot_sha256,
    prepared_at, document_date, valid_through, input_version,
    canonicalization_version, template_version, renderer_recipe_version,
    publication_status, reservation_key, input_snapshot, input_sha256,
    has_zero_tax_treatment, state, attempt_count, next_attempt_at,
    created_by, created_at, updated_at
  ) VALUES (
    candidate_id, requested_workspace_id, discovered_project_id,
    requested_offer_id, offer_record.offer_number, requested_variant_id,
    variant_revision.id, variant_revision.revision,
    variant_revision.snapshot_sha256, source_draft.id, 'succeeded',
    source_draft.input_sha256, source_draft.artifact_mime_type,
    source_draft.artifact_sha256, source_draft.artifact_size_bytes,
    requested_profile_id, profile_revision.id, profile_revision.revision,
    profile_revision.snapshot_sha256, profile_activation.id,
    recipient_head.id, recipient_revision.id, recipient_revision.revision,
    recipient_revision.snapshot_sha256, prepared_time, document_day,
    requested_valid_through, 'offer-release-candidate-input.v1',
    'offer-jcs.v1', 'offer-release-candidate-template.v1',
    'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    'not_issued', reservation_digest, candidate_input, candidate_input_sha256,
    zero_tax, 'queued', 0, prepared_time, actor_id, prepared_time,
    prepared_time
  );
  RETURN public._m203a_prepared_candidate_result(
    requested_workspace_id, candidate_id, false
  );
END
$m203a_prepare_candidate$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prepare_offer_release_candidate(
  uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.approve_offer_release_candidate(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_candidate_id uuid,
  expected_artifact_version uuid,
  recipient_billing_reviewed boolean,
  commercial_content_reviewed boolean,
  active_profile_reviewed boolean,
  not_issued_status_understood boolean,
  zero_tax_treatment_reviewed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_approve_candidate$
DECLARE
  actor_id uuid;
  discovered_candidate public.offer_release_candidate%ROWTYPE;
  candidate public.offer_release_candidate%ROWTYPE;
  profile_head public.offer_release_profile%ROWTYPE;
  profile_activation public.offer_release_profile_activation%ROWTYPE;
  profile_revision public.offer_release_profile_revision%ROWTYPE;
  recipient_head public.offer_recipient%ROWTYPE;
  recipient_revision public.offer_recipient_revision%ROWTYPE;
  variant_head public.offer_variant%ROWTYPE;
  variant_revision public.offer_variant_revision%ROWTYPE;
  source_draft public.offer_pdf_draft%ROWTYPE;
  existing_approval public.offer_release_candidate_approval%ROWTYPE;
  approval_id uuid;
  approved_time timestamptz;
  approval_command jsonb;
BEGIN
  actor_id := public._m203a_authorize_offer_release(
    requested_workspace_id, 'approve'
  );
  IF requested_offer_id IS NULL OR requested_candidate_id IS NULL
     OR expected_artifact_version IS NULL THEN
    RAISE EXCEPTION 'ungueltiger Freigabebefehl' USING ERRCODE = '22023';
  END IF;
  SELECT release_candidate.* INTO discovered_candidate
    FROM public.offer_release_candidate AS release_candidate
   WHERE release_candidate.workspace_id = requested_workspace_id
     AND release_candidate.offer_id = requested_offer_id
     AND release_candidate.id = requested_candidate_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF discovered_candidate.state <> 'ready_for_approval'
     OR discovered_candidate.artifact_version IS DISTINCT FROM
          expected_artifact_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_not_ready'
    );
  END IF;

  SELECT profile.* INTO profile_head
    FROM public.offer_release_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id = discovered_candidate.profile_id
   FOR UPDATE;
  IF NOT FOUND
     OR profile_head.active_activation_id IS DISTINCT FROM
          discovered_candidate.profile_activation_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;
  SELECT activation.* INTO profile_activation
    FROM public.offer_release_profile_activation AS activation
   WHERE activation.workspace_id = requested_workspace_id
     AND activation.id = discovered_candidate.profile_activation_id
     AND activation.profile_id = discovered_candidate.profile_id
     AND activation.profile_revision_id = discovered_candidate.profile_revision_id
     AND activation.profile_revision = discovered_candidate.profile_revision
     AND activation.profile_snapshot_sha256 =
           discovered_candidate.profile_snapshot_sha256
     AND activation.review_state = 'operator_reviewed'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;
  SELECT revision.* INTO profile_revision
    FROM public.offer_release_profile_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id = discovered_candidate.profile_revision_id
     AND revision.profile_id = discovered_candidate.profile_id
     AND revision.revision = discovered_candidate.profile_revision
     AND revision.snapshot_sha256 = discovered_candidate.profile_snapshot_sha256
   FOR SHARE;
  IF NOT FOUND OR profile_revision.snapshot_sha256 IS DISTINCT FROM
       pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(
           profile_revision.snapshot - 'snapshotSha256'
         ), 'UTF8'
       )) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'profile_activation_changed'
    );
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = discovered_candidate.project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id = requested_offer_id
     AND offer_record.project_id = discovered_candidate.project_id
     AND offer_record.status = 'draft'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT recipient.* INTO recipient_head
    FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.offer_id = requested_offer_id
     AND recipient.id = discovered_candidate.recipient_id
   FOR UPDATE;
  IF NOT FOUND
     OR recipient_head.current_revision <> discovered_candidate.recipient_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  SELECT revision.* INTO recipient_revision
    FROM public.offer_recipient_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id = discovered_candidate.recipient_revision_id
     AND revision.recipient_id = discovered_candidate.recipient_id
     AND revision.offer_id = requested_offer_id
     AND revision.revision = discovered_candidate.recipient_revision
     AND revision.snapshot_sha256 =
           discovered_candidate.recipient_snapshot_sha256
   FOR SHARE;
  IF NOT FOUND OR recipient_revision.snapshot_sha256 IS DISTINCT FROM
       pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(
           recipient_revision.snapshot - 'snapshotSha256'
         ), 'UTF8'
       )) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;

  SELECT variant.* INTO variant_head
    FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.offer_id = requested_offer_id
     AND variant.id = discovered_candidate.variant_id
   FOR UPDATE;
  IF NOT FOUND
     OR variant_head.current_revision <> discovered_candidate.variant_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  SELECT revision.* INTO variant_revision
    FROM public.offer_variant_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id = discovered_candidate.variant_revision_id
     AND revision.offer_id = requested_offer_id
     AND revision.variant_id = discovered_candidate.variant_id
     AND revision.project_id = discovered_candidate.project_id
     AND revision.revision = discovered_candidate.variant_revision
     AND revision.snapshot_sha256 = discovered_candidate.variant_snapshot_sha256
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;

  SELECT draft.* INTO source_draft
    FROM public.offer_pdf_draft AS draft
   WHERE draft.workspace_id = requested_workspace_id
     AND draft.id = discovered_candidate.source_pdf_draft_id
   FOR SHARE;
  IF NOT FOUND
     OR source_draft.state <> 'succeeded'
     OR source_draft.project_id IS DISTINCT FROM discovered_candidate.project_id
     OR source_draft.offer_id IS DISTINCT FROM requested_offer_id
     OR source_draft.variant_revision_id IS DISTINCT FROM
          discovered_candidate.variant_revision_id
     OR source_draft.input_sha256 IS DISTINCT FROM
          discovered_candidate.source_pdf_draft_input_sha256
     OR source_draft.artifact_sha256 IS DISTINCT FROM
          discovered_candidate.source_pdf_draft_artifact_sha256
     OR source_draft.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
          pg_catalog.convert_to(
            public.canonicalize_offer_json_v1(source_draft.input_snapshot),
            'UTF8'
          )
        )
     OR source_draft.artifact_sha256 IS DISTINCT FROM
          pg_catalog.sha256(source_draft.artifact_bytes) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;

  SELECT release_candidate.* INTO candidate
    FROM public.offer_release_candidate AS release_candidate
   WHERE release_candidate.workspace_id = requested_workspace_id
     AND release_candidate.offer_id = requested_offer_id
     AND release_candidate.id = requested_candidate_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF candidate.state <> 'ready_for_approval'
     OR candidate.artifact_version IS DISTINCT FROM expected_artifact_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_not_ready'
    );
  END IF;
  IF candidate.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
       pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(candidate.input_snapshot), 'UTF8'
       )
     )
     OR candidate.artifact_mime_type <> 'application/pdf'
     OR candidate.artifact_size_bytes IS NULL
     OR candidate.artifact_size_bytes NOT BETWEEN 100 AND 8388608
     OR candidate.artifact_size_bytes IS DISTINCT FROM
          pg_catalog.octet_length(candidate.artifact_bytes)
     OR candidate.artifact_sha256 IS DISTINCT FROM
          pg_catalog.sha256(candidate.artifact_bytes) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'artifact_integrity_changed'
    );
  END IF;

  IF recipient_billing_reviewed IS DISTINCT FROM true
     OR commercial_content_reviewed IS DISTINCT FROM true
     OR active_profile_reviewed IS DISTINCT FROM true
     OR not_issued_status_understood IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'approval_conflict'
    );
  END IF;
  IF candidate.has_zero_tax_treatment
     AND zero_tax_treatment_reviewed IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'zero_tax_review_required'
    );
  END IF;
  IF NOT candidate.has_zero_tax_treatment
     AND zero_tax_treatment_reviewed IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'zero_tax_review_forbidden'
    );
  END IF;

  approval_command := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-release-approval-command.v1',
    'workspaceId', requested_workspace_id::text,
    'offerId', requested_offer_id::text,
    'candidateId', requested_candidate_id::text,
    'expectedArtifactVersion', expected_artifact_version::text,
    'recipientBillingReviewed', true,
    'commercialContentReviewed', true,
    'activeProfileReviewed', true,
    'notIssuedStatusUnderstood', true
  ) || CASE WHEN candidate.has_zero_tax_treatment
       THEN pg_catalog.jsonb_build_object('zeroTaxTreatmentReviewed', true)
       ELSE '{}'::jsonb END;
  SELECT approval.* INTO existing_approval
    FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.candidate_id = requested_candidate_id
   FOR UPDATE;
  IF FOUND THEN
    IF existing_approval.approval_command IS DISTINCT FROM approval_command THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'approval_conflict'
      );
    END IF;
    RETURN public._m203a_approved_candidate_result(
      requested_workspace_id, requested_candidate_id, true
    );
  END IF;

  approval_id := pg_catalog.gen_random_uuid();
  approved_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  INSERT INTO public.offer_release_candidate_approval (
    id, workspace_id, candidate_id, project_id, offer_id, variant_id,
    variant_revision_id, variant_revision, variant_snapshot_sha256,
    source_pdf_draft_id, source_pdf_draft_input_sha256,
    source_pdf_draft_artifact_sha256, profile_activation_id, profile_id,
    profile_revision_id, profile_revision, profile_snapshot_sha256,
    recipient_id, recipient_revision_id, recipient_revision,
    recipient_snapshot_sha256, input_version, canonicalization_version,
    template_version, renderer_recipe_version, input_sha256,
    publication_status, has_zero_tax_treatment, artifact_mime_type,
    artifact_sha256, artifact_size_bytes, artifact_version, approval_version,
    approval_command_version, approval_command, recipient_billing_reviewed,
    commercial_content_reviewed, active_profile_reviewed,
    not_issued_status_understood, zero_tax_treatment_reviewed,
    approved_by, approved_at
  ) VALUES (
    approval_id, candidate.workspace_id, candidate.id, candidate.project_id,
    candidate.offer_id, candidate.variant_id, candidate.variant_revision_id,
    candidate.variant_revision, candidate.variant_snapshot_sha256,
    candidate.source_pdf_draft_id, candidate.source_pdf_draft_input_sha256,
    candidate.source_pdf_draft_artifact_sha256,
    candidate.profile_activation_id, candidate.profile_id,
    candidate.profile_revision_id, candidate.profile_revision,
    candidate.profile_snapshot_sha256, candidate.recipient_id,
    candidate.recipient_revision_id, candidate.recipient_revision,
    candidate.recipient_snapshot_sha256, candidate.input_version,
    candidate.canonicalization_version, candidate.template_version,
    candidate.renderer_recipe_version, candidate.input_sha256,
    candidate.publication_status, candidate.has_zero_tax_treatment,
    candidate.artifact_mime_type, candidate.artifact_sha256,
    candidate.artifact_size_bytes, candidate.artifact_version,
    'offer-release-candidate-approval.v1',
    'offer-release-approval-command.v1', approval_command, true, true, true,
    true, zero_tax_treatment_reviewed, actor_id, approved_time
  );
  RETURN public._m203a_approved_candidate_result(
    requested_workspace_id, requested_candidate_id, false
  );
END
$m203a_approve_candidate$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.approve_offer_release_candidate(
  uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.read_offer_release_candidate_status(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_candidate_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  id uuid,
  offer_id uuid,
  variant_id uuid,
  variant_revision integer,
  profile_revision integer,
  recipient_revision integer,
  publication_status text,
  has_zero_tax_treatment boolean,
  state text,
  attempt_count integer,
  next_attempt_at timestamptz,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  approval_id uuid,
  approval_version text,
  approval_command_version text,
  approved_at timestamptz,
  approval_artifact_version uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_candidate_status$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
  can_approve boolean;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer release context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
     WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
  ) OR (
    actor_capabilities ? 'external_only'
    AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
  ) THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  can_approve := actor_role = 'admin' OR (
    actor_role = 'editor'
    AND actor_capabilities->'approve_offer_documents' = 'true'::jsonb
  );

  RETURN QUERY
  SELECT candidate.workspace_id,
         candidate.id,
         candidate.offer_id,
         candidate.variant_id,
         candidate.variant_revision,
         candidate.profile_revision,
         candidate.recipient_revision,
         candidate.publication_status,
         candidate.has_zero_tax_treatment,
         candidate.state,
         candidate.attempt_count,
         candidate.next_attempt_at,
         candidate.created_at,
         candidate.started_at,
         candidate.finished_at,
         candidate.error_code,
         approval.id,
         approval.approval_version,
         approval.approval_command_version,
         approval.approved_at,
         CASE
           WHEN approval.id IS NULL
             AND candidate.state = 'ready_for_approval'
             AND can_approve
           THEN candidate.artifact_version
           ELSE NULL::uuid
         END
    FROM public.offer_release_candidate AS candidate
    LEFT JOIN public.offer_release_candidate_approval AS approval
      ON approval.workspace_id = candidate.workspace_id
     AND approval.candidate_id = candidate.id
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.offer_id = requested_offer_id
     AND (
       requested_candidate_id IS NULL
       OR candidate.id = requested_candidate_id
     );
END
$m203a_candidate_status$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_release_candidate_status(
  uuid, uuid, uuid
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.read_offer_release_candidate_artifact(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_candidate_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  id uuid,
  offer_id uuid,
  variant_id uuid,
  variant_revision integer,
  profile_revision integer,
  recipient_revision integer,
  publication_status text,
  has_zero_tax_treatment boolean,
  state text,
  attempt_count integer,
  next_attempt_at timestamptz,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  approval_id uuid,
  approval_version text,
  approval_command_version text,
  approved_at timestamptz,
  approval_artifact_version uuid,
  offer_number text,
  artifact_mime_type text,
  artifact_sha256_hex text,
  artifact_size_bytes integer,
  artifact_bytes bytea
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203a_candidate_artifact$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
  can_approve boolean;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer release context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR requested_candidate_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
     WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
  ) OR (
    actor_capabilities ? 'external_only'
    AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
  ) THEN
    RAISE EXCEPTION 'offer release context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  can_approve := actor_role = 'admin' OR (
    actor_role = 'editor'
    AND actor_capabilities->'approve_offer_documents' = 'true'::jsonb
  );

  RETURN QUERY
  SELECT candidate.workspace_id,
         candidate.id,
         candidate.offer_id,
         candidate.variant_id,
         candidate.variant_revision,
         candidate.profile_revision,
         candidate.recipient_revision,
         candidate.publication_status,
         candidate.has_zero_tax_treatment,
         candidate.state,
         candidate.attempt_count,
         candidate.next_attempt_at,
         candidate.created_at,
         candidate.started_at,
         candidate.finished_at,
         candidate.error_code,
         approval.id,
         approval.approval_version,
         approval.approval_command_version,
         approval.approved_at,
         NULL::uuid,
         offer_record.offer_number,
         candidate.artifact_mime_type,
         pg_catalog.encode(candidate.artifact_sha256, 'hex'),
         candidate.artifact_size_bytes,
         candidate.artifact_bytes
    FROM public.offer_release_candidate AS candidate
    JOIN public.offer AS offer_record
      ON offer_record.workspace_id = candidate.workspace_id
     AND offer_record.id = candidate.offer_id
    LEFT JOIN public.offer_release_candidate_approval AS approval
      ON approval.workspace_id = candidate.workspace_id
     AND approval.candidate_id = candidate.id
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.offer_id = requested_offer_id
     AND candidate.id = requested_candidate_id
     AND candidate.state = 'ready_for_approval'
     AND (approval.id IS NOT NULL OR can_approve);
END
$m203a_candidate_artifact$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_release_candidate_artifact(
  uuid, uuid, uuid
) FROM PUBLIC;--> statement-breakpoint

DO $m203a_release_function_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m203a_prepared_candidate_result(uuid,uuid,boolean), '
        'public._m203a_approved_candidate_result(uuid,uuid,boolean), '
        'public.prepare_offer_release_candidate('
          'uuid,uuid,uuid,integer,uuid,uuid,uuid,integer,uuid,integer,date), '
        'public.approve_offer_release_candidate('
          'uuid,uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean), '
        'public.read_offer_release_candidate_status(uuid,uuid,uuid), '
        'public.read_offer_release_candidate_artifact(uuid,uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.prepare_offer_release_candidate(
      uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer,
      date
    ) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.approve_offer_release_candidate(
      uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean
    ), public.read_offer_release_candidate_status(uuid, uuid, uuid),
       public.read_offer_release_candidate_artifact(uuid, uuid, uuid)
    TO app_runtime;
  END IF;
END
$m203a_release_function_acl$;
--> statement-breakpoint

-- Candidate-Dispatch folgt demselben gepinnten pg-boss-v38-Vertrag wie
-- M2-02. Der Worker besitzt Schema und Funktion; Runtime und Worker erhalten
-- nur EXECUTE auf diese eine Recovery-Naht, niemals Tabellenrechte im
-- worker-owned Schema.
DO $m203a_candidate_dispatch_migration$
DECLARE
  pgboss_owner text;
  pgboss_version integer;
BEGIN
  SELECT owner.rolname
    INTO pgboss_owner
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'pgboss';

  IF pgboss_owner IS NULL THEN
    IF CURRENT_USER = SESSION_USER
       AND CURRENT_USER IN ('app_test', 'app_ci')
       AND pg_catalog.current_database() ~* 'test' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'M2-03a Candidate dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M2-03a Candidate dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M2-03a Candidate dispatch: app_migrator braucht SET auf app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'M2-03a Candidate dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version)
    INTO pgboss_version
    FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'M2-03a Candidate dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'offer.release-candidate.render'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 10
     AND queue.retry_delay = 1
     AND queue.retry_backoff = true
     AND queue.retry_delay_max = 60
     AND queue.expire_seconds = 180
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-03a Candidate dispatch: Queue fehlt oder driftet';
  END IF;

  EXECUTE $candidate_dispatch_ddl$
    CREATE FUNCTION pgboss.enqueue_offer_release_candidate(
      workspace_id uuid,
      candidate_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $candidate_dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_attempt integer;
      dispatch_key text;
      dispatch_start_after timestamp with time zone;
      domain_state text;
      domain_attempt_count integer;
      domain_next_attempt_at timestamp with time zone;
      domain_lease_expires_at timestamp with time zone;
      runtime_pgboss_version integer;
    BEGIN
      IF NULLIF(
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'Candidate dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT candidate.state,
             candidate.attempt_count,
             candidate.next_attempt_at,
             candidate.lease_expires_at
        INTO domain_state,
             domain_attempt_count,
             domain_next_attempt_at,
             domain_lease_expires_at
        FROM public.offer_release_candidate AS candidate
       WHERE candidate.workspace_id = $1
         AND candidate.id = $2
         AND candidate.state IN ('queued', 'running', 'retry_wait')
         AND candidate.input_version = 'offer-release-candidate-input.v1'
         AND candidate.canonicalization_version = 'offer-jcs.v1'
         AND candidate.template_version =
             'offer-release-candidate-template.v1'
         AND candidate.renderer_recipe_version =
             'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
         AND candidate.publication_status = 'not_issued'
         AND pg_catalog.octet_length(candidate.reservation_key) = 32
         AND pg_catalog.octet_length(candidate.input_sha256) = 32
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Candidate dispatch: keine zustellbare Reservation'
          USING ERRCODE = '42501';
      END IF;

      dispatch_attempt := domain_attempt_count + 1;
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := CASE domain_state
        WHEN 'running' THEN domain_lease_expires_at
        ELSE domain_next_attempt_at
      END;
      IF dispatch_start_after IS NULL THEN
        RAISE EXCEPTION 'Candidate dispatch: Zustellzeit fehlt';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734773)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'Candidate dispatch: pg-boss-Schemaversion driftet';
      END IF;
      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'offer.release-candidate.render';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'Candidate dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'offer-release-candidate-dispatch.v1',
        'workspaceId', $1::text,
        'candidateId', $2::text
      );
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'offer.release-candidate.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'offer.release-candidate.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'offer.release-candidate.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'Candidate dispatch: aktiver Job verletzt Vertrag';
      END IF;

      INSERT INTO pgboss.job (
        name, data, priority, start_after, singleton_key, expire_seconds,
        deletion_seconds, keep_until, retry_limit, retry_delay,
        retry_backoff, retry_delay_max, policy, dead_letter,
        heartbeat_seconds
      )
      SELECT queue_config.name,
             dispatch_payload,
             0,
             dispatch_start_after,
             dispatch_key,
             queue_config.expire_seconds,
             queue_config.deletion_seconds,
             dispatch_start_after
               + queue_config.retention_seconds * interval '1 second',
             queue_config.retry_limit,
             queue_config.retry_delay,
             queue_config.retry_backoff,
             queue_config.retry_delay_max,
             queue_config.policy,
             queue_config.dead_letter,
             queue_config.heartbeat_seconds
      ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        IF EXISTS (
          SELECT 1
            FROM pgboss.job AS queued_job
           WHERE queued_job.name = 'offer.release-candidate.render'
             AND queued_job.singleton_key = dispatch_key
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'Candidate dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $candidate_dispatch_body$
  $candidate_dispatch_ddl$;

  EXECUTE 'REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_erasure, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_erasure, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_erasure, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_erasure, app_membership_writer, identity_reconciler';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_project_calculation(uuid, uuid) TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_offer_pdf_draft(uuid, uuid) TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_offer_release_candidate(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m203a_candidate_dispatch_migration$;
--> statement-breakpoint

-- Kontaktbezogene Release-Daten werden nur unter dem bestehenden WORM-
-- Tombstone geloescht. Das Workspace-Singleton-Profil ist absichtlich kein
-- Lead-Untergraph: ein Kontakt darf niemals die Absender-/Rechtskonfiguration
-- anderer Angebote entfernen.
CREATE FUNCTION public._m203a_erasure_delete_allowed(
  row_workspace_id uuid,
  row_id uuid,
  graph_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $m203a_erasure_allowed$
DECLARE
  erasure_operation uuid;
BEGIN
  IF graph_key NOT IN (
       'offerRecipientIds', 'offerRecipientRevisionIds',
       'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds'
     ) THEN
    RETURN false;
  END IF;
  BEGIN
    erasure_operation := NULLIF(
      pg_catalog.current_setting('app.erasure_operation_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  IF erasure_operation IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = row_workspace_id
       AND tombstone.graph_ids->graph_key ? row_id::text
  );
END
$m203a_erasure_allowed$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_erasure_delete_allowed(
  uuid, uuid, text
) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m203a_guard_offer_release_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_append_only_erasure$
DECLARE
  graph_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    graph_key := CASE TG_TABLE_NAME
      WHEN 'offer_recipient_revision' THEN 'offerRecipientRevisionIds'
      WHEN 'offer_release_candidate_approval' THEN
        'offerReleaseCandidateApprovalIds'
      ELSE NULL
    END;
    IF graph_key IS NOT NULL
       AND public._m203a_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, graph_key
       ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% ist append-only; % ist verboten', TG_TABLE_NAME, TG_OP;
END
$m203a_append_only_erasure$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_release_append_only()
  FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m203a_guard_offer_recipient_head()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_recipient_head_erasure$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m203a_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, 'offerRecipientIds'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'offer_recipient: DELETE ist nur im Erasurevertrag erlaubt';
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_recipient ist immutable; % ist verboten', TG_OP;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['current_revision', 'updated_at']::text[])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY['current_revision', 'updated_at']::text[])
     OR NEW.current_revision <> OLD.current_revision + 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'offer_recipient Head muss monoton um eins fortschreiten';
  END IF;
  RETURN NEW;
END
$m203a_recipient_head_erasure$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_recipient_head()
  FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m203a_guard_offer_release_candidate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_candidate_guard_erasure$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m203a_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, 'offerReleaseCandidateIds'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'offer_release_candidate: DELETE ist nur im Erasurevertrag erlaubt';
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_release_candidate ist append-only; % ist verboten', TG_OP;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY[
        'state', 'attempt_count', 'next_attempt_at', 'lease_token',
        'lease_expires_at', 'error_code', 'error_retryable',
        'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
        'artifact_bytes', 'artifact_version', 'updated_at', 'started_at',
        'finished_at'
      ]::text[])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY[
        'state', 'attempt_count', 'next_attempt_at', 'lease_token',
        'lease_expires_at', 'error_code', 'error_retryable',
        'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
        'artifact_bytes', 'artifact_version', 'updated_at', 'started_at',
        'finished_at'
      ]::text[]) THEN
    RAISE EXCEPTION 'offer_release_candidate: versiegelte Bindung ist immutable';
  END IF;
  IF OLD.state IN ('ready_for_approval', 'failed_final') THEN
    RAISE EXCEPTION 'offer_release_candidate: terminaler Zustand ist immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'offer_release_candidate: monotone Queuewerte verletzt';
  END IF;
  IF OLD.started_at IS NOT NULL
     AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'offer_release_candidate.started_at ist immutable';
  END IF;

  IF NEW.state = 'running' THEN
    IF OLD.state NOT IN ('queued', 'retry_wait', 'running')
       OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Claim-Uebergang';
    END IF;
    IF OLD.state = 'running'
       AND OLD.lease_expires_at > pg_catalog.statement_timestamp() THEN
      RAISE EXCEPTION 'offer_release_candidate: aktive Lease darf nicht uebernommen werden';
    END IF;
  ELSIF NEW.state IN ('retry_wait', 'ready_for_approval', 'failed_final') THEN
    IF OLD.state <> 'running'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Abschluss-Uebergang';
    END IF;
  ELSIF NEW.state = 'queued' THEN
    IF OLD.state <> 'retry_wait'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_release_candidate: ungueltiger Requeue-Uebergang';
    END IF;
  ELSE
    RAISE EXCEPTION 'offer_release_candidate: ungueltiger Zustandsuebergang';
  END IF;

  IF NEW.state = 'ready_for_approval' THEN
    IF OLD.artifact_bytes IS NOT NULL OR NEW.artifact_bytes IS NULL
       OR OLD.artifact_version IS NOT NULL OR NEW.artifact_version IS NULL THEN
      RAISE EXCEPTION 'offer_release_candidate: Artefakt darf nur einmal gesetzt werden';
    END IF;
  ELSIF NEW.artifact_mime_type IS DISTINCT FROM OLD.artifact_mime_type
     OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
     OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
     OR NEW.artifact_bytes IS DISTINCT FROM OLD.artifact_bytes
     OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version THEN
    RAISE EXCEPTION 'offer_release_candidate: Artefaktmutation ausserhalb Erfolg verboten';
  END IF;
  RETURN NEW;
END
$m203a_candidate_guard_erasure$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203a_guard_offer_release_candidate()
  FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203a_tombstone_worm$
DECLARE
  graph_key text;
  required_keys constant text[] := ARRAY[
    'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
    'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds',
    'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
    'offerVariantSectionIds', 'offerBomLineIds'
  ]::text[];
  optional_keys constant text[] := ARRAY[
    'offerPdfDraftIds', 'offerRecipientIds', 'offerRecipientRevisionIds',
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds'
  ]::text[];
  allowed_keys constant text[] := required_keys || optional_keys;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'erasure_tombstone WORM append-only: % ist verboten', TG_OP;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids) <> 'object'
     OR NEW.graph_ids - allowed_keys <> '{}'::jsonb
     OR NOT NEW.graph_ids ?& required_keys THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids->'contactId') <> 'string'
     OR NEW.graph_ids->>'contactId' <> NEW.contact_id::text THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;

  FOREACH graph_key IN ARRAY allowed_keys LOOP
    CONTINUE WHEN graph_key = 'contactId';
    CONTINUE WHEN graph_key = ANY(optional_keys)
                  AND NOT NEW.graph_ids ? graph_key;
    IF pg_catalog.jsonb_typeof(NEW.graph_ids->graph_key) <> 'array'
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(NEW.graph_ids->graph_key)
             AS graph_value(value)
          WHERE pg_catalog.jsonb_typeof(graph_value.value) <> 'string'
             OR graph_value.value #>> '{}' !~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ) THEN
      RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
    END IF;
    IF NEW.graph_ids->graph_key IS DISTINCT FROM COALESCE((
         SELECT pg_catalog.jsonb_agg(
                  graph_value.value ORDER BY graph_value.value #>> '{}'
                )
           FROM pg_catalog.jsonb_array_elements(NEW.graph_ids->graph_key)
             AS graph_value(value)
       ), '[]'::jsonb)
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements_text(NEW.graph_ids->graph_key)
             AS graph_value(value)
          GROUP BY graph_value.value
         HAVING pg_catalog.count(*) > 1
       ) THEN
      RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonisch sortierten ID-only-Graphen';
    END IF;
  END LOOP;
  RETURN NEW;
END
$m203a_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m202;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph_m202(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m203a_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m202(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN recipient_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerRecipientIds', recipient_graph.ids
              ) END
         || CASE WHEN recipient_revision_graph.ids = '[]'::jsonb
              THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object(
                'offerRecipientRevisionIds', recipient_revision_graph.ids
              ) END
         || CASE WHEN candidate_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerReleaseCandidateIds', candidate_graph.ids
              ) END
         || CASE WHEN approval_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerReleaseCandidateApprovalIds', approval_graph.ids
              ) END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(recipient.id::text ORDER BY recipient.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_recipient AS recipient
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = recipient.workspace_id
         AND offer_record.id = recipient.offer_id
       WHERE recipient.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS recipient_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(revision.id::text ORDER BY revision.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_recipient_revision AS revision
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = revision.workspace_id
         AND offer_record.id = revision.offer_id
       WHERE revision.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS recipient_revision_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(candidate.id::text ORDER BY candidate.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_release_candidate AS candidate
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = candidate.workspace_id
         AND offer_record.id = candidate.offer_id
       WHERE candidate.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS candidate_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(approval.id::text ORDER BY approval.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_release_candidate_approval AS approval
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = approval.workspace_id
         AND offer_record.id = approval.offer_id
       WHERE approval.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS approval_graph
$m203a_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

DO $m203a_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_offer_lock constant text := $m203a_old_offer_lock$
  PERFORM 1 FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerIds'
       ) AS value
     )
   ORDER BY offer_record.id FOR UPDATE;
  PERFORM 1 FROM public.offer_variant AS variant
$m203a_old_offer_lock$;
  new_offer_lock constant text := $m203a_new_offer_lock$
  PERFORM 1 FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerIds'
       ) AS value
     )
   ORDER BY offer_record.id FOR UPDATE;
  PERFORM 1 FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerRecipientIds', '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY recipient.id FOR UPDATE;
  PERFORM 1 FROM public.offer_recipient_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerRecipientRevisionIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY revision.id FOR UPDATE;
  PERFORM 1 FROM public.offer_variant AS variant
$m203a_new_offer_lock$;
  old_pdf_lock constant text := $m203a_old_pdf_lock$
  -- PDF-Request-Aktivitaet steckt bereits in offer.updated_at. Worker-Zeiten
  -- sind absichtlich kein eigener Retention-Anker.
  PERFORM 1 FROM public.offer_pdf_draft AS draft
   WHERE draft.workspace_id = requested_workspace_id
     AND draft.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerPdfDraftIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY draft.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.offer_pdf_draft AS draft
     WHERE draft.workspace_id = requested_workspace_id
       AND draft.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(
             operational_graph_document->'offerPdfDraftIds',
             '[]'::jsonb
           )
         ) AS value
       )
       AND draft.state = 'running'
       AND draft.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
$m203a_old_pdf_lock$;
  new_pdf_lock constant text := $m203a_new_pdf_lock$
  -- PDF-Request-Aktivitaet steckt bereits in offer.updated_at. Worker-Zeiten
  -- sind absichtlich kein eigener Retention-Anker.
  PERFORM 1 FROM public.offer_pdf_draft AS draft
   WHERE draft.workspace_id = requested_workspace_id
     AND draft.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerPdfDraftIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY draft.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.offer_pdf_draft AS draft
     WHERE draft.workspace_id = requested_workspace_id
       AND draft.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(
             operational_graph_document->'offerPdfDraftIds',
             '[]'::jsonb
           )
         ) AS value
       )
       AND draft.state = 'running'
       AND draft.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
  PERFORM 1 FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerReleaseCandidateIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY candidate.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.offer_release_candidate AS candidate
     WHERE candidate.workspace_id = requested_workspace_id
       AND candidate.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(
             operational_graph_document->'offerReleaseCandidateIds',
             '[]'::jsonb
           )
         ) AS value
       )
       AND candidate.state = 'running'
       AND candidate.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
  PERFORM 1 FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerReleaseCandidateApprovalIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY approval.id FOR UPDATE;
$m203a_new_pdf_lock$;
  old_activity constant text := $m203a_old_activity$
        UNION ALL
        SELECT revision.created_at FROM public.offer_variant_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'offerVariantRevisionIds') AS value
           )
      ) AS activity;
$m203a_old_activity$;
  new_activity constant text := $m203a_new_activity$
        UNION ALL
        SELECT revision.created_at FROM public.offer_variant_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'offerVariantRevisionIds') AS value
           )
        UNION ALL
        SELECT recipient.updated_at FROM public.offer_recipient AS recipient
         WHERE recipient.workspace_id = requested_workspace_id
           AND recipient.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(graph_document->'offerRecipientIds', '[]'::jsonb)
             ) AS value
           )
        UNION ALL
        SELECT revision.created_at FROM public.offer_recipient_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(
                 graph_document->'offerRecipientRevisionIds', '[]'::jsonb
               )
             ) AS value
           )
        UNION ALL
        SELECT candidate.created_at FROM public.offer_release_candidate AS candidate
         WHERE candidate.workspace_id = requested_workspace_id
           AND candidate.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(
                 graph_document->'offerReleaseCandidateIds', '[]'::jsonb
               )
             ) AS value
           )
        UNION ALL
        SELECT approval.approved_at FROM public.offer_release_candidate_approval AS approval
         WHERE approval.workspace_id = requested_workspace_id
           AND approval.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(
                 graph_document->'offerReleaseCandidateApprovalIds',
                 '[]'::jsonb
               )
             ) AS value
           )
      ) AS activity;
$m203a_new_activity$;
  old_delete constant text := $m203a_old_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_bom_line AS line_record
$m203a_old_delete$;
  new_delete constant text := $m203a_new_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerReleaseCandidateApprovalIds',
           '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerReleaseCandidateIds',
           '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_recipient_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerRecipientRevisionIds',
           '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerRecipientIds', '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_bom_line AS line_record
$m203a_new_delete$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO erase_source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'erase_inactive_lead'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-03a Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       'ba6c9475ce7520ef61c443c9fc0d04dd19af30edb8fb2664fd7889abcc66508a' THEN
    RAISE EXCEPTION 'M2-03a Erasure: unerwarteter M2-02-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_offer_lock) = 0
     OR pg_catalog.strpos(erase_source, old_pdf_lock) = 0
     OR pg_catalog.strpos(erase_source, old_activity) = 0
     OR pg_catalog.strpos(erase_source, old_delete) = 0 THEN
    RAISE EXCEPTION 'M2-03a Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_offer_lock, new_offer_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_pdf_lock, new_pdf_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_activity, new_activity
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_delete, new_delete
  );
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION public.erase_inactive_lead('
    'requested_workspace_id uuid, requested_contact_id uuid, '
    'requested_operation_id uuid) '
    'RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER '
    'SET search_path = pg_catalog AS %L',
    upgraded_source
  );
END
$m203a_erasure_upgrade$;
--> statement-breakpoint

DO $m203a_erasure_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m203a_erasure_delete_allowed(uuid,uuid,text), '
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m202(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m203a_erasure_acl$;
