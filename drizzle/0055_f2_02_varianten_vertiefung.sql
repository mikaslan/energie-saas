-- F2.2: Guard-Whitelist erweitert (DECIDED): total_price_override_net_cents
-- am offer sowie is_primary + optional_bundles an offer_variant sind
-- Business-Felder der neuen Varianten-Semantik — die Erasure-/Identitaets-
-- Invarianten des M2-01-Guards bleiben unveraendert. Reihenfolge bewusst
-- VOR dem Backfill, damit die Primaermarkierungs-Migration auf nicht-leeren
-- Bestaenden unter dem erweiterten Guard laeuft.
CREATE OR REPLACE FUNCTION public.guard_offer_erasure_mutation()
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
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at', 'total_price_override_net_cents']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at', 'total_price_override_net_cents']::text[]) THEN
        RAISE EXCEPTION 'offer ist immutable; nur updated_at darf fortgeschrieben werden';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer.updated_at muss monoton sein';
      END IF;
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_variant' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY[
            'current_revision', 'name', 'description', 'updated_at',
            'is_primary', 'optional_bundles'
          ]::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'current_revision', 'name', 'description', 'updated_at',
             'is_primary', 'optional_bundles'
           ]::text[]) THEN
        RAISE EXCEPTION 'offer_variant: stabile Identitaet ist immutable';
      END IF;
      -- F2.2: Flag-Mutationen (is_primary/optional_bundles) bumpen die
      -- Revision bewusst NICHT — die Monotonie gilt nur, wenn die
      -- Revision tatsaechlich fortschreitet (Snapshot-Semantik bleibt).
      IF (NEW.current_revision IS DISTINCT FROM OLD.current_revision
          AND NEW.current_revision <> OLD.current_revision + 1)
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

ALTER TABLE "offer" ADD COLUMN "total_price_override_net_cents" bigint;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_variant" ADD COLUMN "optional_bundles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "offer_variant" AS "v" SET "is_primary" = true WHERE "v"."id" = (SELECT "w"."id" FROM "offer_variant" AS "w" WHERE "w"."workspace_id" = "v"."workspace_id" AND "w"."offer_id" = "v"."offer_id" ORDER BY "w"."ordinal" ASC, "w"."created_at" ASC, "w"."id" ASC LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX "offer_variant_ws_offer_primary_uq" ON "offer_variant" USING btree ("workspace_id","offer_id") WHERE "offer_variant"."is_primary" = true;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_total_override_ck" CHECK ("offer"."total_price_override_net_cents" is null
      or "offer"."total_price_override_net_cents" between 0 and 9000000000000000);--> statement-breakpoint
ALTER TABLE "offer_variant" ADD CONSTRAINT "offer_variant_bundles_ck" CHECK (pg_catalog.jsonb_typeof("offer_variant"."optional_bundles") = 'array');