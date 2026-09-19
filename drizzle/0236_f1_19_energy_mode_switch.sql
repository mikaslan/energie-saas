-- F1-19 (0236): Modi-Wechsel am gespeicherten Profil erlauben.
-- Der M1-07-Guard pinnte input_mode als unveraenderlich (Ein-Modus-Aera);
-- seit 0232 (4 Modi + Contract-CHECK) ist der Modus wechselbar.
CREATE OR REPLACE FUNCTION public.guard_site_energy_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_profile_guard$
DECLARE
  erasure_setting text;
  erasure_operation uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    erasure_setting := pg_catalog.current_setting('app.erasure_operation_id', true);
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
         AND tombstone.graph_ids->'profileIds' ? OLD.id::text
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'site_energy_profile mutation guard: DELETE ist nur im Erasurevertrag erlaubt';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     -- F1-19 (0236): input_mode ist seit den 4 Eingabemodi (0232) kein
     -- Identitaetsmerkmal mehr; Modus-Kopplung prueft site_energy_profile_contract_ck.
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'site_energy_profile mutation guard: Identitaet und Vertrag sind unveraenderlich';
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
