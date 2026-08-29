CREATE TABLE "project_calculation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"address_revision" integer NOT NULL,
	"pin_confirmed_address_revision" integer NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"confirmed_profile_revision" integer NOT NULL,
	"confirmed_address_revision" integer NOT NULL,
	"requirement_id" uuid NOT NULL,
	"requirement_revision" integer NOT NULL,
	"source_snapshot_id" uuid,
	"reservation_key" "bytea" NOT NULL,
	"provider_recipe_version" text NOT NULL,
	"contract_version" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text NOT NULL,
	"source_revision" text NOT NULL,
	"defaults_version" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"input_sha256" "bytea",
	"input_snapshot" jsonb,
	"provider_snapshot" jsonb,
	"error_code" text,
	"error_retryable" boolean,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result_revision_id" uuid,
	CONSTRAINT "project_calculation_job_ws_id_project_site_uq" UNIQUE("workspace_id","id","project_id","site_id"),
	CONSTRAINT "project_calculation_job_binding_revision_ck" CHECK ("project_calculation_job"."address_revision" > 0
        and "project_calculation_job"."address_revision" = "project_calculation_job"."pin_confirmed_address_revision"
        and "project_calculation_job"."address_revision" = "project_calculation_job"."confirmed_address_revision"
        and "project_calculation_job"."profile_revision" > 0
        and "project_calculation_job"."profile_revision" = "project_calculation_job"."confirmed_profile_revision"
        and "project_calculation_job"."requirement_revision" > 0),
	CONSTRAINT "project_calculation_job_reservation_hash_ck" CHECK (octet_length("project_calculation_job"."reservation_key") = 32),
	CONSTRAINT "project_calculation_job_versions_ck" CHECK ("project_calculation_job"."contract_version" = 'planning-calculation.v1'
        and length(btrim("project_calculation_job"."provider_recipe_version")) between 1 and 100
        and "project_calculation_job"."model_id" = 'wmee-solar'
        and "project_calculation_job"."model_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][a-z0-9.-]+)?$'
        and "project_calculation_job"."source_revision" ~ '^[0-9a-f]{40}$'
        and "project_calculation_job"."defaults_version" = 'wmee-planning-defaults.v1'),
	CONSTRAINT "project_calculation_job_state_ck" CHECK ("project_calculation_job"."state" in ('queued', 'running', 'retry_wait', 'succeeded', 'failed_final')),
	CONSTRAINT "project_calculation_job_attempt_ck" CHECK ("project_calculation_job"."attempt_count" between 0 and 10),
	CONSTRAINT "project_calculation_job_input_ck" CHECK ((
        ("project_calculation_job"."input_sha256" is null
          and "project_calculation_job"."input_snapshot" is null
          and "project_calculation_job"."provider_snapshot" is null)
        or
        (octet_length("project_calculation_job"."input_sha256") = 32
          and jsonb_typeof("project_calculation_job"."input_snapshot") = 'object'
          and jsonb_typeof("project_calculation_job"."provider_snapshot") in ('object', 'array'))
      ) is true),
	CONSTRAINT "project_calculation_job_error_ck" CHECK (("project_calculation_job"."error_code" is null and "project_calculation_job"."error_retryable" is null)
        or ("project_calculation_job"."error_code" ~ '^[a-z][a-z0-9_]{0,79}$' and "project_calculation_job"."error_retryable" is not null)),
	CONSTRAINT "project_calculation_job_shape_ck" CHECK (case "project_calculation_job"."state"
        when 'queued' then
          "project_calculation_job"."lease_token" is null and "project_calculation_job"."lease_expires_at" is null
          and "project_calculation_job"."finished_at" is null and "project_calculation_job"."result_revision_id" is null
          and "project_calculation_job"."error_code" is null and "project_calculation_job"."error_retryable" is null
        when 'running' then
          "project_calculation_job"."lease_token" is not null and "project_calculation_job"."lease_expires_at" is not null
          and "project_calculation_job"."started_at" is not null and "project_calculation_job"."finished_at" is null
          and "project_calculation_job"."result_revision_id" is null
          and "project_calculation_job"."error_code" is null and "project_calculation_job"."error_retryable" is null
        when 'retry_wait' then
          "project_calculation_job"."lease_token" is null and "project_calculation_job"."lease_expires_at" is null
          and "project_calculation_job"."started_at" is not null and "project_calculation_job"."finished_at" is null
          and "project_calculation_job"."result_revision_id" is null
          and "project_calculation_job"."error_code" is not null and "project_calculation_job"."error_retryable" = true
        when 'succeeded' then
          "project_calculation_job"."lease_token" is null and "project_calculation_job"."lease_expires_at" is null
          and "project_calculation_job"."started_at" is not null and "project_calculation_job"."finished_at" is not null
          and "project_calculation_job"."result_revision_id" is not null
          and "project_calculation_job"."input_sha256" is not null
          and "project_calculation_job"."error_code" is null and "project_calculation_job"."error_retryable" is null
        when 'failed_final' then
          "project_calculation_job"."lease_token" is null and "project_calculation_job"."lease_expires_at" is null
          and "project_calculation_job"."started_at" is not null and "project_calculation_job"."finished_at" is not null
          and "project_calculation_job"."result_revision_id" is null
          and "project_calculation_job"."error_code" is not null and "project_calculation_job"."error_retryable" = false
        else false
      end)
);
--> statement-breakpoint
CREATE TABLE "project_calculation_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"job_id" uuid NOT NULL,
	"address_revision" integer NOT NULL,
	"pin_confirmed_address_revision" integer NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_revision" integer NOT NULL,
	"confirmed_profile_revision" integer NOT NULL,
	"confirmed_address_revision" integer NOT NULL,
	"requirement_id" uuid NOT NULL,
	"requirement_revision" integer NOT NULL,
	"source_snapshot_id" uuid,
	"contract_version" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text NOT NULL,
	"source_revision" text NOT NULL,
	"defaults_version" text NOT NULL,
	"quality" text NOT NULL,
	"validation_status" text NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"result_sha256" "bytea" NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"provider_snapshot" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_calculation_revision_ws_id_project_site_uq" UNIQUE("workspace_id","id","project_id","site_id"),
	CONSTRAINT "project_calculation_revision_revision_ck" CHECK ("project_calculation_revision"."revision" > 0),
	CONSTRAINT "project_calculation_revision_binding_revision_ck" CHECK ("project_calculation_revision"."address_revision" > 0
        and "project_calculation_revision"."address_revision" = "project_calculation_revision"."pin_confirmed_address_revision"
        and "project_calculation_revision"."address_revision" = "project_calculation_revision"."confirmed_address_revision"
        and "project_calculation_revision"."profile_revision" > 0
        and "project_calculation_revision"."profile_revision" = "project_calculation_revision"."confirmed_profile_revision"
        and "project_calculation_revision"."requirement_revision" > 0),
	CONSTRAINT "project_calculation_revision_versions_ck" CHECK ("project_calculation_revision"."contract_version" = 'planning-calculation.v1'
        and "project_calculation_revision"."model_id" = 'wmee-solar'
        and "project_calculation_revision"."model_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][a-z0-9.-]+)?$'
        and "project_calculation_revision"."source_revision" ~ '^[0-9a-f]{40}$'
        and "project_calculation_revision"."defaults_version" = 'wmee-planning-defaults.v1'
        and "project_calculation_revision"."quality" = 'server_reproduced_estimate'
        and "project_calculation_revision"."validation_status" = 'not_f4_reference_validated'),
	CONSTRAINT "project_calculation_revision_hash_ck" CHECK (octet_length("project_calculation_revision"."input_sha256") = 32 and octet_length("project_calculation_revision"."result_sha256") = 32),
	CONSTRAINT "project_calculation_revision_json_ck" CHECK (jsonb_typeof("project_calculation_revision"."input_snapshot") = 'object'
        and jsonb_typeof("project_calculation_revision"."provider_snapshot") in ('object', 'array')
        and jsonb_typeof("project_calculation_revision"."result") = 'object'
        and "project_calculation_revision"."result"->>'contractVersion' = "project_calculation_revision"."contract_version"
        and "project_calculation_revision"."result"->>'inputSha256' = encode("project_calculation_revision"."input_sha256", 'hex')
        and "project_calculation_revision"."result"->>'resultSha256' = encode("project_calculation_revision"."result_sha256", 'hex')
        and "project_calculation_revision"."result"->>'quality' = "project_calculation_revision"."quality"
        and "project_calculation_revision"."result"->>'validationStatus' = "project_calculation_revision"."validation_status"
        and "project_calculation_revision"."result"#>>'{model,id}' = "project_calculation_revision"."model_id"
        and "project_calculation_revision"."result"#>>'{model,version}' = "project_calculation_revision"."model_version"
        and "project_calculation_revision"."result"#>>'{model,sourceRevision}' = "project_calculation_revision"."source_revision")
);
--> statement-breakpoint
CREATE TABLE "site_energy_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"schema_version" text NOT NULL,
	"input_mode" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_snapshot_id" uuid,
	"source_project_id" uuid,
	"address_revision" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"profile_sha256" "bytea" NOT NULL,
	"confirmed_profile_revision" integer,
	"confirmed_address_revision" integer,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_energy_profile_ws_id_site_uq" UNIQUE("workspace_id","id","site_id"),
	CONSTRAINT "site_energy_profile_revision_ck" CHECK ("site_energy_profile"."revision" > 0),
	CONSTRAINT "site_energy_profile_address_revision_ck" CHECK ("site_energy_profile"."address_revision" > 0),
	CONSTRAINT "site_energy_profile_contract_ck" CHECK ("site_energy_profile"."schema_version" = 'site-energy-profile.v1' and "site_energy_profile"."input_mode" = 'consumption'),
	CONSTRAINT "site_energy_profile_source_ck" CHECK ((
        ("site_energy_profile"."source_kind" = 'manual'
          and "site_energy_profile"."source_snapshot_id" is null
          and "site_energy_profile"."source_project_id" is null)
        or
        ("site_energy_profile"."source_kind" = 'rechner_snapshot'
          and "site_energy_profile"."source_snapshot_id" is not null
          and "site_energy_profile"."source_project_id" is not null)
      ) is true),
	CONSTRAINT "site_energy_profile_hash_ck" CHECK (octet_length("site_energy_profile"."profile_sha256") = 32),
	CONSTRAINT "site_energy_profile_json_ck" CHECK ((
        jsonb_typeof("site_energy_profile"."profile") = 'object'
        and ("site_energy_profile"."profile" - array[
          'schemaVersion', 'inputMode', 'building', 'roofs', 'consumption',
          'existingAssets', 'provenance'
        ]::text[]) = '{}'::jsonb
        and "site_energy_profile"."profile"->>'schemaVersion' = "site_energy_profile"."schema_version"
        and "site_energy_profile"."profile"->>'inputMode' = "site_energy_profile"."input_mode"
        and jsonb_typeof("site_energy_profile"."profile"->'building') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'roofs') = 'array'
        and jsonb_array_length("site_energy_profile"."profile"->'roofs') between 1 and 4
        and jsonb_typeof("site_energy_profile"."profile"->'consumption') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'existingAssets') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'provenance') = 'object'
      ) is true),
	CONSTRAINT "site_energy_profile_confirmation_ck" CHECK ((
        ("site_energy_profile"."confirmed_profile_revision" is null
          and "site_energy_profile"."confirmed_address_revision" is null
          and "site_energy_profile"."confirmed_by" is null
          and "site_energy_profile"."confirmed_at" is null)
        or
        ("site_energy_profile"."confirmed_profile_revision" = "site_energy_profile"."revision"
          and "site_energy_profile"."confirmed_address_revision" = "site_energy_profile"."address_revision"
          and "site_energy_profile"."confirmed_by" is not null
          and "site_energy_profile"."confirmed_at" is not null)
      ) is true)
);
--> statement-breakpoint
-- Zielschlüssel vor den zusammengesetzten FKs anlegen. Die Änderung ist
-- additiv; die veröffentlichte Historie 0000–0023 bleibt unangetastet.
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_ws_id_project_revision_uq" UNIQUE("workspace_id","id","project_id","revision");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_ws_id_site_uq" UNIQUE("workspace_id","id","site_id");--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_project_site_fk" FOREIGN KEY ("workspace_id","project_id","site_id") REFERENCES "public"."project"("workspace_id","id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_profile_site_fk" FOREIGN KEY ("workspace_id","profile_id","site_id") REFERENCES "public"."site_energy_profile"("workspace_id","id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_requirement_project_revision_fk" FOREIGN KEY ("workspace_id","requirement_id","project_id","requirement_revision") REFERENCES "public"."project_requirement"("workspace_id","id","project_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_source_snapshot_project_fk" FOREIGN KEY ("workspace_id","source_snapshot_id","project_id") REFERENCES "public"."calculator_snapshot"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_project_site_fk" FOREIGN KEY ("workspace_id","project_id","site_id") REFERENCES "public"."project"("workspace_id","id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_profile_site_fk" FOREIGN KEY ("workspace_id","profile_id","site_id") REFERENCES "public"."site_energy_profile"("workspace_id","id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_requirement_project_revision_fk" FOREIGN KEY ("workspace_id","requirement_id","project_id","requirement_revision") REFERENCES "public"."project_requirement"("workspace_id","id","project_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_source_snapshot_project_fk" FOREIGN KEY ("workspace_id","source_snapshot_id","project_id") REFERENCES "public"."calculator_snapshot"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_job_project_site_fk" FOREIGN KEY ("workspace_id","job_id","project_id","site_id") REFERENCES "public"."project_calculation_job"("workspace_id","id","project_id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_site_fk" FOREIGN KEY ("workspace_id","site_id") REFERENCES "public"."site"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_source_project_site_fk" FOREIGN KEY ("workspace_id","source_project_id","site_id") REFERENCES "public"."project"("workspace_id","id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_source_snapshot_project_fk" FOREIGN KEY ("workspace_id","source_snapshot_id","source_project_id") REFERENCES "public"."calculator_snapshot"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_confirmed_by_fk" FOREIGN KEY ("workspace_id","confirmed_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_result_revision_project_site_fk" FOREIGN KEY ("workspace_id","result_revision_id","project_id","site_id") REFERENCES "public"."project_calculation_revision"("workspace_id","id","project_id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_job_ws_id_uq" ON "project_calculation_job" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_job_ws_project_reservation_uq" ON "project_calculation_job" USING btree ("workspace_id","project_id","reservation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_job_ws_project_active_uq" ON "project_calculation_job" USING btree ("workspace_id","project_id") WHERE "project_calculation_job"."state" in ('queued', 'running', 'retry_wait');--> statement-breakpoint
CREATE INDEX "project_calculation_job_due_idx" ON "project_calculation_job" USING btree ("workspace_id","state","next_attempt_at","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_revision_ws_id_uq" ON "project_calculation_revision" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_revision_ws_project_revision_uq" ON "project_calculation_revision" USING btree ("workspace_id","project_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_revision_ws_job_uq" ON "project_calculation_revision" USING btree ("workspace_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_calculation_revision_ws_project_input_engine_uq" ON "project_calculation_revision" USING btree ("workspace_id","project_id","input_sha256","model_id","model_version","source_revision","defaults_version");--> statement-breakpoint
CREATE UNIQUE INDEX "site_energy_profile_ws_id_uq" ON "site_energy_profile" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_energy_profile_ws_site_uq" ON "site_energy_profile" USING btree ("workspace_id","site_id");--> statement-breakpoint

-- Genau eine kanonische Mandantenpolicy je neuer Fachtabelle.
ALTER TABLE public.site_energy_profile ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.site_energy_profile FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.site_energy_profile
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.project_calculation_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_calculation_job FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_calculation_job
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.project_calculation_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_calculation_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_calculation_revision
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

-- Ein Profil-UPDATE ist entweder die erstmalige Confirmation derselben
-- Wahrheit oder ein echtes Save N+1, das die Confirmation vollständig leert.
CREATE FUNCTION public.guard_site_energy_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_profile_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'site_energy_profile mutation guard: DELETE ist nur im separaten Erasurevertrag erlaubt';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.input_mode IS DISTINCT FROM OLD.input_mode
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'site_energy_profile mutation guard: Identität und Vertrag sind unveränderlich';
  END IF;

  IF OLD.confirmed_profile_revision IS NULL
     AND OLD.confirmed_address_revision IS NULL
     AND OLD.confirmed_by IS NULL
     AND OLD.confirmed_at IS NULL
     AND NEW.revision = OLD.revision
     AND NEW.address_revision = OLD.address_revision
     AND NEW.profile IS NOT DISTINCT FROM OLD.profile
     AND NEW.profile_sha256 IS NOT DISTINCT FROM OLD.profile_sha256
     AND NEW.source_kind IS NOT DISTINCT FROM OLD.source_kind
     AND NEW.source_snapshot_id IS NOT DISTINCT FROM OLD.source_snapshot_id
     AND NEW.source_project_id IS NOT DISTINCT FROM OLD.source_project_id
     AND NEW.confirmed_profile_revision = OLD.revision
     AND NEW.confirmed_address_revision = OLD.address_revision
     AND NEW.confirmed_by IS NOT NULL
     AND NEW.confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.revision = OLD.revision + 1
     AND NEW.confirmed_profile_revision IS NULL
     AND NEW.confirmed_address_revision IS NULL
     AND NEW.confirmed_by IS NULL
     AND NEW.confirmed_at IS NULL
     AND (
       NEW.profile IS DISTINCT FROM OLD.profile
       OR NEW.profile_sha256 IS DISTINCT FROM OLD.profile_sha256
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
       OR NEW.source_project_id IS DISTINCT FROM OLD.source_project_id
       OR NEW.address_revision IS DISTINCT FROM OLD.address_revision
     )
     AND ((NEW.profile IS DISTINCT FROM OLD.profile)
       = (NEW.profile_sha256 IS DISTINCT FROM OLD.profile_sha256)) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'site_energy_profile mutation guard: nur Confirmation oder Save N+1 ist erlaubt';
END
$m1_07_profile_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_site_energy_profile_mutation() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forbid_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER site_energy_profile_mutation_guard
BEFORE UPDATE OR DELETE ON public.site_energy_profile
FOR EACH ROW EXECUTE FUNCTION public.guard_site_energy_profile_mutation();--> statement-breakpoint
CREATE TRIGGER site_energy_profile_no_truncate
BEFORE TRUNCATE ON public.site_energy_profile
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- Der Queuejob hält Bindungen dauerhaft fest, erlaubt nur die enge
-- Zustandsmaschine und setzt fachlichen Input höchstens einmal.
CREATE FUNCTION public.guard_project_calculation_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_job_guard$
DECLARE
  transition_allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: DELETE ist nur im separaten Erasurevertrag erlaubt';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.address_revision IS DISTINCT FROM OLD.address_revision
     OR NEW.pin_confirmed_address_revision IS DISTINCT FROM OLD.pin_confirmed_address_revision
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
     OR NEW.confirmed_profile_revision IS DISTINCT FROM OLD.confirmed_profile_revision
     OR NEW.confirmed_address_revision IS DISTINCT FROM OLD.confirmed_address_revision
     OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
     OR NEW.requirement_revision IS DISTINCT FROM OLD.requirement_revision
     OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.reservation_key IS DISTINCT FROM OLD.reservation_key
     OR NEW.provider_recipe_version IS DISTINCT FROM OLD.provider_recipe_version
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.defaults_version IS DISTINCT FROM OLD.defaults_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Bindungen sind unveränderlich';
  END IF;

  IF OLD.input_sha256 IS NOT NULL
     AND (NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
       OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
       OR NEW.provider_snapshot IS DISTINCT FROM OLD.provider_snapshot) THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Input-Snapshot ist unveränderlich';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: attempt_count darf nur monoton einzeln steigen';
  END IF;

  transition_allowed :=
    NEW.state = OLD.state
    OR (OLD.state = 'queued' AND NEW.state = 'running')
    OR (OLD.state = 'running' AND NEW.state IN ('retry_wait', 'succeeded', 'failed_final'))
    OR (OLD.state = 'retry_wait' AND NEW.state = 'queued');
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: unzulässige state transition';
  END IF;

  IF NEW.state = 'running' AND OLD.state <> 'running'
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Claim muss attempt_count erhöhen';
  END IF;
  IF NEW.state <> 'running' AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: attempt_count ändert sich nur beim Claim';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: started_at ist nach erstem Setzen unveränderlich';
  END IF;
  IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: finished_at ist unveränderlich';
  END IF;
  IF OLD.result_revision_id IS NOT NULL
     AND NEW.result_revision_id IS DISTINCT FROM OLD.result_revision_id THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Resultbindung ist unveränderlich';
  END IF;

  RETURN NEW;
END
$m1_07_job_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_project_calculation_job_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER project_calculation_job_mutation_guard
BEFORE UPDATE OR DELETE ON public.project_calculation_job
FOR EACH ROW EXECUTE FUNCTION public.guard_project_calculation_job_mutation();--> statement-breakpoint
CREATE TRIGGER project_calculation_job_no_truncate
BEFORE TRUNCATE ON public.project_calculation_job
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- Die Resultrevision validiert beim INSERT dieselben gepinnten Bindungen wie
-- ihr Job und ist danach vollständig append-only.
CREATE FUNCTION public.guard_project_calculation_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_revision_guard$
DECLARE
  bound_job public.project_calculation_job%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'project_calculation_revision ist immutable; UPDATE/DELETE ist verboten';
  END IF;

  SELECT * INTO bound_job
    FROM public.project_calculation_job
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.job_id
     AND project_id = NEW.project_id
     AND site_id = NEW.site_id;
  IF NOT FOUND OR bound_job.state <> 'running' THEN
    RAISE EXCEPTION 'project_calculation_revision: Job fehlt oder ist nicht running';
  END IF;
  IF bound_job.address_revision IS DISTINCT FROM NEW.address_revision
     OR bound_job.pin_confirmed_address_revision IS DISTINCT FROM NEW.pin_confirmed_address_revision
     OR bound_job.profile_id IS DISTINCT FROM NEW.profile_id
     OR bound_job.profile_revision IS DISTINCT FROM NEW.profile_revision
     OR bound_job.confirmed_profile_revision IS DISTINCT FROM NEW.confirmed_profile_revision
     OR bound_job.confirmed_address_revision IS DISTINCT FROM NEW.confirmed_address_revision
     OR bound_job.requirement_id IS DISTINCT FROM NEW.requirement_id
     OR bound_job.requirement_revision IS DISTINCT FROM NEW.requirement_revision
     OR bound_job.source_snapshot_id IS DISTINCT FROM NEW.source_snapshot_id
     OR bound_job.contract_version IS DISTINCT FROM NEW.contract_version
     OR bound_job.model_id IS DISTINCT FROM NEW.model_id
     OR bound_job.model_version IS DISTINCT FROM NEW.model_version
     OR bound_job.source_revision IS DISTINCT FROM NEW.source_revision
     OR bound_job.defaults_version IS DISTINCT FROM NEW.defaults_version
     OR bound_job.input_sha256 IS DISTINCT FROM NEW.input_sha256
     OR bound_job.input_snapshot IS DISTINCT FROM NEW.input_snapshot
     OR bound_job.provider_snapshot IS DISTINCT FROM NEW.provider_snapshot
     OR bound_job.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'project_calculation_revision: Resultbindungen stimmen nicht mit dem Job überein';
  END IF;
  RETURN NEW;
END
$m1_07_revision_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_project_calculation_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER project_calculation_revision_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.project_calculation_revision
FOR EACH ROW EXECUTE FUNCTION public.guard_project_calculation_revision();--> statement-breakpoint
CREATE TRIGGER project_calculation_revision_no_truncate
BEFORE TRUNCATE ON public.project_calculation_revision
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
