CREATE TABLE "project_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"assignment_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_assignment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_assignment_ws_project_membership_uq" UNIQUE("workspace_id","project_id","membership_id"),
	CONSTRAINT "project_assignment_role_ck" CHECK ("project_assignment"."assignment_role" in ('key_account', 'user'))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "assignment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_assignment_one_key_account_uidx" ON "project_assignment" USING btree ("workspace_id","project_id") WHERE assignment_role = 'key_account';--> statement-breakpoint
CREATE INDEX "project_assignment_ws_membership_project_idx" ON "project_assignment" USING btree ("workspace_id","membership_id","project_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_assignment_revision_ck" CHECK ("project"."assignment_revision" >= 0);--> statement-breakpoint

-- Der Actor bleibt die kanonische user_identity.id. Assignments speichern die
-- tenantgebundene membership.id; diese Invoker-Funktion bildet beides unter
-- der bereits erzwungenen Membership-RLS aufeinander ab.
CREATE OR REPLACE FUNCTION public.app_actor_membership_id(
  requested_workspace_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m1_09_actor_membership$
  SELECT membership_record.id
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = public.app_actor_id()
   LIMIT 1
$m1_09_actor_membership$;--> statement-breakpoint

-- `external_only` ist ein negatives Sicherheitsmerkmal. Ein gesetzter Actor
-- ohne sichtbare Membership sowie jedes fehlgeformte JSON werden fail-closed
-- als extern behandelt. Nur Abwesenheit oder das exakte boolean false stehen
-- fuer einen internen Account; ein leerer Actor ist ein technischer Systempfad.
CREATE OR REPLACE FUNCTION public.app_actor_is_external_only(
  requested_workspace_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m1_09_external_only$
DECLARE
  actor_id pg_catalog.uuid := public.app_actor_id();
  actor_capabilities pg_catalog.jsonb;
BEGIN
  IF actor_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT membership_record.capabilities
    INTO actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF pg_catalog.jsonb_typeof(actor_capabilities) <> 'object' THEN
    RETURN true;
  END IF;

  IF NOT actor_capabilities ? 'external_only' THEN
    RETURN false;
  END IF;

  RETURN NOT (
    pg_catalog.jsonb_typeof(actor_capabilities -> 'external_only') = 'boolean'
    AND actor_capabilities ->> 'external_only' = 'false'
  );
END
$m1_09_external_only$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.app_actor_membership_id(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_actor_is_external_only(uuid) FROM PUBLIC;--> statement-breakpoint
DO $m1_09_helper_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.app_actor_membership_id(uuid) TO app_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.app_actor_is_external_only(uuid) TO app_runtime';
  END IF;
END
$m1_09_helper_acl$;--> statement-breakpoint

ALTER TABLE public.project_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_assignment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_assignment
  USING (
    workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );--> statement-breakpoint

-- Externe Accounts sehen ausschliesslich ihre eigenen direkten Zuweisungen.
-- Die Projekt-Policy unten setzt zusaetzlich request/open voraus.
-- Die Single-Role-Testdatenbank besitzt bewusst keine Produktionsrollen. Dort
-- gelten dieselben Policies fuer PUBLIC; im strikten Rollenmodell dagegen nur
-- fuer app_runtime. Worker/System bleiben dadurch von Actor-Abhaengigkeiten
-- frei und erhalten weder Assignment- noch Helper-Rechte.
DO $m1_09_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_assignment_actor_select
      ON public.project_assignment
      AS RESTRICTIVE FOR SELECT TO %s
      USING (
        NOT public.app_actor_is_external_only(workspace_id)
        OR (
          membership_id = public.app_actor_membership_id(workspace_id)
          AND assignment_role IN ('key_account', 'user')
        )
      )
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_assignment_actor_insert_guard
      ON public.project_assignment
      AS RESTRICTIVE FOR INSERT TO %s
      WITH CHECK (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_assignment_actor_update_guard
      ON public.project_assignment
      AS RESTRICTIVE FOR UPDATE TO %s
      USING (NOT public.app_actor_is_external_only(workspace_id))
      WITH CHECK (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_assignment_actor_delete_guard
      ON public.project_assignment
      AS RESTRICTIVE FOR DELETE TO %s
      USING (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);

  -- Die bestehende permissive Project-Tenant-Policy bleibt die einzige
  -- permissive Policy. Diese Actor-Policies werden mit ihr per AND verknuepft.
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_external_select_scope
      ON public.project
      AS RESTRICTIVE FOR SELECT TO %s
      USING (
        NOT public.app_actor_is_external_only(workspace_id)
        OR (
          phase = 'request'
          AND outcome = 'open'
          AND EXISTS (
            SELECT 1
              FROM public.project_assignment AS assignment_record
             WHERE assignment_record.workspace_id = project.workspace_id
               AND assignment_record.project_id = project.id
               AND assignment_record.membership_id = public.app_actor_membership_id(project.workspace_id)
               AND assignment_record.assignment_role IN ('key_account', 'user')
          )
        )
      )
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_external_insert_guard
      ON public.project
      AS RESTRICTIVE FOR INSERT TO %s
      WITH CHECK (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_external_update_guard
      ON public.project
      AS RESTRICTIVE FOR UPDATE TO %s
      USING (NOT public.app_actor_is_external_only(workspace_id))
      WITH CHECK (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);
  EXECUTE pg_catalog.format($policy$
    CREATE POLICY project_external_delete_guard
      ON public.project
      AS RESTRICTIVE FOR DELETE TO %s
      USING (NOT public.app_actor_is_external_only(workspace_id))
  $policy$, actor_policy_role);
END
$m1_09_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.project_assignment FROM PUBLIC;--> statement-breakpoint
DO $m1_09_table_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_assignment TO app_runtime';
  END IF;
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.project_assignment FROM app_worker';
  END IF;
END
$m1_09_table_acl$;
