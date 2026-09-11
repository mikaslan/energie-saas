-- ═══════════════════════════════════════════════════════════════════════
-- F10-05 Portal-Statusmapping (Installation-Umfang): kundenlesbare
-- Bezeichnung je Installationsstand, Resolver projiziert Overrides als
-- installation.statusLabels (Muster 0109). Reine Leseprojektion des
-- DEFINER-Resolvers; Schreibrechte installation.read/write im Service.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "portal_status_label" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"source_key" text NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_status_label_scope_ck" CHECK ("portal_status_label"."scope" = 'installation'),
	CONSTRAINT "portal_status_label_key_ck" CHECK ("portal_status_label"."source_key" in ('active', 'completed', 'handover')),
	CONSTRAINT "portal_status_label_label_ck" CHECK ("portal_status_label"."label" = pg_catalog.btrim("portal_status_label"."label") and pg_catalog.length("portal_status_label"."label") between 1 and 80 and "portal_status_label"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "portal_status_label_timestamps_ck" CHECK ("portal_status_label"."updated_at" >= "portal_status_label"."created_at" and pg_catalog.isfinite("portal_status_label"."created_at") and pg_catalog.isfinite("portal_status_label"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "portal_status_label" ADD CONSTRAINT "portal_status_label_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_status_label_ws_id_uq" ON "portal_status_label" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_status_label_ws_scope_key_uq" ON "portal_status_label" USING btree ("workspace_id","scope","source_key");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F10-05: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: installation.read/installation.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.portal_status_label ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.portal_status_label FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.portal_status_label
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
DO $f1013_replace_resolver$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app = 'app_owner' THEN
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
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
  portal_project_scope text;
  file_request_list jsonb;
  subsidy_entry jsonb;
  service_case_list jsonb;
  grid_entry jsonb;
  status_label_map jsonb;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  expired_count integer := 0;
  view_count integer;
  document_list jsonb;
  appointment_list jsonb;
  installation_entry jsonb;
  installation_timeline jsonb;
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
  -- F10-03c: Bereich des Projekt-Boards (fail-closed: fehlendes Board
  -- bricht den Resolve ueber den strikten Contract ab, kein Fallback).
  SELECT board.scope INTO portal_project_scope
    FROM public.kanban_board AS board
   WHERE board.workspace_id = invite_row.workspace_id
     AND board.id = project_row.kanban_board_id;

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
        ),
        'signatureStatus', COALESCE(sig.status, 'none'),
        'signedAt', sig.signed_at
      ) AS doc
        FROM public.offer_issuance AS issuance
        LEFT JOIN public.signature_request AS sig
          ON sig.workspace_id = issuance.workspace_id
         AND sig.issuance_id = issuance.id
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

  -- F10.2 Slice A: Projektermine ohne Freitext-Beschreibung (Privacy:
  -- description ist intern und wird nie projiziert).
  SELECT COALESCE(pg_catalog.jsonb_agg(app), '[]'::jsonb)
    INTO appointment_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', appointment.id,
        'title', appointment.title,
        'startAt', appointment.start_at,
        'endAt', appointment.end_at,
        'allDay', appointment.all_day,
        'appointmentType', appointment.appointment_type,
        'location', appointment.location
      ) AS app
        FROM public.project_appointment AS appointment
       WHERE appointment.workspace_id = invite_row.workspace_id
         AND appointment.project_id = invite_row.project_id
       ORDER BY appointment.start_at, appointment.id
    ) AS apps;

  -- F10-03: genau eine Installationszeile je Projekt (UNIQUE) oder NULL.
  -- Nur Stand + Daten, nie Namen/Notizen/Referenzen.
  SELECT pg_catalog.jsonb_build_object(
           'status', installation.status,
           'completedAt', installation.completed_at,
           'handoverAt', installation.handover_at
         )
    INTO installation_entry
    FROM public.installation AS installation
   WHERE installation.workspace_id = invite_row.workspace_id
     AND installation.project_id = invite_row.project_id;

  -- F10-03b: oeffentliche Status-Timeline (nur Typ + Zeit, nie Payloads/
  -- Akteure; lead_installer_assigned bleibt intern — Membership-PII).
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'type', timeline_row.type,
               'at', timeline_row.at,
               'day', timeline_row.day
             )
             ORDER BY timeline_row.at, timeline_row.type
           ),
           '[]'::jsonb
         )
    INTO installation_timeline
    FROM (
      SELECT CASE domain_event.event_type
               WHEN 'installation.created' THEN 'created'
               WHEN 'installation.completed' THEN 'completed'
               WHEN 'installation.handover_recorded' THEN 'handover_recorded'
             END AS type,
             domain_event.occurred_at AS at,
             (domain_event.occurred_at AT TIME ZONE 'Europe/Berlin')::date::text AS day
        FROM public.domain_events AS domain_event
        JOIN public.installation AS installation
          ON installation.workspace_id = domain_event.workspace_id
         AND installation.id = domain_event.aggregate_id
       WHERE domain_event.workspace_id = invite_row.workspace_id
         AND domain_event.aggregate_type = 'installation'
         AND domain_event.event_type IN (
               'installation.created',
               'installation.completed',
               'installation.handover_recorded'
             )
         AND installation.project_id = invite_row.project_id
    ) AS timeline_row;

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'timeline', installation_timeline
    );
  END IF;

  -- F10-05: Admin-Statusmapping (Installation-Umfang; nur Labels, nie
  -- interne Schluessel; ungemappt = leeres Objekt, TS-Defaults greifen).
  SELECT pg_catalog.jsonb_object_agg(label_row.source_key, label_row.label)
    INTO status_label_map
    FROM public.portal_status_label AS label_row
   WHERE label_row.workspace_id = invite_row.workspace_id
     AND label_row.scope = 'installation';

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'statusLabels', COALESCE(status_label_map, '{}'::jsonb)
    );
  END IF;

  -- F10-04: offene + hochgeladene Datei-Anfragen (Titel/Beschreibung/
  -- Stand, nie Storage-Key/Pruefsumme — rein interne Belegdaten).
  SELECT COALESCE(pg_catalog.jsonb_agg(req), '[]'::jsonb)
    INTO file_request_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', freq.id,
        'title', freq.title,
        'description', freq.description,
        'status', freq.status,
        'createdAt', freq.created_at,
        'uploadedAt', freq.uploaded_at,
        'originalFilename', freq.original_filename
      ) AS req
        FROM public.file_request AS freq
       WHERE freq.workspace_id = invite_row.workspace_id
         AND freq.project_id = invite_row.project_id
         AND freq.status IN ('offen', 'hochgeladen')
       ORDER BY freq.created_at, freq.id
    ) AS reqs;

  -- F13-04: Foerderakte des Invite-Projekts (Stand/Programm/Daten;
  -- nie BzA-Nummer — rein interne Referenz).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', scase.status,
      'program', scase.program,
      'bzaSubmittedAt', scase.bza_submitted_at,
      'bzaApprovedAt', scase.bza_approved_at,
      'bndSubmittedAt', scase.bnd_submitted_at,
      'completedAt', scase.completed_at
    )
      FROM public.subsidy_case AS scase
     WHERE scase.workspace_id = invite_row.workspace_id
       AND scase.project_id = invite_row.project_id
  ) INTO subsidy_entry;

  -- F13-06: Servicevorgaenge des Invite-Projekts (Titel/Stand/Zeiten/
  -- Bestaetigung; nie description — Freitext bleibt intern; cancelled
  -- bleibt ohne Kundenhandlungsbedarf intern).
  SELECT COALESCE(pg_catalog.jsonb_agg(svc), '[]'::jsonb)
    INTO service_case_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', svc_case.id,
        'title', svc_case.title,
        'status', svc_case.status,
        'dueDate', svc_case.due_date,
        'completedAt', svc_case.completed_at,
        'confirmedAt', svc_case.confirmed_at
      ) AS svc
        FROM public.service_case AS svc_case
       WHERE svc_case.workspace_id = invite_row.workspace_id
         AND svc_case.project_id = invite_row.project_id
         AND svc_case.status IN ('open', 'in_progress', 'done')
       ORDER BY svc_case.created_at, svc_case.id
    ) AS svcs;

  -- F13-09: Netzanmeldung des Invite-Projekts (Stand/Betreiber/
  -- Phasen-Daten; nie Zaehlernummer — rein interne Betriebsreferenz).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', greg.status,
      'operatorName', greg.operator_name,
      'submittedAt', greg.submitted_at,
      'decidedAt', greg.decided_at,
      'completedAt', greg.completed_at
    )
      FROM public.grid_registration AS greg
     WHERE greg.workspace_id = invite_row.workspace_id
       AND greg.project_id = invite_row.project_id
  ) INTO grid_entry;

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
      'outcome', project_row.outcome,
      'scope', portal_project_scope
    ),
    'documents', document_list,
    'appointments', appointment_list,
    'installation', installation_entry,
    'fileRequests', file_request_list,
    'subsidy', subsidy_entry,
    'service', service_case_list,
    'gridRegistration', grid_entry
  );
END
$f1001_resolve_token$;$ddl$;
  ELSE
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    -- Definer-Rechte fuer Timeline-Join (Muster 0091: ohne Tabellen-Grant
    -- scheitert der Resolver mit 42501).
    GRANT SELECT ON public.domain_events TO app_owner;
    -- F10-03c: Board-Scope fuer project.scope (Muster domain_events).
    GRANT SELECT ON public.kanban_board TO app_owner;
    GRANT SELECT ON public.file_request TO app_owner;
    GRANT SELECT ON public.subsidy_case TO app_owner;
    GRANT SELECT ON public.service_case TO app_owner;
    SET ROLE app_owner;
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
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
  portal_project_scope text;
  file_request_list jsonb;
  subsidy_entry jsonb;
  service_case_list jsonb;
  grid_entry jsonb;
  status_label_map jsonb;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  expired_count integer := 0;
  view_count integer;
  document_list jsonb;
  appointment_list jsonb;
  installation_entry jsonb;
  installation_timeline jsonb;
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
  -- F10-03c: Bereich des Projekt-Boards (fail-closed: fehlendes Board
  -- bricht den Resolve ueber den strikten Contract ab, kein Fallback).
  SELECT board.scope INTO portal_project_scope
    FROM public.kanban_board AS board
   WHERE board.workspace_id = invite_row.workspace_id
     AND board.id = project_row.kanban_board_id;

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
        ),
        'signatureStatus', COALESCE(sig.status, 'none'),
        'signedAt', sig.signed_at
      ) AS doc
        FROM public.offer_issuance AS issuance
        LEFT JOIN public.signature_request AS sig
          ON sig.workspace_id = issuance.workspace_id
         AND sig.issuance_id = issuance.id
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

  -- F10.2 Slice A: Projektermine ohne Freitext-Beschreibung (Privacy:
  -- description ist intern und wird nie projiziert).
  SELECT COALESCE(pg_catalog.jsonb_agg(app), '[]'::jsonb)
    INTO appointment_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', appointment.id,
        'title', appointment.title,
        'startAt', appointment.start_at,
        'endAt', appointment.end_at,
        'allDay', appointment.all_day,
        'appointmentType', appointment.appointment_type,
        'location', appointment.location
      ) AS app
        FROM public.project_appointment AS appointment
       WHERE appointment.workspace_id = invite_row.workspace_id
         AND appointment.project_id = invite_row.project_id
       ORDER BY appointment.start_at, appointment.id
    ) AS apps;

  -- F10-03: genau eine Installationszeile je Projekt (UNIQUE) oder NULL.
  -- Nur Stand + Daten, nie Namen/Notizen/Referenzen.
  SELECT pg_catalog.jsonb_build_object(
           'status', installation.status,
           'completedAt', installation.completed_at,
           'handoverAt', installation.handover_at
         )
    INTO installation_entry
    FROM public.installation AS installation
   WHERE installation.workspace_id = invite_row.workspace_id
     AND installation.project_id = invite_row.project_id;

  -- F10-03b: oeffentliche Status-Timeline (nur Typ + Zeit, nie Payloads/
  -- Akteure; lead_installer_assigned bleibt intern — Membership-PII).
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'type', timeline_row.type,
               'at', timeline_row.at,
               'day', timeline_row.day
             )
             ORDER BY timeline_row.at, timeline_row.type
           ),
           '[]'::jsonb
         )
    INTO installation_timeline
    FROM (
      SELECT CASE domain_event.event_type
               WHEN 'installation.created' THEN 'created'
               WHEN 'installation.completed' THEN 'completed'
               WHEN 'installation.handover_recorded' THEN 'handover_recorded'
             END AS type,
             domain_event.occurred_at AS at,
             (domain_event.occurred_at AT TIME ZONE 'Europe/Berlin')::date::text AS day
        FROM public.domain_events AS domain_event
        JOIN public.installation AS installation
          ON installation.workspace_id = domain_event.workspace_id
         AND installation.id = domain_event.aggregate_id
       WHERE domain_event.workspace_id = invite_row.workspace_id
         AND domain_event.aggregate_type = 'installation'
         AND domain_event.event_type IN (
               'installation.created',
               'installation.completed',
               'installation.handover_recorded'
             )
         AND installation.project_id = invite_row.project_id
    ) AS timeline_row;

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'timeline', installation_timeline
    );
  END IF;

  -- F10-05: Admin-Statusmapping (Installation-Umfang; nur Labels, nie
  -- interne Schluessel; ungemappt = leeres Objekt, TS-Defaults greifen).
  SELECT pg_catalog.jsonb_object_agg(label_row.source_key, label_row.label)
    INTO status_label_map
    FROM public.portal_status_label AS label_row
   WHERE label_row.workspace_id = invite_row.workspace_id
     AND label_row.scope = 'installation';

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'statusLabels', COALESCE(status_label_map, '{}'::jsonb)
    );
  END IF;

  -- F10-04: offene + hochgeladene Datei-Anfragen (Titel/Beschreibung/
  -- Stand, nie Storage-Key/Pruefsumme — rein interne Belegdaten).
  SELECT COALESCE(pg_catalog.jsonb_agg(req), '[]'::jsonb)
    INTO file_request_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', freq.id,
        'title', freq.title,
        'description', freq.description,
        'status', freq.status,
        'createdAt', freq.created_at,
        'uploadedAt', freq.uploaded_at,
        'originalFilename', freq.original_filename
      ) AS req
        FROM public.file_request AS freq
       WHERE freq.workspace_id = invite_row.workspace_id
         AND freq.project_id = invite_row.project_id
         AND freq.status IN ('offen', 'hochgeladen')
       ORDER BY freq.created_at, freq.id
    ) AS reqs;

  -- F13-04: Foerderakte des Invite-Projekts (Stand/Programm/Daten;
  -- nie BzA-Nummer — rein interne Referenz).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', scase.status,
      'program', scase.program,
      'bzaSubmittedAt', scase.bza_submitted_at,
      'bzaApprovedAt', scase.bza_approved_at,
      'bndSubmittedAt', scase.bnd_submitted_at,
      'completedAt', scase.completed_at
    )
      FROM public.subsidy_case AS scase
     WHERE scase.workspace_id = invite_row.workspace_id
       AND scase.project_id = invite_row.project_id
  ) INTO subsidy_entry;

  -- F13-06: Servicevorgaenge des Invite-Projekts (Titel/Stand/Zeiten/
  -- Bestaetigung; nie description — Freitext bleibt intern; cancelled
  -- bleibt ohne Kundenhandlungsbedarf intern).
  SELECT COALESCE(pg_catalog.jsonb_agg(svc), '[]'::jsonb)
    INTO service_case_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', svc_case.id,
        'title', svc_case.title,
        'status', svc_case.status,
        'dueDate', svc_case.due_date,
        'completedAt', svc_case.completed_at,
        'confirmedAt', svc_case.confirmed_at
      ) AS svc
        FROM public.service_case AS svc_case
       WHERE svc_case.workspace_id = invite_row.workspace_id
         AND svc_case.project_id = invite_row.project_id
         AND svc_case.status IN ('open', 'in_progress', 'done')
       ORDER BY svc_case.created_at, svc_case.id
    ) AS svcs;

  -- F13-09: Netzanmeldung des Invite-Projekts (Stand/Betreiber/
  -- Phasen-Daten; nie Zaehlernummer — rein interne Betriebsreferenz).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', greg.status,
      'operatorName', greg.operator_name,
      'submittedAt', greg.submitted_at,
      'decidedAt', greg.decided_at,
      'completedAt', greg.completed_at
    )
      FROM public.grid_registration AS greg
     WHERE greg.workspace_id = invite_row.workspace_id
       AND greg.project_id = invite_row.project_id
  ) INTO grid_entry;

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
      'outcome', project_row.outcome,
      'scope', portal_project_scope
    ),
    'documents', document_list,
    'appointments', appointment_list,
    'installation', installation_entry,
    'fileRequests', file_request_list,
    'subsidy', subsidy_entry,
    'service', service_case_list,
    'gridRegistration', grid_entry
  );
END
$f1001_resolve_token$;$ddl$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f1013_replace_resolver$;--> statement-breakpoint
DO $f1013_grants$
BEGIN
  IF current_user <> 'app_owner' THEN
    -- Projektion-Relation des Definers (Strict: Tabellen-Ownership).
    GRANT SELECT ON public.grid_registration TO app_owner;
    -- F10-05: Statusmapping-Projektion des Definers (Muster grid_registration).
    GRANT SELECT ON public.portal_status_label TO app_owner;
  END IF;
END
$f1013_grants$;--> statement-breakpoint
