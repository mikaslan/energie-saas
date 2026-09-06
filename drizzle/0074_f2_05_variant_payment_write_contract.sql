-- F2.5 Nachzug: payment_option_id ist ein bewusst revisionsloses,
-- mandantengebundenes Anzeigefeld der Variante. 0068 fuegte die Spalte und
-- den zusammengesetzten Tenant-FK hinzu, erweiterte aber weder den
-- Offer-Guard noch den Runtime-Spaltengrant. Der Guard bleibt fail-closed:
-- nur dieses Feld kommt zur bestehenden Whitelist hinzu; Identitaet,
-- Workspace/Offer-Zuordnung und alle Snapshot-Mirror bleiben immutable.
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
            'is_primary', 'optional_bundles', 'payment_option_id'
          ]::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'current_revision', 'name', 'description', 'updated_at',
             'is_primary', 'optional_bundles', 'payment_option_id'
           ]::text[]) THEN
        RAISE EXCEPTION 'offer_variant: stabile Identitaet ist immutable';
      END IF;
      -- Revisionslose Business-Felder bumpen current_revision bewusst nicht;
      -- die Monotonie gilt nur, wenn der Snapshot-Pointer fortschreitet.
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
COMMENT ON COLUMN public.offer_variant.payment_option_id IS
  'F2.5 Varianten-Zahlart-Schreibvertrag v1';
