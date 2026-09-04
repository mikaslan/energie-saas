ALTER TABLE "offer" ADD COLUMN "total_price_override_net_cents" bigint;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD COLUMN "optional_bundles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "offer_variant" AS "v" SET "is_primary" = true WHERE "v"."id" = (SELECT "w"."id" FROM "offer_variant" AS "w" WHERE "w"."workspace_id" = "v"."workspace_id" AND "w"."offer_id" = "v"."offer_id" ORDER BY "w"."ordinal" ASC, "w"."created_at" ASC, "w"."id" ASC LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX "offer_variant_ws_offer_primary_uq" ON "offer_variant" USING btree ("workspace_id","offer_id") WHERE "offer_variant"."is_primary" = true;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_total_override_ck" CHECK ("offer"."total_price_override_net_cents" is null
      or "offer"."total_price_override_net_cents" between 0 and 9000000000000000);--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_bundles_ck" CHECK (pg_catalog.jsonb_typeof("offer_variant"."optional_bundles") = 'array');