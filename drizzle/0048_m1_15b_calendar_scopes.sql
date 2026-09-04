CREATE TABLE "calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"category_id" uuid,
	"calendar_type" text NOT NULL,
	"membership_id" uuid,
	"team_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "calendar_type_ck" CHECK ("calendar"."calendar_type" in ('team', 'tenancy', 'user', 'client')),
	CONSTRAINT "calendar_name_ck" CHECK (length(btrim("calendar"."name")) between 1 and 200
        and "calendar"."name" = normalize("calendar"."name", NFKC)
        and "calendar"."name" !~ '[\u0000-\u001F\u007F]'),
	CONSTRAINT "calendar_color_ck" CHECK ("calendar"."color" is null or "calendar"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "calendar_scope_user_ck" CHECK ("calendar"."calendar_type" <> 'user'
        or ("calendar"."membership_id" is not null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_scope_team_ck" CHECK ("calendar"."calendar_type" <> 'team'
        or ("calendar"."team_id" is not null and "calendar"."membership_id" is null)),
	CONSTRAINT "calendar_scope_tenancy_ck" CHECK ("calendar"."calendar_type" <> 'tenancy'
        or ("calendar"."membership_id" is null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_scope_client_ck" CHECK ("calendar"."calendar_type" <> 'client'
        or ("calendar"."membership_id" is null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_revision_ck" CHECK ("calendar"."revision" between 1 and 2147483647),
	CONSTRAINT "calendar_timestamps_ck" CHECK ("calendar"."updated_at" >= "calendar"."created_at"
        and isfinite("calendar"."created_at")
        and isfinite("calendar"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."calendar_category"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_ws_name_uq" ON "calendar" USING btree ("workspace_id",lower(btrim("calendar"."name")));--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_ws_membership_user_uniq" ON "calendar" USING btree ("workspace_id","membership_id") WHERE "calendar_type" = 'user';--> statement-breakpoint
CREATE INDEX "calendar_ws_type_active_idx" ON "calendar" USING btree ("workspace_id","calendar_type","active","name","id");--> statement-breakpoint
CREATE INDEX "calendar_ws_membership_idx" ON "calendar" USING btree ("workspace_id","membership_id");--> statement-breakpoint
CREATE INDEX "calendar_ws_team_idx" ON "calendar" USING btree ("workspace_id","team_id");

-- ═══════════════════════════════════════════════════════════════════════
-- Backfill (Spec §4.2, DEC-M115B-14/16): genau EIN persönlicher Kalender je
-- Membership („Persönlich — <E-Mail>"), dann Bestands-Termine an den
-- persönlichen Kalender ihres created_by binden; appointment.category_id
-- entfällt (ACCEPTED_EXCEPTION: leerer Kategorie-Bestand in 0043).
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO "calendar" (
  "id", "workspace_id", "name", "calendar_type", "membership_id",
  "active", "revision", "created_by"
)
SELECT gen_random_uuid(), membership_record.workspace_id,
       'Persönlich — ' || identity_record.email, 'user',
       membership_record.id, true, 1, membership_record.user_id
  FROM public.membership AS membership_record
  JOIN public.user_identity AS identity_record
    ON identity_record.id = membership_record.user_id
 WHERE membership_record.role IN ('viewer', 'editor', 'admin')
   AND pg_catalog.jsonb_typeof(membership_record.capabilities) = 'object'
   AND NOT EXISTS (
     membership_record.capabilities ? 'external_only'
     AND membership_record.capabilities->'external_only'
       IS DISTINCT FROM 'false'::jsonb
   )
 ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "project_appointment" ADD COLUMN "calendar_id" uuid;--> statement-breakpoint
UPDATE "project_appointment" AS appointment_record
   SET "calendar_id" = personal_calendar."id"
  FROM public.membership AS membership_record
  JOIN "calendar" AS personal_calendar
    ON personal_calendar.workspace_id = membership_record.workspace_id
   AND personal_calendar.membership_id = membership_record.id
   AND personal_calendar.calendar_type = 'user'
 WHERE membership_record.workspace_id = appointment_record.workspace_id
   AND membership_record.user_id = appointment_record.created_by;
--> statement-breakpoint
-- Restbestand (kein persönlicher Kalender auffindbar) → Unternehmenskalender
-- „Unternehmen" je Workspace (angelegt falls nötig).
INSERT INTO "calendar" (
  "id", "workspace_id", "name", "calendar_type", "active", "revision", "created_by"
)
SELECT gen_random_uuid(), workspace_record.id, 'Unternehmen', 'tenancy',
       true, 1, workspace_record.id
  FROM public.workspace AS workspace_record
 WHERE EXISTS (
   SELECT 1 FROM public.project_appointment AS appointment_record
    WHERE appointment_record.workspace_id = workspace_record.id
      AND appointment_record.calendar_id IS NULL
 )
 ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "project_appointment" AS appointment_record
   SET "calendar_id" = tenancy_calendar."id"
  FROM "calendar" AS tenancy_calendar
 WHERE appointment_record.calendar_id IS NULL
   AND tenancy_calendar.workspace_id = appointment_record.workspace_id
   AND tenancy_calendar.calendar_type = 'tenancy'
   AND tenancy_calendar.name = 'Unternehmen';
--> statement-breakpoint
ALTER TABLE "project_appointment" ALTER COLUMN "calendar_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_calendar_fk" FOREIGN KEY ("workspace_id","calendar_id") REFERENCES "public"."calendar"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment" DROP CONSTRAINT "project_appointment_category_fk";--> statement-breakpoint
ALTER TABLE "project_appointment" DROP COLUMN "category_id";--> statement-breakpoint
DROP INDEX "project_appointment_ws_category_idx";--> statement-breakpoint
CREATE INDEX "project_appointment_ws_calendar_range_idx" ON "project_appointment" USING btree ("workspace_id","calendar_id","start_at","end_at","id");

-- ═══════════════════════════════════════════════════════════════════════
-- M1-15b: Calendar-Actor-Helfer (Muster M1-15 _m115_*).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m115b_actor_calendar_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115b_actor_role$
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
$m115b_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m115b_actor_can_read_calendars(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115b_actor_read$
  SELECT COALESCE(
    public._m115b_actor_calendar_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m115b_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m115b_actor_can_write_calendars(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115b_actor_write$
  SELECT COALESCE(
    public._m115b_actor_calendar_role(requested_workspace_id) = 'admin',
    false
  )
$m115b_actor_write$;--> statement-breakpoint

-- Scope-Sichtbarkeit je Zeile (Spec §7): tenancy → alle internen Rollen;
-- user → Owner oder Admin; team → Admin (Teams fehlen strukturell);
-- client → niemand (default deny).
CREATE FUNCTION public._m115b_actor_can_read_calendar(
  requested_workspace_id uuid,
  calendar_type text,
  calendar_membership_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m115b_actor_can_read_calendar$
DECLARE
  actor_id uuid;
  actor_role text;
BEGIN
  actor_role := public._m115b_actor_calendar_role(requested_workspace_id);
  IF actor_role IS NULL THEN
    RETURN false;
  END IF;
  IF calendar_type = 'tenancy' THEN
    RETURN true;
  END IF;
  IF calendar_type = 'user' THEN
    IF actor_role = 'admin' THEN
      RETURN true;
    END IF;
    actor_id := public.app_actor_id();
    RETURN EXISTS (
      SELECT 1
        FROM public.membership AS membership_record
       WHERE membership_record.workspace_id = requested_workspace_id
         AND membership_record.user_id = actor_id
         AND membership_record.id = calendar_membership_id
    );
  END IF;
  -- team: Mitgliedschafts-Transitivität folgt mit dem Team-Slice; bis dahin
  -- sieht nur der Admin Team-Kalender. client: default deny.
  IF calendar_type = 'team' AND actor_role = 'admin' THEN
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END
$m115b_actor_can_read_calendar$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-15b: RLS-Vertrag (Muster 0043/0045).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.calendar ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.calendar
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

DO $m115b_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.calendar AS RESTRICTIVE FOR SELECT TO %s '
    -- active-Filter bewusst NICHT in der Policy: archivierte Kalender bleiben
    -- lesbar (bestehende Termine, Admin-Verwaltung); die Auswahl blendet sie
    -- im Service aus (Spec §5).
    'USING (public._m115b_actor_can_read_calendar(workspace_id, calendar_type, membership_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'calendar_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.calendar AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m115b_actor_can_write_calendars(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'calendar_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.calendar AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m115b_actor_can_write_calendars(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'calendar_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.calendar AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'calendar_actor_delete', actor_policy_role
  );
END
$m115b_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER calendar_no_truncate
BEFORE TRUNCATE ON public.calendar
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
-- ACL-Vertrag (REVOKE ALL + GRANT SELECT/INSERT/UPDATE an app_runtime, kein
-- DELETE; EXECUTE nur fuer die _m115b-Routinen) wird idempotent von
-- scripts/db-role-contract.mts (applyRoleContract) angewendet und von der
-- Live-Rollenprobe verifiziert (Muster 0045/0047).
