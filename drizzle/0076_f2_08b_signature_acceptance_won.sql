-- F2.8b / M204-I1: Signaturannahme schliesst das Projekt atomar als Won.
-- Installation und Projektphase bleiben bewusst unveraendert: Reonic belegt
-- Won sicher, den Installationszeitpunkt aber widerspruechlich. Weitere offene
-- Links bleiben bestehen und werden bei Bedarf einzeln widerrufen.

DO $f208b_preflight$
DECLARE
  expected record;
  actual_sha256 text;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('_m111b_guard_project_outcome', '',
       'ec8b1e0da4c1a21da65b964c38dafbc3e71788663a1d76e1e0af8cdf83393590'),
      ('_m111b_record_project_outcome', '',
       '77198d622ee01484e2f9660e44a2be19c96468aec1ba9fae76ff622b60d2249a'),
      ('_m111b_guard_outcome_evidence_insert', '',
       'e865e7cb5014b44cc05d377f552329ea92c9e385de20021ab84fe8f9acc5f58c'),
      ('_m204_guard_signature_attestation', '',
       'cc0f2b8a08b9de87cc2a939d951ab16670d91fcf59abd8996a16b06b3c565401'),
      ('sign_signature_by_token', 'bytea, text, text, bytea',
       '86eb6d38ba6d39dc3e816eb191a5969296f1d8bbbf67520b0fb57e873a84c4f9')
    ) AS contract(routine_name, argument_types, source_sha256)
  LOOP
    SELECT pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
             'hex'
           )
      INTO actual_sha256
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = 'public'
       AND routine.proname = expected.routine_name
       AND pg_catalog.oidvectortypes(routine.proargtypes) = expected.argument_types;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'F2.8b: erwartete Funktion public.%(%) fehlt',
        expected.routine_name, expected.argument_types;
    END IF;
    IF actual_sha256 IS DISTINCT FROM expected.source_sha256 THEN
      RAISE EXCEPTION 'F2.8b: unerwarteter Quellhash fuer %(%) (% statt %)',
        expected.routine_name, expected.argument_types,
        actual_sha256, expected.source_sha256;
    END IF;
  END LOOP;
END
$f208b_preflight$;--> statement-breakpoint

-- Der Rollout nimmt dasselbe globale Lockset wie die kanonischen
-- Signaturpfade: Project -> Request -> Attestation. Request braucht fuer den
-- kurzen FORCE-RLS-Inventarscan ACCESS EXCLUSIVE. NOWAIT verhindert, dass ein
-- alter FOR-UPDATE-Pfad zwischen seinem ROW-SHARE- und ROW-EXCLUSIVE-Lock in
-- einen Upgrade-Deadlock geraet. Jeder fehlgeschlagene Versuch rollt seine
-- bereits genommenen Teil-Locks im PL/pgSQL-Subtransaction sofort zurueck.
DO $f208b_rollout_lock$
DECLARE
  attempt_count integer := 0;
BEGIN
  LOOP
    attempt_count := attempt_count + 1;
    BEGIN
      LOCK TABLE public.project IN EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.signature_request IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.signature_attestation IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt_count >= 200 THEN
        RAISE EXCEPTION 'F2.8b: Signaturbestand konnte nicht quiesziert werden'
          USING ERRCODE = '55P03';
      END IF;
    END;
    PERFORM pg_catalog.pg_sleep(0.025);
  END LOOP;
END
$f208b_rollout_lock$;--> statement-breakpoint

-- signature_token_locator ist absichtlich kein vollstaendiger
-- Bestandsindex: alte Analog-/SQL-Pfade konnten terminale Requests ohne
-- Locator hinterlassen. Der aktuelle Tabellen-Owner liest deshalb unter dem
-- bereits gehaltenen Lock einmal direkt. Die UUID-Liste bleibt nur als
-- transaktionslokale GUC; TEMP-Rechte bleiben entzogen. Der DO-Fehlerpfad
-- reaktiviert FORCE RLS auch fuer einen nichtkanonischen Einzelstatementlauf.
DO $f208b_stage_inventory$
DECLARE
  staged_workspace_ids text;
BEGIN
  ALTER TABLE public.signature_request NO FORCE ROW LEVEL SECURITY;
  SELECT COALESCE(
           pg_catalog.array_agg(
             DISTINCT request_record.workspace_id
             ORDER BY request_record.workspace_id
           )::text,
           '{}'
         )
    INTO staged_workspace_ids
    FROM public.signature_request AS request_record
   WHERE request_record.status IN ('signed', 'revoked_by_customer');
  ALTER TABLE public.signature_request FORCE ROW LEVEL SECURITY;
  PERFORM pg_catalog.set_config(
    'app.f208b_terminal_workspace_ids', staged_workspace_ids, true
  );
EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.signature_request FORCE ROW LEVEL SECURITY;
  RAISE;
END
$f208b_stage_inventory$;--> statement-breakpoint

-- Der bestehende Analogpfad aktualisiert Request und Attestierung bewusst in
-- zwei Statements derselben Transaktion. Ein deferred Constraint-Trigger
-- erzwingt deshalb den gemeinsamen COMMIT-Endzustand, ohne diesen Pfad zu
-- verbreitern: terminaler Request, gebundene Attestierung und geschlossenes
-- Offer-/Installationsprojekt muessen zusammen bestehen.
CREATE FUNCTION public._f208b_assert_terminal_signature_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f208b_terminal_integrity$
DECLARE
  target_workspace_id uuid;
  target_request_id uuid;
  current_request public.signature_request%ROWTYPE;
  project_phase text;
  project_outcome text;
  project_closed_at timestamptz;
  project_exists boolean := false;
  attestation_exists boolean := false;
  requires_won boolean := false;
  prior_workspace_setting text := COALESCE(
    pg_catalog.current_setting('app.workspace_id', true), ''
  );
  prior_actor_setting text := COALESCE(
    pg_catalog.current_setting('app.actor_id', true), ''
  );
BEGIN
  IF TG_TABLE_NAME = 'project' AND TG_OP = 'UPDATE' THEN
    target_workspace_id := NEW.workspace_id;
    PERFORM pg_catalog.set_config('app.actor_id', '', true);
    PERFORM pg_catalog.set_config(
      'app.workspace_id', target_workspace_id::text, true
    );

    -- Constraint-Trigger sind deferred: NEW kann daher ein gueltiger
    -- Zwischenstand vor der spaeteren Signaturannahme sein. Phase, Outcome und
    -- Schliesszeit werden aus dem finalen Transaktionsbild gelesen. Historische
    -- terminal→offen- und terminal→Request-Kanten bleiben jedoch an OLD/NEW
    -- gebunden: Sonst koennte eine zyklische Mehrfachmutation den finalen
    -- gueltigen Zustand wiederherstellen und dabei Revision/Zeitbezug faelschen.
    SELECT project_record.phase, project_record.outcome, project_record.closed_at
      INTO project_phase, project_outcome, project_closed_at
      FROM public.project AS project_record
     WHERE project_record.workspace_id = target_workspace_id
       AND project_record.id = NEW.id;
    project_exists := FOUND;

    IF EXISTS (
      SELECT 1
        FROM public.signature_request AS request_record
       WHERE request_record.workspace_id = target_workspace_id
         AND request_record.project_id = NEW.id
         AND request_record.status IN ('signed', 'revoked_by_customer')
    ) THEN
      IF NOT project_exists
         OR project_phase NOT IN ('offer', 'installation')
         OR project_outcome NOT IN ('won', 'lost')
         OR project_closed_at IS NULL
         OR (
           NEW.outcome IS NOT DISTINCT FROM OLD.outcome
           AND NEW.closed_at IS DISTINCT FROM OLD.closed_at
         )
         OR (
           OLD.phase IN ('offer', 'installation')
           AND OLD.outcome IN ('won', 'lost')
           AND NEW.phase NOT IN ('offer', 'installation')
         )
         OR (
           OLD.outcome IN ('won', 'lost')
           AND NEW.outcome = 'open'
         )
         OR EXISTS (
           SELECT 1
             FROM public.signature_request AS request_record
            WHERE request_record.workspace_id = target_workspace_id
              AND request_record.project_id = NEW.id
              AND request_record.status IN ('signed', 'revoked_by_customer')
              AND NOT EXISTS (
                SELECT 1
                  FROM public.signature_attestation AS attestation
                 WHERE attestation.workspace_id = request_record.workspace_id
                   AND attestation.signature_request_id = request_record.id
                   AND attestation.signer_name = request_record.signer_name
                   AND attestation.content_sha256 = request_record.content_sha256
                   AND attestation.signed_at = request_record.signed_at
              )
         ) THEN
        RAISE EXCEPTION 'Terminale Signatur bindet Projektphase, Outcome und Attestierung'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    PERFORM pg_catalog.set_config(
      'app.workspace_id', prior_workspace_setting, true
    );
    PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
    RETURN NULL;
  ELSIF TG_TABLE_NAME = 'signature_request' AND TG_OP IN ('INSERT', 'UPDATE') THEN
    target_workspace_id := NEW.workspace_id;
    target_request_id := NEW.id;
    requires_won := NEW.status = 'signed'
      AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('signed', 'revoked_by_customer'));
  ELSIF TG_TABLE_NAME = 'signature_attestation' AND TG_OP = 'DELETE' THEN
    target_workspace_id := OLD.workspace_id;
    target_request_id := OLD.signature_request_id;
  ELSE
    RAISE EXCEPTION 'F2.8b Terminal-Integritaet ist falsch gebunden'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.workspace_id', target_workspace_id::text, true
  );
  SELECT request_record.* INTO current_request
    FROM public.signature_request AS request_record
   WHERE request_record.workspace_id = target_workspace_id
     AND request_record.id = target_request_id;
  IF NOT FOUND OR current_request.status NOT IN ('signed', 'revoked_by_customer') THEN
    PERFORM pg_catalog.set_config(
      'app.workspace_id', prior_workspace_setting, true
    );
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.signature_attestation AS attestation
     WHERE attestation.workspace_id = current_request.workspace_id
       AND attestation.signature_request_id = current_request.id
       AND attestation.signer_name = current_request.signer_name
       AND attestation.content_sha256 = current_request.content_sha256
       AND attestation.signed_at = current_request.signed_at
  ) INTO attestation_exists;
  SELECT project_record.phase, project_record.outcome, project_record.closed_at
    INTO project_phase, project_outcome, project_closed_at
    FROM public.project AS project_record
   WHERE project_record.workspace_id = current_request.workspace_id
     AND project_record.id = current_request.project_id;
  IF NOT FOUND
     OR NOT attestation_exists
     OR project_phase NOT IN ('offer', 'installation')
     OR project_closed_at IS NULL
     OR (requires_won AND project_outcome <> 'won')
     OR (NOT requires_won AND project_outcome NOT IN ('won', 'lost')) THEN
    RAISE EXCEPTION 'Terminaler Signatur-Request verlangt Attestierung und geschlossenes Projekt'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.workspace_id', prior_workspace_setting, true
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', prior_workspace_setting, true
  );
  PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
  RAISE;
END
$f208b_terminal_integrity$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER signature_request_terminal_integrity
AFTER INSERT OR UPDATE ON public.signature_request
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._f208b_assert_terminal_signature_integrity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER signature_attestation_terminal_integrity
AFTER DELETE ON public.signature_attestation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._f208b_assert_terminal_signature_integrity();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER project_signature_terminal_integrity
AFTER UPDATE ON public.project
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._f208b_assert_terminal_signature_integrity();--> statement-breakpoint

DO $f208b_owner_prepare$
DECLARE
  migrator_role name := current_user;
  routine_contract record;
  routine_owner name;
BEGIN
  IF migrator_role <> 'app_owner' THEN
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', migrator_role
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    -- Im Einrollen-/Legacy-Testmodus sind die Tabellen noch Eigentum des
    -- Testlogins. Die neuen SECURITY-DEFINER-Pfade bekommen dort dieselben
    -- minimalen Objektprivilegien, die app_owner im Strict-Manifest ohnehin
    -- als Owner besitzt.
    GRANT SELECT ON
      public.membership,
      public.signature_token_locator,
      public.offer_variant,
      public.offer_variant_revision,
      public.offer,
      public.contact
    TO app_owner;
    GRANT SELECT, UPDATE ON
      public.project,
      public.signature_request
    TO app_owner;
    GRANT SELECT, INSERT ON public.signature_attestation TO app_owner;
    GRANT INSERT ON
      public.domain_events,
      public.audit_log
    TO app_owner;
    -- Im Legacy-Einrollen-Testmodus gehoeren Alt-Funktionen dem Testlogin.
    -- Strict/Produktion ist bereits app_owner; dort bleibt dieser Block leer.
    FOR routine_contract IN
      SELECT * FROM (VALUES
        ('_m111b_guard_project_outcome', ''),
        ('_m111b_record_project_outcome', ''),
        ('_m111b_guard_outcome_evidence_insert', ''),
        ('_m204_guard_signature_attestation', ''),
        ('sign_signature_by_token', 'bytea, text, text, bytea'),
        ('_f208b_assert_terminal_signature_integrity', '')
      ) AS contract(routine_name, argument_types)
    LOOP
      SELECT owner.rolname INTO routine_owner
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = routine.pronamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
       WHERE namespace.nspname = 'public'
         AND routine.proname = routine_contract.routine_name
         AND pg_catalog.oidvectortypes(routine.proargtypes) = routine_contract.argument_types;
      IF routine_owner = migrator_role THEN
        EXECUTE pg_catalog.format(
          'ALTER FUNCTION public.%I(%s) OWNER TO app_owner',
          routine_contract.routine_name, routine_contract.argument_types
        );
      ELSIF routine_owner <> 'app_owner' THEN
        RAISE EXCEPTION 'F2.8b: unerwarteter Owner % fuer %(%)',
          routine_owner, routine_contract.routine_name,
          routine_contract.argument_types;
      END IF;
    END LOOP;
  END IF;
END
$f208b_owner_prepare$;--> statement-breakpoint
SET ROLE app_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m111b_guard_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111b_outcome_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
  actor_id uuid := public.app_actor_id();
  actor_role text;
  post_acceptance_lost boolean := false;
  acceptance_request public.signature_request%ROWTYPE;
  context_request_id uuid;
  context_attestation_id uuid;
  context_mode text := pg_catalog.current_setting('app.signature_acceptance_mode', true);
  context_actor text := pg_catalog.current_setting('app.signature_acceptance_actor', true);
  context_backfill boolean := COALESCE(
    pg_catalog.current_setting('app.signature_acceptance_backfill', true), ''
  ) = 'true';
  signature_context boolean := false;
BEGIN
  BEGIN
    context_request_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_request_id', true
    ), '')::uuid;
    context_attestation_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_attestation_id', true
    ), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    context_request_id := NULL;
    context_attestation_id := NULL;
  END;

  IF current_user = 'app_owner'
     AND context_request_id IS NOT NULL
     AND context_attestation_id IS NOT NULL
     AND context_mode IN ('click', 'draw', 'analog')
     AND (
       (NOT context_backfill AND pg_catalog.pg_trigger_depth() = 2)
       OR (context_backfill AND pg_catalog.pg_trigger_depth() = 1)
     ) THEN
    SELECT request_record.* INTO acceptance_request
      FROM public.signature_request AS request_record
     WHERE request_record.id = context_request_id
       AND request_record.workspace_id = NEW.workspace_id
       AND request_record.project_id = NEW.id
       AND request_record.status IN ('signed', 'revoked_by_customer')
       AND request_record.signed_at IS NOT NULL
       AND request_record.signed_variant_id = request_record.variant_id;
    IF FOUND AND (
      NOT context_backfill OR EXISTS (
        SELECT 1
          FROM public.signature_attestation AS attestation
         WHERE attestation.id = context_attestation_id
           AND attestation.workspace_id = acceptance_request.workspace_id
           AND attestation.signature_request_id = acceptance_request.id
           AND attestation.mode = context_mode
           AND attestation.signed_at = acceptance_request.signed_at
      )
    ) THEN
      signature_context := true;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS DISTINCT FROM 'open'
       OR NEW.outcome_revision IS DISTINCT FROM 0
       OR NEW.closed_at IS NOT NULL
       OR NEW.loss_reason_id IS NOT NULL
       OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Project muss ohne vorweggenommenes Outcome beginnen'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.outcome = 'lost'
     AND OLD.loss_reason_text IS NOT NULL
     AND NEW.loss_reason_text IS NULL
     AND NEW.name = 'geloescht-' || NEW.id::text
     AND NEW.dedupe_review_required = false
     AND NEW.updated_at >= OLD.updated_at
     AND (
       pg_catalog.to_jsonb(NEW)
         - ARRAY['name', 'dedupe_review_required', 'loss_reason_text', 'updated_at']::text[]
     ) IS NOT DISTINCT FROM (
       pg_catalog.to_jsonb(OLD)
         - ARRAY['name', 'dedupe_review_required', 'loss_reason_text', 'updated_at']::text[]
     ) THEN
    IF public._m111a_erasure_scrub_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF signature_context THEN
    IF context_backfill THEN
      IF context_actor IS DISTINCT FROM 'system' THEN
        RAISE EXCEPTION 'Signatur-Won-Backfill verlangt den System-Actor'
          USING ERRCODE = '23514';
      END IF;
    ELSIF context_mode = 'analog' THEN
      IF actor_id IS NULL
         OR context_actor IS DISTINCT FROM actor_id::text
         OR NOT public._m204_actor_can_write_signatures(NEW.workspace_id) THEN
        RAISE EXCEPTION 'Analoge Signatur-Won-Kante verlangt ihren internen Actor'
          USING ERRCODE = '23514';
      END IF;
    ELSIF actor_id IS NOT NULL OR context_actor IS DISTINCT FROM 'customer' THEN
      RAISE EXCEPTION 'Digitale Signatur-Won-Kante verlangt den Kundenpfad'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.phase NOT IN ('offer', 'installation')
       OR NEW.phase IS DISTINCT FROM OLD.phase
       OR OLD.outcome IS DISTINCT FROM 'open'
       OR NEW.outcome IS DISTINCT FROM 'won'
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.kanban_board_id IS DISTINCT FROM OLD.kanban_board_id
       OR NEW.kanban_column_id IS DISTINCT FROM OLD.kanban_column_id
       OR OLD.outcome_revision >= 2147483647
       OR NEW.outcome_revision <> OLD.outcome_revision + 1
       OR NEW.closed_at IS DISTINCT FROM acceptance_request.signed_at
       OR NEW.loss_reason_id IS NOT NULL
       OR NEW.loss_reason_text IS NOT NULL
       OR NEW.updated_at IS DISTINCT FROM GREATEST(
         OLD.updated_at, acceptance_request.signed_at
       ) THEN
      RAISE EXCEPTION 'Signatur-Won verletzt Phase, Outcome, Revision oder Zeitbindung'
        USING ERRCODE = '23514';
    END IF;
    IF (
      pg_catalog.to_jsonb(NEW)
        - ARRAY[
            'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
            'loss_reason_text', 'updated_at'
          ]::text[]
    ) IS DISTINCT FROM (
      pg_catalog.to_jsonb(OLD)
        - ARRAY[
            'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
            'loss_reason_text', 'updated_at'
          ]::text[]
    ) THEN
      RAISE EXCEPTION 'Signatur-Won darf keine fremden Projectfelder aendern'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  actor_role := public._m111a_actor_role(NEW.workspace_id);
  IF actor_role IS NULL OR actor_role NOT IN ('editor', 'admin') THEN
    RAISE EXCEPTION 'Project-Outcome verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM public.contact AS contact_record
   WHERE contact_record.workspace_id = NEW.workspace_id
     AND contact_record.id = NEW.contact_id
     AND contact_record.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project-Outcome ist fuer geloeschte Kontakte gesperrt'
      USING ERRCODE = '23514';
  END IF;
  post_acceptance_lost := OLD.phase IN ('offer', 'installation')
    AND NEW.phase IS NOT DISTINCT FROM OLD.phase
    AND OLD.outcome = 'won'
    AND NEW.outcome = 'lost';
  IF NOT (
       (OLD.phase = 'request' AND NEW.phase = 'request')
       OR post_acceptance_lost
     )
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kanban_board_id IS DISTINCT FROM OLD.kanban_board_id
     OR NEW.kanban_column_id IS DISTINCT FROM OLD.kanban_column_id
     OR OLD.outcome_revision >= 2147483647
     OR NEW.outcome_revision <> OLD.outcome_revision + 1 THEN
    RAISE EXCEPTION 'Project-Outcome verletzt Scope, Board oder Revision'
      USING ERRCODE = '23514';
  END IF;
  IF (
    pg_catalog.to_jsonb(NEW)
      - ARRAY[
          'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
          'loss_reason_text', 'updated_at'
        ]::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD)
      - ARRAY[
          'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
          'loss_reason_text', 'updated_at'
        ]::text[]
  ) THEN
    RAISE EXCEPTION 'Project-Outcome darf keine fremden Projectfelder aendern'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.outcome = 'open' AND NEW.outcome = 'won' THEN
    IF NEW.loss_reason_id IS NOT NULL OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Won darf keinen Verlustgrund tragen'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF (OLD.outcome = 'open' OR post_acceptance_lost)
        AND NEW.outcome = 'lost' THEN
    IF NEW.loss_reason_id IS NULL THEN
      RAISE EXCEPTION 'Lost verlangt einen strukturierten Verlustgrund'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project_loss_reason AS reason_record
     WHERE reason_record.workspace_id = NEW.workspace_id
       AND reason_record.id = NEW.loss_reason_id
       AND reason_record.archived_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lost-Verlustgrund fehlt, ist fremd oder archiviert'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF OLD.outcome = 'open' AND NEW.outcome = 'cannot_fulfill' THEN
    IF NEW.loss_reason_id IS NOT NULL OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot Fulfil darf keinen Verlustgrund tragen'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open' THEN
    NEW.closed_at := NULL;
    NEW.loss_reason_id := NULL;
    NEW.loss_reason_text := NULL;
  ELSE
    RAISE EXCEPTION 'Illegale Project-Outcome-Transition'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m111b_outcome_guard$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m111b_record_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111b_outcome_evidence$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_text text;
  event_type text;
  evidence jsonb;
  acceptance_request public.signature_request%ROWTYPE;
  context_request_id uuid;
  context_attestation_id uuid;
  context_mode text := pg_catalog.current_setting('app.signature_acceptance_mode', true);
  context_actor text := pg_catalog.current_setting('app.signature_acceptance_actor', true);
  context_backfill boolean := COALESCE(
    pg_catalog.current_setting('app.signature_acceptance_backfill', true), ''
  ) = 'true';
  signature_context boolean := false;
BEGIN
  BEGIN
    context_request_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_request_id', true
    ), '')::uuid;
    context_attestation_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_attestation_id', true
    ), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    context_request_id := NULL;
    context_attestation_id := NULL;
  END;
  IF current_user = 'app_owner'
     AND context_request_id IS NOT NULL
     AND context_attestation_id IS NOT NULL
     AND context_mode IN ('click', 'draw', 'analog')
     AND (
       (NOT context_backfill AND pg_catalog.pg_trigger_depth() = 2)
       OR (context_backfill AND pg_catalog.pg_trigger_depth() = 1)
     ) THEN
    SELECT request_record.* INTO acceptance_request
      FROM public.signature_request AS request_record
     WHERE request_record.id = context_request_id
       AND request_record.workspace_id = NEW.workspace_id
       AND request_record.project_id = NEW.id
       AND request_record.status IN ('signed', 'revoked_by_customer')
       AND request_record.signed_at = NEW.closed_at;
    IF FOUND AND (
      NOT context_backfill OR EXISTS (
        SELECT 1 FROM public.signature_attestation AS attestation
         WHERE attestation.id = context_attestation_id
           AND attestation.workspace_id = acceptance_request.workspace_id
           AND attestation.signature_request_id = acceptance_request.id
           AND attestation.mode = context_mode
           AND attestation.signed_at = acceptance_request.signed_at
      )
    ) THEN
      signature_context := true;
    END IF;
  END IF;

  IF signature_context THEN
    IF OLD.outcome IS DISTINCT FROM 'open' OR NEW.outcome IS DISTINCT FROM 'won' THEN
      RAISE EXCEPTION 'Unbekannte Signatur-Outcome-Evidenzkante'
        USING ERRCODE = '23514';
    END IF;
    IF context_backfill THEN
      IF context_actor IS DISTINCT FROM 'system' THEN
        RAISE EXCEPTION 'Signatur-Won-Backfill verlangt den System-Actor'
          USING ERRCODE = '23514';
      END IF;
      actor_text := 'system';
    ELSIF context_mode = 'analog' THEN
      IF actor_id IS NULL OR context_actor IS DISTINCT FROM actor_id::text THEN
        RAISE EXCEPTION 'Analoge Signatur-Evidenz verlangt ihren internen Actor'
          USING ERRCODE = '23514';
      END IF;
      actor_text := actor_id::text;
    ELSE
      IF actor_id IS NOT NULL OR context_actor IS DISTINCT FROM 'customer' THEN
        RAISE EXCEPTION 'Digitale Signatur-Evidenz verlangt den Kundenpfad'
          USING ERRCODE = '23514';
      END IF;
      actor_text := 'customer';
    END IF;
  ELSE
    IF actor_id IS NULL THEN
      RAISE EXCEPTION 'Project-Outcome-Evidenz verlangt einen Actor'
        USING ERRCODE = '42501';
    END IF;
    actor_text := actor_id::text;
  END IF;

  event_type := CASE
    WHEN OLD.outcome = 'open' AND NEW.outcome = 'won' THEN 'project.outcome_won'
    WHEN OLD.outcome IN ('open', 'won') AND NEW.outcome = 'lost'
      THEN 'project.outcome_lost'
    WHEN OLD.outcome = 'open' AND NEW.outcome = 'cannot_fulfill'
      THEN 'project.outcome_cannot_fulfil'
    WHEN OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open'
      THEN 'project.outcome_reopened'
    ELSE NULL
  END;
  IF event_type IS NULL THEN
    RAISE EXCEPTION 'Unbekannte Project-Outcome-Evidenzkante'
      USING ERRCODE = '23514';
  END IF;
  evidence := pg_catalog.jsonb_build_object(
    'projectId', NEW.id::text,
    'previousOutcome', OLD.outcome,
    'nextOutcome', NEW.outcome,
    'outcomeRevision', NEW.outcome_revision
  );
  IF signature_context THEN
    evidence := evidence || pg_catalog.jsonb_build_object(
      'source', 'signature',
      'signatureRequestId', acceptance_request.id::text,
      'signatureAttestationId', context_attestation_id::text,
      'signatureMode', context_mode,
      'offerId', acceptance_request.offer_id::text,
      'variantId', acceptance_request.variant_id::text
    );
  ELSIF NEW.outcome = 'lost' THEN
    evidence := evidence || pg_catalog.jsonb_build_object(
      'lossReasonId', NEW.loss_reason_id::text,
      'hasComment', NEW.loss_reason_text IS NOT NULL
    );
  ELSIF OLD.outcome = 'lost' THEN
    evidence := evidence || pg_catalog.jsonb_build_object(
      'lossReasonId', OLD.loss_reason_id::text,
      'hasComment', OLD.loss_reason_text IS NOT NULL
    );
  END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    NEW.workspace_id, 'project', NEW.id, event_type,
    actor_text, evidence, NEW.updated_at
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    NEW.workspace_id, actor_text, 'project.outcome.write',
    'project', true, evidence, NEW.updated_at
  );
  RETURN NULL;
END
$m111b_outcome_evidence$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m111b_guard_outcome_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111b_outcome_evidence_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  expected_actor text;
  expected_activity_label text;
  acceptance_request public.signature_request%ROWTYPE;
  context_request_id uuid;
  context_attestation_id uuid;
  context_mode text := pg_catalog.current_setting('app.signature_acceptance_mode', true);
  context_actor text := pg_catalog.current_setting('app.signature_acceptance_actor', true);
  context_backfill boolean := COALESCE(
    pg_catalog.current_setting('app.signature_acceptance_backfill', true), ''
  ) = 'true';
  base_signature_context boolean := false;
BEGIN
  BEGIN
    context_request_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_request_id', true
    ), '')::uuid;
    context_attestation_id := NULLIF(pg_catalog.current_setting(
      'app.signature_acceptance_attestation_id', true
    ), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    context_request_id := NULL;
    context_attestation_id := NULL;
  END;
  IF current_user = 'app_owner'
     AND context_request_id IS NOT NULL
     AND context_attestation_id IS NOT NULL
     AND context_mode IN ('click', 'draw', 'analog') THEN
    SELECT request_record.* INTO acceptance_request
      FROM public.signature_request AS request_record
     WHERE request_record.id = context_request_id
       AND request_record.status IN ('signed', 'revoked_by_customer')
       AND request_record.signed_at IS NOT NULL;
    IF FOUND AND (
      NOT context_backfill OR EXISTS (
        SELECT 1 FROM public.signature_attestation AS attestation
         WHERE attestation.id = context_attestation_id
           AND attestation.workspace_id = acceptance_request.workspace_id
           AND attestation.signature_request_id = acceptance_request.id
           AND attestation.mode = context_mode
           AND attestation.signed_at = acceptance_request.signed_at
      )
    ) THEN
      base_signature_context := true;
      IF context_backfill THEN
        expected_actor := 'system';
      ELSIF context_mode = 'analog' THEN
        expected_actor := actor_id::text;
      ELSE
        expected_actor := 'customer';
      END IF;
      expected_activity_label := CASE WHEN context_mode = 'analog'
        THEN 'Signature request accepted analogously'
        ELSE 'Signature request accepted by customer'
      END;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'domain_events' THEN
    IF NEW.event_type IN (
         'project.outcome_won', 'project.outcome_lost',
         'project.outcome_reopened', 'project.outcome_cannot_fulfil'
       ) THEN
      IF NEW.payload->>'source' = 'signature' THEN
        IF NOT base_signature_context
           OR NEW.event_type IS DISTINCT FROM 'project.outcome_won'
           OR (
             (NOT context_backfill AND pg_catalog.pg_trigger_depth() <> 3)
             OR (context_backfill AND pg_catalog.pg_trigger_depth() <> 2)
           )
           OR context_actor IS DISTINCT FROM expected_actor
           OR NEW.workspace_id IS DISTINCT FROM acceptance_request.workspace_id
           OR NEW.aggregate_type IS DISTINCT FROM 'project'
           OR NEW.aggregate_id IS DISTINCT FROM acceptance_request.project_id
           OR NEW.aggregate_id::text IS DISTINCT FROM NEW.payload->>'projectId'
           OR NEW.actor IS DISTINCT FROM expected_actor
           OR NEW.payload->>'signatureRequestId' IS DISTINCT FROM acceptance_request.id::text
           OR NEW.payload->>'signatureAttestationId' IS DISTINCT FROM context_attestation_id::text
           OR NEW.payload->>'signatureMode' IS DISTINCT FROM context_mode
           OR NEW.payload->>'offerId' IS DISTINCT FROM acceptance_request.offer_id::text
           OR NEW.payload->>'variantId' IS DISTINCT FROM acceptance_request.variant_id::text THEN
          RAISE EXCEPTION 'Signatur-Outcome-Event verlangt den Akzeptanz-Trigger'
            USING ERRCODE = '23514';
        END IF;
      ELSIF pg_catalog.pg_trigger_depth() <> 2
         OR NEW.aggregate_type IS DISTINCT FROM 'project'
         OR NEW.aggregate_id::text IS DISTINCT FROM NEW.payload->>'projectId'
         OR NEW.actor IS DISTINCT FROM actor_id::text THEN
        RAISE EXCEPTION 'Project-Outcome-Event verlangt den Transition-Trigger'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.event_type = 'signature.signed' THEN
      IF NOT base_signature_context
         OR context_backfill
         OR pg_catalog.pg_trigger_depth() <> 2
         OR context_actor IS DISTINCT FROM expected_actor
         OR NEW.workspace_id IS DISTINCT FROM acceptance_request.workspace_id
         OR NEW.aggregate_type IS DISTINCT FROM 'offer'
         OR NEW.aggregate_id IS DISTINCT FROM acceptance_request.offer_id
         OR NEW.actor IS DISTINCT FROM expected_actor
         OR NEW.occurred_at IS DISTINCT FROM acceptance_request.signed_at
         OR NEW.payload->>'source' IS DISTINCT FROM 'signature'
         OR NEW.payload->>'requestId' IS DISTINCT FROM acceptance_request.id::text
         OR NEW.payload->>'projectId' IS DISTINCT FROM acceptance_request.project_id::text
         OR NEW.payload->>'offerId' IS DISTINCT FROM acceptance_request.offer_id::text
         OR NEW.payload->>'variantId' IS DISTINCT FROM acceptance_request.variant_id::text
         OR NEW.payload->>'mode' IS DISTINCT FROM context_mode
         OR NEW.payload->>'activityLabel' IS DISTINCT FROM expected_activity_label THEN
        RAISE EXCEPTION 'signature.signed verlangt den Akzeptanz-Trigger'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'audit_log' THEN
    IF NEW.action = 'project.outcome.write' AND NEW.allowed IS TRUE THEN
      IF NEW.details->>'source' = 'signature' THEN
        IF NOT base_signature_context
           OR (
             (NOT context_backfill AND pg_catalog.pg_trigger_depth() <> 3)
             OR (context_backfill AND pg_catalog.pg_trigger_depth() <> 2)
           )
           OR context_actor IS DISTINCT FROM expected_actor
           OR NEW.workspace_id IS DISTINCT FROM acceptance_request.workspace_id
           OR NEW.resource IS DISTINCT FROM 'project'
           OR NEW.actor IS DISTINCT FROM expected_actor
           OR NEW.details->>'projectId' IS DISTINCT FROM acceptance_request.project_id::text
           OR NEW.details->>'signatureRequestId' IS DISTINCT FROM acceptance_request.id::text
           OR NEW.details->>'signatureAttestationId' IS DISTINCT FROM context_attestation_id::text
           OR NEW.details->>'signatureMode' IS DISTINCT FROM context_mode
           OR NEW.details->>'offerId' IS DISTINCT FROM acceptance_request.offer_id::text
           OR NEW.details->>'variantId' IS DISTINCT FROM acceptance_request.variant_id::text THEN
          RAISE EXCEPTION 'Signatur-Outcome-Audit verlangt den Akzeptanz-Trigger'
            USING ERRCODE = '23514';
        END IF;
      ELSIF pg_catalog.pg_trigger_depth() <> 2
         OR NEW.resource IS DISTINCT FROM 'project'
         OR NEW.actor IS DISTINCT FROM actor_id::text THEN
        RAISE EXCEPTION 'Project-Outcome-Audit verlangt den Transition-Trigger'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.action IN (
      'offer.signature.accept_customer', 'offer.signature.upload_analog'
    ) AND NEW.allowed IS TRUE THEN
      IF NOT base_signature_context
         OR context_backfill
         OR pg_catalog.pg_trigger_depth() <> 2
         OR context_actor IS DISTINCT FROM expected_actor
         OR NEW.workspace_id IS DISTINCT FROM acceptance_request.workspace_id
         OR NEW.resource IS DISTINCT FROM 'signature_request'
         OR NEW.actor IS DISTINCT FROM expected_actor
         OR NEW.occurred_at IS DISTINCT FROM acceptance_request.signed_at
         OR NEW.details->>'source' IS DISTINCT FROM 'signature'
         OR NEW.details->>'requestId' IS DISTINCT FROM acceptance_request.id::text
         OR NEW.details->>'projectId' IS DISTINCT FROM acceptance_request.project_id::text
         OR NEW.details->>'offerId' IS DISTINCT FROM acceptance_request.offer_id::text
         OR NEW.details->>'variantId' IS DISTINCT FROM acceptance_request.variant_id::text
         OR NEW.details->>'mode' IS DISTINCT FROM context_mode
         OR NEW.details->>'activityLabel' IS DISTINCT FROM expected_activity_label
         OR NEW.action IS DISTINCT FROM (
           CASE WHEN context_mode = 'analog'
             THEN 'offer.signature.upload_analog'
             ELSE 'offer.signature.accept_customer'
           END
         ) THEN
        RAISE EXCEPTION 'Signatur-Audit verlangt den Akzeptanz-Trigger'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$m111b_outcome_evidence_guard$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public._m204_guard_signature_attestation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_attestation_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  actor_id uuid := public.app_actor_id();
  located_project_id uuid;
  request_row public.signature_request%ROWTYPE;
  project_phase text;
  project_outcome text;
  project_outcome_revision integer;
  evidence_actor text;
  activity_label text;
  prior_request_context text := COALESCE(pg_catalog.current_setting(
    'app.signature_acceptance_request_id', true
  ), '');
  prior_attestation_context text := COALESCE(pg_catalog.current_setting(
    'app.signature_acceptance_attestation_id', true
  ), '');
  prior_mode_context text := COALESCE(pg_catalog.current_setting(
    'app.signature_acceptance_mode', true
  ), '');
  prior_actor_context text := COALESCE(pg_catalog.current_setting(
    'app.signature_acceptance_actor', true
  ), '');
  prior_backfill_context text := COALESCE(pg_catalog.current_setting(
    'app.signature_acceptance_backfill', true
  ), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m204_erasure_scrub_allowed(OLD.workspace_id, OLD.signature_request_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signature_attestation DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'signature_attestation ist append-only'
      USING ERRCODE = '23514';
  END IF;

  -- Die erste Abfrage ist nur ein unveraenderlicher Locator und nimmt keinen
  -- Row-Lock. Erst Project, dann Request: damit bleibt auch ein erlaubter
  -- direkter Attestation-Insert deadlockfrei zum Token-/Servicepfad.
  SELECT request_record.project_id INTO located_project_id
    FROM public.signature_request AS request_record
   WHERE request_record.workspace_id = NEW.workspace_id
     AND request_record.id = NEW.signature_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signature_attestation verlangt einen signierten Request'
      USING ERRCODE = '23514';
  END IF;

  SELECT project_record.phase, project_record.outcome,
         project_record.outcome_revision
    INTO project_phase, project_outcome, project_outcome_revision
    FROM public.project AS project_record
   WHERE project_record.workspace_id = NEW.workspace_id
     AND project_record.id = located_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Signatur-Won-Projekt fehlt'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO request_row
    FROM public.signature_request
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.signature_request_id
     AND project_id = located_project_id
   FOR SHARE;
  IF NOT FOUND OR request_row.status <> 'signed' THEN
    RAISE EXCEPTION 'signature_attestation verlangt einen signierten Request'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.mode = 'analog' THEN
    IF NOT public._m204_actor_can_write_signatures(NEW.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'signature_attestation analog verlangt einen internen Editor oder Admin'
        USING ERRCODE = '23514';
    END IF;
    evidence_actor := actor_id::text;
    activity_label := 'Signature request accepted analogously';
  ELSE
    IF actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'signature_attestation click/draw verlangt den Token-Pfad'
        USING ERRCODE = '23514';
    END IF;
    evidence_actor := 'customer';
    activity_label := 'Signature request accepted by customer';
  END IF;
  IF NEW.signer_name IS DISTINCT FROM request_row.signer_name
     OR NEW.content_sha256 IS DISTINCT FROM request_row.content_sha256 THEN
    RAISE EXCEPTION 'signature_attestation Bindung weicht vom Request ab'
      USING ERRCODE = '23514';
  END IF;
  NEW.signed_at := request_row.signed_at;
  NEW.created_at := mutation_time;

  IF project_phase NOT IN ('offer', 'installation') THEN
    RAISE EXCEPTION 'Signatur-Won verlangt Offer- oder Installationsphase'
      USING ERRCODE = '23514';
  END IF;
  IF project_outcome NOT IN ('open', 'won') THEN
    RAISE EXCEPTION 'Signatur darf Lost/Cannot-Fulfil nicht ueberschreiben'
      USING ERRCODE = '23514';
  END IF;
  IF project_outcome = 'open' AND project_outcome_revision >= 2147483647 THEN
    RAISE EXCEPTION 'Signatur-Won-Revision ist ausgeschoepft'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.signature_acceptance_request_id', request_row.id::text, true
  );
  PERFORM pg_catalog.set_config(
    'app.signature_acceptance_attestation_id', NEW.id::text, true
  );
  PERFORM pg_catalog.set_config('app.signature_acceptance_mode', NEW.mode, true);
  PERFORM pg_catalog.set_config(
    'app.signature_acceptance_actor', evidence_actor, true
  );
  PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', 'false', true);

  IF project_outcome = 'open' THEN
    UPDATE public.project
       SET outcome = 'won',
           outcome_revision = outcome_revision + 1,
           closed_at = request_row.signed_at,
           loss_reason_id = NULL,
           loss_reason_text = NULL,
           updated_at = GREATEST(updated_at, request_row.signed_at)
     WHERE workspace_id = request_row.workspace_id
       AND id = request_row.project_id
       AND outcome = 'open'
       AND outcome_revision = project_outcome_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Signatur-Won verlor den Project-CAS'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    request_row.workspace_id, 'offer', request_row.offer_id,
    'signature.signed', evidence_actor,
    pg_catalog.jsonb_build_object(
      'source', 'signature',
      'requestId', request_row.id::text,
      'projectId', request_row.project_id::text,
      'offerId', request_row.offer_id::text,
      'variantId', request_row.variant_id::text,
      'mode', NEW.mode,
      'activityLabel', activity_label
    ), request_row.signed_at
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    request_row.workspace_id, evidence_actor,
    CASE WHEN NEW.mode = 'analog'
      THEN 'offer.signature.upload_analog'
      ELSE 'offer.signature.accept_customer'
    END,
    'signature_request', true,
    pg_catalog.jsonb_build_object(
      'source', 'signature',
      'requestId', request_row.id::text,
      'projectId', request_row.project_id::text,
      'offerId', request_row.offer_id::text,
      'variantId', request_row.variant_id::text,
      'mode', NEW.mode,
      'activityLabel', activity_label
    ), request_row.signed_at
  );

  PERFORM pg_catalog.set_config('app.signature_acceptance_request_id', prior_request_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_attestation_id', prior_attestation_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_mode', prior_mode_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_actor', prior_actor_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', prior_backfill_context, true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.signature_acceptance_request_id', prior_request_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_attestation_id', prior_attestation_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_mode', prior_mode_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_actor', prior_actor_context, true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', prior_backfill_context, true);
  RAISE;
END
$m204_attestation_guard$;--> statement-breakpoint

CREATE FUNCTION public.sign_signature_analog(
  requested_workspace_id uuid,
  requested_request_id uuid,
  requested_signing_date timestamptz,
  requested_artifact_mime_type text,
  requested_artifact_bytes bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f208b_sign_analog$
DECLARE
  actor_id uuid := public.app_actor_id();
  located_project_id uuid;
  request_row public.signature_request%ROWTYPE;
  project_phase text;
  project_outcome text;
  project_outcome_revision integer;
  resolved_signer_name text;
  signing_time timestamptz := pg_catalog.statement_timestamp();
  attestation_id uuid := pg_catalog.gen_random_uuid();
  artifact_size integer;
  artifact_magic_valid boolean := false;
BEGIN
  IF requested_workspace_id IS NULL
     OR requested_request_id IS NULL
     OR requested_signing_date IS NULL
     OR requested_artifact_mime_type NOT IN ('application/pdf', 'image/jpeg')
     OR requested_artifact_bytes IS NULL THEN
    RAISE EXCEPTION 'Analoge Signaturparameter sind ungueltig'
      USING ERRCODE = '22023';
  END IF;
  artifact_size := pg_catalog.octet_length(requested_artifact_bytes);
  IF artifact_size < 1 OR artifact_size > 8388608
     OR requested_signing_date > signing_time + interval '1 day' THEN
    RAISE EXCEPTION 'Analoge Signaturparameter sind ausserhalb der Grenzen'
      USING ERRCODE = '22023';
  END IF;
  artifact_magic_valid := CASE requested_artifact_mime_type
    WHEN 'application/pdf' THEN
      artifact_size >= 5
      AND pg_catalog.substring(requested_artifact_bytes, 1, 5)
        = pg_catalog.decode('255044462d', 'hex')
    WHEN 'image/jpeg' THEN
      artifact_size >= 3
      AND pg_catalog.substring(requested_artifact_bytes, 1, 3)
        = pg_catalog.decode('ffd8ff', 'hex')
    ELSE false
  END;
  IF NOT artifact_magic_valid THEN
    RAISE EXCEPTION 'Analoge Signaturdatei passt nicht zum MIME-Typ'
      USING ERRCODE = '22023';
  END IF;
  IF actor_id IS NULL
     OR NOT public._m204_actor_can_write_signatures(requested_workspace_id) THEN
    RAISE EXCEPTION 'Analoge Signatur verlangt einen internen Editor oder Admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT request_record.project_id INTO located_project_id
    FROM public.signature_request AS request_record
   WHERE request_record.workspace_id = requested_workspace_id
     AND request_record.id = requested_request_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Kanonische Lockreihenfolge: Project -> SignatureRequest -> Variant.
  SELECT project_record.phase, project_record.outcome,
         project_record.outcome_revision
    INTO project_phase, project_outcome, project_outcome_revision
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = located_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO request_row
    FROM public.signature_request
   WHERE workspace_id = requested_workspace_id
     AND id = requested_request_id
     AND project_id = located_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF request_row.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'transition_conflict'
    );
  END IF;
  IF project_phase NOT IN ('offer', 'installation')
     OR project_outcome NOT IN ('open', 'won') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'project_outcome_conflict'
    );
  END IF;
  IF project_outcome = 'open' AND project_outcome_revision >= 2147483647 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'project_outcome_revision_exhausted'
    );
  END IF;
  IF request_row.expires_at <= signing_time THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'transition_conflict'
    );
  END IF;

  PERFORM 1
    FROM public.offer_variant AS variant_record
    JOIN public.offer_variant_revision AS revision_record
      ON revision_record.workspace_id = variant_record.workspace_id
     AND revision_record.offer_id = variant_record.offer_id
     AND revision_record.variant_id = variant_record.id
     AND revision_record.revision = variant_record.current_revision
   WHERE variant_record.workspace_id = request_row.workspace_id
     AND variant_record.offer_id = request_row.offer_id
     AND variant_record.id = request_row.variant_id
     AND revision_record.id = request_row.variant_revision_id
   FOR UPDATE OF variant_record;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'variant_revision_changed'
    );
  END IF;

  SELECT contact_record.display_name INTO resolved_signer_name
    FROM public.offer AS offer_record
    JOIN public.contact AS contact_record
      ON contact_record.workspace_id = offer_record.workspace_id
     AND contact_record.id = offer_record.contact_id
   WHERE offer_record.workspace_id = request_row.workspace_id
     AND offer_record.id = request_row.offer_id
   LIMIT 1;
  IF resolved_signer_name IS NULL OR pg_catalog.btrim(resolved_signer_name) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'signer_missing'
    );
  END IF;

  UPDATE public.signature_request
     SET status = 'signed',
         signer_name = resolved_signer_name,
         signed_variant_id = variant_id,
         signed_at = signing_time
   WHERE workspace_id = request_row.workspace_id
     AND id = request_row.id
     AND status = 'pending';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'transition_conflict'
    );
  END IF;

  INSERT INTO public.signature_attestation (
    id, workspace_id, signature_request_id, mode, signer_name,
    content_sha256, signing_date, artifact_mime_type, artifact_sha256,
    artifact_size_bytes, artifact_bytes
  ) VALUES (
    attestation_id, request_row.workspace_id, request_row.id, 'analog',
    resolved_signer_name, request_row.content_sha256, requested_signing_date,
    requested_artifact_mime_type,
    pg_catalog.sha256(requested_artifact_bytes), artifact_size,
    requested_artifact_bytes
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'signed',
    'requestId', request_row.id,
    'projectId', request_row.project_id,
    'offerId', request_row.offer_id,
    'attestationId', attestation_id,
    'signerName', resolved_signer_name,
    'signedAt', signing_time
  );
END
$f208b_sign_analog$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.sign_signature_by_token(
  requested_token_hash bytea,
  requested_mode text,
  requested_artifact_mime_type text,
  requested_artifact_bytes bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_sign_token$
DECLARE
  request_row public.signature_request%ROWTYPE;
  located_workspace_id uuid;
  located_request_id uuid;
  located_project_id uuid;
  project_phase text;
  project_outcome text;
  project_outcome_revision integer;
  resolved_signer_name text;
  signing_time timestamptz := pg_catalog.statement_timestamp();
  attestation_id uuid := pg_catalog.gen_random_uuid();
  result_payload jsonb;
  prior_actor_setting text := COALESCE(
    pg_catalog.current_setting('app.actor_id', true), ''
  );
  prior_workspace_setting text := COALESCE(
    pg_catalog.current_setting('app.workspace_id', true), ''
  );
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  <<signature_flow>>
  BEGIN
    SELECT locator.workspace_id, locator.signature_request_id
      INTO located_workspace_id, located_request_id
      FROM public.signature_token_locator AS locator
     WHERE locator.token_hash = requested_token_hash;
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object('status', 'not_found');
      EXIT signature_flow;
    END IF;
    PERFORM pg_catalog.set_config(
      'app.workspace_id', located_workspace_id::text, true
    );

    SELECT request_record.project_id INTO located_project_id
      FROM public.signature_request AS request_record
     WHERE request_record.workspace_id = located_workspace_id
       AND request_record.id = located_request_id;
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object('status', 'not_found');
      EXIT signature_flow;
    END IF;

    -- Kanonische Lockreihenfolge: Project -> SignatureRequest -> Variant.
    SELECT project_record.phase, project_record.outcome,
           project_record.outcome_revision
      INTO project_phase, project_outcome, project_outcome_revision
      FROM public.project AS project_record
     WHERE project_record.workspace_id = located_workspace_id
       AND project_record.id = located_project_id
     FOR UPDATE;
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object('status', 'not_found');
      EXIT signature_flow;
    END IF;

    SELECT * INTO request_row
      FROM public.signature_request
     WHERE workspace_id = located_workspace_id
       AND id = located_request_id
     FOR UPDATE;
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object('status', 'not_found');
      EXIT signature_flow;
    END IF;
    IF request_row.status = 'signed' THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'already_signed', 'requestId', request_row.id
      );
      EXIT signature_flow;
    END IF;
    IF request_row.status <> 'pending' THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', request_row.status, 'requestId', request_row.id
      );
      EXIT signature_flow;
    END IF;
    IF request_row.expires_at <= signing_time THEN
      UPDATE public.signature_request
         SET status = 'expired'
       WHERE id = request_row.id AND status = 'pending';
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'expired', 'requestId', request_row.id
      );
      EXIT signature_flow;
    END IF;
    IF project_phase NOT IN ('offer', 'installation')
       OR project_outcome NOT IN ('open', 'won') THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'project_outcome_conflict'
      );
      EXIT signature_flow;
    END IF;
    IF project_outcome = 'open' AND project_outcome_revision >= 2147483647 THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'project_outcome_revision_exhausted'
      );
      EXIT signature_flow;
    END IF;

    PERFORM 1
      FROM public.offer_variant AS variant_record
      JOIN public.offer_variant_revision AS revision_record
        ON revision_record.workspace_id = variant_record.workspace_id
       AND revision_record.offer_id = variant_record.offer_id
       AND revision_record.variant_id = variant_record.id
       AND revision_record.revision = variant_record.current_revision
     WHERE variant_record.workspace_id = request_row.workspace_id
       AND variant_record.offer_id = request_row.offer_id
       AND variant_record.id = request_row.variant_id
       AND revision_record.id = request_row.variant_revision_id
     FOR UPDATE OF variant_record;
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'variant_revision_changed'
      );
      EXIT signature_flow;
    END IF;

    SELECT contact_record.display_name INTO resolved_signer_name
      FROM public.offer AS offer_record
      JOIN public.contact AS contact_record
        ON contact_record.workspace_id = offer_record.workspace_id
       AND contact_record.id = offer_record.contact_id
     WHERE offer_record.workspace_id = request_row.workspace_id
       AND offer_record.id = request_row.offer_id
     LIMIT 1;
    IF resolved_signer_name IS NULL OR pg_catalog.btrim(resolved_signer_name) = '' THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'signer_missing'
      );
      EXIT signature_flow;
    END IF;

    UPDATE public.signature_request
       SET status = 'signed',
           signer_name = resolved_signer_name,
           signed_variant_id = variant_id,
           signed_at = signing_time
     WHERE id = request_row.id AND status = 'pending';
    IF NOT FOUND THEN
      result_payload := pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'transition_conflict'
      );
      EXIT signature_flow;
    END IF;

    INSERT INTO public.signature_attestation (
      id, workspace_id, signature_request_id, mode, signer_name,
      content_sha256, artifact_mime_type, artifact_sha256,
      artifact_size_bytes, artifact_bytes
    ) VALUES (
      attestation_id, request_row.workspace_id, request_row.id, requested_mode,
      resolved_signer_name, request_row.content_sha256,
      requested_artifact_mime_type,
      CASE WHEN requested_artifact_bytes IS NULL THEN NULL
           ELSE pg_catalog.sha256(requested_artifact_bytes) END,
      CASE WHEN requested_artifact_bytes IS NULL THEN NULL
           ELSE pg_catalog.octet_length(requested_artifact_bytes) END,
      requested_artifact_bytes
    );

    result_payload := pg_catalog.jsonb_build_object(
      'status', 'signed',
      'requestId', request_row.id,
      'projectId', request_row.project_id,
      'offerId', request_row.offer_id,
      'attestationId', attestation_id,
      'signerName', resolved_signer_name,
      'signedAt', signing_time
    );
  END signature_flow;

  PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
  PERFORM pg_catalog.set_config('app.workspace_id', prior_workspace_setting, true);
  RETURN result_payload;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
  PERFORM pg_catalog.set_config('app.workspace_id', prior_workspace_setting, true);
  RAISE;
END
$m204_sign_token$;--> statement-breakpoint

-- Vorhandene signierte Rows werden in Signierzeit-Reihenfolge nachgezogen.
-- Inkonsistente oder bereits negativ geschlossene Projekte brechen die
-- Migration ab; Lost/Cannot-Fulfil werden nie still ueberschrieben.
DO $f208b_backfill$
DECLARE
  workspace_row record;
  acceptance record;
  project_row record;
  terminal_workspace_ids uuid[];
  staged_workspace_ids text := pg_catalog.current_setting(
    'app.f208b_terminal_workspace_ids', true
  );
  prior_actor_setting text := COALESCE(
    pg_catalog.current_setting('app.actor_id', true), ''
  );
  prior_workspace_setting text := COALESCE(
    pg_catalog.current_setting('app.workspace_id', true), ''
  );
BEGIN
  IF staged_workspace_ids IS NULL OR staged_workspace_ids = '' THEN
    RAISE EXCEPTION 'F2.8b: terminales Workspace-Inventar fehlt'
      USING ERRCODE = '23514';
  END IF;
  terminal_workspace_ids := staged_workspace_ids::uuid[];

  FOR workspace_row IN
    SELECT staged.workspace_id
      FROM pg_catalog.unnest(terminal_workspace_ids) AS staged(workspace_id)
  LOOP
    PERFORM pg_catalog.set_config(
      'app.workspace_id', workspace_row.workspace_id::text, true
    );
    PERFORM pg_catalog.set_config('app.actor_id', '', true);

    IF EXISTS (
      SELECT 1
        FROM public.signature_request AS request_record
       WHERE request_record.workspace_id = workspace_row.workspace_id
         AND request_record.status IN ('signed', 'revoked_by_customer')
         AND NOT EXISTS (
           SELECT 1 FROM public.signature_attestation AS attestation
            WHERE attestation.workspace_id = request_record.workspace_id
              AND attestation.signature_request_id = request_record.id
              AND attestation.signer_name = request_record.signer_name
              AND attestation.content_sha256 = request_record.content_sha256
              AND attestation.signed_at = request_record.signed_at
         )
    ) THEN
      RAISE EXCEPTION 'F2.8b: signierter Request ohne passende Attestierung in Workspace %',
        workspace_row.workspace_id;
    END IF;

    FOR acceptance IN
      SELECT request_record.id AS request_id,
             request_record.project_id,
             request_record.offer_id,
             request_record.variant_id,
             request_record.signed_at,
             attestation.id AS attestation_id,
             attestation.mode
        FROM public.signature_request AS request_record
        JOIN public.signature_attestation AS attestation
          ON attestation.workspace_id = request_record.workspace_id
         AND attestation.signature_request_id = request_record.id
         AND attestation.signer_name = request_record.signer_name
         AND attestation.content_sha256 = request_record.content_sha256
         AND attestation.signed_at = request_record.signed_at
       WHERE request_record.workspace_id = workspace_row.workspace_id
         AND request_record.status IN ('signed', 'revoked_by_customer')
       ORDER BY request_record.signed_at, request_record.id
    LOOP
      SELECT project_record.phase, project_record.outcome,
             project_record.outcome_revision, project_record.updated_at
        INTO project_row
        FROM public.project AS project_record
       WHERE project_record.workspace_id = workspace_row.workspace_id
         AND project_record.id = acceptance.project_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'F2.8b: Projekt % fuer Signatur % fehlt',
          acceptance.project_id, acceptance.request_id;
      END IF;
      IF project_row.phase NOT IN ('offer', 'installation') THEN
        RAISE EXCEPTION 'F2.8b: Signatur % darf Projektphase % nicht ueberschreiben',
          acceptance.request_id, project_row.phase;
      END IF;
      IF project_row.outcome = 'won' THEN
        CONTINUE;
      END IF;
      IF project_row.outcome <> 'open'
         OR project_row.outcome_revision >= 2147483647 THEN
        RAISE EXCEPTION 'F2.8b: Signatur % darf Projektzustand %/% nicht ueberschreiben',
          acceptance.request_id, project_row.phase, project_row.outcome;
      END IF;

      PERFORM pg_catalog.set_config(
        'app.signature_acceptance_request_id', acceptance.request_id::text, true
      );
      PERFORM pg_catalog.set_config(
        'app.signature_acceptance_attestation_id', acceptance.attestation_id::text, true
      );
      PERFORM pg_catalog.set_config('app.signature_acceptance_mode', acceptance.mode, true);
      PERFORM pg_catalog.set_config('app.signature_acceptance_actor', 'system', true);
      PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', 'true', true);

      UPDATE public.project
         SET outcome = 'won',
             outcome_revision = outcome_revision + 1,
             closed_at = acceptance.signed_at,
             loss_reason_id = NULL,
             loss_reason_text = NULL,
             updated_at = GREATEST(updated_at, acceptance.signed_at)
       WHERE workspace_id = workspace_row.workspace_id
         AND id = acceptance.project_id
         AND outcome = 'open'
         AND outcome_revision = project_row.outcome_revision;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'F2.8b: Backfill verlor den Project-CAS fuer %',
          acceptance.project_id USING ERRCODE = '40001';
      END IF;
    END LOOP;
  END LOOP;

  PERFORM pg_catalog.set_config('app.signature_acceptance_request_id', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_attestation_id', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_mode', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_actor', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', '', true);
  PERFORM pg_catalog.set_config('app.f208b_terminal_workspace_ids', '', true);
  PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
  PERFORM pg_catalog.set_config('app.workspace_id', prior_workspace_setting, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.signature_acceptance_request_id', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_attestation_id', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_mode', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_actor', '', true);
  PERFORM pg_catalog.set_config('app.signature_acceptance_backfill', '', true);
  PERFORM pg_catalog.set_config('app.f208b_terminal_workspace_ids', '', true);
  PERFORM pg_catalog.set_config('app.actor_id', prior_actor_setting, true);
  PERFORM pg_catalog.set_config('app.workspace_id', prior_workspace_setting, true);
  RAISE;
END
$f208b_backfill$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m111b_guard_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_record_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_guard_outcome_evidence_insert() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_guard_signature_attestation() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.sign_signature_by_token(bytea, text, text, bytea)
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.sign_signature_analog(
  uuid, uuid, timestamptz, text, bytea
) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f208b_assert_terminal_signature_integrity()
  FROM PUBLIC;--> statement-breakpoint

-- Schema und Runtime-Berechtigung wechseln in demselben Drizzle-Commit.
-- Das nachgelagerte Rollenmanifest attestiert/repariert weiterhin den
-- Gesamtvertrag, ist aber weder Sicherheits- noch Verfuegbarkeits-Cutover.
DO $f208b_runtime_acl_cutover$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    REVOKE INSERT ON TABLE public.signature_attestation FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.sign_signature_by_token(
      bytea, text, text, bytea
    ) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.sign_signature_analog(
      uuid, uuid, timestamptz, text, bytea
    ) TO app_runtime;
  END IF;
END
$f208b_runtime_acl_cutover$;--> statement-breakpoint

RESET ROLE;--> statement-breakpoint
DO $f208b_owner_restore$
DECLARE
  migrator_role name := current_user;
BEGIN
  IF migrator_role <> 'app_owner' THEN
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', migrator_role
    );
  END IF;
END
$f208b_owner_restore$;
