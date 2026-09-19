CREATE TABLE "inbound_rest_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_record_id" text NOT NULL,
	"source_name" text,
	"contract_version" text NOT NULL,
	"body_sha256" "bytea" NOT NULL,
	"auth_key_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contact_resolution" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"email_match_contact_id" uuid,
	"phone_match_contact_id" uuid,
	"site_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note" text,
	CONSTRAINT "inbound_rest_receipt_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "inbound_rest_receipt_ws_id_project_uq" UNIQUE("workspace_id","id","project_id"),
	CONSTRAINT "inbound_rest_receipt_ws_id_project_hash_uq" UNIQUE("workspace_id","id","project_id","body_sha256"),
	CONSTRAINT "inbound_rest_receipt_record_ck" CHECK (length(btrim("inbound_rest_receipt"."client_record_id")) between 1 and 128),
	CONSTRAINT "inbound_rest_receipt_source_name_ck" CHECK ("inbound_rest_receipt"."source_name" is null or length(btrim("inbound_rest_receipt"."source_name")) between 1 and 100),
	CONSTRAINT "inbound_rest_receipt_contract_ck" CHECK ("inbound_rest_receipt"."contract_version" = 'rest-intake.v1'),
	CONSTRAINT "inbound_rest_receipt_hash_ck" CHECK (octet_length("inbound_rest_receipt"."body_sha256") = 32),
	CONSTRAINT "inbound_rest_receipt_auth_key_ck" CHECK ("inbound_rest_receipt"."auth_key_id" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "inbound_rest_receipt_contact_resolution_ck" CHECK ("inbound_rest_receipt"."contact_resolution" in ('created', 'email_match', 'phone_match', 'review_created')),
	CONSTRAINT "inbound_rest_receipt_note_ck" CHECK ("inbound_rest_receipt"."note" is null or char_length("inbound_rest_receipt"."note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "site" DROP CONSTRAINT "site_intake_address_shape_ck";--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ADD CONSTRAINT "inbound_rest_receipt_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ADD CONSTRAINT "inbound_rest_receipt_project_graph_fk" FOREIGN KEY ("workspace_id","project_id","contact_id","site_id") REFERENCES "public"."project"("workspace_id","id","contact_id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ALTER CONSTRAINT "inbound_rest_receipt_project_graph_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ADD CONSTRAINT "inbound_rest_receipt_email_match_contact_fk" FOREIGN KEY ("workspace_id","email_match_contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ADD CONSTRAINT "inbound_rest_receipt_phone_match_contact_fk" FOREIGN KEY ("workspace_id","phone_match_contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_rest_receipt_ws_received_idx" ON "inbound_rest_receipt" USING btree ("workspace_id","auth_key_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_rest_receipt_ws_client_record_uq" ON "inbound_rest_receipt" USING btree ("workspace_id","client_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_rest_receipt_ws_project_uq" ON "inbound_rest_receipt" USING btree ("workspace_id","project_id");--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_intake_address_shape_ck" CHECK (("site"."address_mode" = 'legacy' and "site"."geocode_place_id" is null) or (
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
          and "site"."geocode_precision" = 'house'
          and (
            ("site"."geocode_source" = 'photon' and "site"."geocode_place_id" is null)
            or (
              "site"."geocode_source" = 'geoapify'
              and "site"."geocode_place_id" is not null
              and length(btrim("site"."geocode_place_id")) between 1 and 300
            )
            or ("site"."geocode_source" = 'broker' and "site"."geocode_place_id" is null)
            or ("site"."geocode_source" = 'rest' and "site"."geocode_place_id" is null)
          ))
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
          and "site"."geocode_place_id" is null
          and "site"."geocode_precision" = 'region')
      )
    ) is true);--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_rest_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inbound_rest_receipt" AS PERMISSIVE FOR ALL TO PUBLIC USING ("workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid) WITH CHECK ("workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
