CREATE TABLE "offer_pdf_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_revision_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"variant_snapshot_sha256" "bytea" NOT NULL,
	"input_version" text NOT NULL,
	"canonicalization_version" text NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe_version" text NOT NULL,
	"reservation_key" "bytea" NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"error_retryable" boolean,
	"artifact_mime_type" text,
	"artifact_sha256" "bytea",
	"artifact_size_bytes" integer,
	"artifact_bytes" "bytea",
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "offer_pdf_draft_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "offer_pdf_draft_ws_reservation_uq" UNIQUE("workspace_id","reservation_key"),
	CONSTRAINT "offer_pdf_draft_ws_recipe_uq" UNIQUE("workspace_id","variant_id","variant_revision","template_version","renderer_recipe_version"),
	CONSTRAINT "offer_pdf_draft_binding_ck" CHECK ("offer_pdf_draft"."variant_revision" > 0
      and octet_length("offer_pdf_draft"."variant_snapshot_sha256") = 32
      and octet_length("offer_pdf_draft"."reservation_key") = 32
      and octet_length("offer_pdf_draft"."input_sha256") = 32),
	CONSTRAINT "offer_pdf_draft_versions_ck" CHECK ("offer_pdf_draft"."input_version" = 'offer-pdf-draft-input.v1'
      and "offer_pdf_draft"."canonicalization_version" = 'offer-jcs.v1'
      and "offer_pdf_draft"."template_version" = 'offer-pdf-draft-template.v1'
      and "offer_pdf_draft"."renderer_recipe_version" = 'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'),
	CONSTRAINT "offer_pdf_draft_input_ck" CHECK (jsonb_typeof("offer_pdf_draft"."input_snapshot") = 'object'
      and "offer_pdf_draft"."input_snapshot"->>'schemaVersion' = "offer_pdf_draft"."input_version"
      and "offer_pdf_draft"."input_snapshot"->>'canonicalizationVersion' = "offer_pdf_draft"."canonicalization_version"
      and "offer_pdf_draft"."input_snapshot"->>'templateVersion' = "offer_pdf_draft"."template_version"
      and "offer_pdf_draft"."input_snapshot"->>'rendererRecipeVersion' = "offer_pdf_draft"."renderer_recipe_version"),
	CONSTRAINT "offer_pdf_draft_input_hash_ck" CHECK ("offer_pdf_draft"."input_sha256" = sha256(convert_to(
      public.canonicalize_offer_json_v1("offer_pdf_draft"."input_snapshot"), 'UTF8'
    ))),
	CONSTRAINT "offer_pdf_draft_state_ck" CHECK ("offer_pdf_draft"."state" in (
      'queued', 'running', 'retry_wait', 'succeeded', 'failed_final'
    )),
	CONSTRAINT "offer_pdf_draft_attempt_ck" CHECK ("offer_pdf_draft"."attempt_count" between 0 and 3),
	CONSTRAINT "offer_pdf_draft_error_ck" CHECK ((
      "offer_pdf_draft"."error_code" is null and "offer_pdf_draft"."error_retryable" is null
    ) or (
      "offer_pdf_draft"."error_code" ~ '^[a-z][a-z0-9_]{0,79}$' and "offer_pdf_draft"."error_retryable" is not null
    )),
	CONSTRAINT "offer_pdf_draft_artifact_ck" CHECK ((
      "offer_pdf_draft"."artifact_mime_type" is null
      and "offer_pdf_draft"."artifact_sha256" is null
      and "offer_pdf_draft"."artifact_size_bytes" is null
      and "offer_pdf_draft"."artifact_bytes" is null
    ) or (
      "offer_pdf_draft"."artifact_mime_type" = 'application/pdf'
      and octet_length("offer_pdf_draft"."artifact_sha256") = 32
      and "offer_pdf_draft"."artifact_size_bytes" between 100 and 8388608
      and octet_length("offer_pdf_draft"."artifact_bytes") = "offer_pdf_draft"."artifact_size_bytes"
      and "offer_pdf_draft"."artifact_sha256" = pg_catalog.sha256("offer_pdf_draft"."artifact_bytes")
    )),
	CONSTRAINT "offer_pdf_draft_shape_ck" CHECK (case "offer_pdf_draft"."state"
      when 'queued' then
        "offer_pdf_draft"."lease_token" is null and "offer_pdf_draft"."lease_expires_at" is null
        and "offer_pdf_draft"."finished_at" is null and "offer_pdf_draft"."error_code" is null
        and "offer_pdf_draft"."error_retryable" is null and "offer_pdf_draft"."artifact_bytes" is null
      when 'running' then
        "offer_pdf_draft"."lease_token" is not null and "offer_pdf_draft"."lease_expires_at" is not null
        and "offer_pdf_draft"."started_at" is not null and "offer_pdf_draft"."finished_at" is null
        and "offer_pdf_draft"."error_code" is null and "offer_pdf_draft"."error_retryable" is null
        and "offer_pdf_draft"."artifact_bytes" is null
      when 'retry_wait' then
        "offer_pdf_draft"."lease_token" is null and "offer_pdf_draft"."lease_expires_at" is null
        and "offer_pdf_draft"."started_at" is not null and "offer_pdf_draft"."finished_at" is null
        and "offer_pdf_draft"."error_code" is not null and "offer_pdf_draft"."error_retryable" = true
        and "offer_pdf_draft"."artifact_bytes" is null
      when 'succeeded' then
        "offer_pdf_draft"."lease_token" is null and "offer_pdf_draft"."lease_expires_at" is null
        and "offer_pdf_draft"."started_at" is not null and "offer_pdf_draft"."finished_at" is not null
        and "offer_pdf_draft"."error_code" is null and "offer_pdf_draft"."error_retryable" is null
        and "offer_pdf_draft"."artifact_bytes" is not null
      when 'failed_final' then
        "offer_pdf_draft"."lease_token" is null and "offer_pdf_draft"."lease_expires_at" is null
        and "offer_pdf_draft"."started_at" is not null and "offer_pdf_draft"."finished_at" is not null
        and "offer_pdf_draft"."error_code" is not null and "offer_pdf_draft"."error_retryable" = false
        and "offer_pdf_draft"."artifact_bytes" is null
      else false end)
);
--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_ws_pdf_source_uq" UNIQUE("workspace_id","id","offer_id","variant_id","project_id","revision","snapshot_sha256");--> statement-breakpoint
ALTER TABLE "offer_pdf_draft" ADD CONSTRAINT "offer_pdf_draft_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_pdf_draft" ADD CONSTRAINT "offer_pdf_draft_variant_revision_fk" FOREIGN KEY ("workspace_id","variant_revision_id","offer_id","variant_id","project_id","variant_revision","variant_snapshot_sha256") REFERENCES "public"."offer_variant_revision"("workspace_id","id","offer_id","variant_id","project_id","revision","snapshot_sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_pdf_draft" ADD CONSTRAINT "offer_pdf_draft_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_pdf_draft_ws_offer_idx" ON "offer_pdf_draft" USING btree ("workspace_id","offer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "offer_pdf_draft_due_idx" ON "offer_pdf_draft" USING btree ("workspace_id","state","next_attempt_at","created_at","id");
--> statement-breakpoint

ALTER TABLE public.offer_pdf_draft ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_pdf_draft FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.offer_pdf_draft
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

-- Runtime uebergibt ausschliesslich die versiegelte Source-Bindung. Der
-- renderbare Dokumentinput wird vor jedem INSERT deterministisch aus genau
-- dieser VariantRevision abgeleitet; frei erfundene PII, Preise oder Summen
-- koennen damit nicht als gueltig gehashter Fremdinput eingeschleust werden.
CREATE FUNCTION public.derive_offer_pdf_draft_input()
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
REVOKE ALL ON FUNCTION public.derive_offer_pdf_draft_input() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER offer_pdf_draft_input_derive
  BEFORE INSERT ON public.offer_pdf_draft
  FOR EACH ROW EXECUTE FUNCTION public.derive_offer_pdf_draft_input();--> statement-breakpoint

-- Source, Dokumentinput und Rezept sind nach INSERT unveraenderlich. Der
-- Worker darf nur den expliziten Lease-/Statusautomaten fortschreiben und
-- erfolgreiche Bytes genau einmal setzen. DELETE bleibt ausschliesslich dem
-- bestehenden, tombstone-gebundenen Erasurevertrag vorbehalten.
CREATE FUNCTION public.guard_offer_pdf_draft_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m2_02_pdf_guard$
DECLARE
  erasure_setting text;
  erasure_operation uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY[
          'state', 'attempt_count', 'next_attempt_at', 'lease_token',
          'lease_expires_at', 'error_code', 'error_retryable',
          'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
          'artifact_bytes', 'updated_at', 'started_at', 'finished_at'
        ]::text[])
         IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY[
          'state', 'attempt_count', 'next_attempt_at', 'lease_token',
          'lease_expires_at', 'error_code', 'error_retryable',
          'artifact_mime_type', 'artifact_sha256', 'artifact_size_bytes',
          'artifact_bytes', 'updated_at', 'started_at', 'finished_at'
        ]::text[]) THEN
      RAISE EXCEPTION 'offer_pdf_draft: versiegelte Quelle ist immutable';
    END IF;

    IF OLD.state IN ('succeeded', 'failed_final') THEN
      RAISE EXCEPTION 'offer_pdf_draft: terminaler Zustand ist immutable';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'offer_pdf_draft.updated_at muss monoton sein';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count
       OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'offer_pdf_draft.attempt_count verletzt den CAS-Vertrag';
    END IF;
    IF OLD.started_at IS NOT NULL
       AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'offer_pdf_draft.started_at ist nach dem ersten Claim immutable';
    END IF;

    IF NEW.state = 'running' THEN
      IF OLD.state NOT IN ('queued', 'retry_wait', 'running')
         OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'offer_pdf_draft: ungueltiger Claim-Uebergang';
      END IF;
      IF OLD.state = 'running'
         AND OLD.lease_expires_at > pg_catalog.statement_timestamp() THEN
        RAISE EXCEPTION 'offer_pdf_draft: aktive Lease darf nicht uebernommen werden';
      END IF;
    ELSIF NEW.state IN ('retry_wait', 'succeeded', 'failed_final') THEN
      IF OLD.state <> 'running'
         OR NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'offer_pdf_draft: ungueltiger Abschluss-Uebergang';
      END IF;
    ELSIF NEW.state = 'queued' THEN
      IF OLD.state <> 'retry_wait'
         OR NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'offer_pdf_draft: ungueltiger Requeue-Uebergang';
      END IF;
    ELSE
      RAISE EXCEPTION 'offer_pdf_draft: ungueltiger Zustandsuebergang';
    END IF;

    IF NEW.state = 'succeeded' THEN
      IF OLD.artifact_bytes IS NOT NULL
         OR NEW.artifact_bytes IS NULL THEN
        RAISE EXCEPTION 'offer_pdf_draft: Artefakt darf nur einmal gesetzt werden';
      END IF;
    ELSIF NEW.artifact_mime_type IS DISTINCT FROM OLD.artifact_mime_type
       OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
       OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
       OR NEW.artifact_bytes IS DISTINCT FROM OLD.artifact_bytes THEN
      RAISE EXCEPTION 'offer_pdf_draft: Artefaktmutation ausserhalb Erfolg verboten';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'offer_pdf_draft: unbekannte Mutation';
  END IF;
  erasure_setting := pg_catalog.current_setting(
    'app.erasure_operation_id', true
  );
  BEGIN
    erasure_operation := NULLIF(erasure_setting, '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  IF erasure_operation IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = OLD.workspace_id
       AND tombstone.graph_ids->'offerPdfDraftIds' ? OLD.id::text
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'offer_pdf_draft: DELETE ist nur im Erasurevertrag erlaubt';
END
$m2_02_pdf_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_offer_pdf_draft_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER offer_pdf_draft_mutation_guard
  BEFORE UPDATE OR DELETE ON public.offer_pdf_draft
  FOR EACH ROW EXECUTE FUNCTION public.guard_offer_pdf_draft_mutation();--> statement-breakpoint
CREATE TRIGGER offer_pdf_draft_no_truncate
  BEFORE TRUNCATE ON public.offer_pdf_draft
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- Der bisherige Graphshape bleibt Pflicht; offerPdfDraftIds ist ausschliesslich
-- dann als kanonisch sortiertes UUID-Array erlaubt, wenn dieser additive Slice
-- tatsaechlich Draftbytes loeschen muss. Bestehende Tombstones bleiben damit
-- unveraendert und replaybar.
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m2_02_tombstone_worm$
DECLARE
  graph_key text;
  required_keys constant text[] := ARRAY[
    'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
    'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds',
    'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
    'offerVariantSectionIds', 'offerBomLineIds'
  ]::text[];
  allowed_keys constant text[] := required_keys || ARRAY[
    'offerPdfDraftIds'
  ]::text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'erasure_tombstone WORM append-only: % ist verboten', TG_OP;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids) <> 'object'
     OR NEW.graph_ids - allowed_keys <> '{}'::jsonb
     OR NOT NEW.graph_ids ?& required_keys THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids->'contactId') <> 'string'
     OR NEW.graph_ids->>'contactId' <> NEW.contact_id::text THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;

  FOREACH graph_key IN ARRAY allowed_keys LOOP
    CONTINUE WHEN graph_key = 'contactId';
    CONTINUE WHEN graph_key = 'offerPdfDraftIds'
                  AND NOT NEW.graph_ids ? graph_key;
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
         SELECT pg_catalog.jsonb_agg(
                  graph_value.value ORDER BY graph_value.value #>> '{}'
                )
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
$m2_02_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;--> statement-breakpoint

-- Der vorhandene Erasuregraph bleibt als unveraenderte M2-01-Basis erhalten;
-- die oeffentliche Signatur erhaelt additiv nur die PDF-Draft-IDs. Dadurch
-- koennen die per FK kaskadierten Bytes vom Guard exakt gegen den Tombstone
-- geprueft werden, ohne alte Graphschluessel umzudeuten.
ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m201;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph_m201(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m2_02_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m201(
           requested_workspace_id, requested_contact_id
         ) || CASE
           -- Den Schluessel nur materialisieren, wenn ein Draft existiert.
           -- So bleiben Tombstones vor M2-02 sowie neue Graphen ohne PDF
           -- byte-/hashkompatibel und der Replay-Subsetvertrag bleibt wahr.
           WHEN pdf_graph.ids = '[]'::jsonb THEN '{}'::jsonb
           ELSE pg_catalog.jsonb_build_object(
             'offerPdfDraftIds', pdf_graph.ids
           )
         END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(draft.id::text ORDER BY draft.id),
        '[]'::jsonb
      ) AS ids
        FROM public.offer_pdf_draft AS draft
        JOIN public.offer AS offer_record
          ON offer_record.workspace_id = draft.workspace_id
         AND offer_record.id = draft.offer_id
       WHERE draft.workspace_id = requested_workspace_id
         AND offer_record.contact_id = requested_contact_id
         AND offer_record.status = 'draft'
    ) AS pdf_graph
$m2_02_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

-- M1-07 sperrt den gesamten Erasuregraph in einer globalen Reihenfolge. Der
-- M2-02-Untergraph wird nach seinen Offer-Mirrors deterministisch angehaengt:
-- Solange Chromium einen PII-haltigen Input unter gueltiger Lease verarbeitet,
-- darf weder ein Erstlauf noch ein Tombstone-Replay loeschen. Die PDF-Anfrage
-- selbst ist bereits atomar in offer.updated_at abgebildet; rein technische
-- Worker-Retries/Abschluesse verlaengern die 24-Monats-Retention bewusst nicht.
--
-- Die bestehende SECURITY-DEFINER-Funktion wird nur an einem hashgepinnten
-- Quellanker erweitert. So bleibt die vollstaendige M1-07-Implementierung aus
-- 0032 die einzige Basis und jede unerwartete Prefix-Drift bricht fail-closed.
DO $m2_02_erasure_pdf_lease_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_lock_block constant text := $m2_02_old_lock$
  PERFORM 1 FROM public.offer_bom_line AS line_record
   WHERE line_record.workspace_id = requested_workspace_id
     AND line_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerBomLineIds'
       ) AS value
     )
   ORDER BY line_record.id FOR UPDATE;
$m2_02_old_lock$;
  new_lock_block constant text := $m2_02_new_lock$
  PERFORM 1 FROM public.offer_bom_line AS line_record
   WHERE line_record.workspace_id = requested_workspace_id
     AND line_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'offerBomLineIds'
       ) AS value
     )
   ORDER BY line_record.id FOR UPDATE;

  -- PDF-Request-Aktivitaet steckt bereits in offer.updated_at. Worker-Zeiten
  -- sind absichtlich kein eigener Retention-Anker.
  PERFORM 1 FROM public.offer_pdf_draft AS draft
   WHERE draft.workspace_id = requested_workspace_id
     AND draft.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(
           operational_graph_document->'offerPdfDraftIds',
           '[]'::jsonb
         )
       ) AS value
     )
   ORDER BY draft.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.offer_pdf_draft AS draft
     WHERE draft.workspace_id = requested_workspace_id
       AND draft.id IN (
         SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(
             operational_graph_document->'offerPdfDraftIds',
             '[]'::jsonb
           )
         ) AS value
       )
       AND draft.state = 'running'
       AND draft.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
$m2_02_new_lock$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO erase_source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'erase_inactive_lead'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-02 Erasure-Lease: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       'bba97fd4f1224ab42768aa952f54e4a933229225f8ab251e16173adf75084fdd' THEN
    RAISE EXCEPTION 'M2-02 Erasure-Lease: unerwarteter M1-07/M2-01-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_lock_block) = 0 THEN
    RAISE EXCEPTION 'M2-02 Erasure-Lease: Lockanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source,
    old_lock_block,
    new_lock_block
  );
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION public.erase_inactive_lead('
    'requested_workspace_id uuid, requested_contact_id uuid, '
    'requested_operation_id uuid) '
    'RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER '
    'SET search_path = pg_catalog AS %L',
    upgraded_source
  );
END
$m2_02_erasure_pdf_lease_upgrade$;
--> statement-breakpoint

-- Der Dispatch ist die einzige Runtime-Naht in das worker-owned pg-boss-
-- Schema. Testdatenbanken ohne pg-boss duerfen die Migration explizit unter
-- app_test/app_ci ausfuehren; jede andere fehlende oder driftende Installation
-- bricht fail-closed ab.
DO $m2_02_pdf_dispatch_migration$
DECLARE
  pgboss_owner text;
  pgboss_version integer;
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
    RAISE EXCEPTION 'M2-02 PDF dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M2-02 PDF dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M2-02 PDF dispatch: app_migrator braucht SET auf app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'M2-02 PDF dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version)
    INTO pgboss_version
    FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'M2-02 PDF dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'pdf.render'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 10
     AND queue.retry_delay = 1
     AND queue.retry_backoff = true
     AND queue.retry_delay_max = 60
     AND queue.expire_seconds = 180
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-02 PDF dispatch: pdf.render-Queue fehlt oder driftet';
  END IF;

  EXECUTE $dispatch_ddl$
    CREATE FUNCTION pgboss.enqueue_offer_pdf_draft(
      workspace_id uuid,
      job_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_attempt integer;
      dispatch_key text;
      dispatch_start_after timestamp with time zone;
      domain_state text;
      domain_attempt_count integer;
      domain_next_attempt_at timestamp with time zone;
      domain_lease_expires_at timestamp with time zone;
      runtime_pgboss_version integer;
    BEGIN
      IF NULLIF(
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'offer PDF dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT domain_job.state,
             domain_job.attempt_count,
             domain_job.next_attempt_at,
             domain_job.lease_expires_at
        INTO domain_state,
             domain_attempt_count,
             domain_next_attempt_at,
             domain_lease_expires_at
        FROM public.offer_pdf_draft AS domain_job
       WHERE domain_job.workspace_id = $1
         AND domain_job.id = $2
         AND domain_job.state IN ('queued', 'running', 'retry_wait')
         AND domain_job.input_version = 'offer-pdf-draft-input.v1'
         AND domain_job.template_version = 'offer-pdf-draft-template.v1'
         AND domain_job.renderer_recipe_version =
             'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'
         AND pg_catalog.octet_length(domain_job.reservation_key) = 32
         AND pg_catalog.octet_length(domain_job.input_sha256) = 32
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'offer PDF dispatch: keine zustellbare Reservation'
          USING ERRCODE = '42501';
      END IF;

      dispatch_attempt := domain_attempt_count + 1;
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := CASE domain_state
        WHEN 'running' THEN domain_lease_expires_at
        ELSE domain_next_attempt_at
      END;
      IF dispatch_start_after IS NULL THEN
        RAISE EXCEPTION 'offer PDF dispatch: Zustellzeit fehlt';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734771)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'offer PDF dispatch: pg-boss-Schemaversion driftet';
      END IF;
      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'pdf.render';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'offer PDF dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'offer-pdf-draft-dispatch.v1',
        'workspaceId', $1::text,
        'jobId', $2::text
      );
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'offer PDF dispatch: aktiver Job verletzt Vertrag';
      END IF;

      INSERT INTO pgboss.job (
        name, data, priority, start_after, singleton_key, expire_seconds,
        deletion_seconds, keep_until, retry_limit, retry_delay,
        retry_backoff, retry_delay_max, policy, dead_letter,
        heartbeat_seconds
      )
      SELECT queue_config.name,
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

      IF NOT FOUND THEN
        IF EXISTS (
          SELECT 1
            FROM pgboss.job AS queued_job
           WHERE queued_job.name = 'pdf.render'
             AND queued_job.singleton_key = dispatch_key
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'offer PDF dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $dispatch_body$
  $dispatch_ddl$;

  EXECUTE 'REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_project_calculation(uuid, uuid) TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_offer_pdf_draft(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m2_02_pdf_dispatch_migration$;
