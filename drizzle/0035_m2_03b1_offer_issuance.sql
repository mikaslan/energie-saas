CREATE TABLE "offer_issuance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"offer_number" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_approval_id" uuid NOT NULL,
	"candidate_approved_by" uuid NOT NULL,
	"candidate_approved_at" timestamp with time zone NOT NULL,
	"candidate_input_version" text NOT NULL,
	"candidate_canonicalization_version" text NOT NULL,
	"candidate_template_version" text NOT NULL,
	"candidate_renderer_recipe_version" text NOT NULL,
	"candidate_input_sha256" "bytea" NOT NULL,
	"candidate_approval_version" text NOT NULL,
	"candidate_approval_command_version" text NOT NULL,
	"candidate_artifact_mime_type" text NOT NULL,
	"candidate_artifact_sha256" "bytea" NOT NULL,
	"candidate_artifact_size_bytes" integer NOT NULL,
	"candidate_artifact_version" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_revision_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"variant_snapshot_sha256" "bytea" NOT NULL,
	"profile_activation_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"profile_snapshot_sha256" "bytea" NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_revision_id" uuid NOT NULL,
	"recipient_revision" integer NOT NULL,
	"recipient_snapshot_sha256" "bytea" NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_date" date NOT NULL,
	"valid_through" date NOT NULL,
	"artifact_intent" text NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
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
	CONSTRAINT "offer_issuance_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_issuance_ws_reservation_uq" UNIQUE("workspace_id","reservation_key"),
	CONSTRAINT "offer_issuance_ws_approval_binding_uq" UNIQUE("workspace_id","id","project_id","offer_id","candidate_id","candidate_approval_id","candidate_approved_by","artifact_intent","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version"),
	CONSTRAINT "offer_issuance_ws_withdrawal_binding_uq" UNIQUE("workspace_id","id","project_id","offer_id","candidate_id","candidate_approval_id","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256"),
	CONSTRAINT "offer_issuance_source_ck" CHECK (
      "offer_issuance"."offer_number" ~ '^ANG-[0-9]{4}-[0-9]{6}$'
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
      and ("offer_issuance"."valid_through" - "offer_issuance"."document_date") between 1 and 60),
	CONSTRAINT "offer_issuance_intent_ck" CHECK (
      "offer_issuance"."artifact_intent" = 'offer_issuance_final'
      and "offer_issuance"."input_version" = 'offer-issuance-input.v1'
      and "offer_issuance"."canonicalization_version" = 'offer-jcs.v1'
      and "offer_issuance"."template_version" = 'offer-issuance-template.v1'
      and "offer_issuance"."renderer_recipe_version" ~
        '^offer-issuance-renderer-recipe\.v1-linux-amd64-pw1\.62\.1-[0-9a-f]{64}$'
      and octet_length("offer_issuance"."reservation_key") = 32
      and octet_length("offer_issuance"."input_sha256") = 32),
	CONSTRAINT "offer_issuance_input_ck" CHECK (
      jsonb_typeof("offer_issuance"."input_snapshot") = 'object'
      and ("offer_issuance"."input_snapshot" - array[
        'schemaVersion', 'canonicalizationVersion', 'templateVersion',
        'rendererRecipeVersion', 'artifactIntent', 'issuanceId', 'preparedAt',
        'source', 'document'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance"."input_snapshot"->>'schemaVersion' = "offer_issuance"."input_version"
      and "offer_issuance"."input_snapshot"->>'canonicalizationVersion' =
        "offer_issuance"."canonicalization_version"
      and "offer_issuance"."input_snapshot"->>'templateVersion' = "offer_issuance"."template_version"
      and "offer_issuance"."input_snapshot"->>'rendererRecipeVersion' =
        "offer_issuance"."renderer_recipe_version"
      and "offer_issuance"."input_snapshot"->>'artifactIntent' = "offer_issuance"."artifact_intent"
      and "offer_issuance"."input_snapshot"->>'issuanceId' = "offer_issuance"."id"::text
      and ("offer_issuance"."input_snapshot"->>'preparedAt')::timestamptz = "offer_issuance"."prepared_at"
      and "offer_issuance"."prepared_at" = "offer_issuance"."created_at"
      and "offer_issuance"."prepared_at" >= "offer_issuance"."candidate_approved_at"
      and jsonb_typeof("offer_issuance"."input_snapshot"->'source') = 'object'
      and (("offer_issuance"."input_snapshot"->'source') - array[
        'workspaceId', 'projectId', 'offerId', 'candidateId',
        'candidateApprovalId', 'candidateApprovedAt',
        'candidateArtifactVersion', 'candidateArtifactMimeType',
        'candidateArtifactSha256', 'candidateArtifactSizeBytes',
        'candidateInputVersion', 'candidateCanonicalizationVersion',
        'candidateTemplateVersion', 'candidateRendererRecipeVersion',
        'candidateInputSha256', 'candidateApprovalVersion',
        'candidateApprovalCommandVersion', 'variant', 'profile', 'recipient'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance"."input_snapshot"->'source'->>'workspaceId' = "offer_issuance"."workspace_id"::text
      and "offer_issuance"."input_snapshot"->'source'->>'projectId' = "offer_issuance"."project_id"::text
      and "offer_issuance"."input_snapshot"->'source'->>'offerId' = "offer_issuance"."offer_id"::text
      and "offer_issuance"."input_snapshot"->'source'->>'candidateId' = "offer_issuance"."candidate_id"::text
      and "offer_issuance"."input_snapshot"->'source'->>'candidateApprovalId' =
        "offer_issuance"."candidate_approval_id"::text
      and ("offer_issuance"."input_snapshot"->'source'->>'candidateApprovedAt')::timestamptz =
        "offer_issuance"."candidate_approved_at"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateArtifactMimeType' =
        "offer_issuance"."candidate_artifact_mime_type"
      and ("offer_issuance"."input_snapshot"->'source'->>'candidateArtifactSizeBytes')::integer =
        "offer_issuance"."candidate_artifact_size_bytes"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateInputVersion' =
        "offer_issuance"."candidate_input_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateCanonicalizationVersion' =
        "offer_issuance"."candidate_canonicalization_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateTemplateVersion' =
        "offer_issuance"."candidate_template_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateRendererRecipeVersion' =
        "offer_issuance"."candidate_renderer_recipe_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateInputSha256' =
        encode("offer_issuance"."candidate_input_sha256", 'hex')
      and "offer_issuance"."input_snapshot"->'source'->>'candidateApprovalVersion' =
        "offer_issuance"."candidate_approval_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateApprovalCommandVersion' =
        "offer_issuance"."candidate_approval_command_version"
      and "offer_issuance"."input_snapshot"->'source'->>'candidateArtifactSha256' =
        encode("offer_issuance"."candidate_artifact_sha256", 'hex')
      and "offer_issuance"."input_snapshot"->'source'->>'candidateArtifactVersion' =
        "offer_issuance"."candidate_artifact_version"::text
      and (("offer_issuance"."input_snapshot"->'source'->'variant') - array[
        'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance"."input_snapshot"->'source'->'variant'->>'id' = "offer_issuance"."variant_id"::text
      and "offer_issuance"."input_snapshot"->'source'->'variant'->>'revisionId' =
        "offer_issuance"."variant_revision_id"::text
      and ("offer_issuance"."input_snapshot"->'source'->'variant'->>'revision')::integer =
        "offer_issuance"."variant_revision"
      and "offer_issuance"."input_snapshot"->'source'->'variant'->>'snapshotSha256' =
        encode("offer_issuance"."variant_snapshot_sha256", 'hex')
      and (("offer_issuance"."input_snapshot"->'source'->'profile') - array[
        'activationId', 'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance"."input_snapshot"->'source'->'profile'->>'activationId' =
        "offer_issuance"."profile_activation_id"::text
      and "offer_issuance"."input_snapshot"->'source'->'profile'->>'id' = "offer_issuance"."profile_id"::text
      and "offer_issuance"."input_snapshot"->'source'->'profile'->>'revisionId' =
        "offer_issuance"."profile_revision_id"::text
      and ("offer_issuance"."input_snapshot"->'source'->'profile'->>'revision')::integer =
        "offer_issuance"."profile_revision"
      and "offer_issuance"."input_snapshot"->'source'->'profile'->>'snapshotSha256' =
        encode("offer_issuance"."profile_snapshot_sha256", 'hex')
      and (("offer_issuance"."input_snapshot"->'source'->'recipient') - array[
        'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance"."input_snapshot"->'source'->'recipient'->>'id' = "offer_issuance"."recipient_id"::text
      and "offer_issuance"."input_snapshot"->'source'->'recipient'->>'revisionId' =
        "offer_issuance"."recipient_revision_id"::text
      and ("offer_issuance"."input_snapshot"->'source'->'recipient'->>'revision')::integer =
        "offer_issuance"."recipient_revision"
      and "offer_issuance"."input_snapshot"->'source'->'recipient'->>'snapshotSha256' =
        encode("offer_issuance"."recipient_snapshot_sha256", 'hex')
      and jsonb_typeof("offer_issuance"."input_snapshot"->'document') = 'object'
      and "offer_issuance"."input_snapshot"->'document'->>'offerNumber' = "offer_issuance"."offer_number"
      and ("offer_issuance"."input_snapshot"->'document'->>'documentDate')::date =
        "offer_issuance"."document_date"
      and ("offer_issuance"."input_snapshot"->'document'->>'validThrough')::date =
        "offer_issuance"."valid_through"
      and ("offer_issuance"."input_snapshot"->'document'->'variant'->>'revision')::integer =
        "offer_issuance"."variant_revision"
      and ("offer_issuance"."input_snapshot"->'document'->'profile'->>'revision')::integer =
        "offer_issuance"."profile_revision"
      and jsonb_typeof("offer_issuance"."input_snapshot"->'document'->'sections') = 'array'
      and jsonb_array_length("offer_issuance"."input_snapshot"->'document'->'sections')
        between 1 and 25
      and "offer_issuance"."has_zero_tax_treatment" = jsonb_path_exists(
        "offer_issuance"."input_snapshot",
        '$.document.sections[*].lines[*] ? (@.taxRateBps == 0)'::jsonpath
      )),
	CONSTRAINT "offer_issuance_input_hash_ck" CHECK (
      "offer_issuance"."input_sha256" = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1("offer_issuance"."input_snapshot"), 'UTF8'
      ))),
	CONSTRAINT "offer_issuance_state_ck" CHECK ("offer_issuance"."state" in (
      'queued', 'running', 'retry_wait', 'ready_for_approval', 'failed_final'
    )),
	CONSTRAINT "offer_issuance_attempt_ck" CHECK ("offer_issuance"."attempt_count" between 0 and 3),
	CONSTRAINT "offer_issuance_error_ck" CHECK ((
      "offer_issuance"."error_code" is null and "offer_issuance"."error_retryable" is null
    ) or (
      "offer_issuance"."error_code" ~ '^[a-z][a-z0-9_]{0,79}$'
      and "offer_issuance"."error_retryable" is not null
    )),
	CONSTRAINT "offer_issuance_artifact_ck" CHECK ((
      "offer_issuance"."artifact_mime_type" is null
      and "offer_issuance"."artifact_sha256" is null
      and "offer_issuance"."artifact_size_bytes" is null
      and "offer_issuance"."artifact_bytes" is null
      and "offer_issuance"."artifact_version" is null
    ) or (
      "offer_issuance"."artifact_mime_type" = 'application/pdf'
      and octet_length("offer_issuance"."artifact_sha256") = 32
      and "offer_issuance"."artifact_size_bytes" between 100 and 8388608
      and octet_length("offer_issuance"."artifact_bytes") = "offer_issuance"."artifact_size_bytes"
      and "offer_issuance"."artifact_sha256" = pg_catalog.sha256("offer_issuance"."artifact_bytes")
      and "offer_issuance"."artifact_sha256" <> "offer_issuance"."candidate_artifact_sha256"
      and "offer_issuance"."artifact_version" is not null
    )),
	CONSTRAINT "offer_issuance_shape_ck" CHECK (case "offer_issuance"."state"
      when 'queued' then
        "offer_issuance"."lease_token" is null and "offer_issuance"."lease_expires_at" is null
        and "offer_issuance"."started_at" is null and "offer_issuance"."finished_at" is null
        and "offer_issuance"."error_code" is null and "offer_issuance"."error_retryable" is null
        and "offer_issuance"."artifact_bytes" is null and "offer_issuance"."artifact_version" is null
      when 'running' then
        "offer_issuance"."lease_token" is not null and "offer_issuance"."lease_expires_at" is not null
        and "offer_issuance"."started_at" is not null and "offer_issuance"."finished_at" is null
        and "offer_issuance"."error_code" is null and "offer_issuance"."error_retryable" is null
        and "offer_issuance"."artifact_bytes" is null and "offer_issuance"."artifact_version" is null
      when 'retry_wait' then
        "offer_issuance"."lease_token" is null and "offer_issuance"."lease_expires_at" is null
        and "offer_issuance"."started_at" is not null and "offer_issuance"."finished_at" is null
        and "offer_issuance"."error_code" is not null and "offer_issuance"."error_retryable" = true
        and "offer_issuance"."artifact_bytes" is null and "offer_issuance"."artifact_version" is null
      when 'ready_for_approval' then
        "offer_issuance"."lease_token" is null and "offer_issuance"."lease_expires_at" is null
        and "offer_issuance"."started_at" is not null and "offer_issuance"."finished_at" is not null
        and "offer_issuance"."error_code" is null and "offer_issuance"."error_retryable" is null
        and "offer_issuance"."artifact_bytes" is not null and "offer_issuance"."artifact_version" is not null
      when 'failed_final' then
        "offer_issuance"."lease_token" is null and "offer_issuance"."lease_expires_at" is null
        and "offer_issuance"."started_at" is not null and "offer_issuance"."finished_at" is not null
        and "offer_issuance"."error_code" is not null and "offer_issuance"."error_retryable" = false
        and "offer_issuance"."artifact_bytes" is null and "offer_issuance"."artifact_version" is null
      else false end)
);
--> statement-breakpoint
CREATE TABLE "offer_issuance_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issuance_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_approval_id" uuid NOT NULL,
	"candidate_approved_by" uuid NOT NULL,
	"artifact_intent" text NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"has_zero_tax_treatment" boolean NOT NULL,
	"artifact_mime_type" text NOT NULL,
	"artifact_sha256" "bytea" NOT NULL,
	"artifact_size_bytes" integer NOT NULL,
	"artifact_version" uuid NOT NULL,
	"approval_version" text NOT NULL,
	"approval_command_version" text NOT NULL,
	"approval_command" jsonb NOT NULL,
	"recipient_and_scope_reviewed" boolean NOT NULL,
	"commercial_totals_reviewed" boolean NOT NULL,
	"legal_profile_reviewed" boolean NOT NULL,
	"final_pdf_for_archive_understood" boolean NOT NULL,
	"zero_tax_treatment_reviewed" boolean,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_issuance_approval_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_issuance_approval_ws_issuance_actor_uq" UNIQUE("workspace_id","issuance_id","approved_by"),
	CONSTRAINT "offer_issuance_approval_binding_ck" CHECK (
      "offer_issuance_approval"."artifact_intent" = 'offer_issuance_final'
      and "offer_issuance_approval"."input_version" = 'offer-issuance-input.v1'
      and "offer_issuance_approval"."canonicalization_version" = 'offer-jcs.v1'
      and "offer_issuance_approval"."template_version" = 'offer-issuance-template.v1'
      and "offer_issuance_approval"."renderer_recipe_version" ~
        '^offer-issuance-renderer-recipe\.v1-linux-amd64-pw1\.62\.1-[0-9a-f]{64}$'
      and octet_length("offer_issuance_approval"."input_sha256") = 32
      and "offer_issuance_approval"."artifact_mime_type" = 'application/pdf'
      and octet_length("offer_issuance_approval"."artifact_sha256") = 32
      and "offer_issuance_approval"."artifact_size_bytes" between 100 and 8388608),
	CONSTRAINT "offer_issuance_approval_ack_ck" CHECK (
      "offer_issuance_approval"."recipient_and_scope_reviewed" = true
      and "offer_issuance_approval"."commercial_totals_reviewed" = true
      and "offer_issuance_approval"."legal_profile_reviewed" = true
      and "offer_issuance_approval"."final_pdf_for_archive_understood" = true),
	CONSTRAINT "offer_issuance_approval_zero_tax_ck" CHECK ((
      "offer_issuance_approval"."has_zero_tax_treatment" = true
      and "offer_issuance_approval"."zero_tax_treatment_reviewed" = true
      and "offer_issuance_approval"."approval_command" ? 'zeroTaxTreatmentReviewed'
    ) or (
      "offer_issuance_approval"."has_zero_tax_treatment" = false
      and "offer_issuance_approval"."zero_tax_treatment_reviewed" is null
      and not ("offer_issuance_approval"."approval_command" ? 'zeroTaxTreatmentReviewed')
    )),
	CONSTRAINT "offer_issuance_approval_json_ck" CHECK (
      jsonb_typeof("offer_issuance_approval"."approval_command") = 'object'
      and ("offer_issuance_approval"."approval_command" - array[
        'schemaVersion', 'issuanceId', 'recipientAndScopeReviewed',
        'commercialTotalsReviewed', 'legalProfileReviewed',
        'finalPdfForArchiveUnderstood', 'zeroTaxTreatmentReviewed'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance_approval"."approval_command"->>'schemaVersion' = "offer_issuance_approval"."approval_command_version"
      and "offer_issuance_approval"."approval_command"->>'issuanceId' = "offer_issuance_approval"."issuance_id"::text
      and ("offer_issuance_approval"."approval_command"->>'recipientAndScopeReviewed')::boolean =
        "offer_issuance_approval"."recipient_and_scope_reviewed"
      and ("offer_issuance_approval"."approval_command"->>'commercialTotalsReviewed')::boolean =
        "offer_issuance_approval"."commercial_totals_reviewed"
      and ("offer_issuance_approval"."approval_command"->>'legalProfileReviewed')::boolean =
        "offer_issuance_approval"."legal_profile_reviewed"
      and ("offer_issuance_approval"."approval_command"->>'finalPdfForArchiveUnderstood')::boolean =
        "offer_issuance_approval"."final_pdf_for_archive_understood"
      and case when "offer_issuance_approval"."has_zero_tax_treatment"
        then ("offer_issuance_approval"."approval_command"->>'zeroTaxTreatmentReviewed')::boolean =
          "offer_issuance_approval"."zero_tax_treatment_reviewed"
        else not ("offer_issuance_approval"."approval_command" ? 'zeroTaxTreatmentReviewed')
      end
      and "offer_issuance_approval"."approval_version" = 'offer-issuance-approval.v1'
      and "offer_issuance_approval"."approval_command_version" = 'offer-issuance-approval-command.v1')
);
--> statement-breakpoint
CREATE TABLE "offer_issuance_withdrawal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issuance_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"candidate_approval_id" uuid NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"withdrawal_version" text NOT NULL,
	"withdrawal_command_version" text NOT NULL,
	"withdrawal_command" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"withdrawn_by" uuid NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_issuance_withdrawal_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_issuance_withdrawal_ws_issuance_uq" UNIQUE("workspace_id","issuance_id"),
	CONSTRAINT "offer_issuance_withdrawal_reason_ck" CHECK ("offer_issuance_withdrawal"."reason_code" in (
      'content_error', 'recipient_error', 'legal_text_error',
      'commercial_error', 'other'
    )),
	CONSTRAINT "offer_issuance_withdrawal_json_ck" CHECK (
      "offer_issuance_withdrawal"."withdrawal_version" = 'offer-issuance-withdrawal.v1'
      and "offer_issuance_withdrawal"."withdrawal_command_version" = 'offer-issuance-withdrawal-command.v1'
      and jsonb_typeof("offer_issuance_withdrawal"."withdrawal_command") = 'object'
      and ("offer_issuance_withdrawal"."withdrawal_command" - array[
        'schemaVersion', 'issuanceId', 'reasonCode'
      ]::text[]) = '{}'::jsonb
      and "offer_issuance_withdrawal"."withdrawal_command"->>'schemaVersion' =
        "offer_issuance_withdrawal"."withdrawal_command_version"
      and "offer_issuance_withdrawal"."withdrawal_command"->>'issuanceId' = "offer_issuance_withdrawal"."issuance_id"::text
      and "offer_issuance_withdrawal"."withdrawal_command"->>'reasonCode' = "offer_issuance_withdrawal"."reason_code")
);
--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_candidate_fk" FOREIGN KEY ("workspace_id","candidate_id") REFERENCES "public"."offer_release_candidate"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_candidate_approval_fk" FOREIGN KEY ("workspace_id","candidate_approval_id") REFERENCES "public"."offer_release_candidate_approval"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_variant_revision_fk" FOREIGN KEY ("workspace_id","variant_revision_id","offer_id","variant_id","project_id","variant_revision","variant_snapshot_sha256") REFERENCES "public"."offer_variant_revision"("workspace_id","id","offer_id","variant_id","project_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_profile_activation_fk" FOREIGN KEY ("workspace_id","profile_activation_id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256") REFERENCES "public"."offer_release_profile_activation"("workspace_id","id","profile_id","profile_revision_id","profile_revision","profile_snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_recipient_revision_fk" FOREIGN KEY ("workspace_id","recipient_revision_id","recipient_id","offer_id","recipient_revision","recipient_snapshot_sha256") REFERENCES "public"."offer_recipient_revision"("workspace_id","id","recipient_id","offer_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_candidate_approved_by_fk" FOREIGN KEY ("workspace_id","candidate_approved_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance" ADD CONSTRAINT "offer_issuance_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_approval" ADD CONSTRAINT "offer_issuance_approval_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_approval" ADD CONSTRAINT "offer_issuance_approval_issuance_fk" FOREIGN KEY ("workspace_id","issuance_id","project_id","offer_id","candidate_id","candidate_approval_id","candidate_approved_by","artifact_intent","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version") REFERENCES "public"."offer_issuance"("workspace_id","id","project_id","offer_id","candidate_id","candidate_approval_id","candidate_approved_by","artifact_intent","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256","has_zero_tax_treatment","artifact_mime_type","artifact_sha256","artifact_size_bytes","artifact_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_approval" ADD CONSTRAINT "offer_issuance_approval_approved_by_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_withdrawal" ADD CONSTRAINT "offer_issuance_withdrawal_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_withdrawal" ADD CONSTRAINT "offer_issuance_withdrawal_issuance_fk" FOREIGN KEY ("workspace_id","issuance_id","project_id","offer_id","candidate_id","candidate_approval_id","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256") REFERENCES "public"."offer_issuance"("workspace_id","id","project_id","offer_id","candidate_id","candidate_approval_id","input_version","canonicalization_version","template_version","renderer_recipe_version","input_sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_issuance_withdrawal" ADD CONSTRAINT "offer_issuance_withdrawal_withdrawn_by_fk" FOREIGN KEY ("workspace_id","withdrawn_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_issuance_ws_offer_idx" ON "offer_issuance" USING btree ("workspace_id","offer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "offer_issuance_due_idx" ON "offer_issuance" USING btree ("workspace_id","state","next_attempt_at","created_at","id");--> statement-breakpoint
CREATE INDEX "offer_issuance_approval_ws_offer_idx" ON "offer_issuance_approval" USING btree ("workspace_id","offer_id","approved_at","id");--> statement-breakpoint
CREATE INDEX "offer_issuance_withdrawal_ws_offer_idx" ON "offer_issuance_withdrawal" USING btree ("workspace_id","offer_id","withdrawn_at","id");
--> statement-breakpoint

-- M2-03b1: finale Ausstellungsbytes vor dem getrennten Archivgate. Diese
-- Migration enthaelt absichtlich keinen Ausstellungs-, Versand- oder
-- Storagepfad. Der hoechste abgeleitete Zustand bleibt 2/2 freigegeben.
ALTER TABLE public.offer_issuance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_issuance FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_issuance
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

ALTER TABLE public.offer_issuance_approval ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_issuance_approval FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_issuance_approval
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

ALTER TABLE public.offer_issuance_withdrawal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_issuance_withdrawal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_issuance_withdrawal
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

REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  public.offer_issuance,
  public.offer_issuance_approval,
  public.offer_issuance_withdrawal
FROM PUBLIC;--> statement-breakpoint

DO $m203b1_table_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE '
        'public.offer_issuance, public.offer_issuance_approval, '
        'public.offer_issuance_withdrawal FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
END
$m203b1_table_acl$;--> statement-breakpoint

CREATE FUNCTION public._m203b1_erasure_delete_allowed(
  row_workspace_id uuid,
  row_id uuid,
  graph_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $m203b1_erasure_allowed$
DECLARE
  erasure_operation uuid;
BEGIN
  IF graph_key NOT IN (
       'offerIssuanceIds', 'offerIssuanceApprovalIds',
       'offerIssuanceWithdrawalIds'
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
$m203b1_erasure_allowed$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_erasure_delete_allowed(uuid, uuid, text)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_guard_offer_issuance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203b1_issuance_guard$
DECLARE
  candidate_record record;
  candidate_approval_record record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m203b1_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, 'offerIssuanceIds'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'offer_issuance DELETE ist nur im Erasurevertrag erlaubt';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Auch direkte Owner-Inserts muessen dieselbe globale Lockordnung wie
    -- prepare_offer_issuance einhalten und die Current-Checks darunter binden.
    PERFORM 1
      FROM public.workspace AS workspace_record
     WHERE workspace_record.id = NEW.workspace_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_issuance: Workspace-Bindung fehlt';
    END IF;
    PERFORM 1
      FROM public.offer_release_profile AS profile
     WHERE profile.workspace_id = NEW.workspace_id
       AND profile.id = NEW.profile_id
     FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
         SELECT 1 FROM public.offer_release_profile AS profile
          WHERE profile.workspace_id = NEW.workspace_id
            AND profile.id = NEW.profile_id
            AND profile.current_revision = NEW.profile_revision
            AND profile.active_activation_id = NEW.profile_activation_id
       ) THEN
      RAISE EXCEPTION 'offer_issuance: aktueller Profilkopf driftete';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_issuance: Project-Bindung fehlt';
    END IF;
    PERFORM 1
      FROM public.offer AS offer_record
     WHERE offer_record.workspace_id = NEW.workspace_id
       AND offer_record.id = NEW.offer_id
       AND offer_record.project_id = NEW.project_id
       AND offer_record.status = 'draft'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_issuance: Offer-Bindung driftete';
    END IF;
    PERFORM 1
      FROM public.offer_recipient AS recipient
     WHERE recipient.workspace_id = NEW.workspace_id
       AND recipient.id = NEW.recipient_id
       AND recipient.offer_id = NEW.offer_id
     FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
         SELECT 1 FROM public.offer_recipient AS recipient
          WHERE recipient.workspace_id = NEW.workspace_id
            AND recipient.id = NEW.recipient_id
            AND recipient.current_revision = NEW.recipient_revision
       ) THEN
      RAISE EXCEPTION 'offer_issuance: aktueller Empfaengerkopf driftete';
    END IF;
    PERFORM 1
      FROM public.offer_variant AS variant
     WHERE variant.workspace_id = NEW.workspace_id
       AND variant.id = NEW.variant_id
       AND variant.offer_id = NEW.offer_id
     FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
         SELECT 1 FROM public.offer_variant AS variant
          WHERE variant.workspace_id = NEW.workspace_id
            AND variant.id = NEW.variant_id
            AND variant.current_revision = NEW.variant_revision
       ) THEN
      RAISE EXCEPTION 'offer_issuance: aktueller Variantenkopf driftete';
    END IF;

    SELECT candidate.* INTO candidate_record
      FROM public.offer_release_candidate AS candidate
     WHERE candidate.workspace_id = NEW.workspace_id
       AND candidate.id = NEW.candidate_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_issuance: Candidate-Bindung fehlt';
    END IF;
    SELECT approval.* INTO candidate_approval_record
      FROM public.offer_release_candidate_approval AS approval
     WHERE approval.workspace_id = NEW.workspace_id
       AND approval.id = NEW.candidate_approval_id
       AND approval.candidate_id = NEW.candidate_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_issuance: Candidate ist nicht freigegeben';
    END IF;

    IF candidate_record.state <> 'ready_for_approval'
       OR candidate_record.publication_status <> 'not_issued'
       OR candidate_record.project_id IS DISTINCT FROM NEW.project_id
       OR candidate_record.offer_id IS DISTINCT FROM NEW.offer_id
       OR candidate_record.offer_number IS DISTINCT FROM NEW.offer_number
       OR candidate_record.variant_id IS DISTINCT FROM NEW.variant_id
       OR candidate_record.variant_revision_id IS DISTINCT FROM NEW.variant_revision_id
       OR candidate_record.variant_revision IS DISTINCT FROM NEW.variant_revision
       OR candidate_record.variant_snapshot_sha256 IS DISTINCT FROM NEW.variant_snapshot_sha256
       OR candidate_record.profile_activation_id IS DISTINCT FROM NEW.profile_activation_id
       OR candidate_record.profile_id IS DISTINCT FROM NEW.profile_id
       OR candidate_record.profile_revision_id IS DISTINCT FROM NEW.profile_revision_id
       OR candidate_record.profile_revision IS DISTINCT FROM NEW.profile_revision
       OR candidate_record.profile_snapshot_sha256 IS DISTINCT FROM NEW.profile_snapshot_sha256
       OR candidate_record.recipient_id IS DISTINCT FROM NEW.recipient_id
       OR candidate_record.recipient_revision_id IS DISTINCT FROM NEW.recipient_revision_id
       OR candidate_record.recipient_revision IS DISTINCT FROM NEW.recipient_revision
       OR candidate_record.recipient_snapshot_sha256 IS DISTINCT FROM NEW.recipient_snapshot_sha256
       OR candidate_record.input_version IS DISTINCT FROM NEW.candidate_input_version
       OR candidate_record.canonicalization_version IS DISTINCT FROM NEW.candidate_canonicalization_version
       OR candidate_record.template_version IS DISTINCT FROM NEW.candidate_template_version
       OR candidate_record.renderer_recipe_version IS DISTINCT FROM NEW.candidate_renderer_recipe_version
       OR candidate_record.input_sha256 IS DISTINCT FROM NEW.candidate_input_sha256
       OR candidate_record.artifact_mime_type IS DISTINCT FROM NEW.candidate_artifact_mime_type
       OR candidate_record.artifact_sha256 IS DISTINCT FROM NEW.candidate_artifact_sha256
       OR candidate_record.artifact_size_bytes IS DISTINCT FROM NEW.candidate_artifact_size_bytes
       OR candidate_record.artifact_version IS DISTINCT FROM NEW.candidate_artifact_version
       OR candidate_record.artifact_sha256 IS DISTINCT FROM pg_catalog.sha256(candidate_record.artifact_bytes)
       OR candidate_record.artifact_size_bytes IS DISTINCT FROM pg_catalog.octet_length(candidate_record.artifact_bytes)
       OR candidate_record.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
            pg_catalog.convert_to(
              public.canonicalize_offer_json_v1(candidate_record.input_snapshot),
              'UTF8'
            )
          )
       OR NEW.input_snapshot->'document' IS DISTINCT FROM
            candidate_record.input_snapshot - ARRAY[
              'schemaVersion', 'canonicalizationVersion', 'templateVersion',
              'rendererRecipeVersion', 'documentStatus'
            ]::text[] THEN
      RAISE EXCEPTION 'offer_issuance: Candidate-Quelle oder Bytes driftet';
    END IF;

    IF candidate_approval_record.approved_by IS DISTINCT FROM NEW.candidate_approved_by
       OR candidate_approval_record.approved_at IS DISTINCT FROM NEW.candidate_approved_at
       OR candidate_approval_record.approval_version IS DISTINCT FROM NEW.candidate_approval_version
       OR candidate_approval_record.approval_command_version IS DISTINCT FROM NEW.candidate_approval_command_version
       OR candidate_approval_record.input_sha256 IS DISTINCT FROM NEW.candidate_input_sha256
       OR candidate_approval_record.artifact_sha256 IS DISTINCT FROM NEW.candidate_artifact_sha256
       OR candidate_approval_record.artifact_size_bytes IS DISTINCT FROM NEW.candidate_artifact_size_bytes
       OR candidate_approval_record.artifact_version IS DISTINCT FROM NEW.candidate_artifact_version THEN
      RAISE EXCEPTION 'offer_issuance: Candidate-Approval driftet';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'offer_issuance ist append-only; % ist verboten', TG_OP;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = OLD.workspace_id
          AND withdrawal.issuance_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'offer_issuance: zurueckgezogener Stand ist terminal';
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
    RAISE EXCEPTION 'offer_issuance: versiegelte Bindung ist immutable';
  END IF;
  IF OLD.state IN ('ready_for_approval', 'failed_final') THEN
    RAISE EXCEPTION 'offer_issuance: terminaler Renderzustand ist immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'offer_issuance: monotone Queuewerte verletzt';
  END IF;
  IF OLD.started_at IS NOT NULL
     AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'offer_issuance.started_at ist immutable';
  END IF;

  IF NEW.state = 'running' THEN
    IF OLD.state NOT IN ('queued', 'retry_wait', 'running')
       OR NEW.attempt_count <> OLD.attempt_count + 1
       OR (OLD.state = 'running'
           AND OLD.lease_expires_at > pg_catalog.statement_timestamp()) THEN
      RAISE EXCEPTION 'offer_issuance: ungueltiger Claim-Uebergang';
    END IF;
  ELSIF NEW.state IN ('retry_wait', 'ready_for_approval', 'failed_final') THEN
    IF OLD.state <> 'running'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_issuance: ungueltiger Abschluss-Uebergang';
    END IF;
  ELSIF NEW.state = 'queued' THEN
    IF OLD.state <> 'retry_wait'
       OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'offer_issuance: ungueltiger Requeue-Uebergang';
    END IF;
  ELSE
    RAISE EXCEPTION 'offer_issuance: ungueltiger Zustandsuebergang';
  END IF;

  IF NEW.state = 'ready_for_approval' THEN
    IF OLD.artifact_bytes IS NOT NULL OR NEW.artifact_bytes IS NULL
       OR OLD.artifact_version IS NOT NULL OR NEW.artifact_version IS NULL THEN
      RAISE EXCEPTION 'offer_issuance: Artefakt darf nur einmal gesetzt werden';
    END IF;
  ELSIF NEW.artifact_mime_type IS DISTINCT FROM OLD.artifact_mime_type
     OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
     OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
     OR NEW.artifact_bytes IS DISTINCT FROM OLD.artifact_bytes
     OR NEW.artifact_version IS DISTINCT FROM OLD.artifact_version THEN
    RAISE EXCEPTION 'offer_issuance: Artefaktmutation ausserhalb Erfolg verboten';
  END IF;
  RETURN NEW;
END
$m203b1_issuance_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_guard_offer_issuance() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_guard_offer_issuance_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203b1_approval_guard$
DECLARE
  issuance_record record;
  actor_role text;
  actor_capabilities jsonb;
  approval_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m203b1_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, 'offerIssuanceApprovalIds'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'offer_issuance_approval ist append-only; DELETE ist verboten';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'offer_issuance_approval ist append-only; % ist verboten', TG_OP;
  END IF;

  PERFORM 1
    FROM public.workspace AS workspace_record
   WHERE workspace_record.id = NEW.workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_issuance_approval: Workspace fehlt';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.issuance_id::text, 1701734775)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = NEW.workspace_id
     AND issuance.id = NEW.issuance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_issuance_approval: Ausstellungsfassung fehlt';
  END IF;
  PERFORM 1
    FROM public.offer_release_profile AS profile
   WHERE profile.workspace_id = NEW.workspace_id
     AND profile.id = issuance_record.profile_id
   FOR UPDATE;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = NEW.workspace_id
     AND project_record.id = issuance_record.project_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = NEW.workspace_id
     AND offer_record.id = issuance_record.offer_id
     AND offer_record.project_id = issuance_record.project_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = NEW.workspace_id
     AND recipient.id = issuance_record.recipient_id
     AND recipient.offer_id = issuance_record.offer_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_variant AS variant
   WHERE variant.workspace_id = NEW.workspace_id
     AND variant.id = issuance_record.variant_id
     AND variant.offer_id = issuance_record.offer_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = NEW.workspace_id
     AND candidate.id = issuance_record.candidate_id
   FOR SHARE;
  PERFORM 1
    FROM public.offer_release_candidate_approval AS candidate_approval
   WHERE candidate_approval.workspace_id = NEW.workspace_id
     AND candidate_approval.id = issuance_record.candidate_approval_id
     AND candidate_approval.candidate_id = issuance_record.candidate_id
   FOR SHARE;
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = NEW.workspace_id
     AND issuance.id = NEW.issuance_id
   FOR UPDATE;
  IF NOT FOUND OR issuance_record.state <> 'ready_for_approval' THEN
    RAISE EXCEPTION 'offer_issuance_approval: Ausstellungsbytes sind nicht bereit';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = NEW.workspace_id
          AND withdrawal.issuance_id = NEW.issuance_id
     ) THEN
    RAISE EXCEPTION 'offer_issuance_approval: zurueckgezogener Stand ist terminal';
  END IF;
  IF issuance_record.artifact_sha256 IS DISTINCT FROM
       pg_catalog.sha256(issuance_record.artifact_bytes)
     OR issuance_record.artifact_size_bytes IS DISTINCT FROM
       pg_catalog.octet_length(issuance_record.artifact_bytes) THEN
    RAISE EXCEPTION 'offer_issuance_approval: Artefaktintegritaet verletzt';
  END IF;
  IF NOT public._m203b1_offer_issuance_source_is_current(
       NEW.workspace_id, NEW.issuance_id
     ) THEN
    RAISE EXCEPTION 'offer_issuance_approval: aktuelle Quellkoepfe drifteten';
  END IF;

  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = NEW.workspace_id
     AND membership_record.user_id = NEW.approved_by;
  IF actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb)
     OR (actor_role <> 'admin'
         AND actor_capabilities->'approve_offer_documents' IS DISTINCT FROM 'true'::jsonb) THEN
    RAISE EXCEPTION 'offer_issuance_approval: Actor ist nicht autorisiert'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO approval_count
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = NEW.workspace_id
     AND approval.issuance_id = NEW.issuance_id;
  IF approval_count >= 2 THEN
    RAISE EXCEPTION 'offer_issuance_approval: approval_limit_reached';
  END IF;
  IF approval_count = 1
     AND NEW.approved_by = issuance_record.candidate_approved_by
     AND NOT EXISTS (
       SELECT 1
         FROM public.offer_issuance_approval AS approval
        WHERE approval.workspace_id = NEW.workspace_id
          AND approval.issuance_id = NEW.issuance_id
          AND approval.approved_by <> issuance_record.candidate_approved_by
     ) THEN
    RAISE EXCEPTION 'offer_issuance_approval: mindestens ein Actor muss vom Candidate-Approver abweichen';
  END IF;
  IF approval_count >= 2 THEN
    RAISE EXCEPTION 'offer_issuance_approval: maximal zwei Freigaben';
  END IF;
  RETURN NEW;
END
$m203b1_approval_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_guard_offer_issuance_approval()
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_guard_offer_issuance_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203b1_withdrawal_guard$
DECLARE
  issuance_record record;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m203b1_erasure_delete_allowed(
         OLD.workspace_id, OLD.id, 'offerIssuanceWithdrawalIds'
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'offer_issuance_withdrawal ist append-only; DELETE ist verboten';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'offer_issuance_withdrawal ist append-only; % ist verboten', TG_OP;
  END IF;
  PERFORM 1
    FROM public.workspace AS workspace_record
   WHERE workspace_record.id = NEW.workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_issuance_withdrawal: Workspace fehlt';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.issuance_id::text, 1701734775)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = NEW.workspace_id
     AND issuance.id = NEW.issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_issuance_withdrawal: Issuance fehlt';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = NEW.workspace_id
     AND membership_record.user_id = NEW.withdrawn_by;
  IF actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb)
     OR (actor_role <> 'admin'
         AND actor_capabilities->'approve_offer_documents' IS DISTINCT FROM 'true'::jsonb) THEN
    RAISE EXCEPTION 'offer_issuance_withdrawal: Actor ist nicht autorisiert'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$m203b1_withdrawal_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_guard_offer_issuance_append_only()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER offer_issuance_mutation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.offer_issuance
  FOR EACH ROW EXECUTE FUNCTION public._m203b1_guard_offer_issuance();--> statement-breakpoint
CREATE TRIGGER offer_issuance_no_truncate
  BEFORE TRUNCATE ON public.offer_issuance
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_issuance_approval_mutation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.offer_issuance_approval
  FOR EACH ROW EXECUTE FUNCTION public._m203b1_guard_offer_issuance_approval();--> statement-breakpoint
CREATE TRIGGER offer_issuance_approval_no_truncate
  BEFORE TRUNCATE ON public.offer_issuance_approval
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_issuance_withdrawal_mutation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.offer_issuance_withdrawal
  FOR EACH ROW EXECUTE FUNCTION public._m203b1_guard_offer_issuance_append_only();--> statement-breakpoint
CREATE TRIGGER offer_issuance_withdrawal_no_truncate
  BEFORE TRUNCATE ON public.offer_issuance_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION public._m203b1_offer_issuance_instant(value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $m203b1_instant$
  SELECT pg_catalog.to_char(
    value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$m203b1_instant$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_offer_issuance_instant(timestamptz)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_authorize_offer_issuance(
  requested_workspace_id uuid,
  required_capability text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_authorize$
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
    RAISE EXCEPTION 'offer issuance context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL
     OR required_capability NOT IN (
       'prepare_offer_documents', 'approve_offer_documents'
     ) THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.workspace AS workspace_record
   WHERE workspace_record.id = requested_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb)
     OR (actor_role <> 'admin'
         AND actor_capabilities->required_capability IS DISTINCT FROM 'true'::jsonb) THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_id;
END
$m203b1_authorize$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_authorize_offer_issuance(uuid, text)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_prepared_issuance_result(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  replayed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_prepared_result$
DECLARE
  issuance_record record;
  approval_count integer;
  has_withdrawal boolean;
  derived_state text;
BEGIN
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT pg_catalog.count(*)::integer INTO approval_count
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.issuance_id = requested_issuance_id;
  SELECT EXISTS (
    SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
     WHERE withdrawal.workspace_id = requested_workspace_id
       AND withdrawal.issuance_id = requested_issuance_id
  ) INTO has_withdrawal;
  derived_state := CASE
    WHEN has_withdrawal THEN 'withdrawn_before_archive'
    WHEN approval_count = 2 THEN 'approved_for_archive_not_issued'
    WHEN approval_count = 1 THEN 'approval_pending'
    ELSE issuance_record.state
  END;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'prepared',
    'workspaceId', issuance_record.workspace_id,
    'issuanceId', issuance_record.id,
    'projectId', issuance_record.project_id,
    'offerId', issuance_record.offer_id,
    'candidateId', issuance_record.candidate_id,
    'state', issuance_record.state,
    'approvalCount', approval_count,
    'derivedState', derived_state,
    'attemptCount', issuance_record.attempt_count,
    'nextAttemptAt', issuance_record.next_attempt_at,
    'createdAt', issuance_record.created_at,
    'replayed', replayed
  );
END
$m203b1_prepared_result$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_prepared_issuance_result(
  uuid, uuid, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.prepare_offer_issuance(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_candidate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_prepare$
DECLARE
  actor_id uuid;
  offer_record record;
  profile_head record;
  recipient_head record;
  variant_head record;
  candidate_record record;
  candidate_approval_record record;
  existing_issuance record;
  prepared_time timestamptz;
  prepared_time_text text;
  issuance_id uuid;
  issuance_document jsonb;
  issuance_input jsonb;
  issuance_input_sha256 bytea;
  reservation_material jsonb;
  reservation_digest bytea;
BEGIN
  actor_id := public._m203b1_authorize_offer_issuance(
    requested_workspace_id, 'prepare_offer_documents'
  );
  IF requested_offer_id IS NULL OR requested_candidate_id IS NULL THEN
    RAISE EXCEPTION 'ungueltiger Ausstellungsbefehl' USING ERRCODE = '22023';
  END IF;

  -- Der erste Read ist absichtlich lock-frei: immutable Candidate-/Approval-
  -- Bindungen reichen aus, um einen exakten bestehenden Replay zu erkennen.
  -- Mutable Heads werden nur fuer eine wirkliche Neuanlage gesperrt.
  SELECT candidate.* INTO candidate_record
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id = requested_candidate_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT approval.* INTO candidate_approval_record
    FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.candidate_id = requested_candidate_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_not_approved'
    );
  END IF;

  IF candidate_record.offer_id IS DISTINCT FROM requested_offer_id
     OR candidate_record.state <> 'ready_for_approval'
     OR candidate_record.publication_status <> 'not_issued'
     OR candidate_approval_record.id IS NULL
     OR candidate_approval_record.candidate_id IS DISTINCT FROM candidate_record.id
     OR candidate_approval_record.project_id IS DISTINCT FROM candidate_record.project_id
     OR candidate_approval_record.offer_id IS DISTINCT FROM candidate_record.offer_id
     OR candidate_approval_record.input_sha256 IS DISTINCT FROM candidate_record.input_sha256
     OR candidate_approval_record.publication_status <> 'not_issued' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  IF candidate_record.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
       pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(candidate_record.input_snapshot),
         'UTF8'
       )
     )
     OR candidate_record.artifact_sha256 IS DISTINCT FROM
       pg_catalog.sha256(candidate_record.artifact_bytes)
     OR candidate_record.artifact_size_bytes IS DISTINCT FROM
       pg_catalog.octet_length(candidate_record.artifact_bytes)
     OR candidate_approval_record.artifact_sha256 IS DISTINCT FROM
       candidate_record.artifact_sha256
     OR candidate_approval_record.artifact_size_bytes IS DISTINCT FROM
       candidate_record.artifact_size_bytes
     OR candidate_approval_record.artifact_version IS DISTINCT FROM
       candidate_record.artifact_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_artifact_integrity_changed'
    );
  END IF;

  -- Die exakte, versiegelte Reservation ist vor zeitabhaengiger Gueltigkeit
  -- und vor aktuellen Quellkoepfen autoritativ. So bleibt ein identischer
  -- Retry auch nach Ablauf/Revision ein Replay; eine andere Candidate-Bindung
  -- erreicht diese Reservation nicht.
  reservation_material := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-issuance-reservation.v1',
    'workspaceId', requested_workspace_id::text,
    'projectId', candidate_record.project_id::text,
    'offerId', requested_offer_id::text,
    'candidateId', candidate_record.id::text,
    'candidateApprovalId', candidate_approval_record.id::text,
    'candidateApprovedAt', public._m203b1_offer_issuance_instant(
      candidate_approval_record.approved_at
    ),
    'candidateInputSha256', pg_catalog.encode(candidate_record.input_sha256, 'hex'),
    'candidateArtifactVersion', candidate_record.artifact_version::text,
    'candidateArtifactSha256', pg_catalog.encode(candidate_record.artifact_sha256, 'hex'),
    'variantRevisionId', candidate_record.variant_revision_id::text,
    'variantSnapshotSha256', pg_catalog.encode(candidate_record.variant_snapshot_sha256, 'hex'),
    'profileActivationId', candidate_record.profile_activation_id::text,
    'profileRevisionId', candidate_record.profile_revision_id::text,
    'profileSnapshotSha256', pg_catalog.encode(candidate_record.profile_snapshot_sha256, 'hex'),
    'recipientRevisionId', candidate_record.recipient_revision_id::text,
    'recipientSnapshotSha256', pg_catalog.encode(candidate_record.recipient_snapshot_sha256, 'hex'),
    'inputVersion', 'offer-issuance-input.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'templateVersion', 'offer-issuance-template.v1',
    'rendererRecipeVersion',
      'offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
  );
  reservation_digest := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(reservation_material), 'UTF8'
  ));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    requested_workspace_id::text || ':' || pg_catalog.encode(reservation_digest, 'hex'),
    1701734774
  ));
  SELECT issuance.* INTO existing_issuance
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.reservation_key = reservation_digest
   FOR UPDATE;
  IF FOUND THEN
    IF existing_issuance.offer_id IS DISTINCT FROM requested_offer_id
       OR existing_issuance.candidate_id IS DISTINCT FROM requested_candidate_id
       OR existing_issuance.candidate_approval_id IS DISTINCT FROM
            candidate_approval_record.id THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'candidate_source_changed'
      );
    END IF;
    RETURN public._m203b1_prepared_issuance_result(
      requested_workspace_id, existing_issuance.id, true
    );
  END IF;

  -- Globale Lockordnung wie M2-03a: Workspace (Authorizer) -> Profile ->
  -- Project -> Offer -> Recipient -> Variant -> Candidate/Approval.
  SELECT profile.* INTO profile_head
    FROM public.offer_release_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id = candidate_record.profile_id
   FOR UPDATE;
  IF NOT FOUND
     OR profile_head.current_revision IS DISTINCT FROM candidate_record.profile_revision
     OR profile_head.active_activation_id IS DISTINCT FROM
          candidate_record.profile_activation_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = candidate_record.project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT candidate_offer.* INTO offer_record
    FROM public.offer AS candidate_offer
   WHERE candidate_offer.workspace_id = requested_workspace_id
     AND candidate_offer.id = requested_offer_id
     AND candidate_offer.project_id = candidate_record.project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF offer_record.status <> 'draft' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  SELECT recipient.* INTO recipient_head
    FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.id = candidate_record.recipient_id
     AND recipient.offer_id = requested_offer_id
   FOR UPDATE;
  IF NOT FOUND
     OR recipient_head.current_revision IS DISTINCT FROM
          candidate_record.recipient_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  SELECT variant.* INTO variant_head
    FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.id = candidate_record.variant_id
     AND variant.offer_id = requested_offer_id
   FOR UPDATE;
  IF NOT FOUND
     OR variant_head.current_revision IS DISTINCT FROM
          candidate_record.variant_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_source_changed'
    );
  END IF;
  SELECT candidate.* INTO candidate_record
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id = requested_candidate_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT approval.* INTO candidate_approval_record
    FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.candidate_id = requested_candidate_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_not_approved'
    );
  END IF;

  IF candidate_record.valid_through <
       (pg_catalog.clock_timestamp() AT TIME ZONE 'Europe/Berlin')::date THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'candidate_expired'
    );
  END IF;
  prepared_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  IF prepared_time < candidate_approval_record.approved_at THEN
    prepared_time := pg_catalog.date_trunc(
      'milliseconds', candidate_approval_record.approved_at
    );
  END IF;
  prepared_time_text := public._m203b1_offer_issuance_instant(prepared_time);
  issuance_id := pg_catalog.gen_random_uuid();
  issuance_document := candidate_record.input_snapshot - ARRAY[
    'schemaVersion', 'canonicalizationVersion', 'templateVersion',
    'rendererRecipeVersion', 'documentStatus'
  ]::text[];
  issuance_input := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-issuance-input.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'templateVersion', 'offer-issuance-template.v1',
    'rendererRecipeVersion',
      'offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    'artifactIntent', 'offer_issuance_final',
    'issuanceId', issuance_id::text,
    'preparedAt', prepared_time_text,
    'source', pg_catalog.jsonb_build_object(
      'workspaceId', requested_workspace_id::text,
      'projectId', candidate_record.project_id::text,
      'offerId', requested_offer_id::text,
      'candidateId', candidate_record.id::text,
      'candidateApprovalId', candidate_approval_record.id::text,
      'candidateApprovedAt', public._m203b1_offer_issuance_instant(
        candidate_approval_record.approved_at
      ),
      'candidateArtifactVersion', candidate_record.artifact_version::text,
      'candidateArtifactMimeType', candidate_record.artifact_mime_type,
      'candidateArtifactSha256', pg_catalog.encode(candidate_record.artifact_sha256, 'hex'),
      'candidateArtifactSizeBytes', candidate_record.artifact_size_bytes,
      'candidateInputVersion', candidate_record.input_version,
      'candidateCanonicalizationVersion', candidate_record.canonicalization_version,
      'candidateTemplateVersion', candidate_record.template_version,
      'candidateRendererRecipeVersion', candidate_record.renderer_recipe_version,
      'candidateInputSha256', pg_catalog.encode(candidate_record.input_sha256, 'hex'),
      'candidateApprovalVersion', candidate_approval_record.approval_version,
      'candidateApprovalCommandVersion', candidate_approval_record.approval_command_version,
      'variant', pg_catalog.jsonb_build_object(
        'id', candidate_record.variant_id::text,
        'revisionId', candidate_record.variant_revision_id::text,
        'revision', candidate_record.variant_revision,
        'snapshotSha256', pg_catalog.encode(candidate_record.variant_snapshot_sha256, 'hex')
      ),
      'profile', pg_catalog.jsonb_build_object(
        'activationId', candidate_record.profile_activation_id::text,
        'id', candidate_record.profile_id::text,
        'revisionId', candidate_record.profile_revision_id::text,
        'revision', candidate_record.profile_revision,
        'snapshotSha256', pg_catalog.encode(candidate_record.profile_snapshot_sha256, 'hex')
      ),
      'recipient', pg_catalog.jsonb_build_object(
        'id', candidate_record.recipient_id::text,
        'revisionId', candidate_record.recipient_revision_id::text,
        'revision', candidate_record.recipient_revision,
        'snapshotSha256', pg_catalog.encode(candidate_record.recipient_snapshot_sha256, 'hex')
      )
    ),
    'document', issuance_document
  );
  issuance_input_sha256 := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(issuance_input), 'UTF8'
  ));

  INSERT INTO public.offer_issuance (
    id, workspace_id, project_id, offer_id, offer_number,
    candidate_id, candidate_approval_id, candidate_approved_by,
    candidate_approved_at, candidate_input_version,
    candidate_canonicalization_version, candidate_template_version,
    candidate_renderer_recipe_version, candidate_input_sha256,
    candidate_approval_version, candidate_approval_command_version,
    candidate_artifact_mime_type, candidate_artifact_sha256,
    candidate_artifact_size_bytes, candidate_artifact_version,
    variant_id, variant_revision_id, variant_revision,
    variant_snapshot_sha256, profile_activation_id, profile_id,
    profile_revision_id, profile_revision, profile_snapshot_sha256,
    recipient_id, recipient_revision_id, recipient_revision,
    recipient_snapshot_sha256, prepared_at, document_date, valid_through,
    artifact_intent, input_version, canonicalization_version,
    template_version, renderer_recipe_version, reservation_key,
    input_snapshot, input_sha256, has_zero_tax_treatment,
    state, attempt_count, next_attempt_at, created_by, created_at, updated_at
  ) VALUES (
    issuance_id, requested_workspace_id, candidate_record.project_id,
    requested_offer_id, candidate_record.offer_number,
    candidate_record.id, candidate_approval_record.id,
    candidate_approval_record.approved_by, candidate_approval_record.approved_at,
    candidate_record.input_version, candidate_record.canonicalization_version,
    candidate_record.template_version, candidate_record.renderer_recipe_version,
    candidate_record.input_sha256, candidate_approval_record.approval_version,
    candidate_approval_record.approval_command_version,
    candidate_record.artifact_mime_type, candidate_record.artifact_sha256,
    candidate_record.artifact_size_bytes, candidate_record.artifact_version,
    candidate_record.variant_id, candidate_record.variant_revision_id,
    candidate_record.variant_revision, candidate_record.variant_snapshot_sha256,
    candidate_record.profile_activation_id, candidate_record.profile_id,
    candidate_record.profile_revision_id, candidate_record.profile_revision,
    candidate_record.profile_snapshot_sha256, candidate_record.recipient_id,
    candidate_record.recipient_revision_id, candidate_record.recipient_revision,
    candidate_record.recipient_snapshot_sha256, prepared_time,
    candidate_record.document_date, candidate_record.valid_through,
    'offer_issuance_final', 'offer-issuance-input.v1', 'offer-jcs.v1',
    'offer-issuance-template.v1',
    'offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    reservation_digest, issuance_input, issuance_input_sha256,
    candidate_record.has_zero_tax_treatment, 'queued', 0, prepared_time,
    actor_id, prepared_time, prepared_time
  );
  RETURN public._m203b1_prepared_issuance_result(
    requested_workspace_id, issuance_id, false
  );
END
$m203b1_prepare$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prepare_offer_issuance(uuid, uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public._m203b1_offer_issuance_source_is_current(
  requested_workspace_id uuid,
  requested_issuance_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_source_current$
  SELECT EXISTS (
    SELECT 1
      FROM public.offer_issuance AS issuance
      JOIN public.offer AS offer_record
        ON offer_record.workspace_id = issuance.workspace_id
       AND offer_record.id = issuance.offer_id
       AND offer_record.project_id = issuance.project_id
       AND offer_record.status = 'draft'
      JOIN public.offer_release_candidate AS candidate
        ON candidate.workspace_id = issuance.workspace_id
       AND candidate.id = issuance.candidate_id
       AND candidate.project_id = issuance.project_id
       AND candidate.offer_id = issuance.offer_id
       AND candidate.state = 'ready_for_approval'
       AND candidate.publication_status = 'not_issued'
       AND candidate.input_sha256 = issuance.candidate_input_sha256
       AND candidate.artifact_sha256 = issuance.candidate_artifact_sha256
       AND candidate.artifact_size_bytes = issuance.candidate_artifact_size_bytes
       AND candidate.artifact_version = issuance.candidate_artifact_version
      JOIN public.offer_release_candidate_approval AS candidate_approval
        ON candidate_approval.workspace_id = issuance.workspace_id
       AND candidate_approval.id = issuance.candidate_approval_id
       AND candidate_approval.candidate_id = issuance.candidate_id
       AND candidate_approval.approved_by = issuance.candidate_approved_by
       AND candidate_approval.approved_at = issuance.candidate_approved_at
       AND candidate_approval.input_sha256 = issuance.candidate_input_sha256
       AND candidate_approval.artifact_sha256 = issuance.candidate_artifact_sha256
       AND candidate_approval.artifact_size_bytes = issuance.candidate_artifact_size_bytes
       AND candidate_approval.artifact_version = issuance.candidate_artifact_version
      JOIN public.offer_variant AS variant
        ON variant.workspace_id = issuance.workspace_id
       AND variant.id = issuance.variant_id
       AND variant.offer_id = issuance.offer_id
       AND variant.current_revision = issuance.variant_revision
      JOIN public.offer_recipient AS recipient
        ON recipient.workspace_id = issuance.workspace_id
       AND recipient.id = issuance.recipient_id
       AND recipient.offer_id = issuance.offer_id
       AND recipient.current_revision = issuance.recipient_revision
      JOIN public.offer_release_profile AS profile
        ON profile.workspace_id = issuance.workspace_id
       AND profile.id = issuance.profile_id
       AND profile.current_revision = issuance.profile_revision
       AND profile.active_activation_id = issuance.profile_activation_id
     WHERE issuance.workspace_id = requested_workspace_id
       AND issuance.id = requested_issuance_id
       AND candidate.valid_through >=
         (pg_catalog.statement_timestamp() AT TIME ZONE 'Europe/Berlin')::date
       AND candidate.input_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(candidate.input_snapshot), 'UTF8'
       ))
       AND candidate.artifact_sha256 = pg_catalog.sha256(candidate.artifact_bytes)
       AND candidate.artifact_size_bytes = pg_catalog.octet_length(candidate.artifact_bytes)
       AND issuance.input_snapshot->'document' = candidate.input_snapshot - ARRAY[
         'schemaVersion', 'canonicalizationVersion', 'templateVersion',
         'rendererRecipeVersion', 'documentStatus'
       ]::text[]
  )
$m203b1_source_current$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_offer_issuance_source_is_current(
  uuid, uuid
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_approved_issuance_result(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  requested_approval_id uuid,
  replayed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_approved_result$
DECLARE
  approval_record record;
  approval_count integer;
BEGIN
  SELECT approval.* INTO approval_record
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.id = requested_approval_id
     AND approval.issuance_id = requested_issuance_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT pg_catalog.count(*)::integer INTO approval_count
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.issuance_id = requested_issuance_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'approved',
    'workspaceId', approval_record.workspace_id,
    'issuanceId', approval_record.issuance_id,
    'offerId', approval_record.offer_id,
    'approvalId', approval_record.id,
    'approvalCount', approval_count,
    'derivedState', CASE approval_count
      WHEN 1 THEN 'approval_pending'
      ELSE 'approved_for_archive_not_issued'
    END,
    'approvedBy', approval_record.approved_by,
    'approvedAt', approval_record.approved_at,
    'replayed', replayed
  );
END
$m203b1_approved_result$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_approved_issuance_result(
  uuid, uuid, uuid, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.approve_offer_issuance(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  recipient_and_scope_reviewed boolean,
  commercial_totals_reviewed boolean,
  legal_profile_reviewed boolean,
  final_pdf_for_archive_understood boolean,
  zero_tax_treatment_reviewed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_approve$
DECLARE
  actor_id uuid;
  issuance_record record;
  existing_approval record;
  approval_id uuid;
  approval_count integer;
  approval_time timestamptz;
  approval_command jsonb;
BEGIN
  actor_id := public._m203b1_authorize_offer_issuance(
    requested_workspace_id, 'approve_offer_documents'
  );
  IF requested_issuance_id IS NULL
     OR recipient_and_scope_reviewed IS DISTINCT FROM true
     OR commercial_totals_reviewed IS DISTINCT FROM true
     OR legal_profile_reviewed IS DISTINCT FROM true
     OR final_pdf_for_archive_understood IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ungueltiger Ausstellungsfreigabebefehl'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_issuance_id::text, 1701734775)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Erasure sperrt Source vor Issuance. Approval entdeckt deshalb nur die
  -- immutable Bindung, sperrt dieselbe Source-Reihenfolge und nimmt die
  -- Issuance erst danach final fuer alle nachfolgenden Checks.
  PERFORM 1
    FROM public.offer_release_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id = issuance_record.profile_id
   FOR UPDATE;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = issuance_record.project_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id = issuance_record.offer_id
     AND offer_record.project_id = issuance_record.project_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_recipient AS recipient
   WHERE recipient.workspace_id = requested_workspace_id
     AND recipient.id = issuance_record.recipient_id
     AND recipient.offer_id = issuance_record.offer_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.id = issuance_record.variant_id
     AND variant.offer_id = issuance_record.offer_id
   FOR UPDATE;
  PERFORM 1
    FROM public.offer_release_candidate AS candidate
   WHERE candidate.workspace_id = requested_workspace_id
     AND candidate.id = issuance_record.candidate_id
   FOR SHARE;
  PERFORM 1
    FROM public.offer_release_candidate_approval AS candidate_approval
   WHERE candidate_approval.workspace_id = requested_workspace_id
     AND candidate_approval.id = issuance_record.candidate_approval_id
     AND candidate_approval.candidate_id = issuance_record.candidate_id
   FOR SHARE;
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = requested_workspace_id
          AND withdrawal.issuance_id = requested_issuance_id
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'withdrawn_before_archive'
    );
  END IF;
  IF issuance_record.state <> 'ready_for_approval' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'issuance_not_ready'
    );
  END IF;
  IF issuance_record.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
       pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(issuance_record.input_snapshot),
         'UTF8'
       )
     )
     OR issuance_record.artifact_sha256 IS DISTINCT FROM
       pg_catalog.sha256(issuance_record.artifact_bytes)
     OR issuance_record.artifact_size_bytes IS DISTINCT FROM
       pg_catalog.octet_length(issuance_record.artifact_bytes) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'artifact_integrity_changed'
    );
  END IF;
  IF NOT public._m203b1_offer_issuance_source_is_current(
       requested_workspace_id, requested_issuance_id
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'issuance_source_changed'
    );
  END IF;
  IF issuance_record.has_zero_tax_treatment
     AND zero_tax_treatment_reviewed IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'zero_tax_review_required'
    );
  END IF;
  IF NOT issuance_record.has_zero_tax_treatment
     AND zero_tax_treatment_reviewed IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'zero_tax_review_forbidden'
    );
  END IF;

  SELECT approval.* INTO existing_approval
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.issuance_id = requested_issuance_id
     AND approval.approved_by = actor_id
   FOR SHARE;
  IF FOUND THEN
    IF existing_approval.recipient_and_scope_reviewed
       AND existing_approval.commercial_totals_reviewed
       AND existing_approval.legal_profile_reviewed
       AND existing_approval.final_pdf_for_archive_understood
       AND existing_approval.zero_tax_treatment_reviewed IS NOT DISTINCT FROM
         zero_tax_treatment_reviewed THEN
      RETURN public._m203b1_approved_issuance_result(
        requested_workspace_id, requested_issuance_id,
        existing_approval.id, true
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'approval_conflict'
    );
  END IF;
  SELECT pg_catalog.count(*)::integer INTO approval_count
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.issuance_id = requested_issuance_id;
  IF approval_count >= 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'approval_limit_reached'
    );
  END IF;

  approval_id := pg_catalog.gen_random_uuid();
  approval_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  approval_command := pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-issuance-approval-command.v1',
    'issuanceId', requested_issuance_id::text,
    'recipientAndScopeReviewed', true,
    'commercialTotalsReviewed', true,
    'legalProfileReviewed', true,
    'finalPdfForArchiveUnderstood', true
  );
  IF issuance_record.has_zero_tax_treatment THEN
    approval_command := approval_command || pg_catalog.jsonb_build_object(
      'zeroTaxTreatmentReviewed', true
    );
  END IF;
  BEGIN
    INSERT INTO public.offer_issuance_approval (
      id, workspace_id, issuance_id, project_id, offer_id, candidate_id,
      candidate_approval_id, candidate_approved_by, artifact_intent,
      input_version, canonicalization_version, template_version,
      renderer_recipe_version, input_sha256, has_zero_tax_treatment,
      artifact_mime_type, artifact_sha256, artifact_size_bytes,
      artifact_version, approval_version, approval_command_version,
      approval_command, recipient_and_scope_reviewed,
      commercial_totals_reviewed, legal_profile_reviewed,
      final_pdf_for_archive_understood, zero_tax_treatment_reviewed,
      approved_by, approved_at
    ) VALUES (
      approval_id, requested_workspace_id, requested_issuance_id,
      issuance_record.project_id, issuance_record.offer_id,
      issuance_record.candidate_id, issuance_record.candidate_approval_id,
      issuance_record.candidate_approved_by, issuance_record.artifact_intent,
      issuance_record.input_version, issuance_record.canonicalization_version,
      issuance_record.template_version, issuance_record.renderer_recipe_version,
      issuance_record.input_sha256, issuance_record.has_zero_tax_treatment,
      issuance_record.artifact_mime_type, issuance_record.artifact_sha256,
      issuance_record.artifact_size_bytes, issuance_record.artifact_version,
      'offer-issuance-approval.v1',
      'offer-issuance-approval-command.v1', approval_command,
      true, true, true, true, zero_tax_treatment_reviewed,
      actor_id, approval_time
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'approval_conflict'
    );
  END;
  RETURN public._m203b1_approved_issuance_result(
    requested_workspace_id, requested_issuance_id, approval_id, false
  );
END
$m203b1_approve$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.approve_offer_issuance(
  uuid, uuid, boolean, boolean, boolean, boolean, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.withdraw_offer_issuance(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  requested_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_withdraw$
DECLARE
  actor_id uuid;
  issuance_record record;
  existing_withdrawal record;
  has_existing_withdrawal boolean;
  withdrawal_id uuid;
  withdrawal_time timestamptz;
  approval_count integer;
BEGIN
  actor_id := public._m203b1_authorize_offer_issuance(
    requested_workspace_id, 'approve_offer_documents'
  );
  IF requested_issuance_id IS NULL
     OR requested_reason_code NOT IN (
       'content_error', 'recipient_error', 'legal_text_error',
       'commercial_error', 'other'
     ) THEN
    RAISE EXCEPTION 'ungueltiger Rueckzugsbefehl' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_issuance_id::text, 1701734775)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT withdrawal.* INTO existing_withdrawal
    FROM public.offer_issuance_withdrawal AS withdrawal
   WHERE withdrawal.workspace_id = requested_workspace_id
     AND withdrawal.issuance_id = requested_issuance_id
   FOR SHARE;
  has_existing_withdrawal := FOUND;
  SELECT pg_catalog.count(*)::integer INTO approval_count
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.issuance_id = requested_issuance_id;
  IF has_existing_withdrawal THEN
    IF existing_withdrawal.withdrawn_by = actor_id
       AND existing_withdrawal.reason_code = requested_reason_code THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'withdrawn',
        'workspaceId', existing_withdrawal.workspace_id,
        'issuanceId', existing_withdrawal.issuance_id,
        'offerId', existing_withdrawal.offer_id,
        'withdrawalId', existing_withdrawal.id,
        'reasonCode', existing_withdrawal.reason_code,
        'approvalCount', approval_count,
        'derivedState', 'withdrawn_before_archive',
        'withdrawnBy', existing_withdrawal.withdrawn_by,
        'withdrawnAt', existing_withdrawal.withdrawn_at,
        'replayed', true
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'withdrawal_conflict'
    );
  END IF;

  withdrawal_id := pg_catalog.gen_random_uuid();
  withdrawal_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  BEGIN
    INSERT INTO public.offer_issuance_withdrawal (
      id, workspace_id, issuance_id, project_id, offer_id, candidate_id,
      candidate_approval_id, input_version, canonicalization_version,
      template_version, renderer_recipe_version, input_sha256,
      withdrawal_version, withdrawal_command_version, withdrawal_command,
      reason_code, withdrawn_by, withdrawn_at
    ) VALUES (
      withdrawal_id, requested_workspace_id, requested_issuance_id,
      issuance_record.project_id, issuance_record.offer_id,
      issuance_record.candidate_id, issuance_record.candidate_approval_id,
      issuance_record.input_version, issuance_record.canonicalization_version,
      issuance_record.template_version, issuance_record.renderer_recipe_version,
      issuance_record.input_sha256, 'offer-issuance-withdrawal.v1',
      'offer-issuance-withdrawal-command.v1', pg_catalog.jsonb_build_object(
        'schemaVersion', 'offer-issuance-withdrawal-command.v1',
        'issuanceId', requested_issuance_id::text,
        'reasonCode', requested_reason_code
      ), requested_reason_code, actor_id, withdrawal_time
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'withdrawal_conflict'
    );
  END;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'withdrawn',
    'workspaceId', requested_workspace_id,
    'issuanceId', requested_issuance_id,
    'offerId', issuance_record.offer_id,
    'withdrawalId', withdrawal_id,
    'reasonCode', requested_reason_code,
    'approvalCount', approval_count,
    'derivedState', 'withdrawn_before_archive',
    'withdrawnBy', actor_id,
    'withdrawnAt', withdrawal_time,
    'replayed', false
  );
END
$m203b1_withdraw$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.withdraw_offer_issuance(uuid, uuid, text)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.read_offer_issuance_status(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_issuance_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  id uuid,
  offer_id uuid,
  candidate_id uuid,
  artifact_intent text,
  has_zero_tax_treatment boolean,
  state text,
  attempt_count integer,
  next_attempt_at timestamptz,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  approval_count integer,
  viewer_has_approved boolean,
  can_current_actor_approve boolean,
  derived_state text,
  withdrawal_id uuid,
  withdrawal_reason_code text,
  withdrawn_at timestamptz,
  approval_artifact_version uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_read_status$
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
    RAISE EXCEPTION 'offer issuance context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  can_approve := actor_role = 'admin' OR (
    actor_role = 'editor'
    AND actor_capabilities->'approve_offer_documents' IS NOT DISTINCT FROM 'true'::jsonb
  );

  RETURN QUERY
  SELECT issuance.workspace_id,
         issuance.id,
         issuance.offer_id,
         issuance.candidate_id,
         issuance.artifact_intent,
         issuance.has_zero_tax_treatment,
         issuance.state,
         issuance.attempt_count,
         issuance.next_attempt_at,
         issuance.created_at,
         issuance.started_at,
         issuance.finished_at,
         issuance.error_code,
         approvals.approval_count,
         approvals.viewer_has_approved,
         withdrawal.id IS NULL
           AND approvals.approval_count < 2
           AND issuance.state = 'ready_for_approval'
           AND can_approve
           AND NOT approvals.viewer_has_approved,
         CASE
           WHEN withdrawal.id IS NOT NULL THEN 'withdrawn_before_archive'
           WHEN approvals.approval_count = 2 THEN 'approved_for_archive_not_issued'
           WHEN approvals.approval_count = 1 THEN 'approval_pending'
           ELSE issuance.state
         END,
         withdrawal.id,
         withdrawal.reason_code,
         withdrawal.withdrawn_at,
         CASE
           WHEN withdrawal.id IS NULL
             AND approvals.approval_count < 2
             AND issuance.state = 'ready_for_approval'
             AND can_approve
           THEN issuance.artifact_version
           ELSE NULL::uuid
         END
    FROM public.offer_issuance AS issuance
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*)::integer AS approval_count,
             COALESCE(
               pg_catalog.bool_or(approval.approved_by = actor_id), false
             ) AS viewer_has_approved
        FROM public.offer_issuance_approval AS approval
       WHERE approval.workspace_id = issuance.workspace_id
         AND approval.issuance_id = issuance.id
    ) AS approvals
    LEFT JOIN public.offer_issuance_withdrawal AS withdrawal
      ON withdrawal.workspace_id = issuance.workspace_id
     AND withdrawal.issuance_id = issuance.id
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.offer_id = requested_offer_id
     AND (requested_issuance_id IS NULL OR issuance.id = requested_issuance_id);
END
$m203b1_read_status$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_issuance_status(uuid, uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.read_offer_issuance_artifact(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_issuance_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  id uuid,
  offer_id uuid,
  candidate_id uuid,
  artifact_intent text,
  has_zero_tax_treatment boolean,
  state text,
  attempt_count integer,
  next_attempt_at timestamptz,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  approval_count integer,
  viewer_has_approved boolean,
  can_current_actor_approve boolean,
  derived_state text,
  withdrawal_id uuid,
  withdrawal_reason_code text,
  withdrawn_at timestamptz,
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
AS $m203b1_read_artifact$
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
    RAISE EXCEPTION 'offer issuance context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR requested_issuance_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'offer issuance context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  can_approve := actor_role = 'admin' OR (
    actor_role = 'editor'
    AND actor_capabilities->'approve_offer_documents' IS NOT DISTINCT FROM 'true'::jsonb
  );

  RETURN QUERY
  SELECT issuance.workspace_id,
         issuance.id,
         issuance.offer_id,
         issuance.candidate_id,
         issuance.artifact_intent,
         issuance.has_zero_tax_treatment,
         issuance.state,
         issuance.attempt_count,
         issuance.next_attempt_at,
         issuance.created_at,
         issuance.started_at,
         issuance.finished_at,
         issuance.error_code,
         approvals.approval_count,
         approvals.viewer_has_approved,
         approvals.approval_count < 2
           AND can_approve
           AND NOT approvals.viewer_has_approved,
         CASE
           WHEN approvals.approval_count = 2 THEN 'approved_for_archive_not_issued'
           WHEN approvals.approval_count = 1 THEN 'approval_pending'
           ELSE issuance.state
         END,
         NULL::uuid,
         NULL::text,
         NULL::timestamptz,
         NULL::uuid,
         issuance.offer_number,
         issuance.artifact_mime_type,
         pg_catalog.encode(issuance.artifact_sha256, 'hex'),
         issuance.artifact_size_bytes,
         issuance.artifact_bytes
    FROM public.offer_issuance AS issuance
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*)::integer AS approval_count,
             COALESCE(
               pg_catalog.bool_or(approval.approved_by = actor_id), false
             ) AS viewer_has_approved
        FROM public.offer_issuance_approval AS approval
       WHERE approval.workspace_id = issuance.workspace_id
         AND approval.issuance_id = issuance.id
    ) AS approvals
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.offer_id = requested_offer_id
     AND issuance.id = requested_issuance_id
     AND issuance.state = 'ready_for_approval'
     AND NOT EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = issuance.workspace_id
          AND withdrawal.issuance_id = issuance.id
     )
     AND issuance.artifact_mime_type = 'application/pdf'
     AND issuance.artifact_size_bytes = pg_catalog.octet_length(issuance.artifact_bytes)
     AND issuance.artifact_sha256 = pg_catalog.sha256(issuance.artifact_bytes)
     AND (approvals.approval_count = 2 OR can_approve);
END
$m203b1_read_artifact$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_issuance_artifact(uuid, uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.claim_offer_issuance_render(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  requested_lease_token uuid,
  requested_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_claim$
DECLARE
  context_workspace_id uuid;
  issuance_record record;
  claim_time timestamptz;
  terminal_attempt_count integer;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer issuance worker context is invalid'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_issuance_id IS NULL
     OR requested_lease_token IS NULL
     OR requested_lease_seconds NOT BETWEEN 1 AND 300
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'offer issuance worker context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_issuance_id::text, 1701734776)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
   FOR UPDATE;
  IF NOT FOUND OR EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = requested_workspace_id
          AND withdrawal.issuance_id = requested_issuance_id
     ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
  END IF;
  claim_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  IF issuance_record.input_version <> 'offer-issuance-input.v1'
     OR issuance_record.canonicalization_version <> 'offer-jcs.v1'
     OR issuance_record.template_version <> 'offer-issuance-template.v1'
     OR issuance_record.renderer_recipe_version <>
       'offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
     OR issuance_record.input_sha256 IS DISTINCT FROM pg_catalog.sha256(
       pg_catalog.convert_to(
         public.canonicalize_offer_json_v1(issuance_record.input_snapshot),
         'UTF8'
       )
     ) THEN
    IF issuance_record.state IN ('queued', 'retry_wait')
       AND issuance_record.attempt_count < 3
       AND issuance_record.next_attempt_at <= claim_time THEN
      terminal_attempt_count := issuance_record.attempt_count + 1;
      UPDATE public.offer_issuance AS issuance
         SET state = 'running',
             attempt_count = terminal_attempt_count,
             lease_token = requested_lease_token,
             lease_expires_at = claim_time
               + pg_catalog.make_interval(secs => requested_lease_seconds),
             error_code = NULL,
             error_retryable = NULL,
             started_at = COALESCE(issuance_record.started_at, claim_time),
             finished_at = NULL,
             updated_at = claim_time
       WHERE issuance.workspace_id = requested_workspace_id
         AND issuance.id = requested_issuance_id;
    ELSIF issuance_record.state = 'running'
          AND issuance_record.attempt_count BETWEEN 1 AND 3
          AND issuance_record.lease_expires_at <= claim_time THEN
      terminal_attempt_count := issuance_record.attempt_count;
    ELSE
      RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
    END IF;

    UPDATE public.offer_issuance AS issuance
       SET state = 'failed_final',
           next_attempt_at = claim_time,
           lease_token = NULL,
           lease_expires_at = NULL,
           error_code = 'invalid_input',
           error_retryable = false,
           updated_at = claim_time,
           finished_at = claim_time
     WHERE issuance.workspace_id = requested_workspace_id
       AND issuance.id = requested_issuance_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'attemptCount', terminal_attempt_count,
      'nextAttemptAt', claim_time,
      'errorCode', 'invalid_input'
    );
  END IF;
  IF issuance_record.state = 'running'
     AND issuance_record.attempt_count = 3
     AND issuance_record.lease_expires_at <= claim_time THEN
    UPDATE public.offer_issuance AS issuance
       SET state = 'failed_final',
           next_attempt_at = claim_time,
           lease_token = NULL,
           lease_expires_at = NULL,
           error_code = 'lease_expired',
           error_retryable = false,
           updated_at = claim_time,
           finished_at = claim_time
     WHERE issuance.workspace_id = requested_workspace_id
       AND issuance.id = requested_issuance_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'attemptCount', 3,
      'nextAttemptAt', claim_time,
      'errorCode', 'lease_expired'
    );
  END IF;
  IF issuance_record.attempt_count >= 3
     OR NOT (
       (issuance_record.state IN ('queued', 'retry_wait')
        AND issuance_record.next_attempt_at <= claim_time)
       OR (issuance_record.state = 'running'
           AND issuance_record.lease_expires_at <= claim_time)
     ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
  END IF;

  UPDATE public.offer_issuance AS issuance
     SET state = 'running',
         attempt_count = issuance_record.attempt_count + 1,
         lease_token = requested_lease_token,
         lease_expires_at = claim_time
           + pg_catalog.make_interval(secs => requested_lease_seconds),
         error_code = NULL,
         error_retryable = NULL,
         started_at = COALESCE(issuance_record.started_at, claim_time),
         finished_at = NULL,
         updated_at = claim_time
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'workspaceId', requested_workspace_id,
    'issuanceId', requested_issuance_id,
    'leaseToken', requested_lease_token,
    'attemptCount', issuance_record.attempt_count + 1,
    'inputVersion', issuance_record.input_version,
    'canonicalizationVersion', issuance_record.canonicalization_version,
    'templateVersion', issuance_record.template_version,
    'rendererRecipeVersion', issuance_record.renderer_recipe_version,
    'inputSha256', pg_catalog.encode(issuance_record.input_sha256, 'hex'),
    'input', issuance_record.input_snapshot
  );
END
$m203b1_claim$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_offer_issuance_render(
  uuid, uuid, uuid, integer
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.finalize_offer_issuance_render_success(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  requested_lease_token uuid,
  expected_attempt_count integer,
  rendered_bytes bytea
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_finalize_success$
DECLARE
  context_workspace_id uuid;
  issuance_record record;
  completion_time timestamptz;
  rendered_sha256 bytea;
  rendered_size integer;
  generated_artifact_version uuid;
  pdf_tail text;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer issuance worker context is invalid'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_issuance_id IS NULL
     OR requested_lease_token IS NULL
     OR expected_attempt_count NOT BETWEEN 1 AND 3
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_input'
    );
  END IF;
  rendered_size := pg_catalog.octet_length(rendered_bytes);
  IF rendered_bytes IS NULL OR rendered_size NOT BETWEEN 100 AND 8388608
     OR pg_catalog.substr(rendered_bytes, 1, 5)
          <> pg_catalog.convert_to('%PDF-', 'UTF8') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_pdf'
    );
  END IF;
  pdf_tail := pg_catalog.convert_from(
    pg_catalog.substr(
      rendered_bytes, greatest(1, rendered_size - 1023)
    ),
    'LATIN1'
  );
  IF pdf_tail !~ '%%EOF[[:space:]]*$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_pdf'
    );
  END IF;
  rendered_sha256 := pg_catalog.sha256(rendered_bytes);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_issuance_id::text, 1701734776)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
   FOR UPDATE;
  IF NOT FOUND OR EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = requested_workspace_id
          AND withdrawal.issuance_id = requested_issuance_id
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale'
    );
  END IF;
  IF rendered_sha256 = issuance_record.candidate_artifact_sha256 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'renderer_nondeterministic'
    );
  END IF;
  IF issuance_record.state = 'ready_for_approval' THEN
    IF issuance_record.attempt_count IS DISTINCT FROM expected_attempt_count THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'retry_conflict'
      );
    END IF;
    IF issuance_record.artifact_sha256 = rendered_sha256
       AND issuance_record.artifact_size_bytes = rendered_size
       AND issuance_record.artifact_bytes = rendered_bytes THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'ready_for_approval',
        'attemptCount', issuance_record.attempt_count,
        'replayed', true,
        'artifactVersion', issuance_record.artifact_version
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'renderer_nondeterministic'
    );
  END IF;
  IF issuance_record.state <> 'running'
     OR issuance_record.lease_token IS DISTINCT FROM requested_lease_token
     OR issuance_record.attempt_count IS DISTINCT FROM expected_attempt_count
     OR issuance_record.lease_expires_at < pg_catalog.statement_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'retry_conflict'
    );
  END IF;
  completion_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  generated_artifact_version := pg_catalog.gen_random_uuid();
  UPDATE public.offer_issuance AS issuance
     SET state = 'ready_for_approval',
         lease_token = NULL,
         lease_expires_at = NULL,
         error_code = NULL,
         error_retryable = NULL,
         artifact_mime_type = 'application/pdf',
         artifact_sha256 = rendered_sha256,
         artifact_size_bytes = rendered_size,
         artifact_bytes = rendered_bytes,
         artifact_version = generated_artifact_version,
         updated_at = completion_time,
         finished_at = completion_time
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ready_for_approval',
    'attemptCount', expected_attempt_count,
    'replayed', false,
    'artifactVersion', generated_artifact_version
  );
END
$m203b1_finalize_success$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_offer_issuance_render_success(
  uuid, uuid, uuid, integer, bytea
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.finalize_offer_issuance_render_failure(
  requested_workspace_id uuid,
  requested_issuance_id uuid,
  requested_lease_token uuid,
  expected_attempt_count integer,
  requested_error_code text,
  requested_retryable boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_finalize_failure$
DECLARE
  context_workspace_id uuid;
  issuance_record record;
  completion_time timestamptz;
  next_time timestamptz;
  next_state text;
  effective_retryable boolean;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer issuance worker context is invalid'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_issuance_id IS NULL
     OR requested_lease_token IS NULL
     OR expected_attempt_count NOT BETWEEN 1 AND 3
     OR requested_error_code NOT IN (
       'browser_unavailable', 'render_timeout', 'persistence_unavailable',
       'network_attempted', 'invalid_input', 'invalid_pdf', 'pdf_too_large',
       'renderer_nondeterministic', 'lease_expired'
     )
     OR requested_retryable IS DISTINCT FROM (
       requested_error_code IN (
         'browser_unavailable', 'render_timeout', 'persistence_unavailable'
       )
     )
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_input'
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_issuance_id::text, 1701734776)
  );
  SELECT issuance.* INTO issuance_record
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
   FOR UPDATE;
  IF NOT FOUND OR EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = requested_workspace_id
          AND withdrawal.issuance_id = requested_issuance_id
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale'
    );
  END IF;
  IF issuance_record.state <> 'running'
     OR issuance_record.lease_token IS DISTINCT FROM requested_lease_token
     OR issuance_record.attempt_count IS DISTINCT FROM expected_attempt_count
     OR issuance_record.lease_expires_at < pg_catalog.statement_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'retry_conflict'
    );
  END IF;
  completion_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  effective_retryable := requested_retryable AND expected_attempt_count < 3;
  next_state := CASE WHEN effective_retryable THEN 'retry_wait' ELSE 'failed_final' END;
  next_time := CASE WHEN effective_retryable THEN
    completion_time + pg_catalog.make_interval(
      secs => least(
        60, (30 * (2 ^ (expected_attempt_count - 1)))::integer
      )
    )
    ELSE completion_time
  END;
  UPDATE public.offer_issuance AS issuance
     SET state = next_state,
         next_attempt_at = next_time,
         lease_token = NULL,
         lease_expires_at = NULL,
         error_code = requested_error_code,
         error_retryable = effective_retryable,
         updated_at = completion_time,
         finished_at = CASE WHEN effective_retryable THEN NULL ELSE completion_time END
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', next_state,
    'attemptCount', expected_attempt_count,
    'nextAttemptAt', next_time,
    'errorCode', requested_error_code
  );
END
$m203b1_finalize_failure$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_offer_issuance_render_failure(
  uuid, uuid, uuid, integer, text, boolean
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.recover_offer_issuance_renders(
  requested_workspace_id uuid,
  requested_limit integer
)
RETURNS TABLE (issuance_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_recover$
DECLARE
  context_workspace_id uuid;
  recovery_time timestamptz;
  issuance_record record;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer issuance worker context is invalid'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_limit NOT BETWEEN 1 AND 100
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'offer issuance worker context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  recovery_time := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  FOR issuance_record IN
    SELECT issuance.*
      FROM public.offer_issuance AS issuance
     WHERE issuance.workspace_id = requested_workspace_id
       AND (
         (issuance.state IN ('queued', 'retry_wait')
          AND issuance.next_attempt_at <= recovery_time
          AND issuance.attempt_count < 3)
         OR (issuance.state = 'running'
             AND issuance.lease_expires_at <= recovery_time)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = issuance.workspace_id
            AND withdrawal.issuance_id = issuance.id
       )
     ORDER BY issuance.next_attempt_at, issuance.id
     FOR UPDATE SKIP LOCKED
     LIMIT requested_limit
  LOOP
    IF issuance_record.state = 'running' THEN
      IF issuance_record.attempt_count < 3 THEN
        UPDATE public.offer_issuance AS issuance
           SET state = 'retry_wait',
               next_attempt_at = recovery_time,
               lease_token = NULL,
               lease_expires_at = NULL,
               error_code = 'lease_expired',
               error_retryable = true,
               updated_at = recovery_time,
               finished_at = NULL
         WHERE issuance.workspace_id = requested_workspace_id
           AND issuance.id = issuance_record.id;
      ELSE
        UPDATE public.offer_issuance AS issuance
           SET state = 'failed_final',
               next_attempt_at = recovery_time,
               lease_token = NULL,
               lease_expires_at = NULL,
               error_code = 'lease_expired',
               error_retryable = false,
               updated_at = recovery_time,
               finished_at = recovery_time
         WHERE issuance.workspace_id = requested_workspace_id
           AND issuance.id = issuance_record.id;
        CONTINUE;
      END IF;
    END IF;
    issuance_id := issuance_record.id;
    RETURN NEXT;
  END LOOP;
END
$m203b1_recover$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.recover_offer_issuance_renders(uuid, integer)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.list_offer_issuance_recovery_workspaces(
  after_workspace_id uuid,
  requested_limit integer
)
RETURNS TABLE (workspace_id uuid)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $m203b1_list_recovery_workspaces$
BEGIN
  IF requested_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ungueltiges Recovery-Limit' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('pgboss.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $m203b1_recovery_query$
    WITH locator_jobs AS MATERIALIZED (
      SELECT job.data,
             CASE
               -- Der Cast liegt absichtlich im validierten CASE-Zweig.
               -- WHERE-Praedikate besitzen keine garantierte Auswertungsreihenfolge;
               -- ein malformed Queue-Eintrag darf den gesamten Sweep nie abbrechen.
               WHEN pg_catalog.pg_input_is_valid(
                 job.data->>'workspaceId', 'uuid'
               )
               THEN (job.data->>'workspaceId')::uuid
               ELSE NULL::uuid
             END AS safe_workspace_id
        FROM pgboss.job AS job
       WHERE job.name = 'offer-issuance.render.v1'
         -- Ein technisch erschoepfter pg-boss-Job bleibt bis zur Retention ein
         -- sicherer, strikt validierter Workspace-Locator. failed blockiert den
         -- exklusiven Singleton nicht; der Sweep kann daher neu zustellen.
         AND job.state::text IN ('created', 'retry', 'active', 'failed')
    )
    SELECT DISTINCT locator.safe_workspace_id AS workspace_id
      FROM locator_jobs AS locator
     WHERE locator.safe_workspace_id IS NOT NULL
       AND pg_catalog.jsonb_typeof(locator.data) = 'object'
       AND (locator.data - ARRAY[
         'schemaVersion', 'workspaceId', 'issuanceId'
       ]::text[]) = '{}'::jsonb
       AND locator.data->>'schemaVersion' = 'offer-issuance-dispatch.v1'
       AND locator.data->>'workspaceId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.pg_input_is_valid(
         locator.data->>'issuanceId', 'uuid'
       )
       AND locator.data->>'issuanceId' ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND ($1::uuid IS NULL OR locator.safe_workspace_id > $1)
     ORDER BY workspace_id
     LIMIT $2
  $m203b1_recovery_query$
  USING after_workspace_id, requested_limit;
END
$m203b1_list_recovery_workspaces$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_offer_issuance_recovery_workspaces(
  uuid, integer
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public._m203b1_offer_issuance_dispatch_state(
  requested_workspace_id uuid,
  requested_issuance_id uuid
)
RETURNS TABLE (
  domain_state text,
  domain_attempt_count integer,
  domain_next_attempt_at timestamptz,
  domain_lease_expires_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m203b1_dispatch_state$
DECLARE
  context_workspace_id uuid;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer issuance dispatch context is invalid'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_issuance_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'offer issuance dispatch context mismatch'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT issuance.state,
         issuance.attempt_count,
         issuance.next_attempt_at,
         issuance.lease_expires_at
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id = requested_issuance_id
     AND (
       (issuance.state IN ('queued', 'retry_wait')
          AND issuance.attempt_count < 3)
       OR (issuance.state = 'running'
          AND issuance.attempt_count BETWEEN 1 AND 3)
     )
     AND issuance.input_version = 'offer-issuance-input.v1'
     AND issuance.canonicalization_version = 'offer-jcs.v1'
     AND issuance.template_version = 'offer-issuance-template.v1'
     AND issuance.renderer_recipe_version =
       'offer-issuance-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
     AND issuance.input_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
       public.canonicalize_offer_json_v1(issuance.input_snapshot), 'UTF8'
     ))
     AND NOT EXISTS (
       SELECT 1 FROM public.offer_issuance_withdrawal AS withdrawal
        WHERE withdrawal.workspace_id = issuance.workspace_id
          AND withdrawal.issuance_id = issuance.id
     );
END
$m203b1_dispatch_state$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m203b1_offer_issuance_dispatch_state(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

-- Die Queue wird vor den App-Migrationen unter app_worker initialisiert. 0035
-- attestiert den gepinnten v38-Vertrag und installiert nur die ID-only-Naht.
DO $m203b1_issuance_dispatch_migration$
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
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: app_migrator braucht SET auf app_worker';
  END IF;
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public._m203b1_offer_issuance_dispatch_state(uuid, uuid)
    TO app_worker;
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version) INTO pgboss_version FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'offer-issuance.render.v1'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 10
     AND queue.retry_delay = 1
     AND queue.retry_backoff = true
     AND queue.retry_delay_max = 60
     AND queue.expire_seconds = 180
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-03b1 Issuance dispatch: Queue fehlt oder driftet';
  END IF;

  EXECUTE $m203b1_dispatch_ddl$
    CREATE FUNCTION pgboss.enqueue_offer_issuance(
      workspace_id uuid,
      issuance_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $m203b1_dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_attempt integer;
      dispatch_key text;
      dispatch_start_after timestamptz;
      issuance_state text;
      issuance_attempt_count integer;
      issuance_next_attempt_at timestamptz;
      issuance_lease_expires_at timestamptz;
      runtime_pgboss_version integer;
    BEGIN
      IF $1 IS NULL OR $2 IS NULL OR NULLIF(
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'Issuance dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;
      SELECT domain.domain_state,
             domain.domain_attempt_count,
             domain.domain_next_attempt_at,
             domain.domain_lease_expires_at
        INTO issuance_state,
             issuance_attempt_count,
             issuance_next_attempt_at,
             issuance_lease_expires_at
        FROM public._m203b1_offer_issuance_dispatch_state($1, $2) AS domain;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Issuance dispatch: keine zustellbare Reservation'
          USING ERRCODE = '42501';
      END IF;
      dispatch_attempt := issuance_attempt_count + 1;
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := CASE issuance_state
        WHEN 'running' THEN issuance_lease_expires_at
        ELSE issuance_next_attempt_at
      END;
      IF dispatch_start_after IS NULL THEN
        RAISE EXCEPTION 'Issuance dispatch: Zustellzeit fehlt';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734777)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'Issuance dispatch: pg-boss-Schemaversion driftet';
      END IF;
      SELECT * INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'offer-issuance.render.v1';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'Issuance dispatch: Queuevertrag fehlt oder driftet';
      END IF;
      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'offer-issuance-dispatch.v1',
        'workspaceId', $1::text,
        'issuanceId', $2::text
      );
      IF EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'offer-issuance.render.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'offer-issuance.render.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'offer-issuance.render.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'Issuance dispatch: aktiver Job verletzt Vertrag';
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
      IF NOT FOUND AND NOT EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'offer-issuance.render.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'Issuance dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $m203b1_dispatch_body$
  $m203b1_dispatch_ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION pgboss.enqueue_offer_issuance(uuid, uuid) FROM PUBLIC';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_offer_issuance(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m203b1_issuance_dispatch_migration$;--> statement-breakpoint

DO $m203b1_function_acl$
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
        'public.prepare_offer_issuance(uuid,uuid,uuid), '
        'public.approve_offer_issuance(uuid,uuid,boolean,boolean,boolean,boolean,boolean), '
        'public.withdraw_offer_issuance(uuid,uuid,text), '
        'public.read_offer_issuance_status(uuid,uuid,uuid), '
        'public.read_offer_issuance_artifact(uuid,uuid,uuid), '
        'public.claim_offer_issuance_render(uuid,uuid,uuid,integer), '
        'public.finalize_offer_issuance_render_success(uuid,uuid,uuid,integer,bytea), '
        'public.finalize_offer_issuance_render_failure(uuid,uuid,uuid,integer,text,boolean), '
        'public.recover_offer_issuance_renders(uuid,integer), '
        'public.list_offer_issuance_recovery_workspaces(uuid,integer), '
        'public._m203b1_offer_issuance_dispatch_state(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public.prepare_offer_issuance(uuid, uuid, uuid),
      public.approve_offer_issuance(
        uuid, uuid, boolean, boolean, boolean, boolean, boolean
      ),
      public.withdraw_offer_issuance(uuid, uuid, text),
      public.read_offer_issuance_status(uuid, uuid, uuid),
      public.read_offer_issuance_artifact(uuid, uuid, uuid)
    TO app_runtime;
  END IF;
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA public TO app_worker;
    GRANT EXECUTE ON FUNCTION
      public.claim_offer_issuance_render(uuid, uuid, uuid, integer),
      public.finalize_offer_issuance_render_success(
        uuid, uuid, uuid, integer, bytea
      ),
      public.finalize_offer_issuance_render_failure(
        uuid, uuid, uuid, integer, text, boolean
      ),
      public.recover_offer_issuance_renders(uuid, integer),
      public.list_offer_issuance_recovery_workspaces(uuid, integer),
      public._m203b1_offer_issuance_dispatch_state(uuid, uuid)
    TO app_worker;
  END IF;
END
$m203b1_function_acl$;
--> statement-breakpoint

-- Bis zu einem spaeteren, belegten Archivgate sind alle Issuance-Daten Teil
-- des bestehenden Offer-Erasuregraphen. Die drei neuen Keys bleiben optional,
-- damit vor 0035 versiegelte Tombstones weiterhin exakt replaybar sind.
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m203b1_tombstone_worm$
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
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds',
    'offerIssuanceIds', 'offerIssuanceApprovalIds',
    'offerIssuanceWithdrawalIds'
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
$m203b1_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m203a;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.build_inactive_lead_erasure_graph_m203a(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m203b1_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m203a(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN issuance_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerIssuanceIds', issuance_graph.ids
              ) END
         || CASE WHEN approval_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerIssuanceApprovalIds', approval_graph.ids
              ) END
         || CASE WHEN withdrawal_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'offerIssuanceWithdrawalIds', withdrawal_graph.ids
              ) END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(issuance.id::text ORDER BY issuance.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_issuance AS issuance
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = issuance.workspace_id
         AND offer_record.id = issuance.offer_id
       WHERE issuance.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS issuance_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(approval.id::text ORDER BY approval.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_issuance_approval AS approval
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = approval.workspace_id
         AND offer_record.id = approval.offer_id
       WHERE approval.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS approval_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(withdrawal.id::text ORDER BY withdrawal.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_issuance_withdrawal AS withdrawal
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = withdrawal.workspace_id
         AND offer_record.id = withdrawal.offer_id
       WHERE withdrawal.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS withdrawal_graph
$m203b1_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

DO $m203b1_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_issuance_lock constant text := $m203b1_old_issuance_lock$
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
$m203b1_old_issuance_lock$;
  new_issuance_lock constant text := $m203b1_new_issuance_lock$
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
  PERFORM 1 FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceIds', '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY issuance.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.offer_issuance AS issuance
     WHERE issuance.workspace_id = requested_workspace_id
       AND issuance.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(
             operational_graph_document->'offerIssuanceIds', '[]'::jsonb
           )
         ) AS value
       )
       AND issuance.state = 'running'
       AND issuance.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
  PERFORM 1 FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceApprovalIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY approval.id FOR UPDATE;
  PERFORM 1 FROM public.offer_issuance_withdrawal AS withdrawal
   WHERE withdrawal.workspace_id = requested_workspace_id
     AND withdrawal.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceWithdrawalIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY withdrawal.id FOR UPDATE;
$m203b1_new_issuance_lock$;
  old_activity constant text := $m203b1_old_activity$
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
$m203b1_old_activity$;
  new_activity constant text := $m203b1_new_activity$
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
        UNION ALL
        SELECT issuance.created_at FROM public.offer_issuance AS issuance
         WHERE issuance.workspace_id = requested_workspace_id
           AND issuance.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(graph_document->'offerIssuanceIds', '[]'::jsonb)
             ) AS value
           )
        UNION ALL
        SELECT approval.approved_at FROM public.offer_issuance_approval AS approval
         WHERE approval.workspace_id = requested_workspace_id
           AND approval.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(
                 graph_document->'offerIssuanceApprovalIds', '[]'::jsonb
               )
             ) AS value
           )
        UNION ALL
        SELECT withdrawal.withdrawn_at FROM public.offer_issuance_withdrawal AS withdrawal
         WHERE withdrawal.workspace_id = requested_workspace_id
           AND withdrawal.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(
                 graph_document->'offerIssuanceWithdrawalIds', '[]'::jsonb
               )
             ) AS value
           )
      ) AS activity;
$m203b1_new_activity$;
  old_delete constant text := $m203b1_old_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_release_candidate_approval AS approval
$m203b1_old_delete$;
  new_delete constant text := $m203b1_new_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceApprovalIds',
           '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_issuance_withdrawal AS withdrawal
   WHERE withdrawal.workspace_id = requested_workspace_id
     AND withdrawal.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceWithdrawalIds',
           '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = requested_workspace_id
     AND issuance.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerIssuanceIds', '[]'::jsonb
         )
       ) AS value
     );
  DELETE FROM public.offer_release_candidate_approval AS approval
$m203b1_new_delete$;
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
    RAISE EXCEPTION 'M2-03b1 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       'c6ad889699c6126642497275b5871cfc56f9b0968b76e341bb2980c984caaaf3' THEN
    RAISE EXCEPTION 'M2-03b1 Erasure: unerwarteter M2-03a-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_issuance_lock) = 0
     OR pg_catalog.strpos(erase_source, old_activity) = 0
     OR pg_catalog.strpos(erase_source, old_delete) = 0 THEN
    RAISE EXCEPTION 'M2-03b1 Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_issuance_lock, new_issuance_lock
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
$m203b1_erasure_upgrade$;
--> statement-breakpoint

DO $m203b1_erasure_acl$
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
        'public._m203b1_erasure_delete_allowed(uuid,uuid,text), '
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m203a(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m203b1_erasure_acl$;
