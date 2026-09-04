CREATE TABLE "portal_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid,
	"withdraw_reason" text,
	CONSTRAINT "portal_invite_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "portal_invite_ws_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "portal_invite_status_ck" CHECK ("portal_invite"."status" in (
      'active', 'withdrawn', 'expired'
    )),
	CONSTRAINT "portal_invite_hash_ck" CHECK (octet_length("portal_invite"."token_hash") = 32),
	CONSTRAINT "portal_invite_expiry_ck" CHECK ("portal_invite"."expires_at" > "portal_invite"."created_at"),
	CONSTRAINT "portal_invite_reason_ck" CHECK (
      "portal_invite"."withdraw_reason" is null or "portal_invite"."withdraw_reason" in (
        'user_request', 'superseded', 'project_closed', 'other'
      )),
	CONSTRAINT "portal_invite_shape_ck" CHECK (case "portal_invite"."status"
      when 'active' then
        "portal_invite"."withdrawn_at" is null
        and "portal_invite"."withdrawn_by" is null
        and "portal_invite"."withdraw_reason" is null
      when 'withdrawn' then
        "portal_invite"."withdrawn_at" is not null
        and "portal_invite"."withdrawn_by" is not null
        and "portal_invite"."withdraw_reason" is not null
      when 'expired' then
        "portal_invite"."withdrawn_at" is null
        and "portal_invite"."withdrawn_by" is null
        and "portal_invite"."withdraw_reason" is null
      else false end)
);
--> statement-breakpoint
CREATE TABLE "portal_token_locator" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"portal_invite_id" uuid NOT NULL,
	CONSTRAINT "portal_token_locator_hash_ck" CHECK (octet_length("portal_token_locator"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "portal_view_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"portal_invite_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_view_log_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "portal_invite" ADD CONSTRAINT "portal_invite_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_invite" ADD CONSTRAINT "portal_invite_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_invite" ADD CONSTRAINT "portal_invite_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_invite" ADD CONSTRAINT "portal_invite_withdrawn_by_fk" FOREIGN KEY ("workspace_id","withdrawn_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_token_locator" ADD CONSTRAINT "portal_token_locator_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_token_locator" ADD CONSTRAINT "portal_token_locator_invite_fk" FOREIGN KEY ("workspace_id","portal_invite_id") REFERENCES "public"."portal_invite"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_view_log" ADD CONSTRAINT "portal_view_log_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_view_log" ADD CONSTRAINT "portal_view_log_invite_fk" FOREIGN KEY ("workspace_id","portal_invite_id") REFERENCES "public"."portal_invite"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_invite_ws_project_active_uq" ON "portal_invite" USING btree ("workspace_id","project_id") WHERE "portal_invite"."status" = 'active';--> statement-breakpoint
CREATE INDEX "portal_invite_ws_project_idx" ON "portal_invite" USING btree ("workspace_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "portal_view_log_ws_invite_idx" ON "portal_view_log" USING btree ("workspace_id","portal_invite_id","viewed_at","id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F10.1 Kundenportal-Skeleton: Actor-Helfer (Spiegel _m113, membership-
-- basiert, external_only fail-closed). Lesen = viewer+, Schreiben = editor+.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._f1001_actor_portal_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f1001_actor_role$
DECLARE
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  actor_id := public.app_actor_id();
  IF actor_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;
  IF NOT FOUND
     OR actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) <> 'object'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_each(actor_capabilities) AS capability(key, value)
        WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
     )
     OR (
       actor_capabilities ? 'external_only'
       AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RETURN NULL;
  END IF;
  RETURN actor_role;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$f1001_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._f1001_actor_can_read_portal(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f1001_actor_read$
  SELECT COALESCE(
    public._f1001_actor_portal_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$f1001_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._f1001_actor_can_write_portal(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f1001_actor_write$
  SELECT COALESCE(
    public._f1001_actor_portal_role(requested_workspace_id)
      IN ('editor', 'admin'),
    false
  )
$f1001_actor_write$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F10.1: Mutations-Guard portal_invite. Terminale Zustaende sind immutable
-- (jede Aenderung an OLD.status <> 'active' -> 'terminal_state').
-- DELETE nur via Projekt-Loeschung (Kaskade): erkennbar daran, dass das
-- Eltern-Projekt im gleichen Statement bereits entfernt wurde; direkte
-- DELETEs bei existierendem Projekt werden abgewiesen.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._f1001_guard_portal_invite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $f1001_invite_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1
      FROM public.project AS parent
     WHERE parent.workspace_id = OLD.workspace_id
       AND parent.id = OLD.project_id;
    IF NOT FOUND THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'portal_invite DELETE ist nur via Projekt-Loeschung erlaubt'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT public._f1001_actor_can_write_portal(NEW.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'portal_invite verlangt einen internen Editor oder Admin'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'portal_invite Projekt-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'active'
       OR NEW.created_by IS DISTINCT FROM actor_id
       OR NEW.withdrawn_at IS NOT NULL
       OR NEW.withdrawn_by IS NOT NULL
       OR NEW.withdraw_reason IS NOT NULL
       OR NEW.expires_at <= mutation_time THEN
      RAISE EXCEPTION 'portal_invite Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'portal_invite terminaler Zustand ist immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'portal_invite immutable Bindung verletzt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'withdrawn' THEN
    IF NOT public._f1001_actor_can_write_portal(NEW.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'portal_invite Entzug verlangt einen internen Editor oder Admin'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.withdrawn_at IS NULL
       OR NEW.withdrawn_by IS DISTINCT FROM actor_id
       OR NEW.withdraw_reason IS NULL THEN
      RAISE EXCEPTION 'portal_invite Withdraw-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.withdrawn_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.status = 'expired' THEN
    IF actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'portal_invite Ablauf verlangt den Token-Pfad'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL
       OR NEW.withdrawn_by IS NOT NULL
       OR NEW.withdraw_reason IS NOT NULL THEN
      RAISE EXCEPTION 'portal_invite Expire-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'portal_invite ungueltiger Statusuebergang'
    USING ERRCODE = '23514';
END
$f1001_invite_guard$;--> statement-breakpoint

CREATE FUNCTION public._f1001_guard_portal_view_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $f1001_view_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1
      FROM public.portal_invite AS parent
     WHERE parent.workspace_id = OLD.workspace_id
       AND parent.id = OLD.portal_invite_id;
    IF NOT FOUND THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'portal_view_log DELETE ist nur via Invite-Loeschung erlaubt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'portal_view_log ist append-only'
      USING ERRCODE = '23514';
  END IF;
  NEW.viewed_at := mutation_time;
  RETURN NEW;
END
$f1001_view_guard$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._f1001_actor_portal_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1001_actor_can_read_portal(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1001_actor_can_write_portal(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1001_guard_portal_invite() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1001_guard_portal_view_log() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER portal_invite_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.portal_invite
FOR EACH ROW EXECUTE FUNCTION public._f1001_guard_portal_invite();--> statement-breakpoint
CREATE TRIGGER portal_invite_no_truncate
BEFORE TRUNCATE ON public.portal_invite
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER portal_view_log_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.portal_view_log
FOR EACH ROW EXECUTE FUNCTION public._f1001_guard_portal_view_log();--> statement-breakpoint
CREATE TRIGGER portal_view_log_no_truncate
BEFORE TRUNCATE ON public.portal_view_log
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

ALTER TABLE public.portal_invite ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.portal_invite FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.portal_view_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.portal_view_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.portal_invite
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.portal_view_log
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

REVOKE ALL ON public.portal_invite FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.portal_view_log FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.portal_token_locator FROM PUBLIC;--> statement-breakpoint

DO $f1001_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.portal_invite, '
        'public.portal_view_log, public.portal_token_locator FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._f1001_actor_portal_role(uuid), '
        'public._f1001_actor_can_read_portal(uuid), '
        'public._f1001_actor_can_write_portal(uuid), '
        'public._f1001_guard_portal_invite(), '
        'public._f1001_guard_portal_view_log() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.portal_invite TO app_runtime;
    -- portal_view_log: bewusst KEIN INSERT fuer app_runtime (Review-Fund:
    -- sonst koennte jeder Viewer View-Counts aufblaehen). Einziger Schreiber
    -- ist resolve_portal_public_view (SECURITY DEFINER, laeuft als Owner und
    -- braucht keinen Grant; RLS-Policies greifen weiterhin).
    GRANT SELECT ON public.portal_view_log TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._f1001_actor_portal_role(uuid),
      public._f1001_actor_can_read_portal(uuid),
      public._f1001_actor_can_write_portal(uuid)
      TO app_runtime;
  END IF;
END
$f1001_acl$;--> statement-breakpoint

DO $f1001_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_invite AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._f1001_actor_can_read_portal(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'portal_invite_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_invite AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._f1001_actor_can_write_portal(workspace_id))',
    'portal_invite_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_invite AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._f1001_actor_can_write_portal(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)) '
    'WITH CHECK (public._f1001_actor_can_write_portal(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'portal_invite_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_invite AS RESTRICTIVE FOR DELETE TO %s USING (false)',
    'portal_invite_actor_delete', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_view_log AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._f1001_actor_can_read_portal(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'portal_view_log_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_view_log AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (true)',
    'portal_view_log_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.portal_view_log AS RESTRICTIVE FOR DELETE TO %s USING (false)',
    'portal_view_log_actor_delete', actor_policy_role
  );
END
$f1001_actor_policies$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F10.1: interne Erzeugung (SECURITY DEFINER). Zieht einen bestehenden
-- aktiven Invite atomar zurueck (Grund 'superseded') und legt den neuen an.
-- Validierung (TTL, IDs) laeuft im Contract-Layer VOR dem DB-Call
-- (Fail-fast); die Bereichspruefung hier ist Defense in Depth.
-- Race-Doppel-aktiv -> unique_violation -> 'race_detected' (Conflict, kein
-- 500). Behaelt app.actor_id fuer den Create-Guard bei.
-- Lock-Reihenfolge (Review-Fund, dokumentiert): erst Projekt FOR SHARE, dann
-- Supersede-UPDATE auf der alten Active-Zeile, dann INSERT. FOR SHARE-Locks
-- sind kompatibel; Row-Locks treffen stets dieselbe alte Zeile (serialisiert,
-- kein Zyklus). Withdraw (Modul-UPDATE) haelt nur den Invite-Row-Lock ohne
-- Projekt-Lock -> keine Inversion. Parallele INSERTs entscheidet der
-- partielle Unique-Index (genau ein Gewinner).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.create_portal_invite(
  requested_workspace_id uuid,
  requested_project_id uuid,
  requested_ttl_days integer,
  requested_token_hash bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1001_create_invite$
DECLARE
  actor_id uuid := public.app_actor_id();
  expires_at timestamptz;
  new_id uuid := pg_catalog.gen_random_uuid();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF requested_ttl_days < 1 OR requested_ttl_days > 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_ttl'
    );
  END IF;
  IF pg_catalog.octet_length(requested_token_hash) <> 32 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_binding'
    );
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = requested_project_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE public.portal_invite AS old_invite
     SET status = 'withdrawn',
         withdrawn_at = mutation_time,
         withdrawn_by = actor_id,
         withdraw_reason = 'superseded'
   WHERE old_invite.workspace_id = requested_workspace_id
     AND old_invite.project_id = requested_project_id
     AND old_invite.status = 'active';

  expires_at := mutation_time + (requested_ttl_days * interval '1 day');

  BEGIN
    INSERT INTO public.portal_invite (
      id, workspace_id, project_id, status, token_hash, expires_at, created_by
    ) VALUES (
      new_id, requested_workspace_id, requested_project_id, 'active',
      requested_token_hash, expires_at, actor_id
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'race_detected'
    );
  END;

  INSERT INTO public.portal_token_locator (
    token_hash, workspace_id, portal_invite_id
  ) VALUES (
    requested_token_hash, requested_workspace_id, new_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'active',
    'inviteId', new_id,
    'projectId', requested_project_id,
    'expiresAt', expires_at,
    'replayed', false
  );
END
$f1001_create_invite$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_portal_invite(uuid, uuid, integer, bytea)
  FROM PUBLIC;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F10.1: Token-Resolver (SECURITY DEFINER). Der oeffentliche Portal-Link ist
-- rollenlos und durch das hoch-entropische Token geschuetzt; diese Funktion
-- liefert in EINEM atomaren Call: Lazy-Expire (active->expired, genau einmal
-- 'portal.invite_expired' als System-Event), View-Log-Eintrag,
-- 'portal.viewed'-Event (nur bei aktiver Projektion) und die
-- oeffentliche Projektion (Projektstatus + Dok-Metadaten, KEINE Bytes).
-- Unbekannt/entzogen/abgelaufen -> 'not_found' ohne Unterscheidung
-- (kein Orakel). Dok-Filter: nur Issuances mit 2 Approvals ohne Withdrawal
-- (approved_for_archive_not_issued, Spiegel M2-03b1).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1001_resolve_token$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  project_row public.project%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  expired_count integer := 0;
  view_count integer;
  document_list jsonb;
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT * INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  INSERT INTO public.portal_view_log (
    workspace_id, portal_invite_id
  ) VALUES (
    invite_row.workspace_id, invite_row.id
  );

  IF invite_row.status = 'active'
     AND invite_row.expires_at <= mutation_time THEN
    UPDATE public.portal_invite
       SET status = 'expired'
     WHERE id = invite_row.id AND status = 'active';
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    IF expired_count = 1 THEN
      INSERT INTO public.domain_events (
        workspace_id, aggregate_type, aggregate_id, event_type,
        actor, payload, occurred_at
      ) VALUES (
        invite_row.workspace_id, 'project', invite_row.project_id,
        'portal.invite_expired', 'system',
        pg_catalog.jsonb_build_object(
          'inviteId', invite_row.id,
          'projectId', invite_row.project_id
        ),
        mutation_time
      );
    END IF;
  END IF;

  -- TOCTOU-Schutz (Review-Fund): die obige Kopie kann durch einen parallel
  -- committeten Withdraw ueberholt sein (Expire-UPDATE trifft 0 Zeilen).
  -- Erneut lesen; nur eine frisch bestaetigte 'active'-Zeile projizieren.
  SELECT * INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  IF NOT FOUND OR invite_row.status <> 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO project_row
    FROM public.project
   WHERE workspace_id = invite_row.workspace_id
     AND id = invite_row.project_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    invite_row.workspace_id, 'project', invite_row.project_id,
    'portal.viewed', 'system',
    pg_catalog.jsonb_build_object(
      'inviteId', invite_row.id,
      'projectId', invite_row.project_id
    ),
    mutation_time
  );

  SELECT COALESCE(pg_catalog.jsonb_agg(doc ORDER BY doc->>'issuedAt' DESC), '[]'::jsonb)
    INTO document_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', issuance.id,
        'offerNumber', issuance.offer_number,
        'documentDate', issuance.document_date,
        'issuedAt', (
          SELECT pg_catalog.max(approval.approved_at)
            FROM public.offer_issuance_approval AS approval
           WHERE approval.workspace_id = issuance.workspace_id
             AND approval.issuance_id = issuance.id
        )
      ) AS doc
        FROM public.offer_issuance AS issuance
       WHERE issuance.workspace_id = invite_row.workspace_id
         AND issuance.project_id = invite_row.project_id
         AND (
           SELECT pg_catalog.count(*)
             FROM public.offer_issuance_approval AS approval
            WHERE approval.workspace_id = issuance.workspace_id
              AND approval.issuance_id = issuance.id
         ) = 2
         AND NOT EXISTS (
           SELECT 1
             FROM public.offer_issuance_withdrawal AS withdrawal
            WHERE withdrawal.workspace_id = issuance.workspace_id
              AND withdrawal.issuance_id = issuance.id
         )
    ) AS docs;

  SELECT pg_catalog.count(*) INTO view_count
    FROM public.portal_view_log AS view_record
   WHERE view_record.workspace_id = invite_row.workspace_id
     AND view_record.portal_invite_id = invite_row.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'inviteId', invite_row.id,
    'expiresAt', invite_row.expires_at,
    'viewCount', view_count,
    'project', pg_catalog.jsonb_build_object(
      'id', project_row.id,
      'name', project_row.name,
      'phase', project_row.phase,
      'outcome', project_row.outcome
    ),
    'documents', document_list
  );
END
$f1001_resolve_token$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_portal_public_view(bytea) FROM PUBLIC;--> statement-breakpoint

DO $f1001_public_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.create_portal_invite(
      uuid, uuid, integer, bytea
    ) TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.resolve_portal_public_view(bytea)
      TO app_runtime;
  END IF;
END
$f1001_public_acl$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F10.1 ROLLBACK-DOKUMENTATION (Repo-Konvention: forward-only, keine
-- Down-Migrationen; Umkehrung bei Bedarf manuell in dieser Reihenfolge):
--   DROP FUNCTION public.resolve_portal_public_view(bytea);
--   DROP FUNCTION public.create_portal_invite(uuid, uuid, integer, bytea);
--   DROP POLICY portal_view_log_actor_delete ON public.portal_view_log;
--   DROP POLICY portal_view_log_actor_insert ON public.portal_view_log;
--   DROP POLICY portal_view_log_actor_select ON public.portal_view_log;
--   DROP POLICY portal_invite_actor_delete ON public.portal_invite;
--   DROP POLICY portal_invite_actor_update ON public.portal_invite;
--   DROP POLICY portal_invite_actor_insert ON public.portal_invite;
--   DROP POLICY portal_invite_actor_select ON public.portal_invite;
--   DROP POLICY tenant_isolation ON public.portal_view_log;
--   DROP POLICY tenant_isolation ON public.portal_invite;
--   ALTER TABLE public.portal_view_log NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.portal_view_log DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.portal_invite NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.portal_invite DISABLE ROW LEVEL SECURITY;
--   DROP TRIGGER portal_view_log_no_truncate ON public.portal_view_log;
--   DROP TRIGGER portal_view_log_mutation_guard ON public.portal_view_log;
--   DROP TRIGGER portal_invite_no_truncate ON public.portal_invite;
--   DROP TRIGGER portal_invite_mutation_guard ON public.portal_invite;
--   DROP FUNCTION public._f1001_guard_portal_view_log();
--   DROP FUNCTION public._f1001_guard_portal_invite();
--   DROP FUNCTION public._f1001_actor_can_write_portal(uuid);
--   DROP FUNCTION public._f1001_actor_can_read_portal(uuid);
--   DROP FUNCTION public._f1001_actor_portal_role(uuid);
--   DROP TABLE public.portal_view_log;
--   DROP TABLE public.portal_token_locator;
--   DROP TABLE public.portal_invite;
-- (Verlustfrei fuer Bestand: keine Backfills, keine Bestandsaenderungen.)
-- ═══════════════════════════════════════════════════════════════════════
