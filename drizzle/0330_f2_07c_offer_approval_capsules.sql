CREATE FUNCTION public.read_offer_approval_ledger(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_issuance_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  issuance_id uuid,
  approved_at timestamptz,
  has_zero_tax_treatment boolean,
  approval_version text,
  recipient_and_scope_reviewed boolean,
  commercial_totals_reviewed boolean,
  legal_profile_reviewed boolean,
  final_pdf_for_archive_understood boolean,
  zero_tax_treatment_reviewed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $f207c_approval_ledger$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer approval context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT approval.workspace_id,
         approval.issuance_id,
         approval.approved_at,
         approval.has_zero_tax_treatment,
         approval.approval_version,
         approval.recipient_and_scope_reviewed,
         approval.commercial_totals_reviewed,
         approval.legal_profile_reviewed,
         approval.final_pdf_for_archive_understood,
         approval.zero_tax_treatment_reviewed
    FROM public.offer_issuance_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.offer_id = requested_offer_id
     AND (requested_issuance_id IS NULL OR approval.issuance_id = requested_issuance_id);
END
$f207c_approval_ledger$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_approval_ledger(uuid, uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.read_offer_candidate_history(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_candidate_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  candidate_id uuid,
  variant_revision integer,
  profile_revision integer,
  recipient_revision integer,
  has_zero_tax_treatment boolean,
  approved_at timestamptz,
  recipient_billing_reviewed boolean,
  commercial_content_reviewed boolean,
  active_profile_reviewed boolean,
  not_issued_status_understood boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $f207c_candidate_history$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer approval context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT approval.workspace_id,
         approval.candidate_id,
         approval.variant_revision,
         approval.profile_revision,
         approval.recipient_revision,
         approval.has_zero_tax_treatment,
         approval.approved_at,
         approval.recipient_billing_reviewed,
         approval.commercial_content_reviewed,
         approval.active_profile_reviewed,
         approval.not_issued_status_understood
    FROM public.offer_release_candidate_approval AS approval
   WHERE approval.workspace_id = requested_workspace_id
     AND approval.offer_id = requested_offer_id
     AND (requested_candidate_id IS NULL OR approval.candidate_id = requested_candidate_id);
END
$f207c_candidate_history$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_candidate_history(uuid, uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.read_offer_withdraw_history(
  requested_workspace_id uuid,
  requested_offer_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  issuance_id uuid,
  reason_code text,
  withdrawn_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $f207c_withdraw_history$
DECLARE
  context_workspace_id uuid;
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
    actor_id := public.app_actor_id();
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'offer approval context is invalid' USING ERRCODE = '42501';
  END;
  IF requested_workspace_id IS NULL
     OR requested_offer_id IS NULL
     OR context_workspace_id IS DISTINCT FROM requested_workspace_id
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id;
  IF actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability
        WHERE pg_catalog.jsonb_typeof(capability.value) IS DISTINCT FROM 'boolean'
     )
     OR (actor_capabilities ? 'external_only'
         AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'offer approval context is not authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT withdrawal.workspace_id,
         withdrawal.issuance_id,
         withdrawal.reason_code,
         withdrawal.withdrawn_at
    FROM public.offer_issuance_withdrawal AS withdrawal
   WHERE withdrawal.workspace_id = requested_workspace_id
     AND withdrawal.offer_id = requested_offer_id;
END
$f207c_withdraw_history$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_offer_withdraw_history(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

DO $f207c_function_acl$
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
        'public.read_offer_approval_ledger(uuid,uuid,uuid), '
        'public.read_offer_candidate_history(uuid,uuid,uuid), '
        'public.read_offer_withdraw_history(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public.read_offer_approval_ledger(uuid, uuid, uuid),
      public.read_offer_candidate_history(uuid, uuid, uuid),
      public.read_offer_withdraw_history(uuid, uuid)
    TO app_runtime;
  END IF;
END
$f207c_function_acl$;--> statement-breakpoint
