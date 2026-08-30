CREATE TABLE "offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope" text DEFAULT 'residential' NOT NULL,
	"price_audience" text DEFAULT 'b2c' NOT NULL,
	"price_audience_decision" jsonb NOT NULL,
	"offer_number" text NOT NULL,
	"number_year" integer NOT NULL,
	"number_sequence" integer NOT NULL,
	"forecast_value_net_cents" bigint,
	"contact_context" jsonb NOT NULL,
	"installation_site_context" jsonb NOT NULL,
	"source_bindings" jsonb NOT NULL,
	"inbound_receipt_id" uuid NOT NULL,
	"inbound_payload_sha256" "bytea" NOT NULL,
	"requirement_id" uuid NOT NULL,
	"requirement_revision" integer NOT NULL,
	"calculation_revision_id" uuid NOT NULL,
	"calculation_revision" integer NOT NULL,
	"calculation_input_sha256" "bytea" NOT NULL,
	"calculation_result_sha256" "bytea" NOT NULL,
	"resolution_id" uuid NOT NULL,
	"resolution_revision" integer NOT NULL,
	"resolution_sha256" "bytea" NOT NULL,
	"create_digest" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_ws_project_uq" UNIQUE("workspace_id","project_id"),
	CONSTRAINT "offer_ws_number_uq" UNIQUE("workspace_id","offer_number"),
	CONSTRAINT "offer_ws_year_sequence_uq" UNIQUE("workspace_id","number_year","number_sequence"),
	CONSTRAINT "offer_status_scope_audience_ck" CHECK ("offer"."status" = 'draft'
      and "offer"."scope" = 'residential' and "offer"."price_audience" = 'b2c'),
	CONSTRAINT "offer_price_audience_decision_ck" CHECK (
      jsonb_typeof("offer"."price_audience_decision") = 'object'
      and ("offer"."price_audience_decision" - array[
        'audience', 'confirmationCode', 'confirmedBy', 'confirmedAt'
      ]::text[]) = '{}'::jsonb
      and "offer"."price_audience_decision"->>'audience' = "offer"."price_audience"
      and "offer"."price_audience_decision"->>'confirmationCode' = 'b2c_operator_confirmed'
      and ("offer"."price_audience_decision"->>'confirmedBy')::uuid = "offer"."created_by"
      and ("offer"."price_audience_decision"->>'confirmedAt')::timestamptz = "offer"."created_at"),
	CONSTRAINT "offer_number_ck" CHECK ("offer"."offer_number" ~ '^ANG-[0-9]{4}-[0-9]{6}$'),
	CONSTRAINT "offer_number_parts_ck" CHECK ("offer"."number_year" between 2000 and 9999
      and "offer"."number_sequence" between 1 and 999999),
	CONSTRAINT "offer_forecast_ck" CHECK ("offer"."forecast_value_net_cents" is null
      or "offer"."forecast_value_net_cents" between 0 and 9000000000000000),
	CONSTRAINT "offer_hashes_ck" CHECK (octet_length("offer"."inbound_payload_sha256") = 32
      and octet_length("offer"."calculation_input_sha256") = 32
      and octet_length("offer"."calculation_result_sha256") = 32
      and octet_length("offer"."resolution_sha256") = 32
      and octet_length("offer"."create_digest") = 32),
	CONSTRAINT "offer_context_json_ck" CHECK (jsonb_typeof("offer"."contact_context") = 'object'
      and jsonb_typeof("offer"."installation_site_context") = 'object'
      and jsonb_typeof("offer"."source_bindings") = 'object')
);
--> statement-breakpoint
CREATE TABLE "offer_bom_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"section_id" uuid NOT NULL,
	"section_domain_id" uuid NOT NULL,
	"line_domain_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"component_category" text NOT NULL,
	"position_type" text NOT NULL,
	"is_hidden" boolean NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit" text NOT NULL,
	"source_kind" text NOT NULL,
	"catalog_component_id" uuid,
	"catalog_component_revision" integer,
	"component_snapshot_sha256" "bytea",
	"original_sales_unit_net_cents" bigint NOT NULL,
	"effective_sales_unit_net_cents" bigint NOT NULL,
	"original_purchase_unit_net_cents" bigint NOT NULL,
	"effective_purchase_unit_net_cents" bigint NOT NULL,
	"line_discount_bps" integer NOT NULL,
	"tax_treatment" text NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"line_base_net_cents" bigint NOT NULL,
	"line_discounted_net_cents" bigint NOT NULL,
	"section_discounted_net_cents" bigint NOT NULL,
	"final_sales_net_cents" bigint NOT NULL,
	"sales_tax_cents" bigint NOT NULL,
	"sales_gross_cents" bigint NOT NULL,
	"purchase_net_cents" bigint NOT NULL,
	"line_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_bom_line_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_bom_line_ws_revision_domain_uq" UNIQUE("workspace_id","revision_id","line_domain_id"),
	CONSTRAINT "offer_bom_line_ws_section_position_uq" UNIQUE("workspace_id","revision_id","section_id","position"),
	CONSTRAINT "offer_bom_line_position_ck" CHECK ("offer_bom_line"."position" between 1 and 500),
	CONSTRAINT "offer_bom_line_category_ck" CHECK ("offer_bom_line"."component_category" in (
      'module', 'inverter', 'battery', 'wallbox', 'heat_pump', 'mounting', 'other'
    )),
	CONSTRAINT "offer_bom_line_position_type_ck" CHECK ("offer_bom_line"."position_type" in ('required', 'additional', 'optional')),
	CONSTRAINT "offer_bom_line_quantity_ck" CHECK ("offer_bom_line"."quantity_milli" between 1 and 100000000
      and ("offer_bom_line"."unit" = 'meter' or "offer_bom_line"."quantity_milli" % 1000 = 0)),
	CONSTRAINT "offer_bom_line_unit_ck" CHECK ("offer_bom_line"."unit" in ('piece', 'set', 'meter')),
	CONSTRAINT "offer_bom_line_source_ck" CHECK ((
      "offer_bom_line"."source_kind" = 'catalog'
      and "offer_bom_line"."catalog_component_id" is not null
      and "offer_bom_line"."catalog_component_revision" is not null
      and octet_length("offer_bom_line"."component_snapshot_sha256") = 32
    ) or (
      "offer_bom_line"."source_kind" = 'custom'
      and "offer_bom_line"."catalog_component_id" is null
      and "offer_bom_line"."catalog_component_revision" is null
      and "offer_bom_line"."component_snapshot_sha256" is null
    )),
	CONSTRAINT "offer_bom_line_discount_tax_ck" CHECK ("offer_bom_line"."line_discount_bps" between 0 and 10000
      and (("offer_bom_line"."tax_treatment" = 'standard_19' and "offer_bom_line"."tax_rate_bps" = 1900)
        or ("offer_bom_line"."tax_treatment" = 'zero_operator_confirmed' and "offer_bom_line"."tax_rate_bps" = 0))),
	CONSTRAINT "offer_bom_line_money_ck" CHECK ("offer_bom_line"."original_sales_unit_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."effective_sales_unit_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."original_purchase_unit_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."effective_purchase_unit_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."line_base_net_cents" between 0 and 9000000000000000 and "offer_bom_line"."line_discounted_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."section_discounted_net_cents" between 0 and 9000000000000000 and "offer_bom_line"."final_sales_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."sales_tax_cents" between 0 and 9000000000000000 and "offer_bom_line"."sales_gross_cents" between 0 and 9000000000000000
      and "offer_bom_line"."purchase_net_cents" between 0 and 9000000000000000
      and "offer_bom_line"."sales_gross_cents" = "offer_bom_line"."final_sales_net_cents" + "offer_bom_line"."sales_tax_cents"),
	CONSTRAINT "offer_bom_line_json_ck" CHECK (jsonb_typeof("offer_bom_line"."line_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "offer_mutation_rate_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"actor_id" uuid,
	"window_start" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_mutation_rate_window_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_mutation_rate_window_scope_ck" CHECK ((
      "offer_mutation_rate_window"."scope" = 'actor' and "offer_mutation_rate_window"."actor_id" is not null and "offer_mutation_rate_window"."attempts" between 1 and 120
    ) or (
      "offer_mutation_rate_window"."scope" = 'workspace' and "offer_mutation_rate_window"."actor_id" is null and "offer_mutation_rate_window"."attempts" between 1 and 1200
    )),
	CONSTRAINT "offer_mutation_rate_window_alignment_ck" CHECK ("offer_mutation_rate_window"."window_start" = date_bin(
      interval '15 minutes', "offer_mutation_rate_window"."window_start", timestamptz '1970-01-01 00:00:00+00'
    ))
);
--> statement-breakpoint
CREATE TABLE "offer_number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"series_year" integer NOT NULL,
	"prefix" text DEFAULT 'ANG' NOT NULL,
	"padding" integer DEFAULT 6 NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_number_series_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_number_series_ws_year_uq" UNIQUE("workspace_id","series_year"),
	CONSTRAINT "offer_number_series_year_ck" CHECK ("offer_number_series"."series_year" between 2000 and 9999),
	CONSTRAINT "offer_number_series_format_ck" CHECK ("offer_number_series"."prefix" = 'ANG' and "offer_number_series"."padding" = 6),
	CONSTRAINT "offer_number_series_sequence_ck" CHECK ("offer_number_series"."last_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "offer_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"current_revision" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_variant_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_variant_ws_offer_id_uq" UNIQUE("workspace_id","offer_id","id"),
	CONSTRAINT "offer_variant_ws_offer_ordinal_uq" UNIQUE("workspace_id","offer_id","ordinal"),
	CONSTRAINT "offer_variant_ordinal_ck" CHECK ("offer_variant"."ordinal" between 1 and 12),
	CONSTRAINT "offer_variant_revision_ck" CHECK ("offer_variant"."current_revision" > 0),
	CONSTRAINT "offer_variant_name_ck" CHECK (length(btrim("offer_variant"."name")) between 1 and 120),
	CONSTRAINT "offer_variant_description_ck" CHECK ("offer_variant"."description" is null
      or length(btrim("offer_variant"."description")) between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "offer_variant_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"revision_snapshot" jsonb NOT NULL,
	"snapshot_sha256" "bytea" NOT NULL,
	"resolution_id" uuid NOT NULL,
	"resolution_revision" integer NOT NULL,
	"resolution_sha256" "bytea" NOT NULL,
	"basis_net_cents" bigint NOT NULL,
	"basis_tax_cents" bigint NOT NULL,
	"basis_gross_cents" bigint NOT NULL,
	"optional_net_cents" bigint NOT NULL,
	"optional_tax_cents" bigint NOT NULL,
	"optional_gross_cents" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_variant_revision_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_variant_revision_ws_graph_uq" UNIQUE("workspace_id","id","offer_id","variant_id","project_id","revision"),
	CONSTRAINT "offer_variant_revision_ws_variant_revision_uq" UNIQUE("workspace_id","variant_id","revision"),
	CONSTRAINT "offer_variant_revision_revision_ck" CHECK ("offer_variant_revision"."revision" > 0),
	CONSTRAINT "offer_variant_revision_version_ck" CHECK ("offer_variant_revision"."schema_version" = 'offer-variant-snapshot.v1'
      and "offer_variant_revision"."canonicalization_version" = 'offer-jcs.v1'),
	CONSTRAINT "offer_variant_revision_hash_ck" CHECK (octet_length("offer_variant_revision"."snapshot_sha256") = 32
      and octet_length("offer_variant_revision"."resolution_sha256") = 32),
	CONSTRAINT "offer_variant_revision_money_ck" CHECK ("offer_variant_revision"."basis_net_cents" between 0 and 9000000000000000
      and "offer_variant_revision"."basis_tax_cents" between 0 and 9000000000000000 and "offer_variant_revision"."basis_gross_cents" between 0 and 9000000000000000
      and "offer_variant_revision"."optional_net_cents" between 0 and 9000000000000000 and "offer_variant_revision"."optional_tax_cents" between 0 and 9000000000000000
      and "offer_variant_revision"."optional_gross_cents" between 0 and 9000000000000000
      and "offer_variant_revision"."basis_gross_cents" = "offer_variant_revision"."basis_net_cents" + "offer_variant_revision"."basis_tax_cents"
      and "offer_variant_revision"."optional_gross_cents" = "offer_variant_revision"."optional_net_cents" + "offer_variant_revision"."optional_tax_cents"),
	CONSTRAINT "offer_variant_revision_json_ck" CHECK (jsonb_typeof("offer_variant_revision"."revision_snapshot") = 'object'
      and "offer_variant_revision"."revision_snapshot"->>'schemaVersion' = "offer_variant_revision"."schema_version"
      and "offer_variant_revision"."revision_snapshot"->>'canonicalizationVersion' = "offer_variant_revision"."canonicalization_version"
      and "offer_variant_revision"."revision_snapshot"->>'workspaceId' = "offer_variant_revision"."workspace_id"::text
      and "offer_variant_revision"."revision_snapshot"->>'offerId' = "offer_variant_revision"."offer_id"::text
      and "offer_variant_revision"."revision_snapshot"->>'variantId' = "offer_variant_revision"."variant_id"::text
      and ("offer_variant_revision"."revision_snapshot"->>'revision')::integer = "offer_variant_revision"."revision"
      and "offer_variant_revision"."revision_snapshot"->>'snapshotSha256' = encode("offer_variant_revision"."snapshot_sha256", 'hex')
      and jsonb_typeof("offer_variant_revision"."revision_snapshot"->'sections') = 'array'
      and jsonb_array_length("offer_variant_revision"."revision_snapshot"->'sections') between 1 and 25)
);
--> statement-breakpoint
CREATE TABLE "offer_variant_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"section_domain_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"discount_bps" integer NOT NULL,
	"section_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_variant_section_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_variant_section_ws_revision_id_uq" UNIQUE("workspace_id","revision_id","id"),
	CONSTRAINT "offer_variant_section_ws_revision_domain_uq" UNIQUE("workspace_id","revision_id","section_domain_id"),
	CONSTRAINT "offer_variant_section_ws_revision_position_uq" UNIQUE("workspace_id","revision_id","position"),
	CONSTRAINT "offer_variant_section_position_ck" CHECK ("offer_variant_section"."position" between 1 and 25),
	CONSTRAINT "offer_variant_section_category_ck" CHECK ("offer_variant_section"."category" in (
      'module', 'inverter', 'battery', 'wallbox', 'heat_pump', 'mounting', 'other'
    )),
	CONSTRAINT "offer_variant_section_title_ck" CHECK (length(btrim("offer_variant_section"."title")) between 1 and 120),
	CONSTRAINT "offer_variant_section_discount_ck" CHECK ("offer_variant_section"."discount_bps" between 0 and 10000),
	CONSTRAINT "offer_variant_section_json_ck" CHECK (jsonb_typeof("offer_variant_section"."section_snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "project_catalog_resolution" ADD CONSTRAINT "project_catalog_resolution_ws_exact_source_uq" UNIQUE("workspace_id","id","project_id","revision","resolution_sha256");--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_ws_exact_source_uq" UNIQUE("workspace_id","id","project_id","site_id","revision","input_sha256","result_sha256");--> statement-breakpoint
ALTER TABLE "inbound_receipt" ADD CONSTRAINT "inbound_receipt_ws_exact_source_uq" UNIQUE("workspace_id","id","project_id","body_sha256");--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_project_graph_fk" FOREIGN KEY ("workspace_id","project_id","contact_id","site_id") REFERENCES "public"."project"("workspace_id","id","contact_id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_inbound_receipt_fk" FOREIGN KEY ("workspace_id","inbound_receipt_id","project_id","inbound_payload_sha256") REFERENCES "public"."inbound_receipt"("workspace_id","id","project_id","body_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_requirement_fk" FOREIGN KEY ("workspace_id","requirement_id","project_id","requirement_revision") REFERENCES "public"."project_requirement"("workspace_id","id","project_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_calculation_revision_fk" FOREIGN KEY ("workspace_id","calculation_revision_id","project_id","site_id","calculation_revision","calculation_input_sha256","calculation_result_sha256") REFERENCES "public"."project_calculation_revision"("workspace_id","id","project_id","site_id","revision","input_sha256","result_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_resolution_fk" FOREIGN KEY ("workspace_id","resolution_id","project_id","resolution_revision","resolution_sha256") REFERENCES "public"."project_catalog_resolution"("workspace_id","id","project_id","revision","resolution_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_bom_line" ADD CONSTRAINT "offer_bom_line_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_bom_line" ADD CONSTRAINT "offer_bom_line_revision_fk" FOREIGN KEY ("workspace_id","revision_id","offer_id","variant_id","project_id","revision") REFERENCES "public"."offer_variant_revision"("workspace_id","id","offer_id","variant_id","project_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_bom_line" ADD CONSTRAINT "offer_bom_line_section_fk" FOREIGN KEY ("workspace_id","revision_id","section_id") REFERENCES "public"."offer_variant_section"("workspace_id","revision_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_bom_line" ADD CONSTRAINT "offer_bom_line_catalog_revision_fk" FOREIGN KEY ("workspace_id","catalog_component_id","catalog_component_revision","component_snapshot_sha256") REFERENCES "public"."catalog_component_revision"("workspace_id","component_id","revision","snapshot_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_mutation_rate_window" ADD CONSTRAINT "offer_mutation_rate_window_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_mutation_rate_window" ADD CONSTRAINT "offer_mutation_rate_window_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_number_series" ADD CONSTRAINT "offer_number_series_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_variant_fk" FOREIGN KEY ("workspace_id","offer_id","variant_id") REFERENCES "public"."offer_variant"("workspace_id","offer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_resolution_fk" FOREIGN KEY ("workspace_id","resolution_id","project_id","resolution_revision","resolution_sha256") REFERENCES "public"."project_catalog_resolution"("workspace_id","id","project_id","revision","resolution_sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_section" ADD CONSTRAINT "offer_variant_section_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_section" ADD CONSTRAINT "offer_variant_section_revision_fk" FOREIGN KEY ("workspace_id","revision_id","offer_id","variant_id","project_id","revision") REFERENCES "public"."offer_variant_revision"("workspace_id","id","offer_id","variant_id","project_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_ws_updated_idx" ON "offer" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "offer_bom_line_ws_catalog_idx" ON "offer_bom_line" USING btree ("workspace_id","catalog_component_id","catalog_component_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_mutation_rate_window_actor_uq" ON "offer_mutation_rate_window" USING btree ("workspace_id","actor_id","window_start") WHERE "offer_mutation_rate_window"."scope" = 'actor';--> statement-breakpoint
CREATE UNIQUE INDEX "offer_mutation_rate_window_workspace_uq" ON "offer_mutation_rate_window" USING btree ("workspace_id","window_start") WHERE "offer_mutation_rate_window"."scope" = 'workspace';--> statement-breakpoint
CREATE INDEX "offer_variant_ws_offer_idx" ON "offer_variant" USING btree ("workspace_id","offer_id","ordinal");--> statement-breakpoint
ALTER TABLE public.offer_variant
  ADD CONSTRAINT offer_variant_current_revision_fk
  FOREIGN KEY (workspace_id, id, current_revision)
  REFERENCES public.offer_variant_revision (workspace_id, variant_id, revision)
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

CREATE TRIGGER offer_variant_revision_immutable
  BEFORE UPDATE OR DELETE ON public.offer_variant_revision
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_variant_revision_no_truncate
  BEFORE TRUNCATE ON public.offer_variant_revision
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_variant_section_immutable
  BEFORE UPDATE OR DELETE ON public.offer_variant_section
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_variant_section_no_truncate
  BEFORE TRUNCATE ON public.offer_variant_section
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_bom_line_immutable
  BEFORE UPDATE OR DELETE ON public.offer_bom_line
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER offer_bom_line_no_truncate
  BEFORE TRUNCATE ON public.offer_bom_line
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

ALTER TABLE public.offer_number_series ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_number_series FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_number_series
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer_variant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_variant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_variant
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer_variant_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_variant_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_variant_revision
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer_variant_section ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_variant_section FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_variant_section
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer_bom_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_bom_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_bom_line
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE public.offer_mutation_rate_window ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_mutation_rate_window FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_mutation_rate_window
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

-- Gepinnte DB-Entsprechung der offer-jcs.v1-Teilmenge. Gueltige Offer-v1-
-- Snapshots besitzen ausschliesslich statische ASCII-Objektschluessel, sichere
-- Ganzzahlen und NFC-Texte. Damit ist die C-Sortierung der Schluessel bytegleich
-- zur JS-/UTF-16-Sortierung und Direkt-SQL kann keinen Fantasiehash behaupten.
CREATE FUNCTION public.canonicalize_offer_json_v1(input_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $m2_01_offer_canonical$
DECLARE
  value_kind text := pg_catalog.jsonb_typeof(input_value);
  raw_text text;
  normalized_text text;
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
        RAISE EXCEPTION 'offer-jcs.v1 erlaubt nur sichere Ganzzahlen';
      END IF;
      RETURN numeric_value::bigint::text;
    WHEN 'string' THEN
      raw_text := input_value #>> '{}';
      normalized_text := pg_catalog.normalize(raw_text, 'NFC');
      RETURN pg_catalog.to_jsonb(normalized_text)::text;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        pg_catalog.string_agg(
          public.canonicalize_offer_json_v1(element.value),
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
         WHERE pg_catalog.octet_length(pg_catalog.convert_to(object_key.key, 'UTF8'))
               <> pg_catalog.char_length(object_key.key)
      ) THEN
        RAISE EXCEPTION 'offer-jcs.v1 erlaubt nur ASCII-Objektschluessel';
      END IF;
      SELECT '{' || COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(member.key)::text || ':' ||
            public.canonicalize_offer_json_v1(member.value),
          ',' ORDER BY member.key COLLATE "C"
        ),
        ''
      ) || '}'
        INTO canonical_value
        FROM pg_catalog.jsonb_each(input_value) AS member(key, value);
      RETURN canonical_value;
    ELSE
      RAISE EXCEPTION 'offer-jcs.v1 kennt den JSON-Typ nicht';
  END CASE;
END
$m2_01_offer_canonical$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.canonicalize_offer_json_v1(jsonb) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.validate_offer_variant_snapshot_mirrors()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m2_01_offer_validate$
DECLARE
  trigger_row jsonb;
  target_workspace_id uuid;
  target_revision_id uuid;
  target_revision public.offer_variant_revision%ROWTYPE;
  target_variant public.offer_variant%ROWTYPE;
  target_offer public.offer%ROWTYPE;
  target_resolution public.project_catalog_resolution%ROWTYPE;
  expected_sections integer;
  actual_sections integer;
  expected_lines integer;
  actual_lines integer;
  mirrored_sections jsonb;
BEGIN
  trigger_row := pg_catalog.to_jsonb(NEW);
  target_workspace_id := (trigger_row->>'workspace_id')::uuid;

  IF TG_TABLE_NAME = 'offer_variant' THEN
    SELECT revision_record.id INTO target_revision_id
      FROM public.offer_variant_revision AS revision_record
     WHERE revision_record.workspace_id = target_workspace_id
       AND revision_record.variant_id = (trigger_row->>'id')::uuid
       AND revision_record.revision = (trigger_row->>'current_revision')::integer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offer_variant: current_revision besitzt keinen Snapshot';
    END IF;
  ELSIF TG_TABLE_NAME = 'offer_variant_revision' THEN
    target_revision_id := (trigger_row->>'id')::uuid;
  ELSE
    target_revision_id := (trigger_row->>'revision_id')::uuid;
  END IF;

  SELECT * INTO target_revision
    FROM public.offer_variant_revision AS revision_record
   WHERE revision_record.workspace_id = target_workspace_id
     AND revision_record.id = target_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer snapshot mirror: Revision fehlt';
  END IF;

  SELECT * INTO target_variant
    FROM public.offer_variant AS variant_record
   WHERE variant_record.workspace_id = target_revision.workspace_id
     AND variant_record.offer_id = target_revision.offer_id
     AND variant_record.id = target_revision.variant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer snapshot mirror: Variante fehlt';
  END IF;

  SELECT * INTO target_offer
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = target_revision.workspace_id
     AND offer_record.id = target_revision.offer_id
     AND offer_record.project_id = target_revision.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer snapshot mirror: Offer fehlt';
  END IF;

  SELECT * INTO target_resolution
    FROM public.project_catalog_resolution AS resolution_record
   WHERE resolution_record.workspace_id = target_revision.workspace_id
     AND resolution_record.id = target_revision.resolution_id
     AND resolution_record.project_id = target_revision.project_id
     AND resolution_record.revision = target_revision.resolution_revision
     AND resolution_record.resolution_sha256 = target_revision.resolution_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer snapshot mirror: Quellaufloesung fehlt';
  END IF;

  IF target_offer.source_bindings IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'projectId', target_offer.project_id,
       'contactId', target_offer.contact_id,
       'siteId', target_offer.site_id,
       'inboundReceiptId', target_offer.inbound_receipt_id,
       'inboundPayloadSha256', pg_catalog.encode(target_offer.inbound_payload_sha256, 'hex'),
       'requirementId', target_offer.requirement_id,
       'requirementRevision', target_offer.requirement_revision,
       'calculationRevisionId', target_offer.calculation_revision_id,
       'calculationRevision', target_offer.calculation_revision,
       'calculationInputSha256', pg_catalog.encode(target_offer.calculation_input_sha256, 'hex'),
       'calculationResultSha256', pg_catalog.encode(target_offer.calculation_result_sha256, 'hex'),
       'resolutionId', target_offer.resolution_id,
       'resolutionRevision', target_offer.resolution_revision,
       'resolutionSha256', pg_catalog.encode(target_offer.resolution_sha256, 'hex')
     ) THEN
    RAISE EXCEPTION 'offer snapshot mirror: Offer-Quellbindungen driften';
  END IF;

  IF target_variant.current_revision IS DISTINCT FROM (
       SELECT pg_catalog.max(candidate.revision)
         FROM public.offer_variant_revision AS candidate
        WHERE candidate.workspace_id = target_variant.workspace_id
          AND candidate.variant_id = target_variant.id
     )
     OR target_variant.current_revision IS DISTINCT FROM target_revision.revision THEN
    RAISE EXCEPTION 'offer_variant: current_revision ist nicht die hoechste vollstaendige Revision';
  END IF;

  IF target_revision.revision_snapshot->>'snapshotSha256'
       IS DISTINCT FROM pg_catalog.encode(target_revision.snapshot_sha256, 'hex')
     OR target_resolution.site_id IS DISTINCT FROM target_offer.site_id
     OR target_revision.revision_snapshot->'sourceBindings'
       IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'projectId', target_revision.project_id,
         'contactId', target_offer.contact_id,
         'siteId', target_offer.site_id,
         'inboundReceiptId', target_offer.inbound_receipt_id,
         'inboundPayloadSha256', pg_catalog.encode(target_offer.inbound_payload_sha256, 'hex'),
         'requirementId', target_resolution.requirement_id,
         'requirementRevision', target_resolution.requirement_revision,
         'calculationRevisionId', target_resolution.calculation_revision_id,
         'calculationRevision', target_resolution.calculation_revision,
         'calculationInputSha256', pg_catalog.encode(target_resolution.calculation_input_sha256, 'hex'),
         'calculationResultSha256', pg_catalog.encode(target_resolution.calculation_result_sha256, 'hex'),
         'resolutionId', target_revision.resolution_id,
         'resolutionRevision', target_revision.resolution_revision,
         'resolutionSha256', pg_catalog.encode(target_revision.resolution_sha256, 'hex')
       )
     OR target_revision.revision_snapshot->'priceAudienceDecision'
       IS DISTINCT FROM target_offer.price_audience_decision
     OR target_revision.revision_snapshot->>'createdBy'
       IS DISTINCT FROM target_revision.created_by::text
     OR (target_revision.revision_snapshot->>'createdAt')::timestamptz
       IS DISTINCT FROM target_revision.created_at
     OR target_revision.revision_snapshot->'contactContext'
       IS DISTINCT FROM target_offer.contact_context
     OR target_revision.revision_snapshot->'installationSiteContext'
       IS DISTINCT FROM target_offer.installation_site_context
     OR target_revision.revision_snapshot->>'variantName'
       IS DISTINCT FROM target_variant.name
     OR target_revision.revision_snapshot->'description'
       IS DISTINCT FROM COALESCE(
         pg_catalog.to_jsonb(target_variant.description),
         'null'::jsonb
       )
     OR (target_revision.revision_snapshot#>>'{totals,basisNetCents}')::bigint
       IS DISTINCT FROM target_revision.basis_net_cents
     OR (target_revision.revision_snapshot#>>'{totals,basisTaxCents}')::bigint
       IS DISTINCT FROM target_revision.basis_tax_cents
     OR (target_revision.revision_snapshot#>>'{totals,basisGrossCents}')::bigint
       IS DISTINCT FROM target_revision.basis_gross_cents
     OR (target_revision.revision_snapshot#>>'{totals,optionalNetCents}')::bigint
       IS DISTINCT FROM target_revision.optional_net_cents
     OR (target_revision.revision_snapshot#>>'{totals,optionalTaxCents}')::bigint
       IS DISTINCT FROM target_revision.optional_tax_cents
     OR (target_revision.revision_snapshot#>>'{totals,optionalGrossCents}')::bigint
       IS DISTINCT FROM target_revision.optional_gross_cents THEN
    RAISE EXCEPTION 'offer snapshot mirror: Revisionsprojektion driftet';
  END IF;

  -- Nur der Revisionstrigger rechnet den relativ teuren Inhaltshash; die
  -- weiteren deferred Mirrortrigger pruefen dieselbe Revision anschliessend
  -- weiterhin auf vollstaendige relationale Projektion.
  IF TG_TABLE_NAME = 'offer_variant_revision'
     AND pg_catalog.sha256(pg_catalog.convert_to(
       public.canonicalize_offer_json_v1(
         target_revision.revision_snapshot - 'snapshotSha256'
       ),
       'UTF8'
     )) IS DISTINCT FROM target_revision.snapshot_sha256 THEN
    RAISE EXCEPTION 'offer snapshot mirror: kanonischer Inhalts-Hash driftet';
  END IF;

  expected_sections := pg_catalog.jsonb_array_length(
    target_revision.revision_snapshot->'sections'
  );
  SELECT pg_catalog.count(*)::integer,
         pg_catalog.jsonb_agg(section_record.section_snapshot ORDER BY section_record.position)
    INTO actual_sections, mirrored_sections
    FROM public.offer_variant_section AS section_record
   WHERE section_record.workspace_id = target_revision.workspace_id
     AND section_record.revision_id = target_revision.id;
  IF actual_sections IS DISTINCT FROM expected_sections
     OR actual_sections < 1
     OR mirrored_sections IS DISTINCT FROM target_revision.revision_snapshot->'sections' THEN
    RAISE EXCEPTION 'offer snapshot mirror: Sektionen sind unvollstaendig oder umgeordnet';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.offer_variant_section AS section_record
     WHERE section_record.workspace_id = target_revision.workspace_id
       AND section_record.revision_id = target_revision.id
       AND (
         section_record.section_snapshot->>'sectionDomainId'
           IS DISTINCT FROM section_record.section_domain_id::text
         OR (section_record.section_snapshot->>'position')::integer
           IS DISTINCT FROM section_record.position
         OR section_record.section_snapshot->>'category'
           IS DISTINCT FROM section_record.category
         OR section_record.section_snapshot->>'title'
           IS DISTINCT FROM section_record.title
         OR (section_record.section_snapshot->>'discountBps')::integer
           IS DISTINCT FROM section_record.discount_bps
       )
  ) THEN
    RAISE EXCEPTION 'offer snapshot mirror: Sektionsprojektion driftet';
  END IF;

  SELECT COALESCE(pg_catalog.sum(
           pg_catalog.jsonb_array_length(section_value.value->'lines')
         ), 0::bigint)::integer
    INTO expected_lines
    FROM pg_catalog.jsonb_array_elements(
      target_revision.revision_snapshot->'sections'
    ) AS section_value(value);
  SELECT pg_catalog.count(*)::integer INTO actual_lines
    FROM public.offer_bom_line AS line_record
   WHERE line_record.workspace_id = target_revision.workspace_id
     AND line_record.revision_id = target_revision.id;
  IF actual_lines IS DISTINCT FROM expected_lines
     OR actual_lines < 1 OR actual_lines > 500 THEN
    RAISE EXCEPTION 'offer snapshot mirror: BOM-Zeilen sind unvollstaendig';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.offer_variant_section AS section_record
     WHERE section_record.workspace_id = target_revision.workspace_id
       AND section_record.revision_id = target_revision.id
       AND (
         SELECT pg_catalog.jsonb_agg(line_record.line_snapshot ORDER BY line_record.position)
           FROM public.offer_bom_line AS line_record
          WHERE line_record.workspace_id = section_record.workspace_id
            AND line_record.revision_id = section_record.revision_id
            AND line_record.section_id = section_record.id
       ) IS DISTINCT FROM section_record.section_snapshot->'lines'
  ) THEN
    RAISE EXCEPTION 'offer snapshot mirror: BOM-Zeilen fehlen oder sind umgeordnet';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.offer_bom_line AS line_record
      JOIN public.offer_variant_section AS section_record
        ON section_record.workspace_id = line_record.workspace_id
       AND section_record.revision_id = line_record.revision_id
       AND section_record.id = line_record.section_id
     WHERE line_record.workspace_id = target_revision.workspace_id
       AND line_record.revision_id = target_revision.id
       AND (
         line_record.section_domain_id IS DISTINCT FROM section_record.section_domain_id
         OR line_record.line_snapshot->>'lineDomainId'
           IS DISTINCT FROM line_record.line_domain_id::text
         OR (line_record.line_snapshot->>'position')::integer
           IS DISTINCT FROM line_record.position
         OR line_record.line_snapshot->>'componentCategory'
           IS DISTINCT FROM line_record.component_category
         OR line_record.line_snapshot->>'positionType'
           IS DISTINCT FROM line_record.position_type
         OR (line_record.line_snapshot->>'isHidden')::boolean
           IS DISTINCT FROM line_record.is_hidden
         OR (line_record.line_snapshot->>'quantityMilli')::integer
           IS DISTINCT FROM line_record.quantity_milli
         OR line_record.line_snapshot#>>'{product,unit}'
           IS DISTINCT FROM line_record.unit
         OR line_record.line_snapshot#>>'{source,kind}'
           IS DISTINCT FROM line_record.source_kind
         OR line_record.line_snapshot#>>'{source,catalogComponentId}'
           IS DISTINCT FROM line_record.catalog_component_id::text
         OR (line_record.line_snapshot#>>'{source,catalogComponentRevision}')::integer
           IS DISTINCT FROM line_record.catalog_component_revision
         OR line_record.line_snapshot#>>'{source,componentSnapshotSha256}'
           IS DISTINCT FROM pg_catalog.encode(line_record.component_snapshot_sha256, 'hex')
         OR (line_record.line_snapshot#>>'{salesPricing,originalUnitNetCents}')::bigint
           IS DISTINCT FROM line_record.original_sales_unit_net_cents
         OR (line_record.line_snapshot#>>'{salesPricing,effectiveUnitNetCents}')::bigint
           IS DISTINCT FROM line_record.effective_sales_unit_net_cents
         OR (line_record.line_snapshot#>>'{purchasePricing,originalUnitNetCents}')::bigint
           IS DISTINCT FROM line_record.original_purchase_unit_net_cents
         OR (line_record.line_snapshot#>>'{purchasePricing,effectiveUnitNetCents}')::bigint
           IS DISTINCT FROM line_record.effective_purchase_unit_net_cents
         OR (line_record.line_snapshot->>'lineDiscountBps')::integer
           IS DISTINCT FROM line_record.line_discount_bps
         OR line_record.line_snapshot->>'taxTreatment'
           IS DISTINCT FROM line_record.tax_treatment
         OR (line_record.line_snapshot->>'taxRateBps')::integer
           IS DISTINCT FROM line_record.tax_rate_bps
         OR (line_record.line_snapshot#>>'{computed,lineBaseNetCents}')::bigint
           IS DISTINCT FROM line_record.line_base_net_cents
         OR (line_record.line_snapshot#>>'{computed,lineDiscountedNetCents}')::bigint
           IS DISTINCT FROM line_record.line_discounted_net_cents
         OR (line_record.line_snapshot#>>'{computed,sectionDiscountedNetCents}')::bigint
           IS DISTINCT FROM line_record.section_discounted_net_cents
         OR (line_record.line_snapshot#>>'{computed,finalSalesNetCents}')::bigint
           IS DISTINCT FROM line_record.final_sales_net_cents
         OR (line_record.line_snapshot#>>'{computed,salesTaxCents}')::bigint
           IS DISTINCT FROM line_record.sales_tax_cents
         OR (line_record.line_snapshot#>>'{computed,salesGrossCents}')::bigint
           IS DISTINCT FROM line_record.sales_gross_cents
         OR (line_record.line_snapshot#>>'{computed,purchaseNetCents}')::bigint
           IS DISTINCT FROM line_record.purchase_net_cents
       )
  ) THEN
    RAISE EXCEPTION 'offer snapshot mirror: BOM-Projektion driftet';
  END IF;

  RETURN NULL;
END
$m2_01_offer_validate$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_offer_variant_snapshot_mirrors() FROM PUBLIC;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER offer_variant_revision_complete
  AFTER INSERT ON public.offer_variant_revision
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_offer_variant_snapshot_mirrors();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER offer_variant_section_complete
  AFTER INSERT ON public.offer_variant_section
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_offer_variant_snapshot_mirrors();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER offer_bom_line_complete
  AFTER INSERT ON public.offer_bom_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_offer_variant_snapshot_mirrors();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER offer_variant_current_complete
  AFTER INSERT OR UPDATE ON public.offer_variant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_offer_variant_snapshot_mirrors();--> statement-breakpoint

-- Nur aktive Default-Wohngebäude-Boards ohne aktive Angebotsspalte erhalten
-- den neuen Zustand. Eigene, gewerbliche, archivierte oder bereits 1/n-fach
-- konfigurierte Boards bleiben bytegenau unangetastet.
-- Beide Tabellen stehen bereits unter FORCE RLS. Für diesen schemaweiten
-- Bestands-Backfill darf ausschließlich der Migrations-Owner kurz an FORCE
-- vorbeisehen; ENABLE RLS bleibt aktiv und FORCE wird unmittelbar danach
-- wiederhergestellt.
ALTER TABLE public.kanban_board NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.kanban_column NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO public.kanban_column (
  id, workspace_id, board_id, name, column_type, position, color, is_intake,
  created_at, updated_at
)
SELECT pg_catalog.gen_random_uuid(), board.workspace_id, board.id,
       'Angebote', 'offer', positions.next_position, 'blue', false,
       pg_catalog.now(), pg_catalog.now()
  FROM public.kanban_board AS board
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.max(existing.position), 0) + 1 AS next_position
      FROM public.kanban_column AS existing
     WHERE existing.workspace_id = board.workspace_id
       AND existing.board_id = board.id
       AND existing.archived_at IS NULL
  ) AS positions
 WHERE board.scope = 'residential'
   AND board.is_default = true
   AND board.archived_at IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM public.kanban_column AS offer_column
      WHERE offer_column.workspace_id = board.workspace_id
        AND offer_column.board_id = board.id
        AND offer_column.column_type = 'offer'
        AND offer_column.archived_at IS NULL
   );--> statement-breakpoint
ALTER TABLE public.kanban_column FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.kanban_board FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Der Workspace-Trigger bleibt die einzige Provisionierungsgrenze. Neue
-- Workspaces erhalten denselben vierstufigen Residential-Workflow wie der
-- idempotente Backfill; PUBLIC bekommt weiterhin kein Ausführungsrecht.
CREATE OR REPLACE FUNCTION public.provision_default_request_board()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m2_01_provision$
DECLARE
  board_id uuid := pg_catalog.gen_random_uuid();
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  PERFORM pg_catalog.set_config('app.workspace_id', NEW.id::text, true);

  INSERT INTO public.kanban_board (
    id, workspace_id, name, scope, is_default, created_at, updated_at
  ) VALUES (
    board_id, NEW.id, 'Anfragen', 'residential', true, now(), now()
  );
  INSERT INTO public.kanban_column (
    id, workspace_id, board_id, name, column_type, position, color, is_intake,
    created_at, updated_at
  ) VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'Eingang', 'lead', 1, 'blue', true, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'In Prüfung', 'lead', 2, 'amber', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'Qualifiziert', 'lead', 3, 'green', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'Angebote', 'offer', 4, 'blue', false, now(), now());

  PERFORM pg_catalog.set_config(
    'app.workspace_id',
    COALESCE(prior_workspace, ''),
    true
  );
  RETURN NEW;
END
$m2_01_provision$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provision_default_request_board() FROM PUBLIC;--> statement-breakpoint

-- M2-01 erweitert den bestehenden WORM-Erasuregraph additiv. Neue Tombstones
-- tragen den geschlossenen Offer-Untergraph; vor M2-01 erzeugte Tombstones
-- behalten ihre byte-/hashidentische Legacy-Form und bleiben replaybar.
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m2_01_tombstone_worm$
DECLARE
  graph_key text;
  offer_keys constant text[] := ARRAY[
    'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
    'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds',
    'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
    'offerVariantSectionIds', 'offerBomLineIds'
  ]::text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'erasure_tombstone WORM append-only: % ist verboten', TG_OP;
  END IF;

  IF pg_catalog.jsonb_typeof(NEW.graph_ids) <> 'object' THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;
  IF NEW.graph_ids - offer_keys <> '{}'::jsonb
     OR NOT NEW.graph_ids ?& offer_keys THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;

  IF pg_catalog.jsonb_typeof(NEW.graph_ids->'contactId') <> 'string'
     OR NEW.graph_ids->>'contactId' <> NEW.contact_id::text THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;
  FOREACH graph_key IN ARRAY offer_keys LOOP
    CONTINUE WHEN graph_key = 'contactId';
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
         SELECT pg_catalog.jsonb_agg(graph_value.value ORDER BY graph_value.value #>> '{}')
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
$m2_01_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;--> statement-breakpoint

-- Offer, Variante und alle immutable Mirrors duerfen nur dann geloescht
-- werden, wenn der gerade aktive WORM-Tombstone genau diese ID autorisiert.
-- UPDATE bleibt fuer die drei Snapshot-Tabellen ausnahmslos verboten. Am
-- Offer-Kopf darf ausschliesslich das monotone Aktivitaetsfeld updated_at
-- fortgeschrieben werden; Nummer, PII-Snapshot, B2C-Entscheidung und saemtliche
-- Quellbindungen sind auch gegen direkte Owner-SQL unveraenderlich.
CREATE FUNCTION public.guard_offer_erasure_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m2_01_offer_erasure_guard$
DECLARE
  erasure_setting text;
  erasure_operation uuid;
  graph_key text;
  old_row jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'offer' THEN
      IF (pg_catalog.to_jsonb(NEW) - 'updated_at')
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'offer ist immutable; nur updated_at darf fortgeschrieben werden';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer.updated_at muss monoton sein';
      END IF;
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_variant' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY[
            'current_revision', 'name', 'description', 'updated_at'
          ]::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'current_revision', 'name', 'description', 'updated_at'
           ]::text[]) THEN
        RAISE EXCEPTION 'offer_variant: stabile Identitaet ist immutable';
      END IF;
      IF NEW.current_revision <> OLD.current_revision + 1
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_variant: Revision und updated_at muessen monoton fortschreiten';
      END IF;
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_number_series' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['last_sequence', 'updated_at']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'last_sequence', 'updated_at'
           ]::text[])
         OR NEW.last_sequence <> OLD.last_sequence + 1
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_number_series darf nur monoton um eins fortschreiten';
      END IF;
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_mutation_rate_window' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['attempts', 'updated_at']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'attempts', 'updated_at'
           ]::text[])
         OR NEW.attempts <> OLD.attempts + 1
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_mutation_rate_window darf nur monoton um eins fortschreiten';
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION '% ist immutable; UPDATE ist verboten', TG_TABLE_NAME;
    END IF;
  ELSIF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION '% ist immutable; UPDATE ist verboten', TG_TABLE_NAME;
  END IF;

  graph_key := CASE TG_TABLE_NAME
    WHEN 'offer' THEN 'offerIds'
    WHEN 'offer_variant' THEN 'offerVariantIds'
    WHEN 'offer_variant_revision' THEN 'offerVariantRevisionIds'
    WHEN 'offer_variant_section' THEN 'offerVariantSectionIds'
    WHEN 'offer_bom_line' THEN 'offerBomLineIds'
    ELSE NULL
  END;
  IF graph_key IS NULL THEN
    RAISE EXCEPTION 'offer erasure guard: unbekannte Tabelle %', TG_TABLE_NAME;
  END IF;

  erasure_setting := pg_catalog.current_setting('app.erasure_operation_id', true);
  BEGIN
    erasure_operation := NULLIF(erasure_setting, '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  old_row := pg_catalog.to_jsonb(OLD);
  IF erasure_operation IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = (old_row->>'workspace_id')::uuid
       AND tombstone.graph_ids->graph_key ? (old_row->>'id')
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%: DELETE ist nur im Erasurevertrag erlaubt', TG_TABLE_NAME;
END
$m2_01_offer_erasure_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_offer_erasure_mutation() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER offer_variant_revision_immutable ON public.offer_variant_revision;--> statement-breakpoint
CREATE TRIGGER offer_variant_revision_immutable
  BEFORE UPDATE OR DELETE ON public.offer_variant_revision
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
DROP TRIGGER offer_variant_section_immutable ON public.offer_variant_section;--> statement-breakpoint
CREATE TRIGGER offer_variant_section_immutable
  BEFORE UPDATE OR DELETE ON public.offer_variant_section
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
DROP TRIGGER offer_bom_line_immutable ON public.offer_bom_line;--> statement-breakpoint
CREATE TRIGGER offer_bom_line_immutable
  BEFORE UPDATE OR DELETE ON public.offer_bom_line
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
CREATE TRIGGER offer_immutable
  BEFORE UPDATE OR DELETE ON public.offer
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
CREATE TRIGGER offer_variant_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_variant
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
CREATE TRIGGER offer_number_series_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_number_series
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
CREATE TRIGGER offer_number_series_no_truncate
  BEFORE TRUNCATE ON public.offer_number_series
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
-- DELETE bleibt fuer den absichtlichen Membership-FK-Cascade offen. Die
-- Runtime besitzt darauf kein DELETE-Recht; der Zaehler-UPDATE ist trotzdem
-- auch fuer Owner-SQL exakt gepinnt.
CREATE TRIGGER offer_mutation_rate_window_update_guard
  BEFORE UPDATE ON public.offer_mutation_rate_window
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_erasure_mutation();--> statement-breakpoint
CREATE TRIGGER offer_mutation_rate_window_no_truncate
  BEFORE TRUNCATE ON public.offer_mutation_rate_window
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m2_01_erasure_graph$
  SELECT pg_catalog.jsonb_build_object(
    'contactId', requested_contact_id::text,
    'legalHoldIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(legal_hold.id::text ORDER BY legal_hold.id)
        FROM public.contact_legal_hold AS legal_hold
       WHERE legal_hold.workspace_id = requested_workspace_id
         AND legal_hold.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'siteIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(site_record.id::text ORDER BY site_record.id)
        FROM public.site AS site_record
       WHERE site_record.workspace_id = requested_workspace_id
         AND site_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'projectIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(project_record.id::text ORDER BY project_record.id)
        FROM public.project AS project_record
       WHERE project_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'profileIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(profile.id::text ORDER BY profile.id)
        FROM public.site_energy_profile AS profile
        JOIN public.site AS site_record
          ON site_record.workspace_id = profile.workspace_id
         AND site_record.id = profile.site_id
       WHERE profile.workspace_id = requested_workspace_id
         AND site_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'jobIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(job.id::text ORDER BY job.id)
        FROM public.project_calculation_job AS job
        JOIN public.project AS project_record
          ON project_record.workspace_id = job.workspace_id
         AND project_record.id = job.project_id
       WHERE job.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'revisionIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(revision.id::text ORDER BY revision.id)
        FROM public.project_calculation_revision AS revision
        JOIN public.project AS project_record
          ON project_record.workspace_id = revision.workspace_id
         AND project_record.id = revision.project_id
       WHERE revision.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'requirementIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(requirement.id::text ORDER BY requirement.id)
        FROM public.project_requirement AS requirement
        JOIN public.project AS project_record
          ON project_record.workspace_id = requirement.workspace_id
         AND project_record.id = requirement.project_id
       WHERE requirement.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'snapshotIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(snapshot.id::text ORDER BY snapshot.id)
        FROM public.calculator_snapshot AS snapshot
        JOIN public.project AS project_record
          ON project_record.workspace_id = snapshot.workspace_id
         AND project_record.id = snapshot.project_id
       WHERE snapshot.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ), '[]'::jsonb),
    'receiptIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(receipt.id::text ORDER BY receipt.id)
        FROM public.inbound_receipt AS receipt
        JOIN public.project AS project_record
          ON project_record.workspace_id = receipt.workspace_id
         AND project_record.id = receipt.project_id
       WHERE receipt.workspace_id = requested_workspace_id
         AND (
           project_record.contact_id = requested_contact_id
           OR receipt.email_match_contact_id = requested_contact_id
           OR receipt.phone_match_contact_id = requested_contact_id
         )
    ), '[]'::jsonb),
    'offerIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(offer_record.id::text ORDER BY offer_record.id)
        FROM public.offer AS offer_record
       WHERE offer_record.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ), '[]'::jsonb),
    'offerVariantIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(variant.id::text ORDER BY variant.id)
        FROM public.offer_variant AS variant
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = variant.workspace_id
         AND offer_record.id = variant.offer_id
       WHERE variant.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ), '[]'::jsonb),
    'offerVariantRevisionIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(revision.id::text ORDER BY revision.id)
        FROM public.offer_variant_revision AS revision
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = revision.workspace_id
         AND offer_record.id = revision.offer_id
       WHERE revision.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ), '[]'::jsonb),
    'offerVariantSectionIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(section_record.id::text ORDER BY section_record.id)
        FROM public.offer_variant_section AS section_record
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = section_record.workspace_id
         AND offer_record.id = section_record.offer_id
       WHERE section_record.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ), '[]'::jsonb),
    'offerBomLineIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(line_record.id::text ORDER BY line_record.id)
        FROM public.offer_bom_line AS line_record
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = line_record.workspace_id
         AND offer_record.id = line_record.offer_id
       WHERE line_record.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ), '[]'::jsonb)
  )
$m2_01_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.erase_inactive_lead(
  requested_workspace_id uuid,
  requested_contact_id uuid,
  requested_operation_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m2_01_erase$
DECLARE
  contact_row public.contact%ROWTYPE;
  existing_tombstone public.erasure_tombstone%ROWTYPE;
  located_workspace_id uuid;
  conflicting_operation uuid;
  graph_document jsonb;
  operational_graph_document jsonb;
  current_graph_document jsonb;
  locked_graph_document jsonb;
  graph_digest bytea;
  tombstone_digest bytea;
  latest_activity timestamp with time zone;
  eligible_time timestamp with time zone;
  erase_time timestamp with time zone;
  is_first_erasure boolean := false;
BEGIN
  IF requested_workspace_id IS NULL
     OR requested_contact_id IS NULL
     OR requested_operation_id IS NULL THEN
    RAISE EXCEPTION 'erasure_invalid_request';
  END IF;

  PERFORM pg_catalog.set_config('app.workspace_id', requested_workspace_id::text, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    requested_workspace_id::text || ':' || requested_contact_id::text,
    1701734770
  ));

  SELECT locator.scope_id INTO located_workspace_id
    FROM public.erasure_operation_locator AS locator
   WHERE locator.operation_id = requested_operation_id
   FOR SHARE;
  IF FOUND AND located_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'erasure_operation_conflict';
  END IF;

  SELECT * INTO existing_tombstone
    FROM public.erasure_tombstone AS tombstone
   WHERE tombstone.operation_id = requested_operation_id
   FOR SHARE;
  IF FOUND THEN
    IF existing_tombstone.workspace_id IS DISTINCT FROM requested_workspace_id
       OR existing_tombstone.contact_id IS DISTINCT FROM requested_contact_id THEN
      RAISE EXCEPTION 'erasure_operation_conflict';
    END IF;
    graph_document := existing_tombstone.graph_ids;
    eligible_time := existing_tombstone.eligible_at;
    erase_time := existing_tombstone.erased_at;
    graph_digest := pg_catalog.sha256(pg_catalog.convert_to(graph_document::text, 'UTF8'));
    IF graph_digest IS DISTINCT FROM existing_tombstone.graph_sha256 THEN
      RAISE EXCEPTION 'erasure_tombstone_corrupt';
    END IF;
    tombstone_digest := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.concat_ws(
        '|', existing_tombstone.operation_id::text,
        existing_tombstone.workspace_id::text,
        existing_tombstone.contact_id::text, existing_tombstone.reason,
        pg_catalog.encode(graph_digest, 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(eligible_time), 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(erase_time), 'hex')
      ),
      'UTF8'
    ));
    IF tombstone_digest IS DISTINCT FROM existing_tombstone.tombstone_sha256 THEN
      RAISE EXCEPTION 'erasure_tombstone_corrupt';
    END IF;
  ELSE
    SELECT tombstone.operation_id INTO conflicting_operation
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.workspace_id = requested_workspace_id
       AND tombstone.contact_id = requested_contact_id
     FOR SHARE;
    IF FOUND THEN
      RAISE EXCEPTION 'erasure_already_recorded';
    END IF;
    is_first_erasure := true;
    erase_time := pg_catalog.statement_timestamp();
  END IF;

  SELECT * INTO contact_row
    FROM public.contact AS contact_record
   WHERE contact_record.workspace_id = requested_workspace_id
     AND contact_record.id = requested_contact_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erasure_contact_not_found';
  END IF;

  -- Globale M1-Lockreihenfolge; der Offer-Untergraph wird ausschliesslich
  -- danach angehaengt und bei Erstlauf wie Replay identisch genommen.
  PERFORM 1
    FROM public.contact_legal_hold AS legal_hold
   WHERE legal_hold.workspace_id = requested_workspace_id
     AND legal_hold.contact_id = requested_contact_id
   ORDER BY legal_hold.id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.contact_legal_hold AS legal_hold
     WHERE legal_hold.workspace_id = requested_workspace_id
       AND legal_hold.contact_id = requested_contact_id
       AND legal_hold.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'erasure_legal_hold';
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.contact_id = requested_contact_id
   ORDER BY project_record.id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.project AS project_record
     WHERE project_record.workspace_id = requested_workspace_id
       AND project_record.contact_id = requested_contact_id
       AND project_record.outcome = 'won'
  ) THEN
    RAISE EXCEPTION 'erasure_contract_retained';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.offer AS offer_record
     WHERE offer_record.workspace_id = requested_workspace_id
       AND offer_record.contact_id = requested_contact_id
       AND offer_record.status <> 'draft'
  ) THEN
    RAISE EXCEPTION 'erasure_contract_retained';
  END IF;

  PERFORM 1
    FROM public.site AS site_record
   WHERE site_record.workspace_id = requested_workspace_id
     AND site_record.contact_id = requested_contact_id
   ORDER BY site_record.id
   FOR UPDATE;

  IF is_first_erasure THEN
    operational_graph_document := public.build_inactive_lead_erasure_graph(
      requested_workspace_id, requested_contact_id
    );
  ELSE
    operational_graph_document := graph_document || pg_catalog.jsonb_build_object(
      'offerIds', COALESCE(graph_document->'offerIds', '[]'::jsonb),
      'offerVariantIds', COALESCE(graph_document->'offerVariantIds', '[]'::jsonb),
      'offerVariantRevisionIds', COALESCE(graph_document->'offerVariantRevisionIds', '[]'::jsonb),
      'offerVariantSectionIds', COALESCE(graph_document->'offerVariantSectionIds', '[]'::jsonb),
      'offerBomLineIds', COALESCE(graph_document->'offerBomLineIds', '[]'::jsonb)
    );
  END IF;

  PERFORM 1 FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'jobIds'
       ) AS value
     )
   ORDER BY job.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.project_calculation_job AS job
     WHERE job.workspace_id = requested_workspace_id
       AND job.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           operational_graph_document->'jobIds'
         ) AS value
       )
       AND job.state = 'running'
       AND job.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
  PERFORM 1 FROM public.project_calculation_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'revisionIds'
       ) AS value
     )
   ORDER BY revision.id FOR UPDATE;
  PERFORM 1 FROM public.site_energy_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'profileIds'
       ) AS value
     )
   ORDER BY profile.id FOR UPDATE;
  PERFORM 1 FROM public.project_requirement AS requirement
   WHERE requirement.workspace_id = requested_workspace_id
     AND requirement.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'requirementIds'
       ) AS value
     )
   ORDER BY requirement.id FOR UPDATE;
  PERFORM 1 FROM public.calculator_snapshot AS snapshot
   WHERE snapshot.workspace_id = requested_workspace_id
     AND snapshot.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'snapshotIds'
       ) AS value
     )
   ORDER BY snapshot.id FOR UPDATE;
  PERFORM 1 FROM public.inbound_receipt AS receipt
   WHERE receipt.workspace_id = requested_workspace_id
     AND receipt.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'receiptIds'
       ) AS value
     )
   ORDER BY receipt.id FOR UPDATE;

  PERFORM 1 FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerIds'
       ) AS value
     )
   ORDER BY offer_record.id FOR UPDATE;
  PERFORM 1 FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantIds'
       ) AS value
     )
   ORDER BY variant.id FOR UPDATE;
  PERFORM 1 FROM public.offer_variant_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantRevisionIds'
       ) AS value
     )
   ORDER BY revision.id FOR UPDATE;
  PERFORM 1 FROM public.offer_variant_section AS section_record
   WHERE section_record.workspace_id = requested_workspace_id
     AND section_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantSectionIds'
       ) AS value
     )
   ORDER BY section_record.id FOR UPDATE;
  PERFORM 1 FROM public.offer_bom_line AS line_record
   WHERE line_record.workspace_id = requested_workspace_id
     AND line_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerBomLineIds'
       ) AS value
     )
   ORDER BY line_record.id FOR UPDATE;

  locked_graph_document := public.build_inactive_lead_erasure_graph(
    requested_workspace_id, requested_contact_id
  );
  IF is_first_erasure THEN
    IF locked_graph_document IS DISTINCT FROM operational_graph_document THEN
      RAISE EXCEPTION 'erasure_graph_drift';
    END IF;
    graph_document := locked_graph_document;
  ELSE
    current_graph_document := locked_graph_document;
    IF NOT current_graph_document <@ operational_graph_document THEN
      RAISE EXCEPTION 'erasure_graph_drift';
    END IF;
  END IF;

  IF is_first_erasure THEN
    SELECT pg_catalog.max(activity.activity_at) INTO latest_activity
      FROM (
        SELECT contact_row.updated_at AS activity_at
        UNION ALL
        SELECT site_record.updated_at FROM public.site AS site_record
         WHERE site_record.workspace_id = requested_workspace_id
           AND site_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'siteIds') AS value
           )
        UNION ALL
        SELECT project_record.updated_at FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'projectIds') AS value
           )
        UNION ALL
        SELECT receipt.received_at FROM public.inbound_receipt AS receipt
         WHERE receipt.workspace_id = requested_workspace_id
           AND receipt.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'receiptIds') AS value
           )
        UNION ALL
        SELECT snapshot.created_at FROM public.calculator_snapshot AS snapshot
         WHERE snapshot.workspace_id = requested_workspace_id
           AND snapshot.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'snapshotIds') AS value
           )
        UNION ALL
        SELECT requirement.created_at FROM public.project_requirement AS requirement
         WHERE requirement.workspace_id = requested_workspace_id
           AND requirement.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'requirementIds') AS value
           )
        UNION ALL
        SELECT profile.updated_at FROM public.site_energy_profile AS profile
         WHERE profile.workspace_id = requested_workspace_id
           AND profile.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'profileIds') AS value
           )
        UNION ALL
        SELECT GREATEST(job.created_at, job.started_at, job.finished_at)
          FROM public.project_calculation_job AS job
         WHERE job.workspace_id = requested_workspace_id
           AND job.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'jobIds') AS value
           )
        UNION ALL
        SELECT revision.created_at FROM public.project_calculation_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'revisionIds') AS value
           )
        UNION ALL
        SELECT GREATEST(offer_record.created_at, offer_record.updated_at)
          FROM public.offer AS offer_record
         WHERE offer_record.workspace_id = requested_workspace_id
           AND offer_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'offerIds') AS value
           )
        UNION ALL
        SELECT variant.created_at FROM public.offer_variant AS variant
         WHERE variant.workspace_id = requested_workspace_id
           AND variant.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'offerVariantIds') AS value
           )
        UNION ALL
        SELECT revision.created_at FROM public.offer_variant_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'offerVariantRevisionIds') AS value
           )
      ) AS activity;
    eligible_time := latest_activity + interval '24 months';
    IF erase_time < eligible_time THEN
      RAISE EXCEPTION 'erasure_not_eligible';
    END IF;

    graph_digest := pg_catalog.sha256(pg_catalog.convert_to(graph_document::text, 'UTF8'));
    tombstone_digest := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.concat_ws(
        '|', requested_operation_id::text, requested_workspace_id::text,
        requested_contact_id::text, 'inactive_lead_24_months',
        pg_catalog.encode(graph_digest, 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(eligible_time), 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(erase_time), 'hex')
      ),
      'UTF8'
    ));
    INSERT INTO public.erasure_operation_locator (operation_id, scope_id)
    VALUES (requested_operation_id, requested_workspace_id);
    INSERT INTO public.erasure_tombstone (
      operation_id, workspace_id, contact_id, reason, graph_sha256,
      tombstone_sha256, graph_ids, eligible_at, erased_at
    ) VALUES (
      requested_operation_id, requested_workspace_id, requested_contact_id,
      'inactive_lead_24_months', graph_digest, tombstone_digest,
      graph_document, eligible_time, erase_time
    );
  END IF;

  PERFORM pg_catalog.set_config(
    'app.erasure_operation_id', requested_operation_id::text, true
  );

  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_bom_line AS line_record
   WHERE line_record.workspace_id = requested_workspace_id
     AND line_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerBomLineIds'
       ) AS value
     );
  DELETE FROM public.offer_variant_section AS section_record
   WHERE section_record.workspace_id = requested_workspace_id
     AND section_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantSectionIds'
       ) AS value
     );
  DELETE FROM public.offer_variant_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantRevisionIds'
       ) AS value
     );
  DELETE FROM public.offer_variant AS variant
   WHERE variant.workspace_id = requested_workspace_id
     AND variant.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerVariantIds'
       ) AS value
     );
  DELETE FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerIds'
       ) AS value
     );

  DELETE FROM public.contact_legal_hold AS legal_hold
   WHERE legal_hold.workspace_id = requested_workspace_id
     AND legal_hold.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'legalHoldIds'
       ) AS value
     );
  DELETE FROM public.project_calculation_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'revisionIds'
       ) AS value
     );
  DELETE FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'jobIds'
       ) AS value
     );
  DELETE FROM public.site_energy_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'profileIds'
       ) AS value
     );
  DELETE FROM public.project_requirement AS requirement
   WHERE requirement.workspace_id = requested_workspace_id
     AND requirement.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'requirementIds'
       ) AS value
     );
  DELETE FROM public.calculator_snapshot AS snapshot
   WHERE snapshot.workspace_id = requested_workspace_id
     AND snapshot.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'snapshotIds'
       ) AS value
     );
  UPDATE public.inbound_receipt AS receipt
     SET producer_deployment_id = NULL,
         acquisition = pg_catalog.jsonb_build_object(
           'channel', 'website_calculator', 'source', 'solarrechner',
           'pagePath', NULL, 'referrerOrigin', NULL,
           'utm', pg_catalog.jsonb_build_object(
             'source', NULL, 'medium', NULL, 'campaign', NULL,
             'term', NULL, 'content', NULL
           )
         ),
         privacy_notice_version = 'erased',
         privacy_notice_url = 'https://example.invalid/erased',
         email_match_contact_id = NULL,
         phone_match_contact_id = NULL
   WHERE receipt.workspace_id = requested_workspace_id
     AND receipt.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'receiptIds'
       ) AS value
     );
  UPDATE public.site AS site_record
     SET label = NULL, formatted_address = NULL, address_fingerprint = NULL,
         address_fingerprint_version = NULL, address_mode = 'legacy',
         street = NULL, house_number = NULL, postal_code = NULL, city = NULL,
         lat = NULL, lng = NULL, geocode_source = NULL,
         geocode_precision = NULL, geocode_place_id = NULL,
         address_follow_up_required = false, pin_confirmed = false,
         pin_confirmed_address_revision = NULL, pin_adjusted = false,
         updated_at = erase_time
   WHERE site_record.workspace_id = requested_workspace_id
     AND site_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'siteIds'
       ) AS value
     );
  UPDATE public.project AS project_record
     SET name = 'geloescht-' || project_record.id::text,
         dedupe_review_required = false, updated_at = erase_time
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     );
  UPDATE public.contact AS contact_record
     SET display_name = 'geloescht-' || contact_record.id::text,
         email_primary = NULL, email_normalized = NULL, phone_raw = NULL,
         phone_e164 = NULL, marketing_consent = false,
         marketing_consent_at = NULL, marketing_consent_source = NULL,
         dedupe_review_required = false, deleted_at = erase_time,
         updated_at = erase_time
   WHERE contact_record.workspace_id = requested_workspace_id
     AND contact_record.id = requested_contact_id;

  IF is_first_erasure THEN
    INSERT INTO public.domain_events (
      workspace_id, aggregate_type, aggregate_id, event_type,
      actor, payload, occurred_at
    ) VALUES (
      requested_workspace_id, 'contact', requested_contact_id,
      'contact.erased', 'app_erasure',
      pg_catalog.jsonb_build_object(
        'operationId', requested_operation_id::text,
        'contactId', requested_contact_id::text,
        'graphSha256', pg_catalog.encode(graph_digest, 'hex')
      ),
      erase_time
    );
    INSERT INTO public.audit_log (
      workspace_id, actor, action, resource, allowed, details, occurred_at
    ) VALUES (
      requested_workspace_id, 'app_erasure',
      'contact.erase_inactive_lead',
      'contact:' || requested_contact_id::text, true,
      pg_catalog.jsonb_build_object(
        'operationId', requested_operation_id::text,
        'contactId', requested_contact_id::text,
        'graphSha256', pg_catalog.encode(graph_digest, 'hex')
      ),
      erase_time
    );
  END IF;
  RETURN requested_operation_id;
END
$m2_01_erase$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid) TO app_erasure;
