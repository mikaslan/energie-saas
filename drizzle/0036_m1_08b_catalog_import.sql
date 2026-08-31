-- Gepinnte DB-Entsprechung der catalog-jcs.v1-Teilmenge. Anders als der
-- Offer-Vertrag normalisiert der Katalog Stringwerte nicht nach NFC.
CREATE FUNCTION public.canonicalize_catalog_json_v1(input_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_catalog_canonical$
DECLARE
  value_kind text := pg_catalog.jsonb_typeof(input_value);
  raw_text text;
  numeric_value numeric;
  canonical_value text;
BEGIN
  CASE value_kind
    WHEN 'null' THEN
      RETURN 'null';
    WHEN 'boolean' THEN
      RETURN input_value::text;
    WHEN 'number' THEN
      numeric_value := input_value::text::numeric;
      IF numeric_value <> pg_catalog.trunc(numeric_value)
         OR pg_catalog.abs(numeric_value) > 9007199254740991::numeric THEN
        RAISE EXCEPTION 'catalog-jcs.v1 erlaubt nur sichere Ganzzahlen';
      END IF;
      RETURN numeric_value::bigint::text;
    WHEN 'string' THEN
      raw_text := input_value #>> '{}';
      RETURN pg_catalog.to_jsonb(raw_text)::text;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        pg_catalog.string_agg(
          public.canonicalize_catalog_json_v1(element.value),
          ',' ORDER BY element.ordinality
        ),
        ''
      ) || ']'
        INTO canonical_value
        FROM pg_catalog.jsonb_array_elements(input_value)
             WITH ORDINALITY AS element(value, ordinality);
      RETURN canonical_value;
    WHEN 'object' THEN
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_object_keys(input_value) AS object_key(key)
         WHERE pg_catalog.octet_length(
                 pg_catalog.convert_to(object_key.key, 'UTF8')
               ) <> pg_catalog.char_length(object_key.key)
      ) THEN
        RAISE EXCEPTION 'catalog-jcs.v1 erlaubt nur ASCII-Objektschluessel';
      END IF;
      SELECT '{' || COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(member.key)::text || ':' ||
            public.canonicalize_catalog_json_v1(member.value),
          ',' ORDER BY member.key COLLATE "C"
        ),
        ''
      ) || '}'
        INTO canonical_value
        FROM pg_catalog.jsonb_each(input_value) AS member(key, value);
      RETURN canonical_value;
    ELSE
      RAISE EXCEPTION 'catalog-jcs.v1 kennt den JSON-Typ nicht';
  END CASE;
END
$m108b_catalog_canonical$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.canonicalize_catalog_json_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE "catalog_import_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"reservation_key" "bytea" NOT NULL,
	"file_name" text,
	"file_size_bytes" integer NOT NULL,
	"file_sha256" "bytea" NOT NULL,
	"encoding" text NOT NULL,
	"delimiter" text NOT NULL,
	"contract_version" text NOT NULL,
	"parser_version" text NOT NULL,
	"mapping_version" text NOT NULL,
	"mapping_snapshot" jsonb,
	"mapping_body_canonical" "bytea",
	"mapping_sha256" "bytea" NOT NULL,
	"total_count" integer NOT NULL,
	"valid_count" integer NOT NULL,
	"invalid_count" integer NOT NULL,
	"sensitive_payload_bytes" integer NOT NULL,
	"state" text NOT NULL,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_row_numbers" integer[],
	"lease_expires_at" timestamp with time zone,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" text,
	"created_by" uuid NOT NULL,
	"execution_actor_id" uuid,
	"attestation_version" text,
	"attestation_text_sha256" "bytea",
	"attested_by" uuid,
	"attested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preview_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"snapshot_cleanup_due_at" timestamp with time zone,
	"snapshot_redacted_at" timestamp with time zone,
	CONSTRAINT "catalog_import_job_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "catalog_import_job_ws_intent_uq" UNIQUE("workspace_id","intent_id"),
	CONSTRAINT "catalog_import_job_ws_reservation_uq" UNIQUE("workspace_id","reservation_key"),
	CONSTRAINT "catalog_import_job_state_ck" CHECK ("catalog_import_job"."state" in (
        'ready_for_review', 'queued', 'running', 'retry_wait',
        'succeeded', 'partial', 'failed_final', 'cancelled_before_start'
      )),
	CONSTRAINT "catalog_import_job_version_ck" CHECK ("catalog_import_job"."contract_version" = 'catalog-csv-import.v1'
        and "catalog_import_job"."parser_version" = 'papaparse-5.7.0-wmee.v1'
        and "catalog_import_job"."mapping_version" = 'catalog-csv-column-mapping.v1'),
	CONSTRAINT "catalog_import_job_file_ck" CHECK ("catalog_import_job"."file_size_bytes" between 1 and 1048576
        and ("catalog_import_job"."file_name" is null or (
          "catalog_import_job"."file_name" ~* '\.csv$'
          and char_length("catalog_import_job"."file_name") between 1 and 180
          and "catalog_import_job"."file_name" = normalize(
            "catalog_import_job"."file_name", NFKC
          )
          and "catalog_import_job"."file_name" !~ '(^[[:space:]])|([[:space:]]$)'
          and "catalog_import_job"."file_name" !~ '[[:cntrl:]]'
          and pg_catalog.strpos("catalog_import_job"."file_name", '/') = 0
          and pg_catalog.strpos(
            "catalog_import_job"."file_name", pg_catalog.chr(92)
          ) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8234)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8235)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8236)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8237)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8238)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8294)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8295)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8296)) = 0
          and pg_catalog.strpos("catalog_import_job"."file_name", pg_catalog.chr(8297)) = 0
        ))
        and "catalog_import_job"."encoding" in ('utf-8', 'windows-1252')
        and "catalog_import_job"."delimiter" in (pg_catalog.chr(59), pg_catalog.chr(44))),
	CONSTRAINT "catalog_import_job_hash_ck" CHECK (octet_length("catalog_import_job"."reservation_key") = 32
        and octet_length("catalog_import_job"."file_sha256") = 32
        and octet_length("catalog_import_job"."mapping_sha256") = 32
        and ("catalog_import_job"."mapping_body_canonical" is null
          or ((
            octet_length("catalog_import_job"."mapping_body_canonical") between 2 and 32768
            and pg_catalog.sha256("catalog_import_job"."mapping_body_canonical") = "catalog_import_job"."mapping_sha256"
            and pg_catalog.convert_from(
              "catalog_import_job"."mapping_body_canonical",
              'UTF8'
            ) = public.canonicalize_catalog_json_v1(
              "catalog_import_job"."mapping_snapshot"
            )
            and pg_catalog.convert_from(
              "catalog_import_job"."mapping_body_canonical",
              'UTF8'
            )::jsonb = "catalog_import_job"."mapping_snapshot"
          ) is true))
        and ("catalog_import_job"."attestation_text_sha256" is null
          or octet_length("catalog_import_job"."attestation_text_sha256") = 32)),
	CONSTRAINT "catalog_import_job_count_ck" CHECK ("catalog_import_job"."total_count" = "catalog_import_job"."valid_count" + "catalog_import_job"."invalid_count"
        and "catalog_import_job"."total_count" between 1 and 1000
        and "catalog_import_job"."valid_count" between 0 and "catalog_import_job"."total_count"
        and "catalog_import_job"."invalid_count" between 0 and "catalog_import_job"."total_count"
        and "catalog_import_job"."sensitive_payload_bytes" between 0 and 31457280),
	CONSTRAINT "catalog_import_job_lease_ck" CHECK ("catalog_import_job"."lease_generation" >= 0
        and (
          ("catalog_import_job"."state" = 'running'
            and "catalog_import_job"."lease_token" is not null
            and "catalog_import_job"."lease_expires_at" is not null
            and "catalog_import_job"."lease_row_numbers" is not null
            and cardinality("catalog_import_job"."lease_row_numbers") between 1 and 25
            and pg_catalog.array_position("catalog_import_job"."lease_row_numbers", null) is null)
          or
          ("catalog_import_job"."state" <> 'running'
            and "catalog_import_job"."lease_token" is null
            and "catalog_import_job"."lease_expires_at" is null
            and "catalog_import_job"."lease_row_numbers" is null)
        )
        and "catalog_import_job"."consecutive_failure_count" between 0 and 3),
	CONSTRAINT "catalog_import_job_execution_shape_ck" CHECK ((
          "catalog_import_job"."state" = 'ready_for_review'
          and "catalog_import_job"."next_attempt_at" is null
          and "catalog_import_job"."error_code" is null
          and "catalog_import_job"."consecutive_failure_count" = 0
        ) or (
          "catalog_import_job"."state" = 'queued'
          and "catalog_import_job"."next_attempt_at" is not null
          and "catalog_import_job"."error_code" is null
          and "catalog_import_job"."consecutive_failure_count" = 0
        ) or (
          "catalog_import_job"."state" = 'running'
          and "catalog_import_job"."next_attempt_at" is null
          and "catalog_import_job"."error_code" is null
          and "catalog_import_job"."consecutive_failure_count" between 0 and 2
        ) or (
          "catalog_import_job"."state" = 'retry_wait'
          and "catalog_import_job"."next_attempt_at" is not null
          and "catalog_import_job"."error_code" is not null
          and "catalog_import_job"."error_code" in ('lease_lost', 'enqueue_failed', 'queue_locator_invalid')
          and "catalog_import_job"."consecutive_failure_count" between 1 and 2
        ) or (
          "catalog_import_job"."state" in ('succeeded', 'partial', 'cancelled_before_start')
          and "catalog_import_job"."next_attempt_at" is null
          and "catalog_import_job"."error_code" is null
          and "catalog_import_job"."consecutive_failure_count" = 0
        ) or (
          "catalog_import_job"."state" = 'failed_final'
          and "catalog_import_job"."next_attempt_at" is null
          and "catalog_import_job"."error_code" is not null
          and (
            ("catalog_import_job"."error_code" = 'technical_retry_exhausted'
              and "catalog_import_job"."consecutive_failure_count" = 3)
            or ("catalog_import_job"."error_code" in (
                'actor_revoked', 'capability_revoked',
                'invalid_persisted_input', 'all_rows_conflicted'
              ) and "catalog_import_job"."consecutive_failure_count" = 0)
          )
        )),
	CONSTRAINT "catalog_import_job_error_ck" CHECK ("catalog_import_job"."error_code" is null or "catalog_import_job"."error_code" in (
        'actor_revoked', 'capability_revoked', 'lease_lost', 'enqueue_failed',
        'invalid_persisted_input', 'technical_retry_exhausted',
        'all_rows_conflicted', 'queue_locator_invalid'
      )),
	CONSTRAINT "catalog_import_job_attestation_ck" CHECK ((
          "catalog_import_job"."state" in ('ready_for_review', 'cancelled_before_start')
          and "catalog_import_job"."execution_actor_id" is null
          and "catalog_import_job"."attestation_version" is null
          and "catalog_import_job"."attestation_text_sha256" is null
          and "catalog_import_job"."attested_by" is null
          and "catalog_import_job"."attested_at" is null
          and "catalog_import_job"."started_at" is null
        ) or (
          "catalog_import_job"."state" not in ('ready_for_review', 'cancelled_before_start')
          and "catalog_import_job"."execution_actor_id" is not null
          and "catalog_import_job"."attestation_version" is not null
          and "catalog_import_job"."attestation_version" = 'catalog-import-rights-attestation.v1'
          and "catalog_import_job"."attestation_text_sha256" is not null
          and "catalog_import_job"."attestation_text_sha256" = pg_catalog.decode(
            '4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8',
            'hex'
          )
          and "catalog_import_job"."attested_by" = "catalog_import_job"."execution_actor_id"
          and "catalog_import_job"."attested_at" is not null
          and "catalog_import_job"."started_at" is not null
        )),
	CONSTRAINT "catalog_import_job_terminal_ck" CHECK ("catalog_import_job"."preview_expires_at" = "catalog_import_job"."created_at" + interval '7 days'
        and (
          ("catalog_import_job"."state" in ('succeeded', 'partial', 'failed_final', 'cancelled_before_start')
            and "catalog_import_job"."terminal_at" is not null
            and "catalog_import_job"."snapshot_cleanup_due_at" is not null
            and "catalog_import_job"."snapshot_cleanup_due_at" = greatest(
              "catalog_import_job"."created_at" + interval '30 days',
              "catalog_import_job"."terminal_at"
            ))
          or ("catalog_import_job"."state" not in ('succeeded', 'partial', 'failed_final', 'cancelled_before_start')
            and "catalog_import_job"."terminal_at" is null
            and "catalog_import_job"."snapshot_cleanup_due_at" is null
            and "catalog_import_job"."snapshot_redacted_at" is null)
        )),
	CONSTRAINT "catalog_import_job_redaction_ck" CHECK (("catalog_import_job"."snapshot_redacted_at" is null
          and "catalog_import_job"."file_name" is not null
          and "catalog_import_job"."mapping_snapshot" is not null
          and "catalog_import_job"."mapping_body_canonical" is not null
          and "catalog_import_job"."sensitive_payload_bytes" > 0)
        or ("catalog_import_job"."snapshot_redacted_at" is not null
          and "catalog_import_job"."file_name" is null
          and "catalog_import_job"."mapping_snapshot" is null
          and "catalog_import_job"."mapping_body_canonical" is null
          and "catalog_import_job"."sensitive_payload_bytes" = 0
          and "catalog_import_job"."terminal_at" is not null
          and "catalog_import_job"."snapshot_cleanup_due_at" is not null
          and "catalog_import_job"."snapshot_redacted_at" >= "catalog_import_job"."snapshot_cleanup_due_at"))
);
--> statement-breakpoint
CREATE TABLE "catalog_import_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"validation_status" text NOT NULL,
	"normalized_sku" text,
	"operation" text,
	"command_snapshot" jsonb,
	"preview_row_body_canonical" "bytea",
	"source_command_body_canonical" "bytea",
	"row_command_body_canonical" "bytea",
	"row_sha256" "bytea" NOT NULL,
	"source_command_sha256" "bytea",
	"row_command_sha256" "bytea",
	"error_snapshot" jsonb,
	"target_component_id" uuid,
	"sealed_target_snapshot" jsonb,
	"sealed_target_body_canonical" "bytea",
	"target_snapshot_sha256" "bytea",
	"expected_component_id" uuid,
	"expected_revision" integer,
	"expected_status" text,
	"expected_snapshot_sha256" "bytea",
	"sensitive_payload_bytes" integer DEFAULT 0 NOT NULL,
	"snapshot_redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_row_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "catalog_import_row_ws_job_row_uq" UNIQUE("workspace_id","job_id","row_number"),
	CONSTRAINT "catalog_import_row_number_ck" CHECK ("catalog_import_row"."row_number" between 2 and 1001),
	CONSTRAINT "catalog_import_row_status_ck" CHECK ("catalog_import_row"."validation_status" in ('valid', 'invalid')
        and ("catalog_import_row"."operation" is null or "catalog_import_row"."operation" in ('create', 'revise', 'unchanged'))),
	CONSTRAINT "catalog_import_row_shape_ck" CHECK ((
          "catalog_import_row"."validation_status" = 'valid'
          and "catalog_import_row"."operation" is not null
          and "catalog_import_row"."source_command_sha256" is not null
          and "catalog_import_row"."row_command_sha256" is not null
          and "catalog_import_row"."error_snapshot" is null
          and "catalog_import_row"."target_component_id" is not null
          and (
            ("catalog_import_row"."snapshot_redacted_at" is null
              and "catalog_import_row"."normalized_sku" is not null
              and "catalog_import_row"."command_snapshot" is not null
              and "catalog_import_row"."preview_row_body_canonical" is not null
              and "catalog_import_row"."source_command_body_canonical" is not null
              and "catalog_import_row"."row_command_body_canonical" is not null
              and (
                ("catalog_import_row"."operation" in ('create', 'revise')
                  and "catalog_import_row"."sealed_target_snapshot" is not null
                  and "catalog_import_row"."sealed_target_body_canonical" is not null)
                or ("catalog_import_row"."operation" = 'unchanged'
                  and "catalog_import_row"."sealed_target_snapshot" is null
                  and "catalog_import_row"."sealed_target_body_canonical" is null)
              ))
            or ("catalog_import_row"."snapshot_redacted_at" is not null
              and "catalog_import_row"."command_snapshot" is null
              and "catalog_import_row"."preview_row_body_canonical" is null
              and "catalog_import_row"."source_command_body_canonical" is null
              and "catalog_import_row"."row_command_body_canonical" is null
              and "catalog_import_row"."sealed_target_snapshot" is null
              and "catalog_import_row"."sealed_target_body_canonical" is null)
          )
        ) or (
          "catalog_import_row"."validation_status" = 'invalid'
          and "catalog_import_row"."operation" is null
          and "catalog_import_row"."command_snapshot" is null
          and (
            ("catalog_import_row"."snapshot_redacted_at" is null
              and "catalog_import_row"."preview_row_body_canonical" is not null)
            or ("catalog_import_row"."snapshot_redacted_at" is not null
              and "catalog_import_row"."preview_row_body_canonical" is null)
          )
          and "catalog_import_row"."source_command_body_canonical" is null
          and "catalog_import_row"."row_command_body_canonical" is null
          and "catalog_import_row"."source_command_sha256" is null
          and "catalog_import_row"."row_command_sha256" is null
          and "catalog_import_row"."error_snapshot" is not null
          and "catalog_import_row"."target_component_id" is null
          and "catalog_import_row"."sealed_target_snapshot" is null
          and "catalog_import_row"."sealed_target_body_canonical" is null
          and "catalog_import_row"."target_snapshot_sha256" is null
          and "catalog_import_row"."expected_component_id" is null
          and "catalog_import_row"."expected_revision" is null
          and "catalog_import_row"."expected_status" is null
          and "catalog_import_row"."expected_snapshot_sha256" is null
        )),
	CONSTRAINT "catalog_import_row_operation_ck" CHECK (("catalog_import_row"."validation_status" = 'invalid') or (
        ("catalog_import_row"."operation" = 'create'
          and "catalog_import_row"."expected_component_id" is null
          and "catalog_import_row"."expected_revision" is null
          and "catalog_import_row"."expected_status" is null
          and "catalog_import_row"."expected_snapshot_sha256" is null
          and "catalog_import_row"."target_snapshot_sha256" is not null)
        or ("catalog_import_row"."operation" = 'revise'
          and "catalog_import_row"."expected_component_id" is not null
          and "catalog_import_row"."expected_component_id" = "catalog_import_row"."target_component_id"
          and "catalog_import_row"."expected_revision" is not null
          and "catalog_import_row"."expected_revision" > 0
          and "catalog_import_row"."expected_status" is not null
          and "catalog_import_row"."expected_status" in ('draft', 'active')
          and "catalog_import_row"."expected_snapshot_sha256" is not null
          and "catalog_import_row"."target_snapshot_sha256" is not null)
        or ("catalog_import_row"."operation" = 'unchanged'
          and "catalog_import_row"."expected_component_id" is not null
          and "catalog_import_row"."expected_component_id" = "catalog_import_row"."target_component_id"
          and "catalog_import_row"."expected_revision" is not null
          and "catalog_import_row"."expected_revision" > 0
          and "catalog_import_row"."expected_status" is not null
          and "catalog_import_row"."expected_status" in ('draft', 'active')
          and "catalog_import_row"."expected_snapshot_sha256" is not null
          and "catalog_import_row"."target_snapshot_sha256" is not null
          and "catalog_import_row"."target_snapshot_sha256" = "catalog_import_row"."expected_snapshot_sha256")
      )),
	CONSTRAINT "catalog_import_row_hash_ck" CHECK (octet_length("catalog_import_row"."row_sha256") = 32
        and ("catalog_import_row"."preview_row_body_canonical" is null
          or ((
            octet_length("catalog_import_row"."preview_row_body_canonical") between 2 and 131072
            and pg_catalog.sha256("catalog_import_row"."preview_row_body_canonical") =
              "catalog_import_row"."row_sha256"
            and pg_catalog.convert_from(
              "catalog_import_row"."preview_row_body_canonical",
              'UTF8'
            ) = public.canonicalize_catalog_json_v1(case
              when "catalog_import_row"."validation_status" = 'valid' then
                pg_catalog.jsonb_build_object(
                  'status', 'valid',
                  'rowNumber', "catalog_import_row"."row_number",
                  'normalizedSku', "catalog_import_row"."normalized_sku",
                  'commandSha256', pg_catalog.encode(
                    "catalog_import_row"."source_command_sha256",
                    'hex'
                  ),
                  'command', "catalog_import_row"."command_snapshot"->'sourceCommand'
                )
              else
                pg_catalog.jsonb_build_object(
                  'status', 'invalid',
                  'rowNumber', "catalog_import_row"."row_number",
                  'normalizedSku', "catalog_import_row"."normalized_sku",
                  'errors', "catalog_import_row"."error_snapshot"
                )
            end)
            and pg_catalog.convert_from(
              "catalog_import_row"."preview_row_body_canonical",
              'UTF8'
            )::jsonb = case
              when "catalog_import_row"."validation_status" = 'valid' then
                pg_catalog.jsonb_build_object(
                  'status', 'valid',
                  'rowNumber', "catalog_import_row"."row_number",
                  'normalizedSku', "catalog_import_row"."normalized_sku",
                  'commandSha256', pg_catalog.encode(
                    "catalog_import_row"."source_command_sha256",
                    'hex'
                  ),
                  'command', "catalog_import_row"."command_snapshot"->'sourceCommand'
                )
              else
                pg_catalog.jsonb_build_object(
                  'status', 'invalid',
                  'rowNumber', "catalog_import_row"."row_number",
                  'normalizedSku', "catalog_import_row"."normalized_sku",
                  'errors', "catalog_import_row"."error_snapshot"
                )
            end
          ) is true))
        and ("catalog_import_row"."source_command_sha256" is null
          or octet_length("catalog_import_row"."source_command_sha256") = 32)
        and ("catalog_import_row"."row_command_sha256" is null
          or octet_length("catalog_import_row"."row_command_sha256") = 32)
        and ("catalog_import_row"."source_command_body_canonical" is null
          or ((
            octet_length("catalog_import_row"."source_command_body_canonical") between 2 and 65536
            and pg_catalog.sha256("catalog_import_row"."source_command_body_canonical") =
              "catalog_import_row"."source_command_sha256"
            and pg_catalog.convert_from(
              "catalog_import_row"."source_command_body_canonical",
              'UTF8'
            ) = public.canonicalize_catalog_json_v1(
              "catalog_import_row"."command_snapshot"->'sourceCommand'
            )
            and pg_catalog.convert_from(
              "catalog_import_row"."source_command_body_canonical",
              'UTF8'
            )::jsonb = "catalog_import_row"."command_snapshot"->'sourceCommand'
          ) is true))
        and ("catalog_import_row"."row_command_body_canonical" is null
          or ((
            octet_length("catalog_import_row"."row_command_body_canonical") between 2 and 262144
            and pg_catalog.sha256("catalog_import_row"."row_command_body_canonical") = "catalog_import_row"."row_command_sha256"
            and pg_catalog.convert_from(
              "catalog_import_row"."row_command_body_canonical",
              'UTF8'
            ) = public.canonicalize_catalog_json_v1(
              "catalog_import_row"."command_snapshot" - 'rowCommandSha256'
            )
            and pg_catalog.convert_from(
              "catalog_import_row"."row_command_body_canonical",
              'UTF8'
            )::jsonb = "catalog_import_row"."command_snapshot" - 'rowCommandSha256'
          ) is true))
        and ("catalog_import_row"."sealed_target_body_canonical" is null
          or ((
            octet_length("catalog_import_row"."sealed_target_body_canonical") between 2 and 65536
            and pg_catalog.sha256("catalog_import_row"."sealed_target_body_canonical") =
              "catalog_import_row"."target_snapshot_sha256"
            and pg_catalog.convert_from(
              "catalog_import_row"."sealed_target_body_canonical",
              'UTF8'
            ) = public.canonicalize_catalog_json_v1(
              "catalog_import_row"."sealed_target_snapshot" - 'snapshotSha256'
            )
            and pg_catalog.convert_from(
              "catalog_import_row"."sealed_target_body_canonical",
              'UTF8'
            )::jsonb = "catalog_import_row"."sealed_target_snapshot" - 'snapshotSha256'
            and "catalog_import_row"."sealed_target_snapshot"->>'snapshotSha256' =
              pg_catalog.encode("catalog_import_row"."target_snapshot_sha256", 'hex')
          ) is true))
        and ("catalog_import_row"."target_snapshot_sha256" is null
          or octet_length("catalog_import_row"."target_snapshot_sha256") = 32)
        and ("catalog_import_row"."expected_snapshot_sha256" is null
          or octet_length("catalog_import_row"."expected_snapshot_sha256") = 32)
        and "catalog_import_row"."sensitive_payload_bytes" between 0 and 31457280),
	CONSTRAINT "catalog_import_row_command_binding_ck" CHECK ("catalog_import_row"."command_snapshot" is null or ((
        "catalog_import_row"."command_snapshot"->>'schemaVersion' = 'catalog-import-row-command.v1'
        and "catalog_import_row"."command_snapshot"->>'operation' = "catalog_import_row"."operation"
        and "catalog_import_row"."command_snapshot"->>'targetComponentId' = ("catalog_import_row"."target_component_id")::text
        and ("catalog_import_row"."command_snapshot"#>>'{source,rowNumber}')::integer = "catalog_import_row"."row_number"
        and "catalog_import_row"."command_snapshot"#>>'{source,rowSha256}' =
          pg_catalog.encode("catalog_import_row"."row_sha256", 'hex')
        and "catalog_import_row"."command_snapshot"#>>'{source,sourceCommandSha256}' =
          pg_catalog.encode("catalog_import_row"."source_command_sha256", 'hex')
        and "catalog_import_row"."command_snapshot"->>'rowCommandSha256' =
          pg_catalog.encode("catalog_import_row"."row_command_sha256", 'hex')
        and "catalog_import_row"."command_snapshot"#>>'{sourceCommand,internalSku}' = "catalog_import_row"."normalized_sku"
        and (
          ("catalog_import_row"."operation" = 'create'
            and jsonb_typeof("catalog_import_row"."command_snapshot"->'expected') = 'null')
          or ("catalog_import_row"."operation" in ('revise', 'unchanged')
            and jsonb_typeof("catalog_import_row"."command_snapshot"->'expected') = 'object'
            and "catalog_import_row"."command_snapshot"#>>'{expected,componentId}' =
              ("catalog_import_row"."expected_component_id")::text
            and ("catalog_import_row"."command_snapshot"#>>'{expected,revision}')::integer =
              "catalog_import_row"."expected_revision"
            and "catalog_import_row"."command_snapshot"#>>'{expected,status}' = "catalog_import_row"."expected_status"
            and "catalog_import_row"."command_snapshot"#>>'{expected,snapshotSha256}' =
              pg_catalog.encode("catalog_import_row"."expected_snapshot_sha256", 'hex')
            and "catalog_import_row"."command_snapshot"#>>'{expected,internalSku}' =
              "catalog_import_row"."command_snapshot"#>>'{sourceCommand,internalSku}'
            and "catalog_import_row"."command_snapshot"#>>'{expected,componentType}' =
              "catalog_import_row"."command_snapshot"#>>'{sourceCommand,componentType}')
        )
        and (
          ("catalog_import_row"."operation" = 'unchanged'
            and jsonb_typeof("catalog_import_row"."command_snapshot"->'sealedTarget') = 'null')
          or ("catalog_import_row"."operation" in ('create', 'revise')
            and jsonb_typeof("catalog_import_row"."command_snapshot"->'sealedTarget') = 'object'
            and "catalog_import_row"."command_snapshot"#>'{sealedTarget,snapshot}' =
              "catalog_import_row"."sealed_target_snapshot"
            and pg_catalog.decode(
              "catalog_import_row"."command_snapshot"#>>'{sealedTarget,bodyCanonicalBase64}',
              'base64'
            ) = "catalog_import_row"."sealed_target_body_canonical"
            and "catalog_import_row"."command_snapshot"#>>'{sealedTarget,snapshotSha256}' =
              pg_catalog.encode("catalog_import_row"."target_snapshot_sha256", 'hex')
            and "catalog_import_row"."command_snapshot"#>>'{sealedTarget,snapshot,identity,componentId}' =
              ("catalog_import_row"."target_component_id")::text)
        )
      ) is true)),
	CONSTRAINT "catalog_import_row_redaction_ck" CHECK ("catalog_import_row"."snapshot_redacted_at" is null
        or (
          "catalog_import_row"."normalized_sku" is null
          and "catalog_import_row"."command_snapshot" is null
          and "catalog_import_row"."preview_row_body_canonical" is null
          and "catalog_import_row"."source_command_body_canonical" is null
          and "catalog_import_row"."row_command_body_canonical" is null
          and "catalog_import_row"."sealed_target_snapshot" is null
          and "catalog_import_row"."sealed_target_body_canonical" is null
          and "catalog_import_row"."sensitive_payload_bytes" = 0
          and (
            "catalog_import_row"."error_snapshot" is null
            or not jsonb_path_exists(
              "catalog_import_row"."error_snapshot",
              '$[*] ? (@.sourceHeader != null)'
            )
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "catalog_import_row_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"result_state" text NOT NULL,
	"component_id" uuid,
	"revision" integer,
	"snapshot_sha256" "bytea",
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_row_result_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "catalog_import_row_result_ws_job_row_uq" UNIQUE("workspace_id","job_id","row_number"),
	CONSTRAINT "catalog_import_row_result_state_ck" CHECK ("catalog_import_row_result"."result_state" in ('created', 'revised', 'unchanged', 'conflict')),
	CONSTRAINT "catalog_import_row_result_shape_ck" CHECK ((
          "catalog_import_row_result"."result_state" in ('created', 'revised', 'unchanged')
          and "catalog_import_row_result"."component_id" is not null
          and "catalog_import_row_result"."revision" is not null
          and "catalog_import_row_result"."revision" > 0
          and "catalog_import_row_result"."snapshot_sha256" is not null
          and "catalog_import_row_result"."error_code" is null
        ) or (
          "catalog_import_row_result"."result_state" = 'conflict'
          and "catalog_import_row_result"."component_id" is null
          and "catalog_import_row_result"."revision" is null
          and "catalog_import_row_result"."snapshot_sha256" is null
          and "catalog_import_row_result"."error_code" is not null
        )),
	CONSTRAINT "catalog_import_row_result_error_ck" CHECK ("catalog_import_row_result"."error_code" is null or "catalog_import_row_result"."error_code" in (
        'sku_created_since_preview', 'revision_drift', 'status_drift',
        'type_drift', 'archived_requires_manual_reactivation',
        'catalog_write_conflict'
      )),
	CONSTRAINT "catalog_import_row_result_hash_ck" CHECK ("catalog_import_row_result"."snapshot_sha256" is null or octet_length("catalog_import_row_result"."snapshot_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "catalog_import_dispatch_receipt" (
	"dispatch_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"receipt_kind" text NOT NULL,
	"lease_generation" bigint NOT NULL,
	"cause_code" text,
	"outcome_state" text NOT NULL,
	"outcome_failure_count" integer NOT NULL,
	"outcome_error_code" text,
	"outcome_next_attempt_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_dispatch_receipt_ws_job_dispatch_uq"
	  UNIQUE("workspace_id", "job_id", "dispatch_id"),
	CONSTRAINT "catalog_import_dispatch_receipt_shape_ck" CHECK ((
	  "lease_generation" >= 0
	  and "outcome_failure_count" between 0 and 3
	  and (
	    ((("receipt_kind" = 'preclaim_failure'
	        and "cause_code" in ('enqueue_failed', 'queue_locator_invalid'))
	      or ("receipt_kind" = 'lease_failure'
	        and "cause_code" in (
	          'lease_lost', 'enqueue_failed', 'queue_locator_invalid'
	        )))
	      and (
	        ("outcome_state" = 'retry_wait'
	          and "outcome_failure_count" between 1 and 2
	          and "outcome_error_code" = "cause_code"
	          and "outcome_next_attempt_at" is not null)
	        or ("outcome_state" = 'failed_final'
	          and "outcome_failure_count" = 3
	          and "outcome_error_code" = 'technical_retry_exhausted'
          and "outcome_next_attempt_at" is null)
	      ))
	    or ("receipt_kind" = 'claim_terminal'
	      and "cause_code" in (
	        'actor_revoked', 'capability_revoked', 'invalid_persisted_input'
	      )
	      and "outcome_state" = 'failed_final'
	      and "outcome_failure_count" = 0
	      and "outcome_error_code" = "cause_code"
	      and "outcome_next_attempt_at" is null)
	    or ("receipt_kind" = 'batch_complete'
	      and "cause_code" is null
	      and "outcome_failure_count" = 0
	      and (
	        ("outcome_state" = 'queued'
	          and "outcome_error_code" is null
	          and "outcome_next_attempt_at" is not null)
	        or ("outcome_state" in ('succeeded', 'partial')
	          and "outcome_error_code" is null
	          and "outcome_next_attempt_at" is null)
	        or ("outcome_state" = 'failed_final'
	          and "outcome_error_code" = 'all_rows_conflicted'
	          and "outcome_next_attempt_at" is null)
	      ))
	  )
	) is true)
);
--> statement-breakpoint
ALTER TABLE "catalog_import_job" ADD CONSTRAINT "catalog_import_job_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_job" ADD CONSTRAINT "catalog_import_job_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_job" ADD CONSTRAINT "catalog_import_job_execution_actor_id_fk" FOREIGN KEY ("execution_actor_id") REFERENCES "public"."user_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_job" ADD CONSTRAINT "catalog_import_job_attested_by_fk" FOREIGN KEY ("attested_by") REFERENCES "public"."user_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row" ADD CONSTRAINT "catalog_import_row_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row" ADD CONSTRAINT "catalog_import_row_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."catalog_import_job"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row" ADD CONSTRAINT "catalog_import_row_expected_revision_fk" FOREIGN KEY ("workspace_id","expected_component_id","expected_revision","expected_snapshot_sha256") REFERENCES "public"."catalog_component_revision"("workspace_id","component_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row_result" ADD CONSTRAINT "catalog_import_row_result_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row_result" ADD CONSTRAINT "catalog_import_row_result_row_fk" FOREIGN KEY ("workspace_id","job_id","row_number") REFERENCES "public"."catalog_import_row"("workspace_id","job_id","row_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_row_result" ADD CONSTRAINT "catalog_import_row_result_revision_fk" FOREIGN KEY ("workspace_id","component_id","revision","snapshot_sha256") REFERENCES "public"."catalog_component_revision"("workspace_id","component_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_dispatch_receipt" ADD CONSTRAINT "catalog_import_dispatch_receipt_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_dispatch_receipt" ADD CONSTRAINT "catalog_import_dispatch_receipt_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."catalog_import_job"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_import_job_ws_active_uq" ON "catalog_import_job" USING btree ("workspace_id") WHERE "catalog_import_job"."state" in ('queued', 'running', 'retry_wait');--> statement-breakpoint
CREATE INDEX "catalog_import_job_recovery_idx" ON "catalog_import_job" USING btree ("workspace_id","state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "catalog_import_job_cleanup_idx" ON "catalog_import_job" USING btree ("workspace_id","snapshot_cleanup_due_at","id") WHERE "catalog_import_job"."snapshot_redacted_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_import_job_preview_expiry_idx" ON "catalog_import_job" USING btree ("workspace_id","preview_expires_at","id") WHERE "catalog_import_job"."state" = 'ready_for_review';--> statement-breakpoint
CREATE INDEX "catalog_import_job_ready_actor_quota_idx" ON "catalog_import_job" USING btree ("workspace_id","created_by","created_at","id") WHERE "catalog_import_job"."state" = 'ready_for_review';--> statement-breakpoint
CREATE INDEX "catalog_import_job_unredacted_budget_idx" ON "catalog_import_job" USING btree ("workspace_id","created_at","id") WHERE "catalog_import_job"."snapshot_redacted_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_import_job_latest_idx" ON "catalog_import_job" USING btree ("workspace_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_import_row_ws_job_valid_sku_uq" ON "catalog_import_row" USING btree ("workspace_id","job_id","normalized_sku") WHERE "catalog_import_row"."validation_status" = 'valid';--> statement-breakpoint
CREATE INDEX "catalog_import_row_ws_job_status_idx" ON "catalog_import_row" USING btree ("workspace_id","job_id","validation_status","row_number");--> statement-breakpoint
CREATE INDEX "catalog_import_row_result_ws_job_idx" ON "catalog_import_row_result" USING btree ("workspace_id","job_id","result_state","row_number");
--> statement-breakpoint
CREATE INDEX "catalog_import_dispatch_receipt_ws_job_idx" ON "catalog_import_dispatch_receipt" USING btree ("workspace_id","job_id","recorded_at","dispatch_id");
--> statement-breakpoint
ALTER TABLE public.catalog_import_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.catalog_import_job FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_import_job
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint
ALTER TABLE public.catalog_import_row ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.catalog_import_row FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_import_row
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint
ALTER TABLE public.catalog_import_row_result ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.catalog_import_row_result FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_import_row_result
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint
ALTER TABLE public.catalog_import_dispatch_receipt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.catalog_import_dispatch_receipt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_import_dispatch_receipt
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  public.catalog_import_job,
  public.catalog_import_row,
  public.catalog_import_row_result,
  public.catalog_import_dispatch_receipt
FROM PUBLIC;
--> statement-breakpoint
DO $m108b_table_acl$
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
        'public.catalog_import_job, public.catalog_import_row, '
        'public.catalog_import_row_result, '
        'public.catalog_import_dispatch_receipt FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
END
$m108b_table_acl$;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_exact_keys(
  candidate jsonb,
  expected_keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_exact_keys$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(candidate) = 'object'
    AND pg_catalog.cardinality(expected_keys) = (
      SELECT pg_catalog.count(*)::integer
        FROM pg_catalog.jsonb_object_keys(candidate) AS actual_key(key)
    )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_object_keys(candidate) AS actual_key(key)
       WHERE NOT (actual_key.key = ANY(expected_keys))
    )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(expected_keys) AS expected_key(key)
       WHERE NOT (candidate ? expected_key.key)
    ),
    false
  );
$m108b_jsonb_exact_keys$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_exact_keys(jsonb, text[]) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_integer_between(
  candidate jsonb,
  minimum_value numeric,
  maximum_value numeric
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_integer_between$
DECLARE
  parsed_value numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  parsed_value := (candidate #>> '{}')::numeric;
  RETURN parsed_value = pg_catalog.trunc(parsed_value)
    AND parsed_value BETWEEN minimum_value AND maximum_value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_jsonb_integer_between$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_integer_between(jsonb, numeric, numeric)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_trimmed_text(
  candidate jsonb,
  minimum_length integer,
  maximum_length integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_trimmed_text$
DECLARE
  parsed_value text;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  parsed_value := candidate #>> '{}';
  RETURN pg_catalog.char_length(parsed_value) BETWEEN minimum_length AND maximum_length
    AND parsed_value = pg_catalog.btrim(parsed_value);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_jsonb_trimmed_text$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_trimmed_text(jsonb, integer, integer)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_sha256(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_sha256$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(candidate) = 'string'
    AND (candidate #>> '{}') ~ '^[0-9a-f]{64}$',
    false
  );
$m108b_jsonb_sha256$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_sha256(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_uuid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_uuid$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(candidate) = 'string'
    AND (candidate #>> '{}') ~ (
      '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
      '|' || '00000000-0000-0000-0000-000000000000'
      '|' || 'ffffffff-ffff-ffff-ffff-ffffffffffff)$'
    ),
    false
  );
$m108b_jsonb_uuid$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_uuid(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_jsonb_date(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_jsonb_date$
DECLARE
  parsed_value text;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  parsed_value := candidate #>> '{}';
  IF parsed_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.to_char(parsed_value::date, 'YYYY-MM-DD') = parsed_value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_jsonb_date$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_jsonb_date(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_mapping(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_mapping$
DECLARE
  canonical_fields constant text[] := ARRAY[
    'internalSku', 'componentType', 'displayName', 'manufacturer', 'model',
    'unit', 'keyPoints', 'technicalSourceKind', 'technicalReference',
    'technicalObservedOn', 'technicalRightsBasis', 'technicalDocumentSha256',
    'purchasePriceNet', 'purchaseSourceKind', 'purchaseReference',
    'purchaseObservedOn', 'purchaseRightsBasis', 'purchaseDocumentSha256',
    'salesPriceNet', 'salesSourceKind', 'salesReference', 'salesObservedOn',
    'salesRightsBasis', 'salesDocumentSha256', 'nominalPowerWatts',
    'nominalAcPowerWatts', 'phaseCount', 'mpptTrackerCount',
    'nominalCapacityWh', 'usableCapacityWh', 'maxContinuousPowerWatts',
    'roundTripEfficiencyPercent', 'backupCapability', 'maxChargingPowerWatts',
    'connector', 'bidirectionalCapability', 'nominalHeatingPowerWatts',
    'scop', 'systemName', 'roofTypes', 'attributes'
  ];
  entry jsonb;
  entry_text text;
  current_position integer;
  prior_position integer := 0;
BEGIN
  IF public._m108b_jsonb_exact_keys(candidate, ARRAY['schemaVersion', 'columns'])
       IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
     OR candidate->>'schemaVersion' IS DISTINCT FROM 'catalog-csv-column-mapping.v1'
     OR pg_catalog.jsonb_typeof(candidate->'columns') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(candidate->'columns') NOT BETWEEN 1 AND 41 THEN
    RETURN false;
  END IF;

  FOR entry IN
    SELECT column_entry.value
      FROM pg_catalog.jsonb_array_elements(candidate->'columns')
        AS column_entry(value)
  LOOP
    IF public._m108b_jsonb_exact_keys(entry, ARRAY['field', 'sourceHeader'])
         IS NOT TRUE
       OR pg_catalog.jsonb_typeof(entry->'field') IS DISTINCT FROM 'string'
       OR public._m108b_jsonb_trimmed_text(entry->'sourceHeader', 1, 240)
         IS NOT TRUE THEN
      RETURN false;
    END IF;
    entry_text := entry->>'sourceHeader';
    IF entry_text IS DISTINCT FROM normalize(entry_text, NFKC)
       OR entry_text ~ '(^[[:space:]])|([[:space:]]$)' THEN
      RETURN false;
    END IF;
    current_position := pg_catalog.array_position(canonical_fields, entry->>'field');
    IF current_position IS NULL OR current_position <= prior_position THEN
      RETURN false;
    END IF;
    prior_position := current_position;
  END LOOP;

  RETURN (
    SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT column_entry.value->>'field')
       AND pg_catalog.count(*) = pg_catalog.count(DISTINCT column_entry.value->>'sourceHeader')
      FROM pg_catalog.jsonb_array_elements(candidate->'columns') AS column_entry(value)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_mapping$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_mapping(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_error_array(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_error_array$
DECLARE
  canonical_fields constant text[] := ARRAY[
    'internalSku', 'componentType', 'displayName', 'manufacturer', 'model',
    'unit', 'keyPoints', 'technicalSourceKind', 'technicalReference',
    'technicalObservedOn', 'technicalRightsBasis', 'technicalDocumentSha256',
    'purchasePriceNet', 'purchaseSourceKind', 'purchaseReference',
    'purchaseObservedOn', 'purchaseRightsBasis', 'purchaseDocumentSha256',
    'salesPriceNet', 'salesSourceKind', 'salesReference', 'salesObservedOn',
    'salesRightsBasis', 'salesDocumentSha256', 'nominalPowerWatts',
    'nominalAcPowerWatts', 'phaseCount', 'mpptTrackerCount',
    'nominalCapacityWh', 'usableCapacityWh', 'maxContinuousPowerWatts',
    'roundTripEfficiencyPercent', 'backupCapability', 'maxChargingPowerWatts',
    'connector', 'bidirectionalCapability', 'nominalHeatingPowerWatts',
    'scop', 'systemName', 'roofTypes', 'attributes'
  ];
  error_codes constant text[] := ARRAY[
    'empty_row', 'missing_mapping', 'missing_value', 'invalid_value',
    'invalid_money', 'invalid_date', 'invalid_enum', 'invalid_sha256',
    'invalid_technical_shape', 'duplicate_sku_in_file', 'sku_type_conflict',
    'archived_requires_manual_reactivation', 'mapping_conflict',
    'row_too_large', 'parser_error'
  ];
  entry jsonb;
  entry_text text;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(candidate) NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(candidate)
  LOOP
    IF public._m108b_jsonb_exact_keys(
         entry,
         ARRAY['field', 'sourceHeader', 'code', 'message']
       ) IS NOT TRUE THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(entry->'field') = 'string' THEN
      IF NOT ((entry->>'field') = ANY(canonical_fields)) THEN RETURN false; END IF;
    ELSIF pg_catalog.jsonb_typeof(entry->'field') IS DISTINCT FROM 'null' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(entry->'sourceHeader') = 'string' THEN
      entry_text := entry->>'sourceHeader';
      IF pg_catalog.char_length(entry_text) NOT BETWEEN 1 AND 240 THEN RETURN false; END IF;
    ELSIF pg_catalog.jsonb_typeof(entry->'sourceHeader') IS DISTINCT FROM 'null' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(entry->'code') IS DISTINCT FROM 'string'
       OR NOT ((entry->>'code') = ANY(error_codes))
       OR pg_catalog.jsonb_typeof(entry->'message') IS DISTINCT FROM 'string'
       OR pg_catalog.char_length(entry->>'message') NOT BETWEEN 1 AND 240
       OR entry->>'message' IS DISTINCT FROM (CASE entry->>'code'
         WHEN 'empty_row' THEN 'Die Datenzeile ist leer.'
         WHEN 'missing_mapping' THEN 'Die benoetigte Spalte ist nicht zugeordnet.'
         WHEN 'missing_value' THEN 'Ein benoetigter Wert fehlt.'
         WHEN 'invalid_value' THEN 'Der Wert entspricht nicht dem Importvertrag.'
         WHEN 'invalid_money' THEN 'Der Nettopreis ist nicht eindeutig lesbar.'
         WHEN 'invalid_date' THEN 'Das Datum muss YYYY-MM-DD entsprechen.'
         WHEN 'invalid_enum' THEN 'Der Wert ist fuer dieses Feld nicht erlaubt.'
         WHEN 'invalid_sha256' THEN
           'Der Dokumenthash muss leer oder ein SHA-256 in Kleinbuchstaben sein.'
         WHEN 'invalid_technical_shape' THEN
           'Die technischen Werte passen nicht zum Produkttyp.'
         WHEN 'duplicate_sku_in_file' THEN
           'Die normalisierte SKU kommt in der Datei mehrfach vor.'
         WHEN 'sku_type_conflict' THEN
           'Die SKU kollidiert mit einem anderen Produkttyp.'
         WHEN 'archived_requires_manual_reactivation' THEN
           'Archivierte Produkte brauchen eine manuelle Reaktivierung.'
         WHEN 'mapping_conflict' THEN 'Die Spaltenzuordnung ist nicht eindeutig.'
         WHEN 'row_too_large' THEN
           'Mindestens eine Zelle ueberschreitet das Zeichenlimit.'
         WHEN 'parser_error' THEN 'Die CSV-Zeile konnte nicht sicher gelesen werden.'
       END) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_error_array$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_error_array(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_provenance(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_provenance$
BEGIN
  RETURN public._m108b_jsonb_exact_keys(
      candidate,
      ARRAY['sourceKind', 'reference', 'observedOn', 'rightsBasis', 'sourceDocumentSha256']
    ) IS TRUE
    AND pg_catalog.jsonb_typeof(candidate->'sourceKind') = 'string'
    AND (candidate->>'sourceKind') = ANY(ARRAY[
      'manufacturer_datasheet', 'supplier_price_list', 'supplier_quote',
      'workspace_pricing', 'workspace_manual', 'csv_import', 'customer_provided'
    ])
    AND public._m108b_jsonb_trimmed_text(candidate->'reference', 1, 240) IS TRUE
    AND public._m108b_jsonb_date(candidate->'observedOn') IS TRUE
    AND pg_catalog.jsonb_typeof(candidate->'rightsBasis') = 'string'
    AND (candidate->>'rightsBasis') = ANY(ARRAY[
      'manufacturer_published', 'supplier_authorized',
      'workspace_owned', 'customer_provided'
    ])
    AND (
      pg_catalog.jsonb_typeof(candidate->'sourceDocumentSha256') = 'null'
      OR public._m108b_jsonb_sha256(candidate->'sourceDocumentSha256') IS TRUE
    );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_provenance$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_provenance(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_presentation(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_presentation$
DECLARE
  key_point jsonb;
BEGIN
  IF public._m108b_jsonb_exact_keys(
       candidate,
       ARRAY['displayName', 'manufacturer', 'model', 'unit', 'keyPoints', 'image', 'datasheet']
     ) IS NOT TRUE
     OR public._m108b_jsonb_trimmed_text(candidate->'displayName', 1, 200) IS NOT TRUE
     OR public._m108b_jsonb_trimmed_text(candidate->'manufacturer', 1, 200) IS NOT TRUE
     OR public._m108b_jsonb_trimmed_text(candidate->'model', 1, 200) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'unit') IS DISTINCT FROM 'string'
     OR NOT ((candidate->>'unit') = ANY(ARRAY['piece', 'set', 'meter']))
     OR pg_catalog.jsonb_typeof(candidate->'keyPoints') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(candidate->'keyPoints') > 6
     OR pg_catalog.jsonb_typeof(candidate->'image') IS DISTINCT FROM 'null'
     OR pg_catalog.jsonb_typeof(candidate->'datasheet') IS DISTINCT FROM 'null' THEN
    RETURN false;
  END IF;
  FOR key_point IN
    SELECT value FROM pg_catalog.jsonb_array_elements(candidate->'keyPoints')
  LOOP
    IF public._m108b_jsonb_trimmed_text(key_point, 1, 240) IS NOT TRUE THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_presentation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_presentation(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_technical_data(
  component_type text,
  candidate jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_technical_data$
DECLARE
  entry jsonb;
BEGIN
  IF component_type = 'module' THEN
    RETURN public._m108b_jsonb_exact_keys(
        candidate, ARRAY['schemaVersion', 'nominalPowerWatts']
      ) IS TRUE
      AND candidate->>'schemaVersion' = 'module.v1'
      AND public._m108b_jsonb_integer_between(
        candidate->'nominalPowerWatts', 1, 10000
      ) IS TRUE;
  ELSIF component_type = 'inverter' THEN
    RETURN public._m108b_jsonb_exact_keys(
        candidate,
        ARRAY['schemaVersion', 'nominalAcPowerWatts', 'phaseCount', 'mpptTrackerCount']
      ) IS TRUE
      AND candidate->>'schemaVersion' = 'inverter.v1'
      AND public._m108b_jsonb_integer_between(
        candidate->'nominalAcPowerWatts', 1, 10000000
      ) IS TRUE
      AND (
        public._m108b_jsonb_integer_between(candidate->'phaseCount', 1, 1) IS TRUE
        OR public._m108b_jsonb_integer_between(candidate->'phaseCount', 3, 3) IS TRUE
      )
      AND public._m108b_jsonb_integer_between(
        candidate->'mpptTrackerCount', 1, 100
      ) IS TRUE;
  ELSIF component_type = 'battery' THEN
    RETURN public._m108b_jsonb_exact_keys(
        candidate,
        ARRAY[
          'schemaVersion', 'nominalCapacityWh', 'usableCapacityWh',
          'maxContinuousPowerWatts', 'roundTripEfficiencyBasisPoints',
          'backupCapability'
        ]
      ) IS TRUE
      AND candidate->>'schemaVersion' = 'battery.v1'
      AND public._m108b_jsonb_integer_between(
        candidate->'nominalCapacityWh', 1, 100000000
      ) IS TRUE
      AND public._m108b_jsonb_integer_between(
        candidate->'usableCapacityWh', 1, 100000000
      ) IS TRUE
      AND (candidate->>'usableCapacityWh')::numeric
        <= (candidate->>'nominalCapacityWh')::numeric
      AND public._m108b_jsonb_integer_between(
        candidate->'maxContinuousPowerWatts', 1, 100000000
      ) IS TRUE
      AND public._m108b_jsonb_integer_between(
        candidate->'roundTripEfficiencyBasisPoints', 1, 10000
      ) IS TRUE
      AND pg_catalog.jsonb_typeof(candidate->'backupCapability') = 'string'
      AND (candidate->>'backupCapability') = ANY(ARRAY[
        'known_supported', 'known_unsupported', 'unknown'
      ]);
  ELSIF component_type = 'wallbox' THEN
    RETURN public._m108b_jsonb_exact_keys(
        candidate,
        ARRAY[
          'schemaVersion', 'maxChargingPowerWatts', 'phaseCount',
          'connector', 'bidirectionalCapability'
        ]
      ) IS TRUE
      AND candidate->>'schemaVersion' = 'wallbox.v1'
      AND public._m108b_jsonb_integer_between(
        candidate->'maxChargingPowerWatts', 1, 1000000
      ) IS TRUE
      AND (
        public._m108b_jsonb_integer_between(candidate->'phaseCount', 1, 1) IS TRUE
        OR public._m108b_jsonb_integer_between(candidate->'phaseCount', 3, 3) IS TRUE
      )
      AND pg_catalog.jsonb_typeof(candidate->'connector') = 'string'
      AND (candidate->>'connector') = ANY(ARRAY[
        'type2_socket', 'type2_cable', 'other'
      ])
      AND pg_catalog.jsonb_typeof(candidate->'bidirectionalCapability') = 'string'
      AND (candidate->>'bidirectionalCapability') = ANY(ARRAY[
        'known_supported', 'known_unsupported', 'unknown'
      ]);
  ELSIF component_type = 'heat_pump' THEN
    RETURN public._m108b_jsonb_exact_keys(
        candidate,
        ARRAY['schemaVersion', 'nominalHeatingPowerWatts', 'scopHundredths']
      ) IS TRUE
      AND candidate->>'schemaVersion' = 'heat_pump.v1'
      AND public._m108b_jsonb_integer_between(
        candidate->'nominalHeatingPowerWatts', 1, 10000000
      ) IS TRUE
      AND public._m108b_jsonb_integer_between(
        candidate->'scopHundredths', 1, 2000
      ) IS TRUE;
  ELSIF component_type = 'mounting' THEN
    IF public._m108b_jsonb_exact_keys(
         candidate, ARRAY['schemaVersion', 'systemName', 'roofTypes']
       ) IS NOT TRUE
       OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
       OR candidate->>'schemaVersion' IS DISTINCT FROM 'mounting.v1'
       OR public._m108b_jsonb_trimmed_text(candidate->'systemName', 1, 200)
         IS NOT TRUE
       OR pg_catalog.jsonb_typeof(candidate->'roofTypes') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(candidate->'roofTypes') NOT BETWEEN 1 AND 4 THEN
      RETURN false;
    END IF;
    FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(candidate->'roofTypes')
    LOOP
      IF pg_catalog.jsonb_typeof(entry) IS DISTINCT FROM 'string'
         OR NOT ((entry #>> '{}') = ANY(ARRAY['pitched', 'flat', 'facade', 'ground'])) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  ELSIF component_type = 'other' THEN
    IF public._m108b_jsonb_exact_keys(
         candidate, ARRAY['schemaVersion', 'attributes']
       ) IS NOT TRUE
       OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
       OR candidate->>'schemaVersion' IS DISTINCT FROM 'other.v1'
       OR pg_catalog.jsonb_typeof(candidate->'attributes') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(candidate->'attributes') > 20 THEN
      RETURN false;
    END IF;
    FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(candidate->'attributes')
    LOOP
      IF public._m108b_jsonb_exact_keys(entry, ARRAY['name', 'value']) IS NOT TRUE
         OR public._m108b_jsonb_trimmed_text(entry->'name', 1, 80) IS NOT TRUE
         OR public._m108b_jsonb_trimmed_text(entry->'value', 1, 240) IS NOT TRUE THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_technical_data$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_technical_data(text, jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_commercial(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_commercial$
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) = 'null' THEN
    RETURN true;
  END IF;
  RETURN public._m108b_jsonb_exact_keys(
      candidate,
      ARRAY[
        'currency', 'basis', 'purchasePriceNetCents', 'salesPriceNetCents',
        'purchaseProvenance', 'salesProvenance'
      ]
    ) IS TRUE
    AND candidate->>'currency' = 'EUR'
    AND candidate->>'basis' = 'net'
    AND public._m108b_jsonb_integer_between(
      candidate->'purchasePriceNetCents', 0, 9000000000000000
    ) IS TRUE
    AND public._m108b_jsonb_integer_between(
      candidate->'salesPriceNetCents', 0, 9000000000000000
    ) IS TRUE
    AND public._m108b_valid_catalog_import_provenance(
      candidate->'purchaseProvenance'
    ) IS TRUE
    AND public._m108b_valid_catalog_import_provenance(
      candidate->'salesProvenance'
    ) IS TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_commercial$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_commercial(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_source_command(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_source_command$
DECLARE
  component_type text;
BEGIN
  IF public._m108b_jsonb_exact_keys(
       candidate,
       ARRAY[
         'schemaVersion', 'internalSku', 'componentType', 'presentation',
         'technicalData', 'commercial', 'technicalProvenance'
       ]
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
     OR candidate->>'schemaVersion' IS DISTINCT FROM 'catalog-component-create-command.v1'
     OR pg_catalog.jsonb_typeof(candidate->'internalSku') IS DISTINCT FROM 'string'
     OR (candidate->>'internalSku') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
     OR pg_catalog.jsonb_typeof(candidate->'componentType') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  component_type := candidate->>'componentType';
  IF NOT (component_type = ANY(ARRAY[
       'module', 'inverter', 'battery', 'wallbox',
       'heat_pump', 'mounting', 'other'
     ]))
     OR public._m108b_valid_catalog_import_presentation(candidate->'presentation')
       IS NOT TRUE
     OR public._m108b_valid_catalog_import_technical_data(
       component_type, candidate->'technicalData'
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'commercial') IS DISTINCT FROM 'object'
     OR public._m108b_valid_catalog_import_commercial(candidate->'commercial')
       IS NOT TRUE
     OR public._m108b_valid_catalog_import_provenance(
       candidate->'technicalProvenance'
     ) IS NOT TRUE THEN
    RETURN false;
  END IF;
  RETURN component_type IN ('mounting', 'other')
    OR candidate#>>'{presentation,unit}' = 'piece';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_source_command$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_source_command(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_expected(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_expected$
BEGIN
  RETURN public._m108b_jsonb_exact_keys(
      candidate,
      ARRAY[
        'componentId', 'revision', 'status', 'snapshotSha256',
        'internalSku', 'componentType'
      ]
    ) IS TRUE
    AND public._m108b_jsonb_uuid(candidate->'componentId') IS TRUE
    AND public._m108b_jsonb_integer_between(
      candidate->'revision', 1, 2147483647
    ) IS TRUE
    AND pg_catalog.jsonb_typeof(candidate->'status') = 'string'
    AND (candidate->>'status') = ANY(ARRAY['draft', 'active'])
    AND public._m108b_jsonb_sha256(candidate->'snapshotSha256') IS TRUE
    AND pg_catalog.jsonb_typeof(candidate->'internalSku') = 'string'
    AND (candidate->>'internalSku') ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
    AND pg_catalog.jsonb_typeof(candidate->'componentType') = 'string'
    AND (candidate->>'componentType') = ANY(ARRAY[
      'module', 'inverter', 'battery', 'wallbox',
      'heat_pump', 'mounting', 'other'
    ]);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_expected$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_expected(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_revision(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_revision$
DECLARE
  component_type text;
BEGIN
  IF public._m108b_jsonb_exact_keys(
       candidate,
       ARRAY[
         'schemaVersion', 'canonicalizationVersion', 'identity',
         'presentation', 'technicalData', 'commercial',
         'technicalProvenance', 'snapshotSha256'
       ]
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
     OR candidate->>'schemaVersion' IS DISTINCT FROM 'catalog-component-revision.v1'
     OR pg_catalog.jsonb_typeof(candidate->'canonicalizationVersion')
       IS DISTINCT FROM 'string'
     OR candidate->>'canonicalizationVersion' IS DISTINCT FROM 'catalog-jcs.v1'
     OR public._m108b_jsonb_exact_keys(
       candidate->'identity',
       ARRAY['workspaceId', 'componentId', 'revision', 'internalSku', 'componentType']
     ) IS NOT TRUE
     OR public._m108b_jsonb_uuid(candidate#>'{identity,workspaceId}') IS NOT TRUE
     OR public._m108b_jsonb_uuid(candidate#>'{identity,componentId}') IS NOT TRUE
     OR public._m108b_jsonb_integer_between(
       candidate#>'{identity,revision}', 1, 2147483647
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate#>'{identity,internalSku}') IS DISTINCT FROM 'string'
     OR (candidate#>>'{identity,internalSku}') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
     OR pg_catalog.jsonb_typeof(candidate#>'{identity,componentType}') IS DISTINCT FROM 'string'
     OR public._m108b_jsonb_sha256(candidate->'snapshotSha256') IS NOT TRUE THEN
    RETURN false;
  END IF;
  component_type := candidate#>>'{identity,componentType}';
  IF NOT (component_type = ANY(ARRAY[
       'module', 'inverter', 'battery', 'wallbox',
       'heat_pump', 'mounting', 'other'
     ]))
     OR public._m108b_valid_catalog_import_presentation(candidate->'presentation')
       IS NOT TRUE
     OR public._m108b_valid_catalog_import_technical_data(
       component_type, candidate->'technicalData'
     ) IS NOT TRUE
     OR public._m108b_valid_catalog_import_commercial(candidate->'commercial')
       IS NOT TRUE
     OR public._m108b_valid_catalog_import_provenance(
       candidate->'technicalProvenance'
     ) IS NOT TRUE THEN
    RETURN false;
  END IF;
  RETURN component_type IN ('mounting', 'other')
    OR candidate#>>'{presentation,unit}' = 'piece';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_revision$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_revision(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_sealed_target(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_sealed_target$
DECLARE
  encoded_body text;
  decoded_body bytea;
  snapshot_hash text;
BEGIN
  IF public._m108b_jsonb_exact_keys(
       candidate,
       ARRAY['snapshot', 'bodyCanonicalBase64', 'snapshotSha256']
     ) IS NOT TRUE
     OR public._m108b_valid_catalog_import_revision(candidate->'snapshot')
       IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'bodyCanonicalBase64') IS DISTINCT FROM 'string'
     OR public._m108b_jsonb_sha256(candidate->'snapshotSha256') IS NOT TRUE THEN
    RETURN false;
  END IF;
  encoded_body := candidate->>'bodyCanonicalBase64';
  snapshot_hash := candidate->>'snapshotSha256';
  IF pg_catalog.char_length(encoded_body) NOT BETWEEN 4 AND 1000000
     OR encoded_body !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
     OR candidate#>>'{snapshot,snapshotSha256}' <> snapshot_hash THEN
    RETURN false;
  END IF;
  decoded_body := pg_catalog.decode(encoded_body, 'base64');
  RETURN pg_catalog.octet_length(decoded_body) BETWEEN 2 AND 65536
    AND pg_catalog.replace(pg_catalog.encode(decoded_body, 'base64'), E'\n', '') = encoded_body
    AND pg_catalog.convert_from(decoded_body, 'UTF8')::jsonb
      = (candidate->'snapshot') - 'snapshotSha256'
    AND pg_catalog.sha256(decoded_body) = pg_catalog.decode(snapshot_hash, 'hex');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_sealed_target$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_sealed_target(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_row_command(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_row_command$
DECLARE
  operation_value text;
  expected_value jsonb;
  source_command jsonb;
  sealed_target jsonb;
BEGIN
  IF public._m108b_jsonb_exact_keys(
       candidate,
       ARRAY[
         'schemaVersion', 'source', 'operation', 'targetComponentId',
         'expected', 'sourceCommand', 'sealedTarget', 'rowCommandSha256'
       ]
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'schemaVersion') IS DISTINCT FROM 'string'
     OR candidate->>'schemaVersion' IS DISTINCT FROM 'catalog-import-row-command.v1'
     OR public._m108b_jsonb_exact_keys(
       candidate->'source',
       ARRAY[
         'fileSha256', 'mappingSha256', 'rowNumber',
         'rowSha256', 'sourceCommandSha256'
       ]
     ) IS NOT TRUE
     OR public._m108b_jsonb_sha256(candidate#>'{source,fileSha256}') IS NOT TRUE
     OR public._m108b_jsonb_sha256(candidate#>'{source,mappingSha256}') IS NOT TRUE
     OR public._m108b_jsonb_integer_between(
       candidate#>'{source,rowNumber}', 2, 1001
     ) IS NOT TRUE
     OR public._m108b_jsonb_sha256(candidate#>'{source,rowSha256}') IS NOT TRUE
     OR public._m108b_jsonb_sha256(candidate#>'{source,sourceCommandSha256}') IS NOT TRUE
     OR pg_catalog.jsonb_typeof(candidate->'operation') IS DISTINCT FROM 'string'
     OR public._m108b_jsonb_uuid(candidate->'targetComponentId') IS NOT TRUE
     OR public._m108b_jsonb_sha256(candidate->'rowCommandSha256') IS NOT TRUE THEN
    RETURN false;
  END IF;

  operation_value := candidate->>'operation';
  expected_value := candidate->'expected';
  source_command := candidate->'sourceCommand';
  sealed_target := candidate->'sealedTarget';
  IF NOT (operation_value = ANY(ARRAY['create', 'revise', 'unchanged']))
     OR public._m108b_valid_catalog_import_source_command(source_command) IS NOT TRUE THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(expected_value) = 'object'
     AND public._m108b_valid_catalog_import_expected(expected_value) IS NOT TRUE THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_typeof(sealed_target) = 'object'
     AND public._m108b_valid_catalog_import_sealed_target(sealed_target) IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF operation_value = 'create' THEN
    IF pg_catalog.jsonb_typeof(expected_value) IS DISTINCT FROM 'null'
       OR pg_catalog.jsonb_typeof(sealed_target) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
  ELSIF operation_value = 'revise' THEN
    IF pg_catalog.jsonb_typeof(expected_value) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(sealed_target) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
  ELSE
    IF pg_catalog.jsonb_typeof(expected_value) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(sealed_target) IS DISTINCT FROM 'null' THEN
      RETURN false;
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(expected_value) = 'object'
     AND (
       expected_value->>'componentId' <> candidate->>'targetComponentId'
       OR expected_value->>'internalSku' <> source_command->>'internalSku'
       OR expected_value->>'componentType' <> source_command->>'componentType'
     ) THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(sealed_target) = 'object' THEN
    IF sealed_target#>>'{snapshot,identity,componentId}'
         <> candidate->>'targetComponentId'
       OR sealed_target#>>'{snapshot,identity,internalSku}'
         <> source_command->>'internalSku'
       OR sealed_target#>>'{snapshot,identity,componentType}'
         <> source_command->>'componentType'
       OR sealed_target#>'{snapshot,presentation}' <> source_command->'presentation'
       OR sealed_target#>'{snapshot,technicalData}' <> source_command->'technicalData'
       OR sealed_target#>'{snapshot,commercial}' <> source_command->'commercial'
       OR sealed_target#>'{snapshot,technicalProvenance}'
         <> source_command->'technicalProvenance' THEN
      RETURN false;
    END IF;
    IF operation_value = 'create'
       AND (sealed_target#>>'{snapshot,identity,revision}')::numeric <> 1 THEN
      RETURN false;
    END IF;
    IF operation_value = 'revise'
       AND (sealed_target#>>'{snapshot,identity,revision}')::numeric
         <> (expected_value->>'revision')::numeric + 1 THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_row_command$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_row_command(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_validate_catalog_import_job_input()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_validate_job_input$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  actor_ready_count integer;
  workspace_ready_count integer;
BEGIN
  -- Derselbe 64-Bit-Transaktionsmutex wie in der zentralen Gateway-Sperre.
  -- Eine theoretische Hashkollision kann nur ueber-serialisieren, niemals
  -- Workspace-Isolation oder Autorisierung lockern.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'm108b.catalog-import.workspace:' || NEW.workspace_id::text,
      1701734778
    )
  );
  PERFORM 1
    FROM public.workspace AS workspace_row
   WHERE workspace_row.id = NEW.workspace_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_import_job: Workspace fehlt';
  END IF;
  IF NEW.state <> 'ready_for_review'
     OR NEW.lease_generation <> 0
     OR NEW.lease_token IS NOT NULL
     OR NEW.lease_row_numbers IS NOT NULL
     OR NEW.lease_expires_at IS NOT NULL
     OR NEW.consecutive_failure_count <> 0
     OR NEW.next_attempt_at IS NOT NULL
     OR NEW.error_code IS NOT NULL
     OR NEW.execution_actor_id IS NOT NULL
     OR NEW.attestation_version IS NOT NULL
     OR NEW.attestation_text_sha256 IS NOT NULL
     OR NEW.attested_by IS NOT NULL
     OR NEW.attested_at IS NOT NULL
     OR NEW.started_at IS NOT NULL
     OR NEW.terminal_at IS NOT NULL
     OR NEW.snapshot_cleanup_due_at IS NOT NULL
     OR NEW.snapshot_redacted_at IS NOT NULL
     OR public._m108b_valid_catalog_import_mapping(NEW.mapping_snapshot) IS NOT TRUE
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_array_elements(NEW.mapping_snapshot->'columns')
           AS mapped_column(value)
        WHERE mapped_column.value->>'field' = ANY(ARRAY[
          'internalSku', 'componentType', 'displayName', 'manufacturer', 'model',
          'unit', 'technicalSourceKind', 'technicalReference',
          'technicalObservedOn', 'technicalRightsBasis', 'purchasePriceNet',
          'purchaseSourceKind', 'purchaseReference', 'purchaseObservedOn',
          'purchaseRightsBasis', 'salesPriceNet', 'salesSourceKind',
          'salesReference', 'salesObservedOn', 'salesRightsBasis'
        ])
     ) <> 20 THEN
    RAISE EXCEPTION 'catalog_import_job: ungueltiger persistierter Previewinput';
  END IF;
  SELECT pg_catalog.count(*) FILTER (
           WHERE job.created_by = NEW.created_by
         )::integer,
         pg_catalog.count(*)::integer
    INTO actor_ready_count, workspace_ready_count
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = NEW.workspace_id
     AND job.state = 'ready_for_review';
  IF actor_ready_count >= 3 THEN
    RAISE EXCEPTION 'catalog_import_job: Actor-Previewquote ueberschritten';
  END IF;
  IF workspace_ready_count >= 10 THEN
    RAISE EXCEPTION 'catalog_import_job: Workspace-Previewquote ueberschritten';
  END IF;
  NEW.created_at := database_time;
  NEW.updated_at := database_time;
  NEW.preview_expires_at := database_time + interval '7 days';
  RETURN NEW;
END
$m108b_validate_job_input$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_validate_catalog_import_job_input() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_validate_catalog_import_row_input()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_validate_row_input$
DECLARE
  locked_job public.catalog_import_job%ROWTYPE;
BEGIN
  IF NEW.snapshot_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_import_row: redigierter Insert ist verboten';
  END IF;
  SELECT job.* INTO locked_job
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = NEW.workspace_id
     AND job.id = NEW.job_id;
  IF NOT FOUND OR locked_job.snapshot_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_import_row: unredigierter Job fehlt';
  END IF;

  IF NEW.validation_status = 'valid' THEN
    IF public._m108b_valid_catalog_import_row_command(NEW.command_snapshot)
         IS NOT TRUE THEN
      RAISE EXCEPTION 'catalog_import_row: ungueltiger persistierter Row-Command';
    END IF;
    IF NEW.command_snapshot#>>'{source,fileSha256}'
         <> pg_catalog.encode(locked_job.file_sha256, 'hex')
       OR NEW.command_snapshot#>>'{source,mappingSha256}'
         <> pg_catalog.encode(locked_job.mapping_sha256, 'hex') THEN
      RAISE EXCEPTION 'catalog_import_row: file_sha256 oder mapping_sha256 driftet';
    END IF;
    IF pg_catalog.jsonb_typeof(NEW.command_snapshot->'sealedTarget') = 'object'
       AND NEW.command_snapshot#>>'{sealedTarget,snapshot,identity,workspaceId}'
         <> (NEW.workspace_id)::text THEN
      RAISE EXCEPTION 'catalog_import_row: Target-Workspace driftet';
    END IF;
  ELSIF NEW.validation_status = 'invalid' THEN
    IF public._m108b_valid_catalog_import_error_array(NEW.error_snapshot)
         IS NOT TRUE THEN
      RAISE EXCEPTION 'catalog_import_row: ungueltiger persistierter Fehler';
    END IF;
    IF NEW.normalized_sku IS NOT NULL AND (
         pg_catalog.char_length(NEW.normalized_sku) NOT BETWEEN 1 AND 64
         OR NEW.normalized_sku !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
       ) THEN
      RAISE EXCEPTION 'catalog_import_row: ungueltige Fehler-SKU';
    END IF;
  ELSE
    RAISE EXCEPTION 'catalog_import_row: ungueltiger Validierungsstatus';
  END IF;
  NEW.created_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$m108b_validate_row_input$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_validate_catalog_import_row_input() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_validate_catalog_import_result_input()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_validate_result_input$
DECLARE
  locked_job public.catalog_import_job%ROWTYPE;
  locked_row public.catalog_import_row%ROWTYPE;
  expected_result_state text;
  expected_revision integer;
BEGIN
  SELECT job.* INTO locked_job
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = NEW.workspace_id
     AND job.id = NEW.job_id
   FOR UPDATE;
  IF NOT FOUND
     OR locked_job.state <> 'running'
     OR locked_job.lease_expires_at <= pg_catalog.clock_timestamp()
     OR NOT (NEW.row_number = ANY(locked_job.lease_row_numbers)) THEN
    RAISE EXCEPTION 'catalog_import_row_result: aktive Job-Lease fehlt';
  END IF;

  SELECT import_row.* INTO locked_row
    FROM public.catalog_import_row AS import_row
   WHERE import_row.workspace_id = NEW.workspace_id
     AND import_row.job_id = NEW.job_id
     AND import_row.row_number = NEW.row_number
   FOR UPDATE;
  IF NOT FOUND OR locked_row.validation_status <> 'valid' THEN
    RAISE EXCEPTION 'catalog_import_row_result: gueltige Importzeile fehlt';
  END IF;

  IF NEW.result_state = 'conflict' THEN
    NEW.created_at := pg_catalog.transaction_timestamp();
    RETURN NEW;
  END IF;
  expected_result_state := CASE locked_row.operation
    WHEN 'create' THEN 'created'
    WHEN 'revise' THEN 'revised'
    WHEN 'unchanged' THEN 'unchanged'
    ELSE NULL
  END;
  expected_revision := CASE
    WHEN locked_row.operation = 'unchanged' THEN locked_row.expected_revision
    ELSE (locked_row.command_snapshot#>>'{sealedTarget,snapshot,identity,revision}')::integer
  END;
  IF NEW.result_state IS DISTINCT FROM expected_result_state
     OR NEW.component_id IS DISTINCT FROM locked_row.target_component_id
     OR NEW.revision IS DISTINCT FROM expected_revision
     OR NEW.snapshot_sha256 IS DISTINCT FROM locked_row.target_snapshot_sha256 THEN
    RAISE EXCEPTION 'catalog_import_row_result: Ergebnis driftet vom versiegelten Ziel';
  END IF;
  NEW.created_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$m108b_validate_result_input$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_validate_catalog_import_result_input() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_valid_catalog_import_lease_rows(candidate integer[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_valid_lease_rows$
DECLARE
  row_count integer;
  distinct_count integer;
  minimum_row integer;
  maximum_row integer;
BEGIN
  IF candidate IS NULL
     OR pg_catalog.cardinality(candidate) NOT BETWEEN 1 AND 25
     OR pg_catalog.array_ndims(candidate) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(candidate, 1) IS DISTINCT FROM 1
     OR pg_catalog.array_upper(candidate, 1) IS DISTINCT FROM
       pg_catalog.cardinality(candidate)
     OR pg_catalog.array_position(candidate, NULL) IS NOT NULL THEN
    RETURN false;
  END IF;
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(DISTINCT row_number)::integer,
         pg_catalog.min(row_number),
         pg_catalog.max(row_number)
    INTO row_count, distinct_count, minimum_row, maximum_row
    FROM pg_catalog.unnest(candidate) AS lease_row(row_number);
  RETURN row_count = distinct_count
    AND minimum_row >= 2
    AND maximum_row <= 1001;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_valid_lease_rows$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_valid_catalog_import_lease_rows(integer[])
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_redact_catalog_import_error_array(candidate jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $m108b_redact_error_array$
DECLARE
  redacted jsonb;
BEGIN
  IF candidate IS NULL THEN
    RETURN NULL;
  END IF;
  IF public._m108b_valid_catalog_import_error_array(candidate) IS NOT TRUE THEN
    RAISE EXCEPTION 'catalog_import_row: Fehlerhistorie ist nicht redigierbar';
  END IF;
  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_set(
             error_entry.value,
             ARRAY['sourceHeader'],
             'null'::jsonb,
             false
           )
           ORDER BY error_entry.ordinality
         )
    INTO redacted
    FROM pg_catalog.jsonb_array_elements(candidate)
      WITH ORDINALITY AS error_entry(value, ordinality);
  RETURN redacted;
END
$m108b_redact_error_array$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_redact_catalog_import_error_array(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_guard_catalog_import_job()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_guard_job$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  result_total_count integer;
  result_success_count integer;
  result_conflict_count integer;
  result_invalid_row_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog_import_job ist WORM; DELETE ist verboten';
  END IF;

  IF ROW(
    NEW.id, NEW.workspace_id, NEW.intent_id, NEW.reservation_key,
    NEW.file_size_bytes, NEW.file_sha256, NEW.encoding, NEW.delimiter,
    NEW.contract_version, NEW.parser_version, NEW.mapping_version,
    NEW.mapping_sha256, NEW.total_count, NEW.valid_count, NEW.invalid_count,
    NEW.created_by, NEW.created_at, NEW.preview_expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.workspace_id, OLD.intent_id, OLD.reservation_key,
    OLD.file_size_bytes, OLD.file_sha256, OLD.encoding, OLD.delimiter,
    OLD.contract_version, OLD.parser_version, OLD.mapping_version,
    OLD.mapping_sha256, OLD.total_count, OLD.valid_count, OLD.invalid_count,
    OLD.created_by, OLD.created_at, OLD.preview_expires_at
  ) THEN
    RAISE EXCEPTION 'catalog_import_job: stabile Previewbindung ist immutable';
  END IF;

  IF OLD.snapshot_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_import_job: redigierter Zustand ist immutable';
  END IF;

  IF NEW.snapshot_redacted_at IS DISTINCT FROM OLD.snapshot_redacted_at THEN
    IF NEW.snapshot_redacted_at IS NULL
       OR OLD.state NOT IN ('succeeded', 'partial', 'failed_final', 'cancelled_before_start')
       OR OLD.snapshot_cleanup_due_at IS NULL
       OR database_time < OLD.snapshot_cleanup_due_at
       OR NEW.file_name IS NOT NULL
       OR NEW.mapping_snapshot IS NOT NULL
       OR NEW.mapping_body_canonical IS NOT NULL
       OR NEW.sensitive_payload_bytes <> 0 THEN
      RAISE EXCEPTION 'catalog_import_job: Vollredaction ist unvollstaendig oder zu frueh';
    END IF;
    IF ROW(
      NEW.state, NEW.lease_generation, NEW.lease_token, NEW.lease_row_numbers,
      NEW.lease_expires_at, NEW.consecutive_failure_count, NEW.next_attempt_at,
      NEW.error_code, NEW.execution_actor_id, NEW.attestation_version,
      NEW.attestation_text_sha256, NEW.attested_by, NEW.attested_at,
      NEW.updated_at, NEW.started_at, NEW.terminal_at,
      NEW.snapshot_cleanup_due_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.lease_generation, OLD.lease_token, OLD.lease_row_numbers,
      OLD.lease_expires_at, OLD.consecutive_failure_count, OLD.next_attempt_at,
      OLD.error_code, OLD.execution_actor_id, OLD.attestation_version,
      OLD.attestation_text_sha256, OLD.attested_by, OLD.attested_at,
      OLD.updated_at, OLD.started_at, OLD.terminal_at,
      OLD.snapshot_cleanup_due_at
    ) THEN
      RAISE EXCEPTION 'catalog_import_job: Redaction darf keine Metadaten aendern';
    END IF;
    NEW.snapshot_redacted_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'ready_for_review'
     AND NEW.state = OLD.state
     AND NEW.sensitive_payload_bytes IS DISTINCT FROM OLD.sensitive_payload_bytes
     AND ROW(
       NEW.file_name, NEW.mapping_snapshot, NEW.mapping_body_canonical,
       NEW.lease_generation, NEW.lease_token, NEW.lease_row_numbers,
       NEW.lease_expires_at, NEW.consecutive_failure_count, NEW.next_attempt_at,
       NEW.error_code, NEW.execution_actor_id, NEW.attestation_version,
       NEW.attestation_text_sha256, NEW.attested_by, NEW.attested_at,
       NEW.updated_at, NEW.started_at, NEW.terminal_at,
       NEW.snapshot_cleanup_due_at
     ) IS NOT DISTINCT FROM ROW(
       OLD.file_name, OLD.mapping_snapshot, OLD.mapping_body_canonical,
       OLD.lease_generation, OLD.lease_token, OLD.lease_row_numbers,
       OLD.lease_expires_at, OLD.consecutive_failure_count, OLD.next_attempt_at,
       OLD.error_code, OLD.execution_actor_id, OLD.attestation_version,
       OLD.attestation_text_sha256, OLD.attested_by, OLD.attested_at,
       OLD.updated_at, OLD.started_at, OLD.terminal_at,
       OLD.snapshot_cleanup_due_at
     ) THEN
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.file_name, NEW.mapping_snapshot, NEW.mapping_body_canonical,
    NEW.sensitive_payload_bytes
  ) IS DISTINCT FROM ROW(
    OLD.file_name, OLD.mapping_snapshot, OLD.mapping_body_canonical,
    OLD.sensitive_payload_bytes
  ) THEN
    RAISE EXCEPTION 'catalog_import_job: sensible Previewdaten sind immutable';
  END IF;

  IF NOT (OLD.state = 'ready_for_review' AND NEW.state = 'queued')
     AND ROW(
       NEW.execution_actor_id, NEW.attestation_version,
       NEW.attestation_text_sha256, NEW.attested_by, NEW.attested_at,
       NEW.started_at
     ) IS DISTINCT FROM ROW(
       OLD.execution_actor_id, OLD.attestation_version,
       OLD.attestation_text_sha256, OLD.attested_by, OLD.attested_at,
       OLD.started_at
     ) THEN
    RAISE EXCEPTION 'catalog_import_job: Execution-Actor und Attestation sind immutable';
  END IF;

  IF OLD.state = 'ready_for_review' AND NEW.state = 'queued' THEN
    IF OLD.valid_count = 0
       OR NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(OLD.lease_token, OLD.lease_row_numbers, OLD.lease_expires_at)
       OR NEW.consecutive_failure_count <> 0
       OR NEW.error_code IS NOT NULL
       OR NEW.next_attempt_at IS DISTINCT FROM database_time
       OR NEW.execution_actor_id IS NULL
       OR NEW.attestation_version <> 'catalog-import-rights-attestation.v1'
       OR NEW.attestation_text_sha256 <> pg_catalog.decode(
         '4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8',
         'hex'
       )
       OR NEW.attested_by IS DISTINCT FROM NEW.execution_actor_id
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Start';
    END IF;
    NEW.attested_at := database_time;
    NEW.started_at := database_time;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'ready_for_review' AND NEW.state = 'cancelled_before_start' THEN
    IF ROW(
      NEW.lease_generation, NEW.lease_token, NEW.lease_row_numbers,
      NEW.lease_expires_at, NEW.consecutive_failure_count, NEW.next_attempt_at,
      NEW.error_code
    ) IS DISTINCT FROM ROW(
      OLD.lease_generation, OLD.lease_token, OLD.lease_row_numbers,
      OLD.lease_expires_at, OLD.consecutive_failure_count, OLD.next_attempt_at,
      OLD.error_code
    ) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Abbruch';
    END IF;
    NEW.terminal_at := database_time;
    NEW.snapshot_cleanup_due_at := greatest(
      OLD.created_at + interval '30 days', database_time
    );
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('queued', 'retry_wait') AND NEW.state = 'running' THEN
    IF NEW.lease_generation <> OLD.lease_generation + 1
       OR public._m108b_valid_catalog_import_lease_rows(NEW.lease_row_numbers)
         IS NOT TRUE
       OR NEW.lease_token IS NULL
       OR NEW.lease_expires_at IS DISTINCT FROM database_time + interval '3 minutes'
       OR NEW.consecutive_failure_count <> OLD.consecutive_failure_count
       OR NEW.next_attempt_at IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at)
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.unnest(NEW.lease_row_numbers) AS lease_row(row_number)
           LEFT JOIN public.catalog_import_row AS import_row
             ON import_row.workspace_id = OLD.workspace_id
            AND import_row.job_id = OLD.id
            AND import_row.row_number = lease_row.row_number
            AND import_row.validation_status = 'valid'
           LEFT JOIN public.catalog_import_row_result AS import_result
             ON import_result.workspace_id = OLD.workspace_id
            AND import_result.job_id = OLD.id
            AND import_result.row_number = lease_row.row_number
          WHERE import_row.id IS NULL OR import_result.id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltige Claim-Bindung';
    END IF;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'queued' AND NEW.state = 'retry_wait' THEN
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(OLD.lease_token, OLD.lease_row_numbers, OLD.lease_expires_at)
       OR NEW.consecutive_failure_count <> 1
       OR NEW.error_code <> ALL(ARRAY[
         'enqueue_failed', 'queue_locator_invalid'
       ])
       OR NEW.next_attempt_at IS DISTINCT FROM
         database_time + interval '30 seconds'
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger erster Retry';
    END IF;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'retry_wait' AND NEW.state = 'retry_wait' THEN
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(OLD.lease_token, OLD.lease_row_numbers, OLD.lease_expires_at)
       OR NEW.consecutive_failure_count <> OLD.consecutive_failure_count + 1
       OR NEW.consecutive_failure_count <> 2
       OR NEW.error_code <> ALL(ARRAY[
         'enqueue_failed', 'queue_locator_invalid'
       ])
       OR NEW.next_attempt_at IS DISTINCT FROM
         database_time + interval '60 seconds'
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger zweiter Retry';
    END IF;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'queued' THEN
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(NULL::uuid, NULL::integer[], NULL::timestamptz)
       OR NEW.consecutive_failure_count <> 0
       OR NEW.next_attempt_at IS DISTINCT FROM database_time
       OR NEW.error_code IS NOT NULL
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Batchfortschritt';
    END IF;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'retry_wait' THEN
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(NULL::uuid, NULL::integer[], NULL::timestamptz)
       OR NEW.consecutive_failure_count <> OLD.consecutive_failure_count + 1
       OR NEW.consecutive_failure_count NOT BETWEEN 1 AND 2
       OR NEW.error_code <> ALL(ARRAY[
         'lease_lost', 'enqueue_failed', 'queue_locator_invalid'
       ])
       OR NEW.next_attempt_at IS DISTINCT FROM database_time + (CASE
         WHEN NEW.consecutive_failure_count = 1 THEN interval '30 seconds'
         ELSE interval '60 seconds'
       END)
       OR ROW(NEW.terminal_at, NEW.snapshot_cleanup_due_at)
         IS DISTINCT FROM ROW(OLD.terminal_at, OLD.snapshot_cleanup_due_at) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger technischer Batchfehler';
    END IF;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state IN ('succeeded', 'partial') THEN
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_result.result_state IN ('created', 'revised', 'unchanged')
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_result.result_state = 'conflict'
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_row.validation_status IS DISTINCT FROM 'valid'
           )::integer
      INTO result_total_count, result_success_count,
           result_conflict_count, result_invalid_row_count
      FROM public.catalog_import_row_result AS import_result
      LEFT JOIN public.catalog_import_row AS import_row
        ON import_row.workspace_id = import_result.workspace_id
       AND import_row.job_id = import_result.job_id
       AND import_row.row_number = import_result.row_number
     WHERE import_result.workspace_id = OLD.workspace_id
       AND import_result.job_id = OLD.id;
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(NULL::uuid, NULL::integer[], NULL::timestamptz)
       OR NEW.consecutive_failure_count <> 0
       OR NEW.next_attempt_at IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR result_invalid_row_count <> 0
       OR result_total_count <> OLD.valid_count
       OR result_success_count + result_conflict_count <> OLD.valid_count
       OR (
         NEW.state = 'succeeded'
         AND NOT (
           OLD.invalid_count = 0
           AND result_success_count = OLD.valid_count
           AND result_conflict_count = 0
         )
       )
       OR (
         NEW.state = 'partial'
         AND NOT (
           result_success_count >= 1
           AND (OLD.invalid_count > 0 OR result_conflict_count > 0)
         )
       ) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Erfolgsabschluss';
    END IF;
    NEW.terminal_at := database_time;
    NEW.snapshot_cleanup_due_at := greatest(
      OLD.created_at + interval '30 days', database_time
    );
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'failed_final' THEN
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_result.result_state IN ('created', 'revised', 'unchanged')
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_result.result_state = 'conflict'
           )::integer,
           pg_catalog.count(*) FILTER (
             WHERE import_row.validation_status IS DISTINCT FROM 'valid'
           )::integer
      INTO result_total_count, result_success_count,
           result_conflict_count, result_invalid_row_count
      FROM public.catalog_import_row_result AS import_result
      LEFT JOIN public.catalog_import_row AS import_row
        ON import_row.workspace_id = import_result.workspace_id
       AND import_row.job_id = import_result.job_id
       AND import_row.row_number = import_result.row_number
     WHERE import_result.workspace_id = OLD.workspace_id
       AND import_result.job_id = OLD.id;
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(NULL::uuid, NULL::integer[], NULL::timestamptz)
       OR NEW.next_attempt_at IS NOT NULL
       OR NOT (
         (OLD.consecutive_failure_count = 2
           AND NEW.consecutive_failure_count = 3
           AND NEW.error_code = 'technical_retry_exhausted')
         OR (NEW.consecutive_failure_count = 0
           AND NEW.error_code = ANY(ARRAY[
             'actor_revoked', 'capability_revoked',
             'invalid_persisted_input', 'all_rows_conflicted'
           ]))
       )
       OR (
         NEW.error_code = 'all_rows_conflicted'
         AND NOT (
           OLD.valid_count > 0
           AND result_invalid_row_count = 0
           AND result_total_count = OLD.valid_count
           AND result_success_count = 0
           AND result_conflict_count = OLD.valid_count
         )
       ) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Fehlerabschluss';
    END IF;
    NEW.terminal_at := database_time;
    NEW.snapshot_cleanup_due_at := greatest(
      OLD.created_at + interval '30 days', database_time
    );
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('queued', 'retry_wait') AND NEW.state = 'failed_final' THEN
    IF NEW.lease_generation <> OLD.lease_generation
       OR ROW(NEW.lease_token, NEW.lease_row_numbers, NEW.lease_expires_at)
         IS DISTINCT FROM ROW(OLD.lease_token, OLD.lease_row_numbers, OLD.lease_expires_at)
       OR NEW.next_attempt_at IS NOT NULL
       OR NOT (
         (OLD.state = 'retry_wait' AND OLD.consecutive_failure_count = 2
           AND NEW.consecutive_failure_count = 3
           AND NEW.error_code = 'technical_retry_exhausted')
         OR (NEW.consecutive_failure_count = 0
           AND NEW.error_code = ANY(ARRAY[
             'actor_revoked', 'capability_revoked', 'invalid_persisted_input'
           ]))
       ) THEN
      RAISE EXCEPTION 'catalog_import_job: ungueltiger Pre-Claim-Abschluss';
    END IF;
    NEW.terminal_at := database_time;
    NEW.snapshot_cleanup_due_at := greatest(
      OLD.created_at + interval '30 days', database_time
    );
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'catalog_import_job: unzulaessiger Zustandsuebergang % -> %',
    OLD.state, NEW.state;
END
$m108b_guard_job$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_guard_catalog_import_job() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_guard_catalog_import_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_guard_row$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  cleanup_due_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog_import_row ist WORM; DELETE ist verboten';
  END IF;
  IF OLD.snapshot_redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'catalog_import_row: redigierter Zustand ist immutable';
  END IF;
  IF NEW.snapshot_redacted_at IS NULL THEN
    RAISE EXCEPTION 'catalog_import_row ist ausserhalb der Vollredaction immutable';
  END IF;

  SELECT job.snapshot_cleanup_due_at
    INTO cleanup_due_at
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = OLD.workspace_id
     AND job.id = OLD.job_id;
  IF NOT FOUND OR cleanup_due_at IS NULL OR database_time < cleanup_due_at THEN
    RAISE EXCEPTION 'catalog_import_row: Redaction ist zu frueh';
  END IF;
  NEW.snapshot_redacted_at := database_time;

  IF ROW(
    NEW.id, NEW.workspace_id, NEW.job_id, NEW.row_number,
    NEW.validation_status, NEW.operation, NEW.row_sha256,
    NEW.source_command_sha256, NEW.row_command_sha256,
    NEW.target_component_id, NEW.target_snapshot_sha256,
    NEW.expected_component_id, NEW.expected_revision, NEW.expected_status,
    NEW.expected_snapshot_sha256, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.workspace_id, OLD.job_id, OLD.row_number,
    OLD.validation_status, OLD.operation, OLD.row_sha256,
    OLD.source_command_sha256, OLD.row_command_sha256,
    OLD.target_component_id, OLD.target_snapshot_sha256,
    OLD.expected_component_id, OLD.expected_revision, OLD.expected_status,
    OLD.expected_snapshot_sha256, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'catalog_import_row: stabile Zeilenbindung ist immutable';
  END IF;

  IF NEW.normalized_sku IS NOT NULL
     OR NEW.command_snapshot IS NOT NULL
     OR NEW.preview_row_body_canonical IS NOT NULL
     OR NEW.source_command_body_canonical IS NOT NULL
     OR NEW.row_command_body_canonical IS NOT NULL
     OR NEW.sealed_target_snapshot IS NOT NULL
     OR NEW.sealed_target_body_canonical IS NOT NULL
     OR NEW.sensitive_payload_bytes <> 0
     OR NEW.error_snapshot IS DISTINCT FROM
       public._m108b_redact_catalog_import_error_array(OLD.error_snapshot) THEN
    RAISE EXCEPTION 'catalog_import_row: Vollredaction ist unvollstaendig';
  END IF;

  RETURN NEW;
END
$m108b_guard_row$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_guard_catalog_import_row() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_catalog_import_error_source_header_bytes(
  error_snapshot jsonb
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $m108b_error_header_bytes$
DECLARE
  payload_bytes bigint;
BEGIN
  IF error_snapshot IS NULL THEN
    RETURN 0;
  END IF;
  IF pg_catalog.jsonb_typeof(error_snapshot) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'catalog_import_row.error_snapshot muss ein Array sein';
  END IF;
  SELECT COALESCE(pg_catalog.sum(
    pg_catalog.octet_length(
      pg_catalog.convert_to(error_entry.value->>'sourceHeader', 'UTF8')
    )
  ), 0)::bigint
    INTO payload_bytes
    FROM pg_catalog.jsonb_array_elements(error_snapshot) AS error_entry(value)
   WHERE pg_catalog.jsonb_typeof(error_entry.value) = 'object'
     AND pg_catalog.jsonb_typeof(error_entry.value->'sourceHeader') = 'string';
  IF payload_bytes > 31457280 THEN
    RAISE EXCEPTION 'catalog_import_row.error_snapshot ueberschreitet das Sensitivbudget';
  END IF;
  RETURN payload_bytes::integer;
END
$m108b_error_header_bytes$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_catalog_import_error_source_header_bytes(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_derive_catalog_import_row_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_derive_row_payload$
DECLARE
  payload_bytes bigint;
BEGIN
  payload_bytes :=
    COALESCE(pg_catalog.octet_length(
      pg_catalog.convert_to(NEW.normalized_sku, 'UTF8')
    ), 0)
    + COALESCE(pg_catalog.octet_length(pg_catalog.convert_to(
      NEW.command_snapshot::text,
      'UTF8'
    )), 0)
    + COALESCE(pg_catalog.octet_length(NEW.preview_row_body_canonical), 0)
    + COALESCE(pg_catalog.octet_length(NEW.source_command_body_canonical), 0)
    + COALESCE(pg_catalog.octet_length(NEW.row_command_body_canonical), 0)
    + public._m108b_catalog_import_error_source_header_bytes(NEW.error_snapshot)
    + COALESCE(pg_catalog.octet_length(pg_catalog.convert_to(
      NEW.sealed_target_snapshot::text,
      'UTF8'
    )), 0)
    + COALESCE(pg_catalog.octet_length(NEW.sealed_target_body_canonical), 0);
  IF payload_bytes > 31457280 THEN
    RAISE EXCEPTION 'catalog_import_row ueberschreitet das Sensitivbudget';
  END IF;
  NEW.sensitive_payload_bytes := payload_bytes::integer;
  RETURN NEW;
END
$m108b_derive_row_payload$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_derive_catalog_import_row_payload() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_validate_catalog_import_redaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_validate_redaction$
DECLARE
  target_workspace_id uuid;
  target_job_id uuid;
  job_record public.catalog_import_job%ROWTYPE;
  actual_total integer;
  actual_valid integer;
  actual_invalid integer;
  minimum_row_number integer;
  maximum_row_number integer;
  expected_payload_bytes bigint;
  workspace_payload_bytes bigint;
BEGIN
  target_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
  IF TG_TABLE_NAME = 'catalog_import_job' THEN
    target_job_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_job_id := COALESCE(NEW.job_id, OLD.job_id);
  END IF;

  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = target_workspace_id
     AND job.id = target_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_import_job: deferred Vollstaendigkeitsbindung fehlt';
  END IF;

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(*) FILTER (
           WHERE import_row.validation_status = 'valid'
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE import_row.validation_status = 'invalid'
         )::integer,
         pg_catalog.min(import_row.row_number)::integer,
         pg_catalog.max(import_row.row_number)::integer
    INTO actual_total, actual_valid, actual_invalid,
         minimum_row_number, maximum_row_number
    FROM public.catalog_import_row AS import_row
   WHERE import_row.workspace_id = target_workspace_id
     AND import_row.job_id = target_job_id;
  IF ROW(actual_total, actual_valid, actual_invalid) IS DISTINCT FROM ROW(
    job_record.total_count, job_record.valid_count, job_record.invalid_count
  ) THEN
    RAISE EXCEPTION 'catalog_import_job: Row-Counts sind nicht DB-vollstaendig';
  END IF;
  IF minimum_row_number IS DISTINCT FROM 2
     OR maximum_row_number IS DISTINCT FROM actual_total + 1 THEN
    RAISE EXCEPTION 'catalog_import_job: Row-Nummern sind nicht lueckenlos';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.catalog_import_row AS import_row
     WHERE import_row.workspace_id = target_workspace_id
       AND import_row.job_id = target_job_id
       AND import_row.normalized_sku IS NOT NULL
     GROUP BY import_row.normalized_sku
    HAVING pg_catalog.count(*) > 1
       AND pg_catalog.bool_or(import_row.validation_status = 'valid')
  ) THEN
    RAISE EXCEPTION 'catalog_import_job: Datei-Duplikat enthaelt valide Zeile';
  END IF;

  expected_payload_bytes :=
    COALESCE(pg_catalog.octet_length(
      pg_catalog.convert_to(job_record.file_name, 'UTF8')
    ), 0)
    + COALESCE(pg_catalog.octet_length(pg_catalog.convert_to(
      job_record.mapping_snapshot::text,
      'UTF8'
    )), 0)
    + COALESCE(pg_catalog.octet_length(job_record.mapping_body_canonical), 0)
    + COALESCE((
      SELECT pg_catalog.sum(import_row.sensitive_payload_bytes)::bigint
        FROM public.catalog_import_row AS import_row
       WHERE import_row.workspace_id = target_workspace_id
         AND import_row.job_id = target_job_id
    ), 0);
  IF job_record.sensitive_payload_bytes::bigint IS DISTINCT FROM
     expected_payload_bytes THEN
    RAISE EXCEPTION
      'catalog_import_job: sensitive_payload_bytes sind nicht DB-abgeleitet (% statt %)',
      job_record.sensitive_payload_bytes, expected_payload_bytes;
  END IF;

  SELECT COALESCE(pg_catalog.sum(job.sensitive_payload_bytes), 0)::bigint
    INTO workspace_payload_bytes
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = target_workspace_id
     AND job.snapshot_redacted_at IS NULL;
  IF workspace_payload_bytes > 31457280 THEN
    RAISE EXCEPTION 'catalog_import_job: Workspace-Sensitivbudget ueberschritten';
  END IF;

  IF job_record.snapshot_redacted_at IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.catalog_import_row AS import_row
       WHERE import_row.workspace_id = target_workspace_id
         AND import_row.job_id = target_job_id
         AND import_row.snapshot_redacted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'catalog_import_job: Teilredaction ist verboten';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM public.catalog_import_row AS import_row
     WHERE import_row.workspace_id = target_workspace_id
       AND import_row.job_id = target_job_id
       AND import_row.snapshot_redacted_at IS DISTINCT FROM
         job_record.snapshot_redacted_at
  ) THEN
    RAISE EXCEPTION 'catalog_import_job: Job und alle Rows brauchen identische Redactionzeit';
  END IF;

  RETURN NULL;
END
$m108b_validate_redaction$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_validate_catalog_import_redaction() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_validate_catalog_import_dispatch_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m108b_validate_dispatch_receipt$
DECLARE
  job_record public.catalog_import_job%ROWTYPE;
BEGIN
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = NEW.workspace_id
     AND job.id = NEW.job_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR job_record.lease_generation IS DISTINCT FROM NEW.lease_generation
     OR job_record.state IS DISTINCT FROM NEW.outcome_state
     OR job_record.consecutive_failure_count IS DISTINCT FROM
       NEW.outcome_failure_count
     OR job_record.error_code IS DISTINCT FROM NEW.outcome_error_code
     OR job_record.next_attempt_at IS DISTINCT FROM NEW.outcome_next_attempt_at THEN
    RAISE EXCEPTION 'catalog_import_dispatch_receipt: Outcome ist nicht jobgebunden';
  END IF;
  NEW.recorded_at := pg_catalog.transaction_timestamp();
  RETURN NEW;
END
$m108b_validate_dispatch_receipt$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_validate_catalog_import_dispatch_receipt()
  FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER catalog_import_job_validate_input
  BEFORE INSERT ON public.catalog_import_job
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_job_input();
--> statement-breakpoint
CREATE TRIGGER catalog_import_job_guard
  BEFORE UPDATE OR DELETE ON public.catalog_import_job
  FOR EACH ROW EXECUTE FUNCTION public._m108b_guard_catalog_import_job();
--> statement-breakpoint
CREATE TRIGGER catalog_import_job_no_truncate
  BEFORE TRUNCATE ON public.catalog_import_job
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_derive_payload
  BEFORE INSERT OR UPDATE ON public.catalog_import_row
  FOR EACH ROW EXECUTE FUNCTION public._m108b_derive_catalog_import_row_payload();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_validate_input
  BEFORE INSERT ON public.catalog_import_row
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_row_input();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_guard
  BEFORE UPDATE OR DELETE ON public.catalog_import_row
  FOR EACH ROW EXECUTE FUNCTION public._m108b_guard_catalog_import_row();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_no_truncate
  BEFORE TRUNCATE ON public.catalog_import_row
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_result_immutable
  BEFORE UPDATE OR DELETE ON public.catalog_import_row_result
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_result_validate_input
  BEFORE INSERT ON public.catalog_import_row_result
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_result_input();
--> statement-breakpoint
CREATE TRIGGER catalog_import_row_result_no_truncate
  BEFORE TRUNCATE ON public.catalog_import_row_result
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_import_dispatch_receipt_validate_input
  BEFORE INSERT ON public.catalog_import_dispatch_receipt
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_dispatch_receipt();
--> statement-breakpoint
CREATE TRIGGER catalog_import_dispatch_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.catalog_import_dispatch_receipt
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_import_dispatch_receipt_no_truncate
  BEFORE TRUNCATE ON public.catalog_import_dispatch_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_import_job_redaction_complete
  AFTER INSERT OR UPDATE ON public.catalog_import_job
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_redaction();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_import_row_redaction_complete
  AFTER INSERT OR UPDATE ON public.catalog_import_row
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._m108b_validate_catalog_import_redaction();
--> statement-breakpoint

-- Runtime- und Worker-Gateways benutzen dieselbe Workspace-first-
-- Lockreihenfolge. Direkte Tabellenrechte bleiben fuer beide Rollen entzogen.
CREATE FUNCTION public._m108b_lock_catalog_import_workspace(
  requested_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_lock_workspace$
DECLARE
  context_workspace_id uuid;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'catalog import requires READ COMMITTED'
      USING ERRCODE = '25001';
  END IF;
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'catalog import context is not authorized'
      USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'catalog import context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  -- Serialisiert alle Import-Gateways eines Workspaces, ohne den
  -- Workspace-Zeilenlock mit Katalog-FKs oder dem Tenant-Commit-Gate in eine
  -- inverse Sperrreihenfolge zu bringen.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'm108b.catalog-import.workspace:' || requested_workspace_id::text,
      1701734778
    )
  );
  PERFORM 1
    FROM public.workspace AS workspace_record
   WHERE workspace_record.id = requested_workspace_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog import context is not authorized'
      USING ERRCODE = '42501';
  END IF;
END
$m108b_lock_workspace$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_lock_catalog_import_workspace(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_catalog_import_actor_auth_code(
  requested_workspace_id uuid,
  requested_actor_id uuid
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_actor_auth$
DECLARE
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  IF requested_actor_id IS NULL THEN
    RETURN 'actor_revoked';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = requested_actor_id;
  IF NOT FOUND THEN
    RETURN 'actor_revoked';
  END IF;
  IF actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value)
          IS DISTINCT FROM 'boolean'
     )
     OR (
       actor_capabilities ? 'external_only'
       AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RETURN 'actor_revoked';
  END IF;
  IF actor_role <> 'admin' AND (
    actor_capabilities->'manage_catalog' IS DISTINCT FROM 'true'::jsonb
    OR actor_capabilities->'edit_prices' IS DISTINCT FROM 'true'::jsonb
    OR actor_capabilities->'see_purchase_prices' IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RETURN 'capability_revoked';
  END IF;
  RETURN NULL;
END
$m108b_actor_auth$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_catalog_import_actor_auth_code(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_authorize_catalog_import_runtime(
  requested_workspace_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_authorize_runtime$
DECLARE
  actor_id uuid;
  auth_code text;
BEGIN
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  BEGIN
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'catalog import context is not authorized'
      USING ERRCODE = '42501';
  END;
  auth_code := public._m108b_catalog_import_actor_auth_code(
    requested_workspace_id,
    actor_id
  );
  IF auth_code IS NOT NULL THEN
    RAISE EXCEPTION 'catalog import context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  RETURN actor_id;
END
$m108b_authorize_runtime$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_authorize_catalog_import_runtime(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_catalog_import_persisted_input_valid(
  requested_workspace_id uuid,
  requested_import_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_persisted_input_valid$
DECLARE
  job_record public.catalog_import_job%ROWTYPE;
  actual_total integer;
  actual_valid integer;
  actual_invalid integer;
  minimum_row integer;
  maximum_row integer;
  every_row_valid boolean;
BEGIN
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  IF NOT FOUND OR job_record.snapshot_redacted_at IS NOT NULL
     OR public._m108b_valid_catalog_import_mapping(job_record.mapping_snapshot)
       IS NOT TRUE
     OR pg_catalog.sha256(job_record.mapping_body_canonical)
       IS DISTINCT FROM job_record.mapping_sha256 THEN
    RETURN false;
  END IF;
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(*) FILTER (
           WHERE import_row.validation_status = 'valid'
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE import_row.validation_status = 'invalid'
         )::integer,
         pg_catalog.min(import_row.row_number)::integer,
         pg_catalog.max(import_row.row_number)::integer,
         COALESCE(pg_catalog.bool_and(CASE
           WHEN import_row.validation_status = 'valid' THEN
             public._m108b_valid_catalog_import_row_command(
               import_row.command_snapshot
             ) IS TRUE
             AND import_row.command_snapshot#>>'{source,fileSha256}' =
               pg_catalog.encode(job_record.file_sha256, 'hex')
             AND import_row.command_snapshot#>>'{source,mappingSha256}' =
               pg_catalog.encode(job_record.mapping_sha256, 'hex')
             AND (
               import_row.operation = 'create'
               OR EXISTS (
                 SELECT 1
                   FROM public.catalog_component_revision
                     AS expected_revision_record
                  WHERE expected_revision_record.workspace_id =
                        import_row.workspace_id
                    AND expected_revision_record.component_id =
                        import_row.expected_component_id
                    AND expected_revision_record.revision =
                        import_row.expected_revision
                    AND expected_revision_record.snapshot_sha256 =
                        import_row.expected_snapshot_sha256
                    AND (
                      (
                        import_row.operation = 'unchanged'
                        AND public.canonicalize_catalog_json_v1(
                          pg_catalog.jsonb_build_object(
                            'presentation',
                              import_row.command_snapshot#>'{sourceCommand,presentation}',
                            'technicalData',
                              import_row.command_snapshot#>'{sourceCommand,technicalData}',
                            'commercial',
                              import_row.command_snapshot#>'{sourceCommand,commercial}',
                            'technicalProvenance',
                              import_row.command_snapshot#>'{sourceCommand,technicalProvenance}'
                          )
                        ) IS NOT DISTINCT FROM
                          public.canonicalize_catalog_json_v1(
                            pg_catalog.jsonb_build_object(
                              'presentation',
                                expected_revision_record.revision_snapshot->'presentation',
                              'technicalData',
                                expected_revision_record.revision_snapshot->'technicalData',
                              'commercial',
                                expected_revision_record.revision_snapshot->'commercial',
                              'technicalProvenance',
                                expected_revision_record.revision_snapshot->'technicalProvenance'
                            )
                          )
                      )
                      OR (
                        import_row.operation = 'revise'
                        AND public.canonicalize_catalog_json_v1(
                          pg_catalog.jsonb_build_object(
                            'presentation',
                              import_row.command_snapshot#>'{sourceCommand,presentation}',
                            'technicalData',
                              import_row.command_snapshot#>'{sourceCommand,technicalData}',
                            'commercial',
                              import_row.command_snapshot#>'{sourceCommand,commercial}',
                            'technicalProvenance',
                              import_row.command_snapshot#>'{sourceCommand,technicalProvenance}'
                          )
                        ) IS DISTINCT FROM
                          public.canonicalize_catalog_json_v1(
                            pg_catalog.jsonb_build_object(
                              'presentation',
                                expected_revision_record.revision_snapshot->'presentation',
                              'technicalData',
                                expected_revision_record.revision_snapshot->'technicalData',
                              'commercial',
                                expected_revision_record.revision_snapshot->'commercial',
                              'technicalProvenance',
                                expected_revision_record.revision_snapshot->'technicalProvenance'
                            )
                          )
                      )
                    )
               )
             )
           ELSE
             public._m108b_valid_catalog_import_error_array(
               import_row.error_snapshot
             ) IS TRUE
         END), false)
    INTO actual_total, actual_valid, actual_invalid,
         minimum_row, maximum_row, every_row_valid
    FROM public.catalog_import_row AS import_row
   WHERE import_row.workspace_id = requested_workspace_id
     AND import_row.job_id = requested_import_id;
  RETURN ROW(actual_total, actual_valid, actual_invalid) IS NOT DISTINCT FROM ROW(
      job_record.total_count, job_record.valid_count, job_record.invalid_count
    )
    AND minimum_row IS NOT DISTINCT FROM 2
    AND maximum_row IS NOT DISTINCT FROM actual_total + 1
    AND every_row_valid;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$m108b_persisted_input_valid$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_catalog_import_persisted_input_valid(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.start_catalog_import_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_attestation_version text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_start$
DECLARE
  actor_id uuid;
  job_record public.catalog_import_job%ROWTYPE;
BEGIN
  actor_id := public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  IF requested_import_id IS NULL
     OR requested_attestation_version IS DISTINCT FROM
       'catalog-import-rights-attestation.v1' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_attestation'
    );
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF job_record.state <> 'ready_for_review' THEN
    IF job_record.state <> 'cancelled_before_start'
       AND job_record.execution_actor_id IS NOT DISTINCT FROM actor_id
       AND job_record.attestation_version IS NOT DISTINCT FROM
         requested_attestation_version
       AND job_record.attestation_text_sha256 IS NOT DISTINCT FROM
         pg_catalog.decode(
           '4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8',
           'hex'
         ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'replayed',
        'state', job_record.state,
        'importId', job_record.id,
        'dispatchRequired', job_record.state IN ('queued', 'retry_wait')
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'state', job_record.state
    );
  END IF;
  IF pg_catalog.transaction_timestamp() >= job_record.preview_expires_at THEN
    UPDATE public.catalog_import_job AS job
       SET state = 'cancelled_before_start'
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    SELECT job.* INTO job_record
      FROM public.catalog_import_job AS job
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'cancelled_before_start',
      'importId', job_record.id,
      'cleanupDispatchAt', job_record.snapshot_cleanup_due_at
    );
  END IF;
  PERFORM component.id
    FROM public.catalog_component AS component
   WHERE component.workspace_id = requested_workspace_id
     AND component.id IN (
       SELECT import_row.target_component_id
         FROM public.catalog_import_row AS import_row
        WHERE import_row.workspace_id = requested_workspace_id
          AND import_row.job_id = requested_import_id
          AND import_row.validation_status = 'valid'
          AND import_row.operation IN ('revise', 'unchanged')
     )
   ORDER BY component.id
   FOR UPDATE;
  IF job_record.valid_count = 0
     OR public._m108b_catalog_import_persisted_input_valid(
       requested_workspace_id,
       requested_import_id
     ) IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_persisted_input'
    );
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = 'queued',
         next_attempt_at = pg_catalog.transaction_timestamp(),
         execution_actor_id = actor_id,
         attestation_version = 'catalog-import-rights-attestation.v1',
         attestation_text_sha256 = pg_catalog.decode(
           '4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8',
           'hex'
         ),
         attested_by = actor_id
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'queued',
    'importId', requested_import_id,
    'replayed', false,
    'dispatchRequired', true,
    'nextAttemptAt', pg_catalog.transaction_timestamp()
  );
END
$m108b_start$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.start_catalog_import_v1(uuid, uuid, text)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.cancel_catalog_import_v1(
  requested_workspace_id uuid,
  requested_import_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_cancel$
DECLARE
  actor_id uuid;
  job_record public.catalog_import_job%ROWTYPE;
BEGIN
  actor_id := public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  IF actor_id IS NULL OR requested_import_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF job_record.state = 'cancelled_before_start' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'cancelled_before_start',
      'importId', job_record.id,
      'replayed', true,
      'cleanupDispatchAt', job_record.snapshot_cleanup_due_at
    );
  END IF;
  IF job_record.state <> 'ready_for_review' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'state', job_record.state
    );
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = 'cancelled_before_start'
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'cancelled_before_start',
    'importId', job_record.id,
    'replayed', false,
    'cleanupDispatchAt', job_record.snapshot_cleanup_due_at
  );
END
$m108b_cancel$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cancel_catalog_import_v1(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.read_latest_catalog_import_id_v1(
  requested_workspace_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_read_latest_job$
BEGIN
  PERFORM public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  RETURN (
    SELECT job.id
      FROM public.catalog_import_job AS job
     WHERE job.workspace_id = requested_workspace_id
     ORDER BY job.created_at DESC, job.id DESC
     LIMIT 1
  );
END
$m108b_read_latest_job$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_latest_catalog_import_id_v1(uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.read_catalog_import_v1(
  requested_workspace_id uuid,
  requested_import_id uuid
)
RETURNS TABLE (
  import_id uuid,
  intent_id uuid,
  file_name text,
  file_size_bytes integer,
  encoding text,
  delimiter text,
  mapping_snapshot jsonb,
  total_count integer,
  valid_count integer,
  invalid_count integer,
  state text,
  consecutive_failure_count integer,
  next_attempt_at timestamptz,
  error_code text,
  created_by uuid,
  execution_actor_id uuid,
  attested_by uuid,
  attested_at timestamptz,
  created_at timestamptz,
  preview_expires_at timestamptz,
  started_at timestamptz,
  terminal_at timestamptz,
  snapshot_cleanup_due_at timestamptz,
  snapshot_redacted_at timestamptz,
  created_result_count integer,
  revised_result_count integer,
  unchanged_result_count integer,
  conflict_result_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_read_job$
BEGIN
  PERFORM public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  IF requested_import_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT job.id,
         job.intent_id,
         job.file_name,
         job.file_size_bytes,
         job.encoding,
         job.delimiter,
         job.mapping_snapshot,
         job.total_count,
         job.valid_count,
         job.invalid_count,
         job.state,
         job.consecutive_failure_count,
         job.next_attempt_at,
         job.error_code,
         job.created_by,
         job.execution_actor_id,
         job.attested_by,
         job.attested_at,
         job.created_at,
         job.preview_expires_at,
         job.started_at,
         job.terminal_at,
         job.snapshot_cleanup_due_at,
         job.snapshot_redacted_at,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state = 'created'
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state = 'revised'
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state = 'unchanged'
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state = 'conflict'
         )::integer
    FROM public.catalog_import_job AS job
    LEFT JOIN public.catalog_import_row_result AS result
      ON result.workspace_id = job.workspace_id
     AND result.job_id = job.id
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   GROUP BY job.id;
END
$m108b_read_job$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_catalog_import_v1(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.read_catalog_import_rows_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_after_row integer,
  requested_limit integer
)
RETURNS TABLE (
  row_number integer,
  validation_status text,
  normalized_sku text,
  operation text,
  source_command jsonb,
  error_snapshot jsonb,
  target_component_id uuid,
  expected_component_id uuid,
  expected_revision integer,
  expected_status text,
  result_state text,
  result_component_id uuid,
  result_revision integer,
  result_error_code text,
  result_created_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_read_rows$
BEGIN
  PERFORM public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  IF requested_import_id IS NULL
     OR requested_after_row IS NULL
     OR requested_limit IS NULL
     OR requested_after_row NOT BETWEEN 1 AND 1001
     OR requested_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'catalog import row pagination is invalid'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT import_row.row_number,
         import_row.validation_status,
         import_row.normalized_sku,
         import_row.operation,
         import_row.command_snapshot->'sourceCommand',
         import_row.error_snapshot,
         import_row.target_component_id,
         import_row.expected_component_id,
         import_row.expected_revision,
         import_row.expected_status,
         result.result_state,
         result.component_id,
         result.revision,
         result.error_code,
         result.created_at
    FROM public.catalog_import_row AS import_row
    LEFT JOIN public.catalog_import_row_result AS result
      ON result.workspace_id = import_row.workspace_id
     AND result.job_id = import_row.job_id
     AND result.row_number = import_row.row_number
   WHERE import_row.workspace_id = requested_workspace_id
     AND import_row.job_id = requested_import_id
     AND import_row.row_number > requested_after_row
   ORDER BY import_row.row_number
   LIMIT requested_limit;
END
$m108b_read_rows$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_catalog_import_rows_v1(
  uuid, uuid, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_catalog_import_receipt_response(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_dispatch_id uuid,
  expected_kind text,
  expected_cause text,
  expected_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_receipt_response$
DECLARE
  receipt_record public.catalog_import_dispatch_receipt%ROWTYPE;
BEGIN
  SELECT receipt.* INTO receipt_record
    FROM public.catalog_import_dispatch_receipt AS receipt
   WHERE receipt.dispatch_id = requested_dispatch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF receipt_record.workspace_id IS DISTINCT FROM requested_workspace_id
     OR receipt_record.job_id IS DISTINCT FROM requested_import_id
     OR (expected_kind IS NOT NULL
       AND receipt_record.receipt_kind IS DISTINCT FROM expected_kind)
     OR (expected_cause IS NOT NULL
       AND receipt_record.cause_code IS DISTINCT FROM expected_cause)
     OR (expected_generation IS NOT NULL
       AND receipt_record.lease_generation IS DISTINCT FROM
         expected_generation) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'dispatch_reused', 'replayed', true
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', receipt_record.outcome_state,
    'importId', receipt_record.job_id,
    'leaseGeneration', receipt_record.lease_generation::text,
    'failureCount', receipt_record.outcome_failure_count,
    'errorCode', receipt_record.outcome_error_code,
    'nextAttemptAt', receipt_record.outcome_next_attempt_at,
    'dispatchRequired', receipt_record.outcome_state IN ('queued', 'retry_wait'),
    'replayed', true
  );
END
$m108b_receipt_response$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_catalog_import_receipt_response(
  uuid, uuid, uuid, text, text, bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.record_catalog_import_preclaim_failure_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_dispatch_id uuid,
  requested_fixed_code text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_preclaim_failure$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
  replay_response jsonb;
  next_failure_count integer;
  next_state text;
  next_error_code text;
  next_attempt timestamptz;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_dispatch_id IS NULL
     OR requested_fixed_code IS NULL
     OR requested_fixed_code NOT IN ('enqueue_failed', 'queue_locator_invalid') THEN
    RAISE EXCEPTION 'catalog import preclaim failure input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  replay_response := public._m108b_catalog_import_receipt_response(
    requested_workspace_id,
    requested_import_id,
    requested_dispatch_id,
    'preclaim_failure',
    requested_fixed_code,
    NULL
  );
  IF replay_response IS NOT NULL THEN
    RETURN replay_response;
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND OR job_record.state NOT IN ('queued', 'retry_wait')
     OR job_record.next_attempt_at IS NULL
     OR job_record.next_attempt_at > database_time THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'not_due'
    );
  END IF;
  next_failure_count := job_record.consecutive_failure_count + 1;
  IF next_failure_count = 3 THEN
    next_state := 'failed_final';
    next_error_code := 'technical_retry_exhausted';
    next_attempt := NULL;
  ELSE
    next_state := 'retry_wait';
    next_error_code := requested_fixed_code;
    next_attempt := database_time + CASE
      WHEN next_failure_count = 1 THEN interval '30 seconds'
      ELSE interval '60 seconds'
    END;
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = next_state,
         consecutive_failure_count = next_failure_count,
         error_code = next_error_code,
         next_attempt_at = next_attempt
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  INSERT INTO public.catalog_import_dispatch_receipt (
    dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
    cause_code, outcome_state, outcome_failure_count,
    outcome_error_code, outcome_next_attempt_at
  ) VALUES (
    requested_dispatch_id, requested_workspace_id, requested_import_id,
    'preclaim_failure', job_record.lease_generation, requested_fixed_code,
    next_state, next_failure_count, next_error_code, next_attempt
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', next_state,
    'importId', requested_import_id,
    'failureCount', next_failure_count,
    'errorCode', next_error_code,
    'nextAttemptAt', next_attempt,
    'dispatchRequired', next_state = 'retry_wait',
    'replayed', false
  );
END
$m108b_preclaim_failure$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_catalog_import_preclaim_failure_v1(
  uuid, uuid, uuid, text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.finalize_catalog_import_failure_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_lease_token uuid,
  expected_lease_generation bigint,
  requested_fixed_code text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_finalize_failure$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
  replay_response jsonb;
  next_failure_count integer;
  next_state text;
  next_error_code text;
  next_attempt timestamptz;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_lease_token IS NULL OR expected_lease_generation IS NULL
     OR expected_lease_generation < 1
     OR requested_fixed_code IS NULL
     OR requested_fixed_code NOT IN (
       'lease_lost', 'enqueue_failed', 'queue_locator_invalid'
     ) THEN
    RAISE EXCEPTION 'catalog import lease failure input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  replay_response := public._m108b_catalog_import_receipt_response(
    requested_workspace_id,
    requested_import_id,
    requested_lease_token,
    'lease_failure',
    requested_fixed_code,
    expected_lease_generation
  );
  IF replay_response IS NOT NULL THEN
    RETURN replay_response;
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND OR job_record.state <> 'running'
     OR job_record.lease_token IS DISTINCT FROM requested_lease_token
     OR job_record.lease_generation IS DISTINCT FROM expected_lease_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale_lease'
    );
  END IF;
  next_failure_count := job_record.consecutive_failure_count + 1;
  IF next_failure_count = 3 THEN
    next_state := 'failed_final';
    next_error_code := 'technical_retry_exhausted';
    next_attempt := NULL;
  ELSE
    next_state := 'retry_wait';
    next_error_code := requested_fixed_code;
    next_attempt := database_time + CASE
      WHEN next_failure_count = 1 THEN interval '30 seconds'
      ELSE interval '60 seconds'
    END;
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = next_state,
         lease_token = NULL,
         lease_row_numbers = NULL,
         lease_expires_at = NULL,
         consecutive_failure_count = next_failure_count,
         error_code = next_error_code,
         next_attempt_at = next_attempt
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  INSERT INTO public.catalog_import_dispatch_receipt (
    dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
    cause_code, outcome_state, outcome_failure_count,
    outcome_error_code, outcome_next_attempt_at
  ) VALUES (
    requested_lease_token, requested_workspace_id, requested_import_id,
    'lease_failure', expected_lease_generation, requested_fixed_code,
    next_state, next_failure_count, next_error_code, next_attempt
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', next_state,
    'importId', requested_import_id,
    'leaseGeneration', expected_lease_generation::text,
    'failureCount', next_failure_count,
    'errorCode', next_error_code,
    'nextAttemptAt', next_attempt,
    'dispatchRequired', next_state = 'retry_wait',
    'replayed', false
  );
END
$m108b_finalize_failure$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_catalog_import_failure_v1(
  uuid, uuid, uuid, bigint, text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.record_catalog_import_dispatch_failure_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_dispatch_id uuid,
  requested_fixed_code text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_dispatch_failure$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
  replay_response jsonb;
  failure_response jsonb;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_dispatch_id IS NULL OR requested_fixed_code IS NULL
     OR requested_fixed_code NOT IN (
       'enqueue_failed', 'queue_locator_invalid'
     ) THEN
    RAISE EXCEPTION 'catalog import dispatch failure input is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.workspace AS workspace
     WHERE workspace.id = requested_workspace_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'state', 'missing',
      'importId', requested_import_id
    );
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  replay_response := public._m108b_catalog_import_receipt_response(
    requested_workspace_id,
    requested_import_id,
    requested_dispatch_id,
    NULL,
    requested_fixed_code,
    NULL
  );
  IF replay_response IS NOT NULL THEN
    RETURN replay_response;
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'state', 'missing',
      'importId', requested_import_id
    );
  END IF;
  IF job_record.state IN ('queued', 'retry_wait')
     AND job_record.next_attempt_at IS NOT NULL
     AND job_record.next_attempt_at <= database_time THEN
    RETURN public.record_catalog_import_preclaim_failure_v1(
      requested_workspace_id,
      requested_import_id,
      requested_dispatch_id,
      requested_fixed_code
    );
  END IF;
  IF job_record.state = 'running'
     AND (
       job_record.lease_token IS NOT DISTINCT FROM requested_dispatch_id
       OR job_record.lease_expires_at <= pg_catalog.clock_timestamp()
     ) THEN
    failure_response := public.finalize_catalog_import_failure_v1(
      requested_workspace_id,
      requested_import_id,
      job_record.lease_token,
      job_record.lease_generation,
      requested_fixed_code
    );
    IF requested_dispatch_id IS DISTINCT FROM job_record.lease_token THEN
      INSERT INTO public.catalog_import_dispatch_receipt (
        dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
        cause_code, outcome_state, outcome_failure_count,
        outcome_error_code, outcome_next_attempt_at
      )
      SELECT requested_dispatch_id,
             receipt.workspace_id,
             receipt.job_id,
             'preclaim_failure',
             receipt.lease_generation,
             receipt.cause_code,
             receipt.outcome_state,
             receipt.outcome_failure_count,
             receipt.outcome_error_code,
             receipt.outcome_next_attempt_at
        FROM public.catalog_import_dispatch_receipt AS receipt
       WHERE receipt.dispatch_id = job_record.lease_token
         AND receipt.workspace_id = requested_workspace_id
         AND receipt.job_id = requested_import_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'catalog import dispatch failure lease receipt is missing';
      END IF;
    END IF;
    RETURN failure_response;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'superseded',
    'state', job_record.state,
    'importId', requested_import_id
  );
END
$m108b_dispatch_failure$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_catalog_import_dispatch_failure_v1(
  uuid, uuid, uuid, text
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.complete_catalog_import_batch_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_lease_token uuid,
  expected_lease_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_complete_batch$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
  replay_response jsonb;
  leased_result_count integer;
  total_result_count integer;
  success_result_count integer;
  conflict_result_count integer;
  next_state text;
  next_error_code text;
  next_attempt timestamptz;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_lease_token IS NULL OR expected_lease_generation IS NULL
     OR expected_lease_generation < 1 THEN
    RAISE EXCEPTION 'catalog import batch completion input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  replay_response := public._m108b_catalog_import_receipt_response(
    requested_workspace_id,
    requested_import_id,
    requested_lease_token,
    'batch_complete',
    NULL,
    expected_lease_generation
  );
  IF replay_response IS NOT NULL THEN
    RETURN replay_response;
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND OR job_record.state <> 'running'
     OR job_record.lease_token IS DISTINCT FROM requested_lease_token
     OR job_record.lease_generation IS DISTINCT FROM expected_lease_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale_lease'
    );
  END IF;
  SELECT pg_catalog.count(*)::integer
    INTO leased_result_count
    FROM public.catalog_import_row_result AS result
   WHERE result.workspace_id = requested_workspace_id
     AND result.job_id = requested_import_id
     AND result.row_number = ANY(job_record.lease_row_numbers);
  IF leased_result_count IS DISTINCT FROM
     pg_catalog.cardinality(job_record.lease_row_numbers) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'batch_incomplete'
    );
  END IF;
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state IN ('created', 'revised', 'unchanged')
         )::integer,
         pg_catalog.count(*) FILTER (
           WHERE result.result_state = 'conflict'
         )::integer
    INTO total_result_count, success_result_count, conflict_result_count
    FROM public.catalog_import_row_result AS result
   WHERE result.workspace_id = requested_workspace_id
     AND result.job_id = requested_import_id;
  IF total_result_count < job_record.valid_count THEN
    next_state := 'queued';
    next_error_code := NULL;
    next_attempt := database_time;
  ELSIF total_result_count = job_record.valid_count
        AND success_result_count = 0
        AND conflict_result_count = job_record.valid_count THEN
    next_state := 'failed_final';
    next_error_code := 'all_rows_conflicted';
    next_attempt := NULL;
  ELSIF total_result_count = job_record.valid_count
        AND job_record.invalid_count = 0
        AND success_result_count = job_record.valid_count
        AND conflict_result_count = 0 THEN
    next_state := 'succeeded';
    next_error_code := NULL;
    next_attempt := NULL;
  ELSIF total_result_count = job_record.valid_count
        AND success_result_count > 0
        AND (job_record.invalid_count > 0 OR conflict_result_count > 0) THEN
    next_state := 'partial';
    next_error_code := NULL;
    next_attempt := NULL;
  ELSE
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_result_set'
    );
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = next_state,
         lease_token = NULL,
         lease_row_numbers = NULL,
         lease_expires_at = NULL,
         consecutive_failure_count = 0,
         error_code = next_error_code,
         next_attempt_at = next_attempt
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  INSERT INTO public.catalog_import_dispatch_receipt (
    dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
    cause_code, outcome_state, outcome_failure_count,
    outcome_error_code, outcome_next_attempt_at
  ) VALUES (
    requested_lease_token, requested_workspace_id, requested_import_id,
    'batch_complete', expected_lease_generation, NULL,
    next_state, 0, next_error_code, next_attempt
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', next_state,
    'importId', requested_import_id,
    'leaseGeneration', expected_lease_generation::text,
    'resultCount', total_result_count,
    'successCount', success_result_count,
    'conflictCount', conflict_result_count,
    'errorCode', next_error_code,
    'nextAttemptAt', next_attempt,
    'dispatchRequired', next_state = 'queued',
    'replayed', false
  );
END
$m108b_complete_batch$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_catalog_import_batch_v1(
  uuid, uuid, uuid, bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.claim_catalog_import_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_dispatch_id uuid,
  requested_batch_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_claim$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  lease_observed_at timestamptz;
  job_record public.catalog_import_job%ROWTYPE;
  replay_response jsonb;
  auth_code text;
  terminal_code text;
  leased_rows integer[];
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_dispatch_id IS NULL
     OR requested_batch_limit IS NULL
     OR requested_batch_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'catalog import claim input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  replay_response := public._m108b_catalog_import_receipt_response(
    requested_workspace_id,
    requested_import_id,
    requested_dispatch_id,
    NULL,
    NULL,
    NULL
  );
  IF replay_response IS NOT NULL THEN
    RETURN replay_response;
  END IF;
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
  END IF;
  IF job_record.state = 'running' THEN
    lease_observed_at := pg_catalog.clock_timestamp();
    IF job_record.lease_token IS NOT DISTINCT FROM requested_dispatch_id
       AND job_record.lease_expires_at > lease_observed_at THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'claimed',
        'importId', requested_import_id,
        'leaseToken', requested_dispatch_id,
        'leaseGeneration', job_record.lease_generation::text,
        'rowNumbers', pg_catalog.to_jsonb(job_record.lease_row_numbers),
        'leaseExpiresAt', job_record.lease_expires_at,
        'replayed', true
      );
    END IF;
    IF job_record.lease_token IS DISTINCT FROM requested_dispatch_id
       AND job_record.lease_expires_at > lease_observed_at THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(job_record.lease_row_numbers) AS leased(row_number)
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.catalog_import_row_result AS result
          WHERE result.workspace_id = requested_workspace_id
            AND result.job_id = requested_import_id
            AND result.row_number = leased.row_number
       )
    ) THEN
      RETURN public.complete_catalog_import_batch_v1(
        requested_workspace_id,
        requested_import_id,
        job_record.lease_token,
        job_record.lease_generation
      );
    END IF;
    RETURN public.finalize_catalog_import_failure_v1(
      requested_workspace_id,
      requested_import_id,
      job_record.lease_token,
      job_record.lease_generation,
      'lease_lost'
    );
  END IF;
  IF job_record.state NOT IN ('queued', 'retry_wait')
     OR job_record.next_attempt_at IS NULL
     OR job_record.next_attempt_at > database_time THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_claimable');
  END IF;
  auth_code := public._m108b_catalog_import_actor_auth_code(
    requested_workspace_id,
    job_record.execution_actor_id
  );
  IF auth_code IS NOT NULL THEN
    terminal_code := auth_code;
  ELSIF public._m108b_catalog_import_persisted_input_valid(
    requested_workspace_id,
    requested_import_id
  ) IS NOT TRUE THEN
    terminal_code := 'invalid_persisted_input';
  END IF;
  IF terminal_code IS NOT NULL THEN
    UPDATE public.catalog_import_job AS job
       SET state = 'failed_final',
           consecutive_failure_count = 0,
           error_code = terminal_code,
           next_attempt_at = NULL
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    INSERT INTO public.catalog_import_dispatch_receipt (
      dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
      cause_code, outcome_state, outcome_failure_count,
      outcome_error_code, outcome_next_attempt_at
    ) VALUES (
      requested_dispatch_id, requested_workspace_id, requested_import_id,
      'claim_terminal', job_record.lease_generation, terminal_code,
      'failed_final', 0, terminal_code, NULL
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'importId', requested_import_id,
      'failureCount', 0,
      'errorCode', terminal_code,
      'replayed', false
    );
  END IF;
  SELECT pg_catalog.array_agg(candidate.row_number ORDER BY candidate.row_number)
    INTO leased_rows
    FROM (
      SELECT import_row.row_number
        FROM public.catalog_import_row AS import_row
       WHERE import_row.workspace_id = requested_workspace_id
         AND import_row.job_id = requested_import_id
         AND import_row.validation_status = 'valid'
         AND NOT EXISTS (
           SELECT 1
             FROM public.catalog_import_row_result AS result
            WHERE result.workspace_id = import_row.workspace_id
              AND result.job_id = import_row.job_id
              AND result.row_number = import_row.row_number
         )
       ORDER BY import_row.row_number
       LIMIT requested_batch_limit
       FOR UPDATE
    ) AS candidate;
  IF public._m108b_valid_catalog_import_lease_rows(leased_rows) IS NOT TRUE THEN
    UPDATE public.catalog_import_job AS job
       SET state = 'failed_final',
           consecutive_failure_count = 0,
           error_code = 'invalid_persisted_input',
           next_attempt_at = NULL
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    INSERT INTO public.catalog_import_dispatch_receipt (
      dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
      cause_code, outcome_state, outcome_failure_count,
      outcome_error_code, outcome_next_attempt_at
    ) VALUES (
      requested_dispatch_id, requested_workspace_id, requested_import_id,
      'claim_terminal', job_record.lease_generation,
      'invalid_persisted_input', 'failed_final', 0,
      'invalid_persisted_input', NULL
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'importId', requested_import_id,
      'failureCount', 0,
      'errorCode', 'invalid_persisted_input',
      'replayed', false
    );
  END IF;
  UPDATE public.catalog_import_job AS job
     SET state = 'running',
         lease_generation = job_record.lease_generation + 1,
         lease_token = requested_dispatch_id,
         lease_row_numbers = leased_rows,
         lease_expires_at = database_time + interval '3 minutes',
         next_attempt_at = NULL,
         error_code = NULL
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'importId', requested_import_id,
    'leaseToken', requested_dispatch_id,
    'leaseGeneration', (job_record.lease_generation + 1)::text,
    'rowNumbers', pg_catalog.to_jsonb(leased_rows),
    'leaseExpiresAt', database_time + interval '3 minutes',
    'replayed', false
  );
END
$m108b_claim$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_catalog_import_v1(
  uuid, uuid, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.recover_catalog_imports_v1(
  requested_workspace_id uuid,
  requested_limit integer
)
RETURNS TABLE (
  import_id uuid,
  recovery_action text,
  dispatch_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_recover$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
  recovery_result jsonb;
BEGIN
  IF requested_workspace_id IS NULL OR requested_limit IS NULL
     OR requested_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'catalog import recovery input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  FOR job_record IN
    SELECT job.*
      FROM public.catalog_import_job AS job
     WHERE job.workspace_id = requested_workspace_id
       AND (
         (job.state = 'ready_for_review'
           AND job.preview_expires_at <= database_time)
         OR (job.state IN ('queued', 'retry_wait')
           AND job.next_attempt_at <= database_time)
         OR (job.state = 'running'
           AND job.lease_expires_at <= database_time)
       )
     ORDER BY job.id
     LIMIT requested_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    import_id := job_record.id;
    dispatch_id := NULL;
    IF job_record.state = 'ready_for_review' THEN
      UPDATE public.catalog_import_job AS job
         SET state = 'cancelled_before_start'
       WHERE job.workspace_id = requested_workspace_id
         AND job.id = job_record.id;
      recovery_action := 'cleanup_required';
      dispatch_id := pg_catalog.gen_random_uuid();
    ELSIF job_record.state IN ('queued', 'retry_wait') THEN
      recovery_action := 'dispatch_required';
      dispatch_id := pg_catalog.gen_random_uuid();
    ELSIF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(job_record.lease_row_numbers) AS leased(row_number)
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.catalog_import_row_result AS result
          WHERE result.workspace_id = requested_workspace_id
            AND result.job_id = job_record.id
            AND result.row_number = leased.row_number
       )
    ) THEN
      recovery_result := public.complete_catalog_import_batch_v1(
        requested_workspace_id,
        job_record.id,
        job_record.lease_token,
        job_record.lease_generation
      );
      IF recovery_result->>'status' = 'queued' THEN
        recovery_action := 'dispatch_required';
        dispatch_id := pg_catalog.gen_random_uuid();
      ELSE
        recovery_action := 'cleanup_required';
        dispatch_id := pg_catalog.gen_random_uuid();
      END IF;
    ELSE
      recovery_result := public.finalize_catalog_import_failure_v1(
        requested_workspace_id,
        job_record.id,
        job_record.lease_token,
        job_record.lease_generation,
        'lease_lost'
      );
      recovery_action := CASE
        WHEN recovery_result->>'status' = 'retry_wait' THEN 'retry_scheduled'
        ELSE 'cleanup_required'
      END;
      dispatch_id := pg_catalog.gen_random_uuid();
    END IF;
    RETURN NEXT;
  END LOOP;
END
$m108b_recover$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.recover_catalog_imports_v1(uuid, integer)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.cleanup_catalog_import_snapshots_v1(
  requested_workspace_id uuid,
  requested_limit integer
)
RETURNS TABLE (import_id uuid, redacted_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_cleanup$
DECLARE
  database_time timestamptz := pg_catalog.transaction_timestamp();
  job_record public.catalog_import_job%ROWTYPE;
BEGIN
  IF requested_workspace_id IS NULL OR requested_limit IS NULL
     OR requested_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'catalog import cleanup input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  FOR job_record IN
    SELECT job.*
      FROM public.catalog_import_job AS job
     WHERE job.workspace_id = requested_workspace_id
       AND job.state IN (
         'succeeded', 'partial', 'failed_final', 'cancelled_before_start'
       )
       AND job.snapshot_redacted_at IS NULL
       AND job.snapshot_cleanup_due_at <= database_time
     ORDER BY job.id
     LIMIT requested_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM 1
      FROM public.catalog_import_row AS import_row
     WHERE import_row.workspace_id = requested_workspace_id
       AND import_row.job_id = job_record.id
     ORDER BY import_row.row_number
     FOR UPDATE;
    UPDATE public.catalog_import_row AS import_row
       SET normalized_sku = NULL,
           command_snapshot = NULL,
           preview_row_body_canonical = NULL,
           source_command_body_canonical = NULL,
           row_command_body_canonical = NULL,
           error_snapshot = public._m108b_redact_catalog_import_error_array(
             import_row.error_snapshot
           ),
           sealed_target_snapshot = NULL,
           sealed_target_body_canonical = NULL,
           sensitive_payload_bytes = 0,
           snapshot_redacted_at = database_time
     WHERE import_row.workspace_id = requested_workspace_id
       AND import_row.job_id = job_record.id;
    UPDATE public.catalog_import_job AS job
       SET file_name = NULL,
           mapping_snapshot = NULL,
           mapping_body_canonical = NULL,
           sensitive_payload_bytes = 0,
           snapshot_redacted_at = database_time
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = job_record.id
    RETURNING job.id, job.snapshot_redacted_at
         INTO import_id, redacted_at;
    RETURN NEXT;
  END LOOP;
END
$m108b_cleanup$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cleanup_catalog_import_snapshots_v1(uuid, integer)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.prepare_catalog_import_v1(
  requested_workspace_id uuid,
  requested_intent_id uuid,
  requested_prepare jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_prepare$
DECLARE
  actor_id uuid;
  file_snapshot jsonb;
  mapping_snapshot jsonb;
  rows_snapshot jsonb;
  mapping_body bytea;
  mapping_digest bytea;
  file_digest bytea;
  reservation_digest bytea;
  existing_job public.catalog_import_job%ROWTYPE;
  prepared_job public.catalog_import_job%ROWTYPE;
  row_entry jsonb;
  row_ordinality bigint;
  row_status text;
  row_command jsonb;
  row_number_value integer;
  total_count_value integer;
  valid_count_value integer := 0;
  invalid_count_value integer := 0;
  preview_body bytea;
  source_body bytea;
  row_command_body bytea;
  sealed_target_body bytea;
  current_component public.catalog_component%ROWTYPE;
  current_revision public.catalog_component_revision%ROWTYPE;
  source_payload text;
  current_payload text;
  generated_job_id uuid := pg_catalog.gen_random_uuid();
  derived_sensitive_bytes bigint;
BEGIN
  IF requested_workspace_id IS NULL OR requested_intent_id IS NULL
     OR requested_prepare IS NULL
     OR pg_catalog.octet_length(pg_catalog.convert_to(
       requested_prepare::text,
       'UTF8'
     )) > 31457280
     OR public._m108b_jsonb_exact_keys(
       requested_prepare,
       ARRAY['schemaVersion', 'file', 'mapping', 'rows']
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(requested_prepare->'schemaVersion')
       IS DISTINCT FROM 'string'
     OR requested_prepare->>'schemaVersion'
       IS DISTINCT FROM 'catalog-import-prepare.v1' THEN
    RAISE EXCEPTION 'catalog import prepare input is invalid'
      USING ERRCODE = '22023';
  END IF;
  file_snapshot := requested_prepare->'file';
  mapping_snapshot := requested_prepare->'mapping';
  rows_snapshot := requested_prepare->'rows';
  IF public._m108b_jsonb_exact_keys(
       file_snapshot,
       ARRAY[
         'filename', 'sizeBytes', 'sha256', 'encoding', 'delimiter',
         'parserVersion', 'rowCount'
       ]
     ) IS NOT TRUE
     OR public._m108b_jsonb_trimmed_text(
       file_snapshot->'filename', 1, 180
     ) IS NOT TRUE
     OR file_snapshot->>'filename' !~* '\.csv$'
     OR file_snapshot->>'filename' IS DISTINCT FROM
       normalize(file_snapshot->>'filename', NFKC)
     OR file_snapshot->>'filename' ~ '(^[[:space:]])|([[:space:]]$)'
     OR file_snapshot->>'filename' ~ '[[:cntrl:]]'
     OR pg_catalog.strpos(file_snapshot->>'filename', '/') <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(92)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8234)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8235)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8236)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8237)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8238)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8294)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8295)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8296)
     ) <> 0
     OR pg_catalog.strpos(
       file_snapshot->>'filename', pg_catalog.chr(8297)
     ) <> 0
     OR public._m108b_jsonb_integer_between(
       file_snapshot->'sizeBytes', 1, 1048576
     ) IS NOT TRUE
     OR pg_catalog.jsonb_typeof(file_snapshot->'sha256')
       IS DISTINCT FROM 'string'
     OR file_snapshot->>'sha256' !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(file_snapshot->'encoding')
       IS DISTINCT FROM 'string'
     OR file_snapshot->>'encoding' NOT IN ('utf-8', 'windows-1252')
     OR pg_catalog.jsonb_typeof(file_snapshot->'delimiter')
       IS DISTINCT FROM 'string'
     OR file_snapshot->>'delimiter' NOT IN (
       pg_catalog.chr(59), pg_catalog.chr(44)
     )
     OR file_snapshot->>'parserVersion'
       IS DISTINCT FROM 'papaparse-5.7.0-wmee.v1'
     OR public._m108b_jsonb_integer_between(
       file_snapshot->'rowCount', 1, 1000
     ) IS NOT TRUE
     OR public._m108b_valid_catalog_import_mapping(mapping_snapshot)
       IS NOT TRUE
     OR pg_catalog.jsonb_typeof(rows_snapshot) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(rows_snapshot) NOT BETWEEN 1 AND 1000
     OR (file_snapshot->>'rowCount')::integer IS DISTINCT FROM
       pg_catalog.jsonb_array_length(rows_snapshot) THEN
    RAISE EXCEPTION 'catalog import prepare envelope is invalid'
      USING ERRCODE = '22023';
  END IF;
  mapping_body := pg_catalog.convert_to(
    public.canonicalize_catalog_json_v1(mapping_snapshot),
    'UTF8'
  );
  IF pg_catalog.octet_length(mapping_body) NOT BETWEEN 2 AND 32768 THEN
    RAISE EXCEPTION 'catalog import mapping is too large'
      USING ERRCODE = '22023';
  END IF;
  mapping_digest := pg_catalog.sha256(mapping_body);
  file_digest := pg_catalog.decode(file_snapshot->>'sha256', 'hex');
  reservation_digest := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_catalog_json_v1(pg_catalog.jsonb_build_object(
      'intentId', requested_intent_id::text,
      'contractVersion', 'catalog-csv-import.v1',
      'fileSha256', file_snapshot->>'sha256',
      'encoding', file_snapshot->>'encoding',
      'delimiter', file_snapshot->>'delimiter',
      'mapping', mapping_snapshot
    )),
    'UTF8'
  ));

  actor_id := public._m108b_authorize_catalog_import_runtime(
    requested_workspace_id
  );
  SELECT job.* INTO existing_job
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.intent_id = requested_intent_id
   FOR UPDATE;
  IF FOUND THEN
    IF existing_job.reservation_key IS DISTINCT FROM reservation_digest
       OR existing_job.file_size_bytes IS DISTINCT FROM
         (file_snapshot->>'sizeBytes')::integer
       OR existing_job.file_sha256 IS DISTINCT FROM file_digest
       OR existing_job.encoding IS DISTINCT FROM file_snapshot->>'encoding'
       OR existing_job.delimiter IS DISTINCT FROM file_snapshot->>'delimiter'
       OR existing_job.parser_version IS DISTINCT FROM
         file_snapshot->>'parserVersion'
       OR existing_job.mapping_sha256 IS DISTINCT FROM mapping_digest
       OR existing_job.mapping_snapshot IS DISTINCT FROM mapping_snapshot
       OR existing_job.snapshot_redacted_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'intent_reused'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', existing_job.state,
      'importId', existing_job.id,
      'intentId', existing_job.intent_id,
      'totalCount', existing_job.total_count,
      'validCount', existing_job.valid_count,
      'invalidCount', existing_job.invalid_count,
      'previewExpiresAt', existing_job.preview_expires_at,
      'replayed', true
    );
  END IF;

  FOR row_entry, row_ordinality IN
    SELECT prepared_row.value, prepared_row.ordinality
      FROM pg_catalog.jsonb_array_elements(rows_snapshot)
        WITH ORDINALITY AS prepared_row(value, ordinality)
     ORDER BY prepared_row.ordinality
  LOOP
    row_status := row_entry->>'status';
    IF row_status = 'valid' THEN
      IF public._m108b_jsonb_exact_keys(
           row_entry, ARRAY['status', 'command']
         ) IS NOT TRUE
         OR public._m108b_valid_catalog_import_row_command(
           row_entry->'command'
         ) IS NOT TRUE THEN
        RAISE EXCEPTION 'catalog import valid prepare row is invalid'
          USING ERRCODE = '22023';
      END IF;
      row_command := row_entry->'command';
      row_number_value := (row_command#>>'{source,rowNumber}')::integer;
      IF row_number_value IS DISTINCT FROM row_ordinality::integer + 1
         OR row_command#>>'{source,fileSha256}'
           IS DISTINCT FROM file_snapshot->>'sha256'
         OR row_command#>>'{source,mappingSha256}'
           IS DISTINCT FROM pg_catalog.encode(mapping_digest, 'hex')
         OR (
           row_command->'sealedTarget' IS DISTINCT FROM 'null'::jsonb
           AND row_command#>>'{sealedTarget,snapshot,identity,workspaceId}'
             IS DISTINCT FROM requested_workspace_id::text
         ) THEN
        RAISE EXCEPTION 'catalog import valid prepare row binding drifted'
          USING ERRCODE = '22023';
      END IF;
      preview_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(pg_catalog.jsonb_build_object(
          'status', 'valid',
          'rowNumber', row_number_value,
          'normalizedSku', row_command#>>'{sourceCommand,internalSku}',
          'commandSha256', row_command#>>'{source,sourceCommandSha256}',
          'command', row_command->'sourceCommand'
        )),
        'UTF8'
      );
      IF pg_catalog.sha256(preview_body) IS DISTINCT FROM pg_catalog.decode(
        row_command#>>'{source,rowSha256}',
        'hex'
      ) THEN
        RAISE EXCEPTION 'catalog import preview row digest drifted'
          USING ERRCODE = '22023';
      END IF;
      valid_count_value := valid_count_value + 1;
    ELSIF row_status = 'invalid' THEN
      IF public._m108b_jsonb_exact_keys(
           row_entry,
           ARRAY['status', 'rowNumber', 'rowSha256', 'normalizedSku', 'errors']
         ) IS NOT TRUE
         OR public._m108b_jsonb_integer_between(
           row_entry->'rowNumber', 2, 1001
         ) IS NOT TRUE
         OR (row_entry->>'rowNumber')::integer IS DISTINCT FROM
           row_ordinality::integer + 1
         OR pg_catalog.jsonb_typeof(row_entry->'rowSha256')
           IS DISTINCT FROM 'string'
         OR row_entry->>'rowSha256' !~ '^[0-9a-f]{64}$'
         OR NOT (
           pg_catalog.jsonb_typeof(row_entry->'normalizedSku') = 'null'
           OR (
             pg_catalog.jsonb_typeof(row_entry->'normalizedSku') = 'string'
             AND row_entry->>'normalizedSku' ~
               '^[A-Z0-9][A-Z0-9._-]{0,63}$'
           )
         )
         OR public._m108b_valid_catalog_import_error_array(
           row_entry->'errors'
         ) IS NOT TRUE THEN
        RAISE EXCEPTION 'catalog import invalid prepare row is invalid'
          USING ERRCODE = '22023';
      END IF;
      preview_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(pg_catalog.jsonb_build_object(
          'status', 'invalid',
          'rowNumber', (row_entry->>'rowNumber')::integer,
          'normalizedSku', row_entry->'normalizedSku',
          'errors', row_entry->'errors'
        )),
        'UTF8'
      );
      IF pg_catalog.sha256(preview_body) IS DISTINCT FROM pg_catalog.decode(
        row_entry->>'rowSha256',
        'hex'
      ) THEN
        RAISE EXCEPTION 'catalog import invalid row digest drifted'
          USING ERRCODE = '22023';
      END IF;
      invalid_count_value := invalid_count_value + 1;
    ELSE
      RAISE EXCEPTION 'catalog import prepare row status is invalid'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  total_count_value := pg_catalog.jsonb_array_length(rows_snapshot);
  IF valid_count_value + invalid_count_value <> total_count_value THEN
    RAISE EXCEPTION 'catalog import prepare row count drifted'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(rows_snapshot) AS prepared_row(value)
     WHERE prepared_row.value->>'status' = 'valid'
     GROUP BY prepared_row.value#>>'{command,sourceCommand,internalSku}'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'catalog import prepare contains duplicate valid SKU'
      USING ERRCODE = '22023';
  END IF;

  PERFORM component.id
    FROM public.catalog_component AS component
    JOIN (
      SELECT DISTINCT (prepared_row.value#>>'{command,targetComponentId}')::uuid
        AS component_id
        FROM pg_catalog.jsonb_array_elements(rows_snapshot) AS prepared_row(value)
       WHERE prepared_row.value->>'status' = 'valid'
         AND prepared_row.value#>>'{command,operation}' IN ('revise', 'unchanged')
    ) AS target ON target.component_id = component.id
   WHERE component.workspace_id = requested_workspace_id
   ORDER BY component.id
   FOR UPDATE OF component;

  FOR row_entry IN
    SELECT prepared_row.value
      FROM pg_catalog.jsonb_array_elements(rows_snapshot) AS prepared_row(value)
     WHERE prepared_row.value->>'status' = 'valid'
     ORDER BY (prepared_row.value#>>'{command,source,rowNumber}')::integer
  LOOP
    row_command := row_entry->'command';
    IF row_command->>'operation' = 'create' THEN
      IF EXISTS (
        SELECT 1
          FROM public.catalog_component AS component
         WHERE component.workspace_id = requested_workspace_id
           AND (
             component.id = (row_command->>'targetComponentId')::uuid
             OR pg_catalog.lower(component.internal_sku) = pg_catalog.lower(
               row_command#>>'{sourceCommand,internalSku}'
             )
           )
      ) THEN
        RAISE EXCEPTION 'catalog import create precondition drifted'
          USING ERRCODE = '40001';
      END IF;
      CONTINUE;
    END IF;
    SELECT component.* INTO current_component
      FROM public.catalog_component AS component
     WHERE component.workspace_id = requested_workspace_id
       AND component.id = (row_command->>'targetComponentId')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog import expected component is missing'
        USING ERRCODE = '40001';
    END IF;
    SELECT revision.* INTO current_revision
      FROM public.catalog_component_revision AS revision
     WHERE revision.workspace_id = requested_workspace_id
       AND revision.component_id = current_component.id
       AND revision.revision = current_component.current_revision;
    IF NOT FOUND
       OR current_component.current_revision IS DISTINCT FROM
         (row_command#>>'{expected,revision}')::integer
       OR current_component.status IS DISTINCT FROM
         row_command#>>'{expected,status}'
       OR current_component.internal_sku IS DISTINCT FROM
         row_command#>>'{expected,internalSku}'
       OR current_component.component_type IS DISTINCT FROM
         row_command#>>'{expected,componentType}'
       OR current_revision.snapshot_sha256 IS DISTINCT FROM pg_catalog.decode(
         row_command#>>'{expected,snapshotSha256}',
         'hex'
       ) THEN
      RAISE EXCEPTION 'catalog import expected component drifted'
        USING ERRCODE = '40001';
    END IF;
    IF row_command->>'operation' IN ('revise', 'unchanged') THEN
      source_payload := public.canonicalize_catalog_json_v1(
        pg_catalog.jsonb_build_object(
          'presentation', row_command#>'{sourceCommand,presentation}',
          'technicalData', row_command#>'{sourceCommand,technicalData}',
          'commercial', row_command#>'{sourceCommand,commercial}',
          'technicalProvenance',
            row_command#>'{sourceCommand,technicalProvenance}'
        )
      );
      current_payload := public.canonicalize_catalog_json_v1(
        pg_catalog.jsonb_build_object(
          'presentation', current_revision.revision_snapshot->'presentation',
          'technicalData', current_revision.revision_snapshot->'technicalData',
          'commercial', current_revision.revision_snapshot->'commercial',
          'technicalProvenance',
            current_revision.revision_snapshot->'technicalProvenance'
        )
      );
      IF (
        row_command->>'operation' = 'unchanged'
        AND source_payload IS DISTINCT FROM current_payload
      ) OR (
        row_command->>'operation' = 'revise'
        AND source_payload IS NOT DISTINCT FROM current_payload
      ) THEN
        RAISE EXCEPTION 'catalog import operation truth drifted'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.catalog_import_job (
    id, workspace_id, intent_id, reservation_key,
    file_name, file_size_bytes, file_sha256, encoding, delimiter,
    contract_version, parser_version, mapping_version,
    mapping_snapshot, mapping_body_canonical, mapping_sha256,
    total_count, valid_count, invalid_count, sensitive_payload_bytes,
    state, created_by, preview_expires_at
  ) VALUES (
    generated_job_id, requested_workspace_id, requested_intent_id,
    reservation_digest,
    file_snapshot->>'filename', (file_snapshot->>'sizeBytes')::integer,
    file_digest, file_snapshot->>'encoding', file_snapshot->>'delimiter',
    'catalog-csv-import.v1', file_snapshot->>'parserVersion',
    'catalog-csv-column-mapping.v1', mapping_snapshot, mapping_body,
    mapping_digest, total_count_value, valid_count_value, invalid_count_value,
    1, 'ready_for_review', actor_id,
    pg_catalog.transaction_timestamp() + interval '7 days'
  );

  FOR row_entry, row_ordinality IN
    SELECT prepared_row.value, prepared_row.ordinality
      FROM pg_catalog.jsonb_array_elements(rows_snapshot)
        WITH ORDINALITY AS prepared_row(value, ordinality)
     ORDER BY prepared_row.ordinality
  LOOP
    IF row_entry->>'status' = 'valid' THEN
      row_command := row_entry->'command';
      row_number_value := (row_command#>>'{source,rowNumber}')::integer;
      preview_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(pg_catalog.jsonb_build_object(
          'status', 'valid',
          'rowNumber', row_number_value,
          'normalizedSku', row_command#>>'{sourceCommand,internalSku}',
          'commandSha256', row_command#>>'{source,sourceCommandSha256}',
          'command', row_command->'sourceCommand'
        )),
        'UTF8'
      );
      source_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(row_command->'sourceCommand'),
        'UTF8'
      );
      row_command_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(
          row_command - 'rowCommandSha256'
        ),
        'UTF8'
      );
      sealed_target_body := CASE
        WHEN row_command->>'operation' = 'unchanged' THEN NULL::bytea
        ELSE pg_catalog.decode(
          row_command#>>'{sealedTarget,bodyCanonicalBase64}',
          'base64'
        )
      END;
      INSERT INTO public.catalog_import_row (
        workspace_id, job_id, row_number, validation_status,
        normalized_sku, operation, command_snapshot,
        preview_row_body_canonical, source_command_body_canonical,
        row_command_body_canonical, row_sha256, source_command_sha256,
        row_command_sha256, target_component_id,
        sealed_target_snapshot, sealed_target_body_canonical,
        target_snapshot_sha256, expected_component_id, expected_revision,
        expected_status, expected_snapshot_sha256
      ) VALUES (
        requested_workspace_id, generated_job_id, row_number_value, 'valid',
        row_command#>>'{sourceCommand,internalSku}', row_command->>'operation',
        row_command, preview_body, source_body, row_command_body,
        pg_catalog.decode(row_command#>>'{source,rowSha256}', 'hex'),
        pg_catalog.decode(
          row_command#>>'{source,sourceCommandSha256}', 'hex'
        ),
        pg_catalog.decode(row_command->>'rowCommandSha256', 'hex'),
        (row_command->>'targetComponentId')::uuid,
        CASE WHEN row_command->>'operation' = 'unchanged' THEN NULL::jsonb
          ELSE row_command#>'{sealedTarget,snapshot}' END,
        sealed_target_body,
        pg_catalog.decode(CASE
          WHEN row_command->>'operation' = 'unchanged'
            THEN row_command#>>'{expected,snapshotSha256}'
          ELSE row_command#>>'{sealedTarget,snapshotSha256}'
        END, 'hex'),
        CASE WHEN row_command->>'operation' = 'create' THEN NULL::uuid
          ELSE (row_command#>>'{expected,componentId}')::uuid END,
        CASE WHEN row_command->>'operation' = 'create' THEN NULL::integer
          ELSE (row_command#>>'{expected,revision}')::integer END,
        CASE WHEN row_command->>'operation' = 'create' THEN NULL::text
          ELSE row_command#>>'{expected,status}' END,
        CASE WHEN row_command->>'operation' = 'create' THEN NULL::bytea
          ELSE pg_catalog.decode(
            row_command#>>'{expected,snapshotSha256}', 'hex'
          ) END
      );
    ELSE
      preview_body := pg_catalog.convert_to(
        public.canonicalize_catalog_json_v1(pg_catalog.jsonb_build_object(
          'status', 'invalid',
          'rowNumber', (row_entry->>'rowNumber')::integer,
          'normalizedSku', row_entry->'normalizedSku',
          'errors', row_entry->'errors'
        )),
        'UTF8'
      );
      INSERT INTO public.catalog_import_row (
        workspace_id, job_id, row_number, validation_status,
        normalized_sku, preview_row_body_canonical, row_sha256,
        error_snapshot
      ) VALUES (
        requested_workspace_id, generated_job_id,
        (row_entry->>'rowNumber')::integer, 'invalid',
        CASE WHEN pg_catalog.jsonb_typeof(row_entry->'normalizedSku') = 'null'
          THEN NULL::text ELSE row_entry->>'normalizedSku' END,
        preview_body,
        pg_catalog.decode(row_entry->>'rowSha256', 'hex'),
        row_entry->'errors'
      );
    END IF;
  END LOOP;

  SELECT (
    pg_catalog.octet_length(pg_catalog.convert_to(job.file_name, 'UTF8'))
    + pg_catalog.octet_length(pg_catalog.convert_to(
      job.mapping_snapshot::text,
      'UTF8'
    ))
    + pg_catalog.octet_length(job.mapping_body_canonical)
    + COALESCE((
      SELECT pg_catalog.sum(import_row.sensitive_payload_bytes)::bigint
        FROM public.catalog_import_row AS import_row
       WHERE import_row.workspace_id = job.workspace_id
         AND import_row.job_id = job.id
    ), 0)
  )::bigint
    INTO derived_sensitive_bytes
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = generated_job_id;
  IF derived_sensitive_bytes NOT BETWEEN 1 AND 31457280 THEN
    RAISE EXCEPTION 'catalog import snapshot budget exceeded'
      USING ERRCODE = '54000';
  END IF;
  UPDATE public.catalog_import_job AS job
     SET sensitive_payload_bytes = derived_sensitive_bytes::integer
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = generated_job_id;
  SELECT job.* INTO prepared_job
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = generated_job_id;
  RETURN pg_catalog.jsonb_build_object(
    'status', prepared_job.state,
    'importId', prepared_job.id,
    'intentId', prepared_job.intent_id,
    'totalCount', prepared_job.total_count,
    'validCount', prepared_job.valid_count,
    'invalidCount', prepared_job.invalid_count,
    'previewExpiresAt', prepared_job.preview_expires_at,
    'replayed', false
  );
END
$m108b_prepare$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prepare_catalog_import_v1(uuid, uuid, jsonb)
  FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.apply_catalog_import_row_v1(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_row_number integer,
  requested_lease_token uuid,
  expected_lease_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_apply_row$
DECLARE
  job_record public.catalog_import_job%ROWTYPE;
  row_record public.catalog_import_row%ROWTYPE;
  result_record public.catalog_import_row_result%ROWTYPE;
  component_record public.catalog_component%ROWTYPE;
  revision_record public.catalog_component_revision%ROWTYPE;
  actor_auth_code text;
  terminal_code text;
  result_state text;
  result_error_code text;
  result_component_id uuid;
  result_revision integer;
  result_snapshot_sha256 bytea;
  prior_actor_setting text;
  source_payload text;
  current_payload text;
  event_type text;
  audit_details jsonb;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_row_number IS NULL
     OR requested_row_number NOT BETWEEN 2 AND 1001
     OR requested_lease_token IS NULL OR expected_lease_generation IS NULL
     OR expected_lease_generation < 1 THEN
    RAISE EXCEPTION 'catalog import row apply input is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._m108b_lock_catalog_import_workspace(requested_workspace_id);
  SELECT job.* INTO job_record
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
   FOR UPDATE;
  IF NOT FOUND OR job_record.state <> 'running'
     OR job_record.lease_token IS DISTINCT FROM requested_lease_token
     OR job_record.lease_generation IS DISTINCT FROM expected_lease_generation
     OR NOT (requested_row_number = ANY(job_record.lease_row_numbers)) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale_lease'
    );
  END IF;
  IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'stale_lease'
    );
  END IF;
  SELECT result.* INTO result_record
    FROM public.catalog_import_row_result AS result
   WHERE result.workspace_id = requested_workspace_id
     AND result.job_id = requested_import_id
     AND result.row_number = requested_row_number;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', result_record.result_state,
      'importId', requested_import_id,
      'rowNumber', requested_row_number,
      'componentId', result_record.component_id,
      'revision', result_record.revision,
      'errorCode', result_record.error_code,
      'snapshotHashRef', CASE
        WHEN result_record.snapshot_sha256 IS NULL THEN NULL::text
        ELSE pg_catalog.substr(
          pg_catalog.encode(result_record.snapshot_sha256, 'hex'), 1, 16
        )
      END,
      'replayed', true
    );
  END IF;
  SELECT import_row.* INTO row_record
    FROM public.catalog_import_row AS import_row
   WHERE import_row.workspace_id = requested_workspace_id
     AND import_row.job_id = requested_import_id
     AND import_row.row_number = requested_row_number
   FOR UPDATE;
  actor_auth_code := public._m108b_catalog_import_actor_auth_code(
    requested_workspace_id,
    job_record.execution_actor_id
  );
  IF actor_auth_code IS NOT NULL THEN
    terminal_code := actor_auth_code;
  ELSIF NOT FOUND OR row_record.validation_status <> 'valid'
     OR public._m108b_catalog_import_persisted_input_valid(
       requested_workspace_id,
       requested_import_id
     ) IS NOT TRUE
     OR public._m108b_valid_catalog_import_row_command(
       row_record.command_snapshot
     ) IS NOT TRUE
     OR row_record.command_snapshot#>>'{source,fileSha256}' IS DISTINCT FROM
       pg_catalog.encode(job_record.file_sha256, 'hex')
     OR row_record.command_snapshot#>>'{source,mappingSha256}' IS DISTINCT FROM
       pg_catalog.encode(job_record.mapping_sha256, 'hex') THEN
    terminal_code := 'invalid_persisted_input';
  END IF;
  IF terminal_code IS NOT NULL THEN
    IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'stale_lease'
      );
    END IF;
    UPDATE public.catalog_import_job AS job
       SET state = 'failed_final',
           lease_token = NULL,
           lease_row_numbers = NULL,
           lease_expires_at = NULL,
           consecutive_failure_count = 0,
           next_attempt_at = NULL,
           error_code = terminal_code
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    INSERT INTO public.catalog_import_dispatch_receipt (
      dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
      cause_code, outcome_state, outcome_failure_count,
      outcome_error_code, outcome_next_attempt_at
    ) VALUES (
      requested_lease_token, requested_workspace_id, requested_import_id,
      'claim_terminal', expected_lease_generation, terminal_code,
      'failed_final', 0, terminal_code, NULL
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'importId', requested_import_id,
      'rowNumber', requested_row_number,
      'errorCode', terminal_code,
      'replayed', false
    );
  END IF;

  IF row_record.operation = 'create' THEN
    SELECT component.* INTO component_record
      FROM public.catalog_component AS component
     WHERE component.workspace_id = requested_workspace_id
       AND (
         component.id = row_record.target_component_id
         OR pg_catalog.lower(component.internal_sku) = pg_catalog.lower(
           row_record.normalized_sku
         )
       )
     ORDER BY component.id
     LIMIT 1
     FOR UPDATE;
    IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'stale_lease'
      );
    END IF;
    IF FOUND THEN
      result_state := 'conflict';
      result_error_code := 'sku_created_since_preview';
    ELSE
      IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'conflict', 'code', 'stale_lease'
        );
      END IF;
      prior_actor_setting := pg_catalog.current_setting('app.actor_id', true);
      PERFORM pg_catalog.set_config(
        'app.actor_id', job_record.execution_actor_id::text, true
      );
      BEGIN
        INSERT INTO public.catalog_component (
          id, workspace_id, internal_sku, component_type, created_by
        ) VALUES (
          row_record.target_component_id,
          requested_workspace_id,
          row_record.normalized_sku,
          row_record.command_snapshot#>>'{sourceCommand,componentType}',
          job_record.execution_actor_id
        );
        INSERT INTO public.catalog_component_revision (
          id, workspace_id, component_id, revision, component_type,
          schema_version, canonicalization_version, revision_snapshot,
          snapshot_sha256, created_by
        ) VALUES (
          pg_catalog.gen_random_uuid(), requested_workspace_id,
          row_record.target_component_id,
          (row_record.sealed_target_snapshot#>>'{identity,revision}')::integer,
          row_record.sealed_target_snapshot#>>'{identity,componentType}',
          row_record.sealed_target_snapshot->>'schemaVersion',
          row_record.sealed_target_snapshot->>'canonicalizationVersion',
          row_record.sealed_target_snapshot,
          row_record.target_snapshot_sha256,
          job_record.execution_actor_id
        );
        result_state := 'created';
        result_component_id := row_record.target_component_id;
        result_revision := (
          row_record.sealed_target_snapshot#>>'{identity,revision}'
        )::integer;
        result_snapshot_sha256 := row_record.target_snapshot_sha256;
      EXCEPTION WHEN unique_violation THEN
        result_state := 'conflict';
        result_error_code := 'catalog_write_conflict';
        result_component_id := NULL;
        result_revision := NULL;
        result_snapshot_sha256 := NULL;
      END;
      PERFORM pg_catalog.set_config(
        'app.actor_id', COALESCE(prior_actor_setting, ''), true
      );
    END IF;
  ELSE
    SELECT component.* INTO component_record
      FROM public.catalog_component AS component
     WHERE component.workspace_id = requested_workspace_id
       AND component.id = row_record.target_component_id
     FOR UPDATE;
    IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'stale_lease'
      );
    END IF;
    IF NOT FOUND THEN
      result_state := 'conflict';
      result_error_code := 'catalog_write_conflict';
    ELSE
      SELECT revision.* INTO revision_record
        FROM public.catalog_component_revision AS revision
       WHERE revision.workspace_id = requested_workspace_id
         AND revision.component_id = component_record.id
         AND revision.revision = component_record.current_revision;
      IF NOT FOUND THEN
        terminal_code := 'invalid_persisted_input';
      ELSIF component_record.status = 'archived' THEN
        result_state := 'conflict';
        result_error_code := 'archived_requires_manual_reactivation';
      ELSIF component_record.component_type IS DISTINCT FROM
            row_record.command_snapshot#>>'{expected,componentType}' THEN
        result_state := 'conflict';
        result_error_code := 'type_drift';
      ELSIF component_record.status IS DISTINCT FROM row_record.expected_status THEN
        result_state := 'conflict';
        result_error_code := 'status_drift';
      ELSIF component_record.current_revision IS DISTINCT FROM
            row_record.expected_revision
         OR revision_record.snapshot_sha256 IS DISTINCT FROM
            row_record.expected_snapshot_sha256 THEN
        result_state := 'conflict';
        result_error_code := 'revision_drift';
      ELSE
        source_payload := public.canonicalize_catalog_json_v1(
          pg_catalog.jsonb_build_object(
            'presentation',
              row_record.command_snapshot#>'{sourceCommand,presentation}',
            'technicalData',
              row_record.command_snapshot#>'{sourceCommand,technicalData}',
            'commercial',
              row_record.command_snapshot#>'{sourceCommand,commercial}',
            'technicalProvenance',
              row_record.command_snapshot#>'{sourceCommand,technicalProvenance}'
          )
        );
        current_payload := public.canonicalize_catalog_json_v1(
          pg_catalog.jsonb_build_object(
            'presentation', revision_record.revision_snapshot->'presentation',
            'technicalData', revision_record.revision_snapshot->'technicalData',
            'commercial', revision_record.revision_snapshot->'commercial',
            'technicalProvenance',
              revision_record.revision_snapshot->'technicalProvenance'
          )
        );
        IF (
          row_record.operation = 'unchanged'
          AND source_payload IS DISTINCT FROM current_payload
        ) OR (
          row_record.operation = 'revise'
          AND source_payload IS NOT DISTINCT FROM current_payload
        ) THEN
          terminal_code := 'invalid_persisted_input';
        ELSIF row_record.operation = 'unchanged' THEN
          result_state := 'unchanged';
          result_component_id := component_record.id;
          result_revision := component_record.current_revision;
          result_snapshot_sha256 := revision_record.snapshot_sha256;
        ELSE
          PERFORM project_record.id
            FROM public.project AS project_record
           WHERE project_record.workspace_id = requested_workspace_id
             AND EXISTS (
               SELECT 1
                 FROM public.project_catalog_resolution AS resolution
                 JOIN public.project_catalog_resolution_line AS line
                   ON line.workspace_id = resolution.workspace_id
                  AND line.resolution_id = resolution.id
                WHERE resolution.workspace_id = project_record.workspace_id
                  AND resolution.project_id = project_record.id
                  AND resolution.revision = (
                    SELECT pg_catalog.max(latest.revision)
                      FROM public.project_catalog_resolution AS latest
                     WHERE latest.workspace_id = resolution.workspace_id
                       AND latest.project_id = resolution.project_id
                  )
                  AND line.catalog_component_id = component_record.id
             )
           ORDER BY project_record.id
           FOR UPDATE OF project_record;
          IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
            RETURN pg_catalog.jsonb_build_object(
              'status', 'conflict', 'code', 'stale_lease'
            );
          END IF;
          prior_actor_setting := pg_catalog.current_setting('app.actor_id', true);
          PERFORM pg_catalog.set_config(
            'app.actor_id', job_record.execution_actor_id::text, true
          );
          BEGIN
            INSERT INTO public.catalog_component_revision (
              id, workspace_id, component_id, revision, component_type,
              schema_version, canonicalization_version, revision_snapshot,
              snapshot_sha256, created_by
            ) VALUES (
              pg_catalog.gen_random_uuid(), requested_workspace_id,
              component_record.id,
              (row_record.sealed_target_snapshot#>>'{identity,revision}')::integer,
              row_record.sealed_target_snapshot#>>'{identity,componentType}',
              row_record.sealed_target_snapshot->>'schemaVersion',
              row_record.sealed_target_snapshot->>'canonicalizationVersion',
              row_record.sealed_target_snapshot,
              row_record.target_snapshot_sha256,
              job_record.execution_actor_id
            );
            result_state := 'revised';
            result_component_id := component_record.id;
            result_revision := (
              row_record.sealed_target_snapshot#>>'{identity,revision}'
            )::integer;
            result_snapshot_sha256 := row_record.target_snapshot_sha256;
          EXCEPTION WHEN unique_violation THEN
            result_state := 'conflict';
            result_error_code := 'catalog_write_conflict';
            result_component_id := NULL;
            result_revision := NULL;
            result_snapshot_sha256 := NULL;
          END;
          PERFORM pg_catalog.set_config(
            'app.actor_id', COALESCE(prior_actor_setting, ''), true
          );
        END IF;
      END IF;
    END IF;
  END IF;

  IF terminal_code IS NOT NULL THEN
    IF job_record.lease_expires_at <= pg_catalog.clock_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'stale_lease'
      );
    END IF;
    UPDATE public.catalog_import_job AS job
       SET state = 'failed_final',
           lease_token = NULL,
           lease_row_numbers = NULL,
           lease_expires_at = NULL,
           consecutive_failure_count = 0,
           next_attempt_at = NULL,
           error_code = terminal_code
     WHERE job.workspace_id = requested_workspace_id
       AND job.id = requested_import_id;
    INSERT INTO public.catalog_import_dispatch_receipt (
      dispatch_id, workspace_id, job_id, receipt_kind, lease_generation,
      cause_code, outcome_state, outcome_failure_count,
      outcome_error_code, outcome_next_attempt_at
    ) VALUES (
      requested_lease_token, requested_workspace_id, requested_import_id,
      'claim_terminal', expected_lease_generation, terminal_code,
      'failed_final', 0, terminal_code, NULL
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'failed_final',
      'importId', requested_import_id,
      'rowNumber', requested_row_number,
      'errorCode', terminal_code,
      'replayed', false
    );
  END IF;

  INSERT INTO public.catalog_import_row_result (
    workspace_id, job_id, row_number, result_state,
    component_id, revision, snapshot_sha256, error_code
  ) VALUES (
    requested_workspace_id, requested_import_id, requested_row_number,
    result_state, result_component_id, result_revision,
    result_snapshot_sha256, result_error_code
  )
  RETURNING * INTO result_record;
  audit_details := pg_catalog.jsonb_build_object(
    'importId', requested_import_id,
    'rowNumber', requested_row_number,
    'componentId', result_record.component_id,
    'revision', result_record.revision,
    'operation', row_record.operation,
    'resultCode', COALESCE(result_record.error_code, result_record.result_state),
    'snapshotHashRef', CASE
      WHEN result_record.snapshot_sha256 IS NULL THEN NULL::text
      ELSE pg_catalog.substr(
        pg_catalog.encode(result_record.snapshot_sha256, 'hex'), 1, 16
      )
    END
  );
  IF result_record.result_state IN ('created', 'revised') THEN
    event_type := CASE result_record.result_state
      WHEN 'created' THEN 'catalog.component_created'
      ELSE 'catalog.component_revised'
    END;
    INSERT INTO public.domain_events (
      workspace_id, aggregate_type, aggregate_id, event_type, actor, payload
    ) VALUES (
      requested_workspace_id, 'catalog_component', result_record.component_id,
      event_type, job_record.execution_actor_id::text, audit_details
    );
  END IF;
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details
  ) VALUES (
    requested_workspace_id, job_record.execution_actor_id::text,
    'catalog.import', 'catalog_import_row', true, audit_details
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', result_record.result_state,
    'importId', requested_import_id,
    'rowNumber', requested_row_number,
    'componentId', result_record.component_id,
    'revision', result_record.revision,
    'errorCode', result_record.error_code,
    'snapshotHashRef', CASE
      WHEN result_record.snapshot_sha256 IS NULL THEN NULL::text
      ELSE pg_catalog.substr(
        pg_catalog.encode(result_record.snapshot_sha256, 'hex'), 1, 16
      )
    END,
    'replayed', false
  );
END
$m108b_apply_row$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.apply_catalog_import_row_v1(
  uuid, uuid, integer, uuid, bigint
) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public._m108b_catalog_import_dispatch_state(
  requested_workspace_id uuid,
  requested_import_id uuid,
  requested_kind text
)
RETURNS TABLE (
  domain_state text,
  lease_generation bigint,
  failure_count integer,
  dispatch_start_after timestamptz,
  dispatch_key text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m108b_dispatch_state$
DECLARE
  context_workspace_id uuid;
  job_state text;
  job_lease_generation bigint;
  job_failure_count integer;
  job_next_attempt_at timestamptz;
  job_lease_expires_at timestamptz;
  job_preview_expires_at timestamptz;
  job_cleanup_due_at timestamptz;
BEGIN
  IF requested_workspace_id IS NULL OR requested_import_id IS NULL
     OR requested_kind IS NULL
     OR requested_kind NOT IN ('import', 'cleanup') THEN
    RAISE EXCEPTION 'catalog import dispatch input is invalid'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'catalog import dispatch context is invalid'
      USING ERRCODE = '42501';
  END;
  IF context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'catalog import dispatch context mismatch'
      USING ERRCODE = '42501';
  END IF;
  SELECT job.state,
         job.lease_generation,
         job.consecutive_failure_count,
         job.next_attempt_at,
         job.lease_expires_at,
         job.preview_expires_at,
         job.snapshot_cleanup_due_at
    INTO job_state,
         job_lease_generation,
         job_failure_count,
         job_next_attempt_at,
         job_lease_expires_at,
         job_preview_expires_at,
         job_cleanup_due_at
    FROM public.catalog_import_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_import_id
     AND job.snapshot_redacted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  domain_state := job_state;
  lease_generation := job_lease_generation;
  failure_count := job_failure_count;
  IF requested_kind = 'import' THEN
    IF job_state IN ('queued', 'retry_wait')
       AND job_next_attempt_at IS NOT NULL THEN
      dispatch_start_after := job_next_attempt_at;
      dispatch_key := requested_import_id::text || ':claim:' ||
        (job_lease_generation + 1)::text || ':' || job_failure_count::text;
      RETURN NEXT;
    ELSIF job_state = 'running' AND job_lease_expires_at IS NOT NULL THEN
      dispatch_start_after := job_lease_expires_at;
      dispatch_key := requested_import_id::text || ':lease:' ||
        job_lease_generation::text;
      RETURN NEXT;
    END IF;
    RETURN;
  END IF;
  IF job_state = 'ready_for_review'
     AND job_preview_expires_at IS NOT NULL THEN
    dispatch_start_after := job_preview_expires_at;
    dispatch_key := requested_import_id::text || ':preview:' ||
      pg_catalog.floor(
        pg_catalog.date_part('epoch', job_preview_expires_at) * 1000000
      )::bigint::text;
    RETURN NEXT;
  ELSIF job_state IN (
    'succeeded', 'partial', 'failed_final', 'cancelled_before_start'
  ) AND job_cleanup_due_at IS NOT NULL THEN
    dispatch_start_after := job_cleanup_due_at;
    dispatch_key := requested_import_id::text || ':cleanup:' ||
      pg_catalog.floor(
        pg_catalog.date_part('epoch', job_cleanup_due_at) * 1000000
      )::bigint::text;
    RETURN NEXT;
  END IF;
END
$m108b_dispatch_state$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m108b_catalog_import_dispatch_state(
  uuid, uuid, text
) FROM PUBLIC;
--> statement-breakpoint
-- Der Queue-Bootstrap laeuft vor den App-Migrationen unter app_worker. Diese
-- Migration attestiert pg-boss v38 sowie beide gepinnten Queuevertraege und
-- installiert ausschliesslich ID-only-Zustell- und Locator-Naehte.
DO $m108b_dispatch_migration$
DECLARE
  pgboss_owner text;
  pgboss_version integer;
  required_queue_name text;
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
    RAISE EXCEPTION 'M1-08b catalog import dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION
      'M1-08b catalog import dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION
      'M1-08b catalog import dispatch: app_migrator braucht SET auf app_worker';
  END IF;
  GRANT EXECUTE ON FUNCTION
    public._m108b_catalog_import_dispatch_state(uuid, uuid, text)
  TO app_worker;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION
      'M1-08b catalog import dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version) INTO pgboss_version FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION
      'M1-08b catalog import dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  FOREACH required_queue_name IN ARRAY ARRAY[
    'catalog.import.v1', 'catalog.import.cleanup.v1'
  ]::text[] LOOP
    PERFORM 1
      FROM pgboss.queue AS queue
     WHERE queue.name = required_queue_name
       AND queue.policy = 'exclusive'
       AND queue.retry_limit = 10
       AND queue.retry_delay = 1
       AND queue.retry_backoff = true
       AND queue.retry_delay_max = 60
       AND queue.expire_seconds = 180
       AND queue.notify = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'M1-08b catalog import dispatch: Queue % fehlt oder driftet',
        required_queue_name;
    END IF;
  END LOOP;

  EXECUTE $m108b_import_enqueue_ddl$
    CREATE FUNCTION pgboss.enqueue_catalog_import_v1(
      workspace_id uuid,
      import_id uuid,
      dispatch_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $m108b_import_enqueue_body$
    DECLARE
      context_workspace_id uuid;
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_start_after timestamptz;
      dispatch_key text;
      runtime_pgboss_version integer;
    BEGIN
      IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL THEN
        RAISE EXCEPTION 'catalog import dispatch input is invalid'
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        context_workspace_id := NULLIF(
          pg_catalog.current_setting('app.workspace_id', true), ''
        )::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'catalog import dispatch context is invalid'
          USING ERRCODE = '42501';
      END;
      IF context_workspace_id IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'catalog import dispatch context mismatch'
          USING ERRCODE = '42501';
      END IF;
      SELECT domain.dispatch_start_after, domain.dispatch_key
        INTO dispatch_start_after, dispatch_key
        FROM public._m108b_catalog_import_dispatch_state(
          $1, $2, 'import'
        ) AS domain;
      IF NOT FOUND OR dispatch_start_after IS NULL OR dispatch_key IS NULL THEN
        RAISE EXCEPTION 'catalog import dispatch has no dispatchable state'
          USING ERRCODE = '42501';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text || ':import', 1701734777)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'catalog import dispatch schema version drifted';
      END IF;
      SELECT * INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'catalog.import.v1';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'catalog import dispatch queue contract drifted';
      END IF;
      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'catalog-import-dispatch.v1',
        'workspaceId', $1::text,
        'importId', $2::text
      );
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'catalog.import.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'catalog import dispatch singleton contract violated';
      END IF;
      INSERT INTO pgboss.job (
        id, name, data, priority, start_after, singleton_key, expire_seconds,
        deletion_seconds, keep_until, retry_limit, retry_delay,
        retry_backoff, retry_delay_max, policy, dead_letter,
        heartbeat_seconds
      )
      SELECT $3,
             queue_config.name,
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
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'catalog import dispatch hit unexpected conflict';
      END IF;
    END
    $m108b_import_enqueue_body$
  $m108b_import_enqueue_ddl$;

  EXECUTE $m108b_cleanup_enqueue_ddl$
    CREATE FUNCTION pgboss.enqueue_catalog_import_cleanup_v1(
      workspace_id uuid,
      import_id uuid,
      dispatch_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $m108b_cleanup_enqueue_body$
    DECLARE
      context_workspace_id uuid;
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_start_after timestamptz;
      dispatch_key text;
      runtime_pgboss_version integer;
    BEGIN
      IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL THEN
        RAISE EXCEPTION 'catalog import cleanup dispatch input is invalid'
          USING ERRCODE = '22023';
      END IF;
      BEGIN
        context_workspace_id := NULLIF(
          pg_catalog.current_setting('app.workspace_id', true), ''
        )::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'catalog import cleanup dispatch context is invalid'
          USING ERRCODE = '42501';
      END;
      IF context_workspace_id IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'catalog import cleanup dispatch context mismatch'
          USING ERRCODE = '42501';
      END IF;
      SELECT domain.dispatch_start_after, domain.dispatch_key
        INTO dispatch_start_after, dispatch_key
        FROM public._m108b_catalog_import_dispatch_state(
          $1, $2, 'cleanup'
        ) AS domain;
      IF NOT FOUND OR dispatch_start_after IS NULL OR dispatch_key IS NULL THEN
        RAISE EXCEPTION
          'catalog import cleanup dispatch has no dispatchable state'
          USING ERRCODE = '42501';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text || ':cleanup', 1701734777)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'catalog import cleanup dispatch schema version drifted';
      END IF;
      SELECT * INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'catalog.import.cleanup.v1';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'catalog import cleanup queue contract drifted';
      END IF;
      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'catalog-import-cleanup-dispatch.v1',
        'workspaceId', $1::text,
        'importId', $2::text
      );
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.cleanup.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'catalog.import.cleanup.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.cleanup.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION
          'catalog import cleanup dispatch singleton contract violated';
      END IF;
      INSERT INTO pgboss.job (
        id, name, data, priority, start_after, singleton_key, expire_seconds,
        deletion_seconds, keep_until, retry_limit, retry_delay,
        retry_backoff, retry_delay_max, policy, dead_letter,
        heartbeat_seconds
      )
      SELECT $3,
             queue_config.name,
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
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'catalog.import.cleanup.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state::text IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION
          'catalog import cleanup dispatch hit unexpected conflict';
      END IF;
    END
    $m108b_cleanup_enqueue_body$
  $m108b_cleanup_enqueue_ddl$;

  EXECUTE $m108b_recovery_locator_ddl$
    CREATE FUNCTION pgboss.list_catalog_import_recovery_locator_jobs_v1(
      after_job_id uuid,
      requested_limit integer
    )
    RETURNS TABLE (
      locator_job_id uuid,
      workspace_id uuid,
      import_id uuid,
      locator_status text
    )
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $m108b_recovery_locator_body$
    DECLARE
      locator_record record;
      payload_bindable boolean;
      payload_valid boolean;
    BEGIN
      IF $2 IS NULL OR $2 NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'catalog import recovery locator limit is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF $1 IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM pgboss.job AS cursor_job
         WHERE cursor_job.id = $1
           AND cursor_job.name = 'catalog.import.v1'
      ) THEN
        RAISE EXCEPTION 'catalog import recovery locator cursor is invalid'
          USING ERRCODE = '22023';
      END IF;
      FOR locator_record IN
        SELECT job.id, job.data
          FROM pgboss.job AS job
         WHERE job.name = 'catalog.import.v1'
           AND job.state::text IN ('created', 'retry', 'active', 'failed')
           AND ($1 IS NULL OR job.id > $1)
         ORDER BY job.id
         LIMIT $2
      LOOP
        payload_bindable := pg_catalog.jsonb_typeof(locator_record.data)
            IS NOT DISTINCT FROM 'object'
          AND pg_catalog.jsonb_typeof(locator_record.data->'workspaceId')
            IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'workspaceId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND pg_catalog.pg_input_is_valid(
            locator_record.data->>'workspaceId', 'uuid'
          ) IS TRUE
          AND pg_catalog.jsonb_typeof(locator_record.data->'importId')
            IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'importId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND pg_catalog.pg_input_is_valid(
            locator_record.data->>'importId', 'uuid'
          ) IS TRUE;
        payload_valid := payload_bindable
          AND (locator_record.data - ARRAY[
            'schemaVersion', 'workspaceId', 'importId'
          ]::text[]) = '{}'::jsonb
          AND pg_catalog.jsonb_typeof(
            locator_record.data->'schemaVersion'
          ) IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'schemaVersion'
            IS NOT DISTINCT FROM 'catalog-import-dispatch.v1';
        locator_job_id := locator_record.id;
        IF payload_bindable THEN
          workspace_id := (locator_record.data->>'workspaceId')::uuid;
          import_id := (locator_record.data->>'importId')::uuid;
        ELSE
          workspace_id := NULL;
          import_id := NULL;
        END IF;
        locator_status := CASE WHEN payload_valid
          THEN 'valid'
          ELSE 'queue_locator_invalid'
        END;
        RETURN NEXT;
      END LOOP;
    END
    $m108b_recovery_locator_body$
  $m108b_recovery_locator_ddl$;

  EXECUTE $m108b_cleanup_locator_ddl$
    CREATE FUNCTION pgboss.list_catalog_import_cleanup_locator_jobs_v1(
      after_job_id uuid,
      requested_limit integer
    )
    RETURNS TABLE (
      locator_job_id uuid,
      workspace_id uuid,
      import_id uuid,
      locator_status text
    )
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $m108b_cleanup_locator_body$
    DECLARE
      locator_record record;
      payload_bindable boolean;
      payload_valid boolean;
    BEGIN
      IF $2 IS NULL OR $2 NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'catalog import cleanup locator limit is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF $1 IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM pgboss.job AS cursor_job
         WHERE cursor_job.id = $1
           AND cursor_job.name = 'catalog.import.cleanup.v1'
      ) THEN
        RAISE EXCEPTION 'catalog import cleanup locator cursor is invalid'
          USING ERRCODE = '22023';
      END IF;
      FOR locator_record IN
        SELECT job.id, job.data
          FROM pgboss.job AS job
         WHERE job.name = 'catalog.import.cleanup.v1'
           AND job.state::text IN ('created', 'retry', 'active', 'failed')
           AND ($1 IS NULL OR job.id > $1)
         ORDER BY job.id
         LIMIT $2
      LOOP
        payload_bindable := pg_catalog.jsonb_typeof(locator_record.data)
            IS NOT DISTINCT FROM 'object'
          AND pg_catalog.jsonb_typeof(locator_record.data->'workspaceId')
            IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'workspaceId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND pg_catalog.pg_input_is_valid(
            locator_record.data->>'workspaceId', 'uuid'
          ) IS TRUE
          AND pg_catalog.jsonb_typeof(locator_record.data->'importId')
            IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'importId' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND pg_catalog.pg_input_is_valid(
            locator_record.data->>'importId', 'uuid'
          ) IS TRUE;
        payload_valid := payload_bindable
          AND (locator_record.data - ARRAY[
            'schemaVersion', 'workspaceId', 'importId'
          ]::text[]) = '{}'::jsonb
          AND pg_catalog.jsonb_typeof(
            locator_record.data->'schemaVersion'
          ) IS NOT DISTINCT FROM 'string'
          AND locator_record.data->>'schemaVersion'
            IS NOT DISTINCT FROM 'catalog-import-cleanup-dispatch.v1';
        locator_job_id := locator_record.id;
        IF payload_bindable THEN
          workspace_id := (locator_record.data->>'workspaceId')::uuid;
          import_id := (locator_record.data->>'importId')::uuid;
        ELSE
          workspace_id := NULL;
          import_id := NULL;
        END IF;
        locator_status := CASE WHEN payload_valid
          THEN 'valid'
          ELSE 'queue_locator_invalid'
        END;
        RETURN NEXT;
      END LOOP;
    END
    $m108b_cleanup_locator_body$
  $m108b_cleanup_locator_ddl$;

  EXECUTE $m108b_quarantine_locator_ddl$
    CREATE FUNCTION pgboss.quarantine_catalog_import_locator_job_v1(
      requested_locator_job_id uuid
    )
    RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $m108b_quarantine_locator_body$
    DECLARE
      locator_record record;
      expected_schema_version text;
      payload_valid boolean;
    BEGIN
      IF $1 IS NULL THEN
        RAISE EXCEPTION 'catalog import locator quarantine input is invalid'
          USING ERRCODE = '22023';
      END IF;
      SELECT job.name, job.data
        INTO locator_record
        FROM pgboss.job AS job
       WHERE job.id = $1
       FOR UPDATE;
      IF NOT FOUND THEN
        RETURN false;
      END IF;
      IF locator_record.name NOT IN (
        'catalog.import.v1', 'catalog.import.cleanup.v1'
      ) THEN
        RAISE EXCEPTION 'catalog import locator quarantine target is invalid'
          USING ERRCODE = '22023';
      END IF;
      expected_schema_version := CASE locator_record.name
        WHEN 'catalog.import.v1' THEN 'catalog-import-dispatch.v1'
        ELSE 'catalog-import-cleanup-dispatch.v1'
      END;
      payload_valid := pg_catalog.jsonb_typeof(locator_record.data)
          IS NOT DISTINCT FROM 'object'
        AND (locator_record.data - ARRAY[
          'schemaVersion', 'workspaceId', 'importId'
        ]::text[]) = '{}'::jsonb
        AND pg_catalog.jsonb_typeof(locator_record.data->'schemaVersion')
          IS NOT DISTINCT FROM 'string'
        AND locator_record.data->>'schemaVersion'
          IS NOT DISTINCT FROM expected_schema_version
        AND pg_catalog.jsonb_typeof(locator_record.data->'workspaceId')
          IS NOT DISTINCT FROM 'string'
        AND locator_record.data->>'workspaceId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(
          locator_record.data->>'workspaceId', 'uuid'
        ) IS TRUE
        AND pg_catalog.jsonb_typeof(locator_record.data->'importId')
          IS NOT DISTINCT FROM 'string'
        AND locator_record.data->>'importId' ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND pg_catalog.pg_input_is_valid(
          locator_record.data->>'importId', 'uuid'
        ) IS TRUE;
      IF payload_valid THEN
        RAISE EXCEPTION 'valid catalog import locator cannot be quarantined'
          USING ERRCODE = '22023';
      END IF;
      UPDATE pgboss.job AS job
         SET state = 'cancelled',
             completed_on = COALESCE(
               job.completed_on,
               pg_catalog.clock_timestamp()
             )
       WHERE job.id = $1;
      RETURN true;
    END
    $m108b_quarantine_locator_body$
  $m108b_quarantine_locator_ddl$;

  EXECUTE
    'REVOKE ALL ON FUNCTION '
    'pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid), '
    'pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid), '
    'pgboss.list_catalog_import_recovery_locator_jobs_v1(uuid,integer), '
    'pgboss.list_catalog_import_cleanup_locator_jobs_v1(uuid,integer), '
    'pgboss.quarantine_catalog_import_locator_job_v1(uuid) '
    'FROM PUBLIC';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE
    'GRANT EXECUTE ON FUNCTION '
    'pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid), '
    'pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid) '
    'TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m108b_dispatch_migration$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  public.cancel_catalog_import_v1(uuid, uuid),
  public.prepare_catalog_import_v1(uuid, uuid, jsonb),
  public.read_latest_catalog_import_id_v1(uuid),
  public.read_catalog_import_rows_v1(uuid, uuid, integer, integer),
  public.read_catalog_import_v1(uuid, uuid),
  public.start_catalog_import_v1(uuid, uuid, text),
  public.apply_catalog_import_row_v1(uuid, uuid, integer, uuid, bigint),
  public.claim_catalog_import_v1(uuid, uuid, uuid, integer),
  public.cleanup_catalog_import_snapshots_v1(uuid, integer),
  public.complete_catalog_import_batch_v1(uuid, uuid, uuid, bigint),
  public._m108b_catalog_import_dispatch_state(uuid, uuid, text),
  public.finalize_catalog_import_failure_v1(uuid, uuid, uuid, bigint, text),
  public.record_catalog_import_dispatch_failure_v1(uuid, uuid, uuid, text),
  public.record_catalog_import_preclaim_failure_v1(uuid, uuid, uuid, text),
  public.recover_catalog_imports_v1(uuid, integer)
FROM PUBLIC;
--> statement-breakpoint
DO $m108b_function_acl$
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
        'public.cancel_catalog_import_v1(uuid,uuid), '
        'public.prepare_catalog_import_v1(uuid,uuid,jsonb), '
        'public.read_latest_catalog_import_id_v1(uuid), '
        'public.read_catalog_import_rows_v1(uuid,uuid,integer,integer), '
        'public.read_catalog_import_v1(uuid,uuid), '
        'public.start_catalog_import_v1(uuid,uuid,text), '
        'public.apply_catalog_import_row_v1(uuid,uuid,integer,uuid,bigint), '
        'public.claim_catalog_import_v1(uuid,uuid,uuid,integer), '
        'public.cleanup_catalog_import_snapshots_v1(uuid,integer), '
        'public.complete_catalog_import_batch_v1(uuid,uuid,uuid,bigint), '
        'public._m108b_catalog_import_dispatch_state(uuid,uuid,text), '
        'public.finalize_catalog_import_failure_v1(uuid,uuid,uuid,bigint,text), '
        'public.record_catalog_import_dispatch_failure_v1(uuid,uuid,uuid,text), '
        'public.record_catalog_import_preclaim_failure_v1(uuid,uuid,uuid,text), '
        'public.recover_catalog_imports_v1(uuid,integer) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public.cancel_catalog_import_v1(uuid, uuid),
      public.prepare_catalog_import_v1(uuid, uuid, jsonb),
      public.read_latest_catalog_import_id_v1(uuid),
      public.read_catalog_import_rows_v1(uuid, uuid, integer, integer),
      public.read_catalog_import_v1(uuid, uuid),
      public.start_catalog_import_v1(uuid, uuid, text)
    TO app_runtime;
  END IF;
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA public TO app_worker;
    GRANT EXECUTE ON FUNCTION
      public.apply_catalog_import_row_v1(uuid, uuid, integer, uuid, bigint),
      public.claim_catalog_import_v1(uuid, uuid, uuid, integer),
      public.cleanup_catalog_import_snapshots_v1(uuid, integer),
      public.complete_catalog_import_batch_v1(uuid, uuid, uuid, bigint),
      public._m108b_catalog_import_dispatch_state(uuid, uuid, text),
      public.finalize_catalog_import_failure_v1(uuid, uuid, uuid, bigint, text),
      public.record_catalog_import_dispatch_failure_v1(uuid, uuid, uuid, text),
      public.record_catalog_import_preclaim_failure_v1(uuid, uuid, uuid, text),
      public.recover_catalog_imports_v1(uuid, integer)
    TO app_worker;
  END IF;
END
$m108b_function_acl$;
