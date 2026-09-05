ALTER TABLE "offer_variant_revision" DROP CONSTRAINT "offer_variant_revision_version_ck";--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_version_ck" CHECK ("offer_variant_revision"."schema_version" in ('offer-variant-snapshot.v1', 'offer-variant-snapshot.v2')
      and "offer_variant_revision"."canonicalization_version" = 'offer-jcs.v1');