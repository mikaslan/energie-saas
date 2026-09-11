-- ═══════════════════════════════════════════════════════════════════════
-- F13-04 Foerderstand im Kundenportal (Katalog F13.2-Folge): Die
-- Portal-Projektion zeigt je aktivem Invite den Stand der Foerderakte
-- (Status/Programm/Phasen-Daten, nie BzA-Nummer). Reine Leseprojektion
-- des DEFINER-Resolvers; keine Schreibpfade, keine neuen Rechte.
-- ═══════════════════════════════════════════════════════════════════════

-- F13-04 Foerderstand im Kundenportal: resolve_portal_public_view
-- projiziert zusaetzlich subsidy (eine Foerderakte je Projekt: Stand,
-- Programm, Phasen-Daten — nie BzA-Nummer/interne Akteure).
-- Funktions-Pin im Rollenvertrag nachgezogen (Hash aus diesem Body).

-- Owner-sicherer Funktionsersatz (Muster 0091/0059/0056).
DO $f1006_replace_resolver$
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
    'subsidy', subsidy_entry
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
    'subsidy', subsidy_entry
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
$f1006_replace_resolver$;--> statement-breakpoint

DO $f1006_grants$
BEGIN
  IF current_user <> 'app_owner' THEN
    -- Projektion-Relationen des Definers (Strict: Tabellen-Ownership).
    GRANT SELECT ON public.domain_events TO app_owner;
    -- F10-03c: Board-Scope fuer project.scope (Muster domain_events).
    GRANT SELECT ON public.kanban_board TO app_owner;
    GRANT SELECT ON public.file_request TO app_owner;
    GRANT SELECT ON public.subsidy_case TO app_owner;
  END IF;
END
$f1006_grants$;--> statement-breakpoint
