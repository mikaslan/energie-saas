-- ═══════════════════════════════════════════════════════════════════════
-- F16.3 Slice E Nachzug (Welle-03-Rebase): DB-seitige Input-Ableitung
-- spiegelt den TS-v3-Vertrag. Der Trigger derive_offer_pdf_draft_input
-- baute commercialTerms ohne globalDiscountCapCents -> der Pflicht-Key
-- fehlte auf DB-seitig abgeleiteten Drafts (m202-Strict). Ersatz für den
-- gedroppten Lane-Port 0066 (Konflikt mit wave-02-0064/0065, dort 0065
-- nur mit Fix): wave-02-0065-Body + Cap-Zeile, sonst bytegleich.
-- CREATE OR REPLACE ohne Owner-Tanz: Trigger-Funktion, INVOKER, Owner
-- bleibt erhalten (Migrationsrolle wie 0033).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.derive_offer_pdf_draft_input()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m2_02_pdf_input_derive$
DECLARE
  source_snapshot jsonb;
  source_offer_number text;
  reservation_material text;
  derived_input jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'offer_pdf_draft: Inputableitung ist nur bei INSERT erlaubt';
  END IF;

  -- BEFORE-Trigger duerfen die generische RLS-with-check-Gegenprobe nicht
  -- durch fruehere Source-/NOT-NULL-Fehler verdecken. Fremde oder fehlende
  -- Tenant-Kontexte laufen unveraendert in die Tabellenpolicy und werden dort
  -- abgelehnt; nur tenant-lokale Zeilen erreichen die Ableitung.
  IF NEW.workspace_id IS DISTINCT FROM NULLIF(
       pg_catalog.current_setting('app.workspace_id', true), ''
     )::uuid THEN
    RETURN NEW;
  END IF;

  -- Dokumentzeit und Queue-Faelligkeit stammen immer aus derselben
  -- autoritativen DB-Transaktion; vom Runtime-Principal gelieferte Zeiten
  -- duerfen weder Darstellung noch Scheduling vor- oder zurueckdatieren.
  NEW.created_at := pg_catalog.transaction_timestamp();
  NEW.updated_at := NEW.created_at;
  NEW.next_attempt_at := NEW.created_at;

  SELECT revision.revision_snapshot,
         offer_record.offer_number
    INTO source_snapshot,
         source_offer_number
    FROM public.offer_variant_revision AS revision
    JOIN public.offer AS offer_record
      ON offer_record.workspace_id = revision.workspace_id
     AND offer_record.id = revision.offer_id
     AND offer_record.project_id = revision.project_id
   WHERE revision.workspace_id = NEW.workspace_id
     AND revision.id = NEW.variant_revision_id
     AND revision.offer_id = NEW.offer_id
     AND revision.variant_id = NEW.variant_id
     AND revision.project_id = NEW.project_id
     AND revision.revision = NEW.variant_revision
     AND revision.snapshot_sha256 = NEW.variant_snapshot_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_pdf_draft: versiegelte PDF-Quelle fehlt'
      USING ERRCODE = '23503';
  END IF;

  -- Das Replay-/Idempotenzmaterial entspricht bytegenau dem gepinnten
  -- TypeScript-v1-Vertrag. Seine interpolierten Werte sind ausschliesslich
  -- UUID, positive Ganzzahl und Hexdigest und benoetigen kein JSON-Escaping.
  reservation_material := pg_catalog.format(
    '{"schemaVersion":"offer-pdf-draft-reservation.v1","workspaceId":"%s","variantId":"%s","variantRevision":%s,"variantSnapshotSha256":"%s","inputVersion":"offer-pdf-draft-input.v1","canonicalizationVersion":"offer-jcs.v1","templateVersion":"offer-pdf-draft-template.v1","rendererRecipeVersion":"offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac"}',
    NEW.workspace_id::text,
    NEW.variant_id::text,
    NEW.variant_revision::text,
    pg_catalog.encode(NEW.variant_snapshot_sha256, 'hex')
  );
  NEW.reservation_key := pg_catalog.sha256(pg_catalog.convert_to(
    reservation_material, 'UTF8'
  ));

  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 'offer-pdf-draft-input.v1',
    'canonicalizationVersion', 'offer-jcs.v1',
    'templateVersion', 'offer-pdf-draft-template.v1',
    'rendererRecipeVersion', 'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
    'offerNumber', source_offer_number,
    'preparedAt', pg_catalog.to_char(
      NEW.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'recipient', pg_catalog.jsonb_build_object(
      'displayName', source_snapshot->'contactContext'->'displayName'
    ),
    'installationSite', pg_catalog.jsonb_build_object(
      'formattedAddress',
      source_snapshot->'installationSiteContext'->'formattedAddress'
    ),
    'variant', pg_catalog.jsonb_build_object(
      'name', source_snapshot->'variantName',
      'revision', source_snapshot->'revision'
    ),
    'commercialTerms', pg_catalog.jsonb_build_object(
      'globalDiscountBps', source_snapshot->'globalDiscountBps',
      'globalDiscountCapCents', source_snapshot->'globalDiscountCapCents',
      'globalFixDiscountCents', source_snapshot->'globalFixDiscountCents',
      'customDealNetCents', source_snapshot->'customDealNetCents'
    ),
    'sections', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'position', source_section.value->'position',
          'title', source_section.value->'title',
          'discountBps', source_section.value->'discountBps',
          'lines', COALESCE((
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'position', source_line.value->'position',
                'title', source_line.value->'product'->'displayName',
                'description', CASE
                  WHEN source_line.value->'product'->>'kind' = 'custom'
                    THEN source_line.value->'product'->'description'
                  ELSE 'null'::jsonb
                END,
                'quantityMilli', source_line.value->'quantityMilli',
                'unit', source_line.value->'product'->'unit',
                'positionType', source_line.value->'positionType',
                'isHidden', source_line.value->'isHidden',
                'salesUnitNetCents',
                  source_line.value->'salesPricing'->'effectiveUnitNetCents',
                'lineDiscountBps', source_line.value->'lineDiscountBps',
                'taxRateBps', source_line.value->'taxRateBps',
                'finalNetCents',
                  source_line.value->'computed'->'finalSalesNetCents',
                'taxCents', source_line.value->'computed'->'salesTaxCents',
                'grossCents', source_line.value->'computed'->'salesGrossCents'
              ) ORDER BY (source_line.value->>'position')::integer
            )
              FROM pg_catalog.jsonb_array_elements(
                source_section.value->'lines'
              ) AS source_line(value)
          ), '[]'::jsonb)
        ) ORDER BY (source_section.value->>'position')::integer
      )
        FROM pg_catalog.jsonb_array_elements(
          source_snapshot->'sections'
        ) AS source_section(value)
       WHERE pg_catalog.jsonb_array_length(
         source_section.value->'lines'
       ) > 0
    ), '[]'::jsonb),
    'totals', source_snapshot->'totals'
  ) INTO derived_input;

  NEW.input_snapshot := derived_input;
  NEW.input_sha256 := pg_catalog.sha256(pg_catalog.convert_to(
    public.canonicalize_offer_json_v1(derived_input), 'UTF8'
  ));
  RETURN NEW;
END
$m2_02_pdf_input_derive$;--> statement-breakpoint
