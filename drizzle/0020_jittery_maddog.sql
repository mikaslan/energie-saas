CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"email_primary" text,
	"email_normalized" text,
	"phone_raw" text,
	"phone_e164" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"marketing_consent_source" text,
	"dedupe_review_required" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "contact_display_name_ck" CHECK (length(btrim("contact"."display_name")) between 1 and 200),
	CONSTRAINT "contact_email_pair_ck" CHECK (("contact"."email_primary" is null) = ("contact"."email_normalized" is null)),
	CONSTRAINT "contact_email_normalized_ck" CHECK ("contact"."email_normalized" is null or (
        "contact"."email_normalized" = lower(btrim("contact"."email_primary"))
        and length("contact"."email_normalized") between 3 and 254
      )),
	CONSTRAINT "contact_phone_pair_ck" CHECK ("contact"."phone_e164" is null or "contact"."phone_raw" is not null),
	CONSTRAINT "contact_phone_e164_ck" CHECK ("contact"."phone_e164" is null or "contact"."phone_e164" ~ '^\+[1-9][0-9]{1,14}$'),
	CONSTRAINT "contact_active_identity_ck" CHECK ("contact"."deleted_at" is not null or "contact"."email_primary" is not null or "contact"."phone_raw" is not null),
	CONSTRAINT "contact_marketing_consent_ck" CHECK ((
        "contact"."marketing_consent" = false
        and "contact"."marketing_consent_at" is null
        and "contact"."marketing_consent_source" is null
      ) or (
        "contact"."marketing_consent" = true
        and "contact"."marketing_consent_at" is not null
        and length(btrim("contact"."marketing_consent_source")) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "calculator_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"calculator_engine" text NOT NULL,
	"result_integrity" text NOT NULL,
	"investment_source" text NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calculator_snapshot_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "calculator_snapshot_ws_id_project_uq" UNIQUE("workspace_id","id","project_id"),
	CONSTRAINT "calculator_snapshot_schema_ck" CHECK ("calculator_snapshot"."schema_version" = 'wmee-solar-snapshot.v1'
        and "calculator_snapshot"."calculator_engine" = 'wmee-solar.v1'
        and "calculator_snapshot"."result_integrity" = 'client_reported_unverified'),
	CONSTRAINT "calculator_snapshot_investment_ck" CHECK ("calculator_snapshot"."investment_source" = 'market_estimate'),
	CONSTRAINT "calculator_snapshot_json_ck" CHECK ((
        jsonb_typeof("calculator_snapshot"."snapshot") = 'object'
        and ("calculator_snapshot"."snapshot" - array[
          'schemaVersion', 'calculatedAt', 'branch', 'questionnaireVariant',
          'resultIntegrity', 'inputs', 'provenance', 'result'
        ]::text[]) = '{}'::jsonb
        and "calculator_snapshot"."snapshot"->>'schemaVersion' = "calculator_snapshot"."schema_version"
        and "calculator_snapshot"."snapshot"->>'resultIntegrity' = "calculator_snapshot"."result_integrity"
        and "calculator_snapshot"."snapshot"->>'branch' in ('new_installation', 'existing_installation')
        and jsonb_typeof("calculator_snapshot"."snapshot"->'inputs') = 'object'
        and jsonb_typeof("calculator_snapshot"."snapshot"->'provenance') = 'object'
        and "calculator_snapshot"."snapshot"#>>'{provenance,investment}' = "calculator_snapshot"."investment_source"
        and jsonb_typeof("calculator_snapshot"."snapshot"->'result') = 'object'
        and (
          ("calculator_snapshot"."snapshot"->>'branch' = 'new_installation'
            and "calculator_snapshot"."snapshot"#>>'{result,mode}' = 'new_installation')
          or
          ("calculator_snapshot"."snapshot"->>'branch' = 'existing_installation'
            and "calculator_snapshot"."snapshot"#>>'{result,mode}' = 'existing_installation')
        )
      ) is true)
);
--> statement-breakpoint
CREATE TABLE "inbound_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"contract_version" text NOT NULL,
	"body_sha256" "bytea" NOT NULL,
	"auth_key_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"producer_application" text NOT NULL,
	"producer_git_revision" text NOT NULL,
	"producer_environment" text NOT NULL,
	"producer_deployment_id" text,
	"calculator_engine" text NOT NULL,
	"acquisition" jsonb NOT NULL,
	"privacy_purpose" text NOT NULL,
	"privacy_legal_basis" text NOT NULL,
	"privacy_notice_version" text NOT NULL,
	"privacy_notice_url" text NOT NULL,
	"contact_resolution" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"email_match_contact_id" uuid,
	"phone_match_contact_id" uuid,
	"site_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "inbound_receipt_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "inbound_receipt_ws_id_project_uq" UNIQUE("workspace_id","id","project_id"),
	CONSTRAINT "inbound_receipt_source_ck" CHECK ("inbound_receipt"."source_key" = 'wmee-rechner-v3'),
	CONSTRAINT "inbound_receipt_contract_ck" CHECK ("inbound_receipt"."contract_version" = 'rechner-intake.v1'),
	CONSTRAINT "inbound_receipt_hash_ck" CHECK (octet_length("inbound_receipt"."body_sha256") = 32),
	CONSTRAINT "inbound_receipt_auth_key_ck" CHECK ("inbound_receipt"."auth_key_id" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "inbound_receipt_producer_ck" CHECK ("inbound_receipt"."producer_application" = 'wmee-rechner-v3'
        and "inbound_receipt"."producer_git_revision" ~ '^[0-9a-f]{40}$'
        and "inbound_receipt"."producer_environment" in ('production', 'preview', 'development')
        and "inbound_receipt"."calculator_engine" = 'wmee-solar.v1'),
	CONSTRAINT "inbound_receipt_privacy_ck" CHECK ("inbound_receipt"."privacy_purpose" = 'offer_request'
        and "inbound_receipt"."privacy_legal_basis" = 'art_6_1_b_precontractual'
        and length(btrim("inbound_receipt"."privacy_notice_version")) between 1 and 100
        and "inbound_receipt"."privacy_notice_url" like 'https://%'),
	CONSTRAINT "inbound_receipt_contact_resolution_ck" CHECK ("inbound_receipt"."contact_resolution" in ('created', 'email_match', 'phone_match', 'review_created')),
	CONSTRAINT "inbound_receipt_acquisition_ck" CHECK (jsonb_typeof("inbound_receipt"."acquisition") = 'object')
);
--> statement-breakpoint
CREATE TABLE "project_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"requirements" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_requirement_revision_ck" CHECK ("project_requirement"."revision" > 0),
	CONSTRAINT "project_requirement_schema_ck" CHECK ("project_requirement"."schema_version" = 'project-requirements.rechner.v1'),
	CONSTRAINT "project_requirement_json_ck" CHECK ((
        jsonb_typeof("project_requirement"."requirements") = 'object'
        and ("project_requirement"."requirements" - array[
          'schemaVersion', 'source', 'branch', 'requestedProducts'
        ]::text[]) = '{}'::jsonb
        and "project_requirement"."requirements"->>'schemaVersion' = "project_requirement"."schema_version"
        and "project_requirement"."requirements"->>'source' = 'wmee-rechner-v3'
        and "project_requirement"."requirements"->>'branch' in ('new_installation', 'existing_installation')
        and jsonb_typeof("project_requirement"."requirements"->'requestedProducts') = 'object'
        and (("project_requirement"."requirements"->'requestedProducts') - array[
          'targetStorageKwh', 'wallbox', 'bidirectionalCharging', 'backupPower'
        ]::text[]) = '{}'::jsonb
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,targetStorageKwh}') = 'number'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,wallbox}') = 'boolean'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,bidirectionalCharging}') = 'boolean'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,backupPower}') = 'boolean'
      ) is true)
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phase" text DEFAULT 'request' NOT NULL,
	"outcome" text DEFAULT 'open' NOT NULL,
	"source_key" text NOT NULL,
	"dedupe_review_required" boolean DEFAULT false NOT NULL,
	"catalog_resolution_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_ws_id_contact_site_uq" UNIQUE("workspace_id","id","contact_id","site_id"),
	CONSTRAINT "project_name_ck" CHECK (length(btrim("project"."name")) between 1 and 200),
	CONSTRAINT "project_phase_ck" CHECK ("project"."phase" in ('request', 'offer', 'installation')),
	CONSTRAINT "project_outcome_ck" CHECK ("project"."outcome" in ('open', 'won', 'lost', 'cannot_fulfill')),
	CONSTRAINT "project_source_key_ck" CHECK (length(btrim("project"."source_key")) between 1 and 80),
	CONSTRAINT "project_catalog_resolution_ck" CHECK ("project"."catalog_resolution_status" in ('pending', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "formatted_address" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "address_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "address_fingerprint_version" smallint;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "address_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "geocode_source" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "geocode_precision" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "address_follow_up_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_ws_contact_id_uq" UNIQUE("workspace_id","contact_id","id");--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculator_snapshot" ADD CONSTRAINT "calculator_snapshot_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculator_snapshot" ADD CONSTRAINT "calculator_snapshot_receipt_project_fk" FOREIGN KEY ("workspace_id","receipt_id","project_id") REFERENCES "public"."inbound_receipt"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calculator_snapshot" ADD CONSTRAINT "calculator_snapshot_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_project_graph_fk" FOREIGN KEY ("workspace_id","project_id","contact_id","site_id") REFERENCES "public"."project"("workspace_id","id","contact_id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt" ALTER CONSTRAINT "inbound_receipt_project_graph_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_email_match_contact_fk" FOREIGN KEY ("workspace_id","email_match_contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_phone_match_contact_fk" FOREIGN KEY ("workspace_id","phone_match_contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_snapshot_project_fk" FOREIGN KEY ("workspace_id","source_snapshot_id","project_id") REFERENCES "public"."calculator_snapshot"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_site_contact_fk" FOREIGN KEY ("workspace_id","contact_id","site_id") REFERENCES "public"."site"("workspace_id","contact_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_ws_email_idx" ON "contact" USING btree ("workspace_id","email_normalized");--> statement-breakpoint
CREATE INDEX "contact_ws_phone_idx" ON "contact" USING btree ("workspace_id","phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "calculator_snapshot_ws_receipt_uq" ON "calculator_snapshot" USING btree ("workspace_id","receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calculator_snapshot_ws_project_uq" ON "calculator_snapshot" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "inbound_receipt_ws_received_idx" ON "inbound_receipt" USING btree ("workspace_id","auth_key_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_receipt_ws_source_submission_uq" ON "inbound_receipt" USING btree ("workspace_id","source_key","submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_receipt_ws_project_uq" ON "inbound_receipt" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_requirement_ws_id_uq" ON "project_requirement" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_requirement_ws_project_revision_uq" ON "project_requirement" USING btree ("workspace_id","project_id","revision");--> statement-breakpoint
CREATE INDEX "project_ws_contact_idx" ON "project" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "project_ws_site_idx" ON "project" USING btree ("workspace_id","site_id");--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_ws_contact_address_fingerprint_uq" ON "site" USING btree ("workspace_id","contact_id","address_fingerprint_version","address_fingerprint") WHERE "site"."address_mode" = 'selected';--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_address_mode_ck" CHECK ("site"."address_mode" in ('legacy', 'selected', 'regional_estimate'));--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_geocode_precision_ck" CHECK ("site"."geocode_precision" is null or "site"."geocode_precision" in ('house', 'street', 'locality', 'region'));--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_intake_address_shape_ck" CHECK ("site"."address_mode" = 'legacy' or (
      "site"."contact_id" is not null
      and "site"."formatted_address" is not null
      and length(btrim("site"."formatted_address")) between 1 and 200
      and "site"."country" = 'DE'
      and "site"."lat" is not null
      and "site"."lat" between -90 and 90
      and "site"."lng" is not null
      and "site"."lng" between -180 and 180
      and "site"."geocode_source" is not null
      and "site"."geocode_precision" is not null
      and (
        ("site"."address_mode" = 'selected'
          and "site"."address_fingerprint" is not null
          and octet_length("site"."address_fingerprint") = 32
          and "site"."address_fingerprint_version" = 1
          and "site"."address_follow_up_required" = false
          and "site"."street" is not null
          and length(btrim("site"."street")) between 1 and 200
          and "site"."house_number" is not null
          and length(btrim("site"."house_number")) between 1 and 30
          and "site"."postal_code" is not null
          and "site"."postal_code" ~ '^[0-9]{5}$'
          and "site"."city" is not null
          and length(btrim("site"."city")) between 1 and 200
          and "site"."geocode_source" = 'photon'
          and "site"."geocode_precision" = 'house')
        or
        ("site"."address_mode" = 'regional_estimate'
          and "site"."address_fingerprint" is null
          and "site"."address_fingerprint_version" is null
          and "site"."address_follow_up_required" = true
          and "site"."street" is null
          and "site"."house_number" is null
          and "site"."postal_code" is null
          and "site"."city" is null
          and "site"."geocode_source" = 'regional_default'
          and "site"."geocode_precision" = 'region')
      )
    ));--> statement-breakpoint

-- M1-04: Jede neue Fachtabelle bleibt auch fuer den Tabellen-Owner unter der
-- kanonischen Workspace-Grenze. Es gibt bewusst genau eine permissive Policy.
ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "inbound_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_receipt"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "calculator_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calculator_snapshot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calculator_snapshot"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_requirement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_requirement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "project_requirement"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
