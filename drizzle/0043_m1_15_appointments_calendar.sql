CREATE TABLE "calendar_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_category_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "calendar_category_name_ck" CHECK (length(btrim("calendar_category"."name")) between 1 and 200
          and "calendar_category"."name" = normalize("calendar_category"."name", NFKC)
          and "calendar_category"."name" !~ '[[:cntrl:]]'
          and "calendar_category"."name" !~ '(^[[:space:]])|([[:space:]]$)'),
	CONSTRAINT "calendar_category_order_ck" CHECK ("calendar_category"."order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"appointment_type" text NOT NULL,
	"category_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_appointment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_appointment_title_ck" CHECK (length(btrim("project_appointment"."title")) between 1 and 2000),
	CONSTRAINT "project_appointment_description_ck" CHECK ("project_appointment"."description" is null or length(btrim("project_appointment"."description")) between 1 and 5000),
	CONSTRAINT "project_appointment_location_ck" CHECK ("project_appointment"."location" is null or length(btrim("project_appointment"."location")) between 1 and 2000),
	CONSTRAINT "project_appointment_type_ck" CHECK ("project_appointment"."appointment_type" in ('on_site', 'phone', 'installation', 'maintenance', 'consultation', 'other')),
	CONSTRAINT "project_appointment_window_ck" CHECK ("project_appointment"."end_at" > "project_appointment"."start_at"
          and (not "project_appointment"."all_day"
               or ("project_appointment"."end_at" at time zone 'Europe/Berlin')::date
                  >= ("project_appointment"."start_at" at time zone 'Europe/Berlin')::date + 1)
          and isfinite("project_appointment"."start_at")
          and isfinite("project_appointment"."end_at")),
	CONSTRAINT "project_appointment_revision_ck" CHECK ("project_appointment"."revision" between 1 and 2147483647),
	CONSTRAINT "project_appointment_timestamps_ck" CHECK ("project_appointment"."updated_at" >= "project_appointment"."created_at"
          and isfinite("project_appointment"."created_at")
          and isfinite("project_appointment"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "project_appointment_attendee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_appointment_attendee_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_appointment_attendee_ws_appt_membership_uq" UNIQUE("workspace_id","appointment_id","membership_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_category" ADD CONSTRAINT "calendar_category_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."calendar_category"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment_attendee" ADD CONSTRAINT "project_appointment_attendee_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment_attendee" ADD CONSTRAINT "project_appointment_attendee_appointment_fk" FOREIGN KEY ("workspace_id","appointment_id") REFERENCES "public"."project_appointment"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment_attendee" ADD CONSTRAINT "project_appointment_attendee_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_category_ws_name_uq" ON "calendar_category" USING btree ("workspace_id",lower(btrim("name")));--> statement-breakpoint
CREATE INDEX "project_appointment_ws_project_range_idx" ON "project_appointment" USING btree ("workspace_id","project_id","start_at","end_at","id");--> statement-breakpoint
CREATE INDEX "project_appointment_ws_project_start_idx" ON "project_appointment" USING btree ("workspace_id","project_id","start_at" DESC NULLS FIRST,"id");--> statement-breakpoint
CREATE INDEX "project_appointment_ws_category_idx" ON "project_appointment" USING btree ("workspace_id","category_id");--> statement-breakpoint
CREATE INDEX "project_appointment_attendee_ws_membership_appt_idx" ON "project_appointment_attendee" USING btree ("workspace_id","membership_id","appointment_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-15: Termine- und Kalender-Actor-Helfer (Muster M1-13 _m113_actor_note_role).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m115_actor_appointment_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115_actor_role$
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
$m115_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m115_actor_can_read_appointments(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115_actor_read$
  SELECT COALESCE(
    public._m115_actor_appointment_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m115_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m115_actor_can_write_appointments(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115_actor_write$
  SELECT COALESCE(
    public._m115_actor_appointment_role(requested_workspace_id)
      IN ('editor', 'admin'),
    false
  )
$m115_actor_write$;--> statement-breakpoint

CREATE FUNCTION public._m115_erasure_delete_allowed(
  row_workspace_id uuid,
  row_appointment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115_erasure_allowed$
DECLARE
  erasure_operation uuid;
BEGIN
  BEGIN
    erasure_operation := NULLIF(
      pg_catalog.current_setting('app.erasure_operation_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  IF erasure_operation IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = row_workspace_id
       AND tombstone.graph_ids->'appointmentIds' ? row_appointment_id::text
  ), false);
END
$m115_erasure_allowed$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m115_actor_appointment_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m115_actor_can_read_appointments(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m115_actor_can_write_appointments(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m115_erasure_delete_allowed(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public._m115_guard_project_appointment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m115_appointment_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF actor_id IS NULL AND CURRENT_USER = 'app_owner' THEN
      IF public._m115_erasure_delete_allowed(OLD.workspace_id, OLD.id) THEN
        RETURN OLD;
      END IF;
    END IF;
    IF NOT public._m115_actor_can_write_appointments(OLD.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'project_appointment DELETE verlangt Editor/Admin oder Erasure'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT public._m115_actor_can_write_appointments(NEW.workspace_id)
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project_appointment verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_appointment Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
      JOIN public.contact AS contact_record
        ON contact_record.workspace_id = project_record.workspace_id
       AND contact_record.id = project_record.contact_id
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
       AND contact_record.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_appointment Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> 1
       OR NEW.created_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_appointment Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'project_appointment immutable Bindung oder Revision verletzt'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m115_appointment_guard$;--> statement-breakpoint

CREATE FUNCTION public._m115_guard_project_appointment_attendee()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m115_attendee_guard$
DECLARE
  row_workspace_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  row_appointment_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.appointment_id ELSE NEW.appointment_id END;
  actor_id uuid := public.app_actor_id();
  target_role text;
  target_capabilities jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF actor_id IS NULL AND CURRENT_USER = 'app_owner' THEN
      IF public._m115_erasure_delete_allowed(row_workspace_id, row_appointment_id) THEN
        RETURN OLD;
      END IF;
    END IF;
    IF NOT public._m115_actor_can_write_appointments(row_workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'project_appointment_attendee DELETE verlangt Editor/Admin oder Erasure'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'project_appointment_attendee UPDATE ist verboten'
      USING ERRCODE = '23514';
  END IF;

  IF actor_id IS NULL
     OR NOT public._m115_actor_can_write_appointments(row_workspace_id) THEN
    RAISE EXCEPTION 'project_appointment_attendee verlangt internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.project_appointment AS appointment_record
   WHERE appointment_record.workspace_id = NEW.workspace_id
     AND appointment_record.id = NEW.appointment_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_appointment_attendee Appointment-Bindung fehlt'
      USING ERRCODE = '23514';
  END IF;

  SELECT membership_record.role, membership_record.capabilities
    INTO target_role, target_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = NEW.workspace_id
     AND membership_record.id = NEW.membership_id
   LIMIT 1;
  IF NOT FOUND
     OR target_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(target_capabilities) <> 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(target_capabilities) AS capability(key, value)
        WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
     )
     OR (
       target_capabilities ? 'external_only'
       AND target_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RAISE EXCEPTION 'project_appointment_attendee muss eine interne Membership sein'
      USING ERRCODE = '23514';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM public.project_appointment_attendee AS attendee
     WHERE attendee.workspace_id = NEW.workspace_id
       AND attendee.appointment_id = NEW.appointment_id
  ) >= 100 THEN
    RAISE EXCEPTION 'project_appointment erlaubt hoechstens 100 Teilnehmer'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := pg_catalog.statement_timestamp();
  RETURN NEW;
END
$m115_attendee_guard$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m115_guard_project_appointment() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m115_guard_project_appointment_attendee() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER project_appointment_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_appointment
FOR EACH ROW EXECUTE FUNCTION public._m115_guard_project_appointment();--> statement-breakpoint
CREATE TRIGGER project_appointment_no_truncate
BEFORE TRUNCATE ON public.project_appointment
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_appointment_attendee_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_appointment_attendee
FOR EACH ROW EXECUTE FUNCTION public._m115_guard_project_appointment_attendee();--> statement-breakpoint
CREATE TRIGGER project_appointment_attendee_no_truncate
BEFORE TRUNCATE ON public.project_appointment_attendee
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER calendar_category_no_truncate
BEFORE TRUNCATE ON public.calendar_category
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint

ALTER TABLE public.calendar_category ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar_category FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_appointment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_appointment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_appointment_attendee ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_appointment_attendee FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.calendar_category
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_appointment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_appointment_attendee
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

DO $m115_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.calendar_category AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m115_actor_can_read_appointments(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'calendar_category_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m115_actor_can_read_appointments(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'project_appointment_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m115_actor_can_write_appointments(workspace_id))',
    'project_appointment_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m115_actor_can_write_appointments(workspace_id)) '
    'WITH CHECK (public._m115_actor_can_write_appointments(workspace_id))',
    'project_appointment_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment AS RESTRICTIVE FOR DELETE TO %s '
    'USING (public._m115_actor_can_write_appointments(workspace_id))',
    'project_appointment_actor_delete', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment_attendee AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m115_actor_can_read_appointments(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'project_appointment_attendee_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment_attendee AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m115_actor_can_write_appointments(workspace_id))',
    'project_appointment_attendee_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_appointment_attendee AS RESTRICTIVE FOR DELETE TO %s '
    'USING (public._m115_actor_can_write_appointments(workspace_id))',
    'project_appointment_attendee_actor_delete', actor_policy_role
  );
END
$m115_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.calendar_category FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.project_appointment FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.project_appointment_attendee FROM PUBLIC;
--> statement-breakpoint

DO $m115_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.calendar_category, '
        'public.project_appointment, public.project_appointment_attendee FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m115_actor_appointment_role(uuid), '
        'public._m115_actor_can_read_appointments(uuid), '
        'public._m115_actor_can_write_appointments(uuid), '
        'public._m115_erasure_delete_allowed(uuid,uuid), '
        'public._m115_guard_project_appointment(), '
        'public._m115_guard_project_appointment_attendee() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT ON public.calendar_category TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_appointment TO app_runtime;
    GRANT SELECT, INSERT, DELETE ON public.project_appointment_attendee TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m115_actor_appointment_role(uuid),
      public._m115_actor_can_read_appointments(uuid),
      public._m115_actor_can_write_appointments(uuid)
      TO app_runtime;
  END IF;
END
$m115_acl$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-15: Erasure-Graph-Erweiterung um appointmentIds (quellgepinnt).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m115_tombstone_worm$
DECLARE
  graph_key text;
  required_keys constant text[] := ARRAY[
    'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
    'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds',
    'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
    'offerVariantSectionIds', 'offerBomLineIds'
  ]::text[];
  optional_keys constant text[] := ARRAY[
    'offerPdfDraftIds', 'offerRecipientIds', 'offerRecipientRevisionIds',
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds',
    'offerIssuanceIds', 'offerIssuanceApprovalIds',
    'offerIssuanceWithdrawalIds', 'taskIds', 'noteIds', 'appointmentIds'
  ]::text[];
  allowed_keys constant text[] := required_keys || optional_keys;
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
    CONTINUE WHEN graph_key = ANY(optional_keys)
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
$m115_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m115;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.build_inactive_lead_erasure_graph_m115(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m115_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m115(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN appointment_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object('appointmentIds', appointment_graph.ids)
            END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(
          appointment_record.id::text ORDER BY appointment_record.id
        ),
        '[]'::jsonb
      ) AS ids
        FROM public.project_appointment AS appointment_record
        JOIN public.project AS project_record
          ON project_record.workspace_id = appointment_record.workspace_id
         AND project_record.id = appointment_record.project_id
       WHERE appointment_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS appointment_graph
$m115_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

-- Die aktuelle 0041-Funktion wird ausschliesslich bei exakt gepinntem prosrc
-- und drei exakten Ankern erweitert.
DO $m115_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_replay_graph constant text := $m115_old_replay_graph$      'taskIds', COALESCE(graph_document->'taskIds', '[]'::jsonb),
      'noteIds', COALESCE(graph_document->'noteIds', '[]'::jsonb)
    );$m115_old_replay_graph$;
  new_replay_graph constant text := $m115_new_replay_graph$      'taskIds', COALESCE(graph_document->'taskIds', '[]'::jsonb),
      'noteIds', COALESCE(graph_document->'noteIds', '[]'::jsonb),
      'appointmentIds', COALESCE(graph_document->'appointmentIds', '[]'::jsonb)
    );$m115_new_replay_graph$;
  old_lock constant text := $m115_old_lock$  PERFORM 1 FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY note_record.id FOR UPDATE;
  PERFORM 1 FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY task_record.id FOR UPDATE;$m115_old_lock$;
  new_lock constant text := $m115_new_lock$  PERFORM 1 FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY note_record.id FOR UPDATE;
  PERFORM 1 FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY task_record.id FOR UPDATE;
  PERFORM 1 FROM public.project_appointment AS appointment_record
   WHERE appointment_record.workspace_id = requested_workspace_id
     AND appointment_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'appointmentIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY appointment_record.id FOR UPDATE;$m115_new_lock$;
  old_delete constant text := $m115_old_delete$  DELETE FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     );
  DELETE FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     );$m115_old_delete$;
  new_delete constant text := $m115_new_delete$  DELETE FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     );
  DELETE FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     );
  DELETE FROM public.project_appointment AS appointment_record
   WHERE appointment_record.workspace_id = requested_workspace_id
     AND appointment_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'appointmentIds', '[]'::jsonb)
       ) AS value
     );$m115_new_delete$;
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
    RAISE EXCEPTION 'M1-15 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '891d9914094e8b0b9b42716813dd957f24301a048b95b91049e4d0f8029da3bb' THEN
    RAISE EXCEPTION 'M1-15 Erasure: unerwarteter M1-13-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_replay_graph) = 0
     OR pg_catalog.strpos(erase_source, old_lock) = 0
     OR pg_catalog.strpos(erase_source, old_delete) = 0 THEN
    RAISE EXCEPTION 'M1-15 Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_replay_graph, new_replay_graph
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_lock, new_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_delete, new_delete
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
$m115_erasure_upgrade$;--> statement-breakpoint

DO $m115_erasure_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m115(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m115_erasure_acl$;


