CREATE TABLE "financing_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"produkttyp" text NOT NULL,
	"provider" text NOT NULL,
	"laufzeit_jahre" integer NOT NULL,
	"volumen_eur_cents" integer NOT NULL,
	"provider_referenz" text,
	"status" text DEFAULT 'beantragt' NOT NULL,
	"beantragt_at" timestamp with time zone,
	"entschieden_at" timestamp with time zone,
	"ausgezahlt_at" timestamp with time zone,
	"abgeschlossen_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financing_case_produkttyp_ck" CHECK ("financing_case"."produkttyp" in ('ratenkauf', 'kredit')),
	CONSTRAINT "financing_case_provider_ck" CHECK ("financing_case"."provider" in ('bees_bears', 'psd_bank')),
	CONSTRAINT "financing_case_status_ck" CHECK ("financing_case"."status" in (
        'beantragt', 'bonitaet', 'entschieden', 'ausgezahlt',
        'abgeschlossen', 'abgelehnt', 'storniert'
      )),
	CONSTRAINT "financing_case_laufzeit_ck" CHECK ("financing_case"."laufzeit_jahre" >= 0),
	CONSTRAINT "financing_case_volumen_ck" CHECK ("financing_case"."volumen_eur_cents" >= 0),
	CONSTRAINT "financing_case_referenz_ck" CHECK ("financing_case"."provider_referenz" is null or pg_catalog.length(pg_catalog.btrim("financing_case"."provider_referenz")) between 1 and 200),
	CONSTRAINT "financing_case_timestamps_ck" CHECK ("financing_case"."updated_at" >= "financing_case"."created_at" and pg_catalog.isfinite("financing_case"."created_at") and pg_catalog.isfinite("financing_case"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "financing_case" ADD CONSTRAINT "financing_case_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_case" ADD CONSTRAINT "financing_case_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financing_case_ws_id_uq" ON "financing_case" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "financing_case_ws_project_idx" ON "financing_case" USING btree ("workspace_id","project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "financing_case_ws_project_active_uq" ON "financing_case" USING btree ("workspace_id","project_id") WHERE "financing_case"."status" NOT IN ('abgeschlossen', 'storniert', 'abgelehnt');--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-15: RLS-Vertrag im F13-11-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0123 (Pin-Stabilität). Rechte:
-- installation.read/installation.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0123).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.financing_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.financing_case FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.financing_case
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- =======================================================================
-- F13-15 Finanzierungs-Intake (Resolver-Amendment): Der Portal-DEFINER
-- projiziert zusaetzlich financing (Stand/Typ/Phasen-Daten; genau der
-- aktive Vorgang, terminale Historie blendet als null aus,
-- F13-00-draft-Muster; Referenz/Volumen/Laufzeit treten nie aus).
-- Ansonsten byte-identische Uebernahme von 0260 (beide Rollen-Pfade).
-- =======================================================================
DO $f1315_replace_resolver$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app = 'app_owner' THEN
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1315_resolve_token$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  project_row public.project%ROWTYPE;
  portal_project_scope text;
  file_request_list jsonb;
  subsidy_entry jsonb;
  subsidy_messages jsonb;
  service_case_list jsonb;
  grid_entry jsonb;
  financing_entry jsonb;
  status_label_map jsonb;
  status_faq_map jsonb;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  expired_count integer := 0;
  view_count integer;
  document_list jsonb;
  appointment_list jsonb;
  installation_entry jsonb;
  installation_timeline jsonb;
  invoice_list jsonb;
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

  -- F8-15: ausgestellte Geldbelege des Invite-Projekts (nur Nummer/
  -- Art/Ausstellung/Brutto/Zahlstand — nie Positionen/Konditionen/
  -- Snapshots; Entwuerfe/stornierte bleiben intern).
  SELECT COALESCE(pg_catalog.jsonb_agg(inv ORDER BY inv->>'issuedAt' DESC), '[]'::jsonb)
    INTO invoice_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', doc.id,
        'number', doc.number,
        'kind', doc.type,
        'issuedAt', doc.issued_at,
        'grossCents', doc.gross_cents,
        'paymentStatus', doc.payment_status
      ) AS inv
        FROM public.commercial_document AS doc
       WHERE doc.workspace_id = invite_row.workspace_id
         AND doc.project_id = invite_row.project_id
         AND doc.status = 'issued'
         AND doc.type IN ('invoice', 'credit_note')
    ) AS invs;

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

  -- F10-09: Admin-FAQ je Installationsstand (nur gesetzte Texte, nie
  -- interne Schluessel; ungemappt = leeres Objekt, kein FAQ-Block).
  SELECT pg_catalog.jsonb_object_agg(faq_row.source_key, faq_row.faq)
    INTO status_faq_map
    FROM public.portal_status_faq AS faq_row
   WHERE faq_row.workspace_id = invite_row.workspace_id
     AND faq_row.scope = 'installation';

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'statusFaq', COALESCE(status_faq_map, '{}'::jsonb)
    );
  END IF;

  -- F10-10: Allow-many — offene + hochgeladene Datei-Anfragen
  -- (Titel/Beschreibung/Stand, nie Storage-Key/Pruefsumme; file_upload_list
  -- zaehlt Folge-Belege je Anfrage, filenames nur Dateinamen).
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
        'originalFilename', freq.original_filename,
        'allowMany', freq.allow_many,
        'uploadCount', (
          SELECT pg_catalog.count(*)
            FROM public.file_request_upload AS file_upload_list
           WHERE file_upload_list.workspace_id = freq.workspace_id
             AND file_upload_list.file_request_id = freq.id
        ),
        'filenames', (
          SELECT COALESCE(
                   pg_catalog.jsonb_agg(
                     file_upload_list.original_filename
                     ORDER BY file_upload_list.uploaded_at, file_upload_list.id
                   ),
                   '[]'::jsonb
                 )
            FROM public.file_request_upload AS file_upload_list
           WHERE file_upload_list.workspace_id = freq.workspace_id
             AND file_upload_list.file_request_id = freq.id
        )
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
       -- F13-00 §1: Entwurf unsichtbar fuer Externe.
       AND scase.status <> 'draft'
  ) INTO subsidy_entry;

  -- F13-10: Chat zur Foerderakte (Seite/Text/Zeit — nie IDs/Akteure;
  -- leer = kein Verlauf, kein Block).
  SELECT COALESCE(pg_catalog.jsonb_agg(chat_row.msg), '[]'::jsonb)
    INTO subsidy_messages
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'side', chat.author_side,
        'body', chat.body,
        'at', chat.created_at
      ) AS msg
        FROM public.subsidy_case_message AS chat
       WHERE chat.workspace_id = invite_row.workspace_id
         AND chat.project_id = invite_row.project_id
       ORDER BY chat.created_at, chat.id
    ) AS chat_row;

  IF subsidy_entry IS NOT NULL THEN
    subsidy_entry := subsidy_entry || pg_catalog.jsonb_build_object(
      'messages', COALESCE(subsidy_messages, '[]'::jsonb)
    );
  END IF;

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

  -- F13-15: Finanzierung des Invite-Projekts (Stand/Typ/Phasen-Daten;
  -- Referenz/Volumen/Laufzeit bleiben intern — nie im Portal).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', fcase.status,
      'produkttyp', fcase.produkttyp,
      'beantragtAt', fcase.beantragt_at,
      'entschiedenAt', fcase.entschieden_at,
      'ausgezahltAt', fcase.ausgezahlt_at,
      'abgeschlossenAt', fcase.abgeschlossen_at
    )
      FROM public.financing_case AS fcase
     WHERE fcase.workspace_id = invite_row.workspace_id
       AND fcase.project_id = invite_row.project_id
       -- Nur der aktive Vorgang (Genau-ein-aktiv-UQ: max 1 Zeile;
       -- terminale Historie blendet als null aus (kein Portal-Block);
       -- LIMIT 1 als Netz gegen UQ-Luecken, Owner-P0).
       AND fcase.status IN ('beantragt', 'bonitaet', 'entschieden', 'ausgezahlt')
     LIMIT 1
  ) INTO financing_entry;

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
    'invoices', invoice_list,
    'appointments', appointment_list,
    'installation', installation_entry,
    'fileRequests', file_request_list,
    'subsidy', subsidy_entry,
    'service', service_case_list,
    'gridRegistration', grid_entry,
    'financing', financing_entry
  );
END
$f1315_resolve_token$;$ddl$;
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
    -- F10-10: Folge-Beleg-Projektion des Definers (Muster file_request).
    GRANT SELECT ON public.file_request_upload TO app_owner;
    -- F8-15: Geldbeleg-Projektion des Definers (Muster file_request).
    GRANT SELECT ON public.commercial_document TO app_owner;
    -- F13-15: Finanzierungs-Projektion des Definers (Muster file_request).
    GRANT SELECT ON public.financing_case TO app_owner;
    SET ROLE app_owner;
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1315_resolve_token$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  project_row public.project%ROWTYPE;
  portal_project_scope text;
  file_request_list jsonb;
  subsidy_entry jsonb;
  subsidy_messages jsonb;
  service_case_list jsonb;
  grid_entry jsonb;
  financing_entry jsonb;
  status_label_map jsonb;
  status_faq_map jsonb;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  expired_count integer := 0;
  view_count integer;
  document_list jsonb;
  appointment_list jsonb;
  installation_entry jsonb;
  installation_timeline jsonb;
  invoice_list jsonb;
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

  -- F8-15: ausgestellte Geldbelege des Invite-Projekts (nur Nummer/
  -- Art/Ausstellung/Brutto/Zahlstand — nie Positionen/Konditionen/
  -- Snapshots; Entwuerfe/stornierte bleiben intern).
  SELECT COALESCE(pg_catalog.jsonb_agg(inv ORDER BY inv->>'issuedAt' DESC), '[]'::jsonb)
    INTO invoice_list
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'id', doc.id,
        'number', doc.number,
        'kind', doc.type,
        'issuedAt', doc.issued_at,
        'grossCents', doc.gross_cents,
        'paymentStatus', doc.payment_status
      ) AS inv
        FROM public.commercial_document AS doc
       WHERE doc.workspace_id = invite_row.workspace_id
         AND doc.project_id = invite_row.project_id
         AND doc.status = 'issued'
         AND doc.type IN ('invoice', 'credit_note')
    ) AS invs;

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

  -- F10-09: Admin-FAQ je Installationsstand (nur gesetzte Texte, nie
  -- interne Schluessel; ungemappt = leeres Objekt, kein FAQ-Block).
  SELECT pg_catalog.jsonb_object_agg(faq_row.source_key, faq_row.faq)
    INTO status_faq_map
    FROM public.portal_status_faq AS faq_row
   WHERE faq_row.workspace_id = invite_row.workspace_id
     AND faq_row.scope = 'installation';

  IF installation_entry IS NOT NULL THEN
    installation_entry := installation_entry || pg_catalog.jsonb_build_object(
      'statusFaq', COALESCE(status_faq_map, '{}'::jsonb)
    );
  END IF;

  -- F10-10: Allow-many — offene + hochgeladene Datei-Anfragen
  -- (Titel/Beschreibung/Stand, nie Storage-Key/Pruefsumme; file_upload_list
  -- zaehlt Folge-Belege je Anfrage, filenames nur Dateinamen).
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
        'originalFilename', freq.original_filename,
        'allowMany', freq.allow_many,
        'uploadCount', (
          SELECT pg_catalog.count(*)
            FROM public.file_request_upload AS file_upload_list
           WHERE file_upload_list.workspace_id = freq.workspace_id
             AND file_upload_list.file_request_id = freq.id
        ),
        'filenames', (
          SELECT COALESCE(
                   pg_catalog.jsonb_agg(
                     file_upload_list.original_filename
                     ORDER BY file_upload_list.uploaded_at, file_upload_list.id
                   ),
                   '[]'::jsonb
                 )
            FROM public.file_request_upload AS file_upload_list
           WHERE file_upload_list.workspace_id = freq.workspace_id
             AND file_upload_list.file_request_id = freq.id
        )
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
       -- F13-00 §1: Entwurf unsichtbar fuer Externe.
       AND scase.status <> 'draft'
  ) INTO subsidy_entry;

  -- F13-10: Chat zur Foerderakte (Seite/Text/Zeit — nie IDs/Akteure;
  -- leer = kein Verlauf, kein Block).
  SELECT COALESCE(pg_catalog.jsonb_agg(chat_row.msg), '[]'::jsonb)
    INTO subsidy_messages
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'side', chat.author_side,
        'body', chat.body,
        'at', chat.created_at
      ) AS msg
        FROM public.subsidy_case_message AS chat
       WHERE chat.workspace_id = invite_row.workspace_id
         AND chat.project_id = invite_row.project_id
       ORDER BY chat.created_at, chat.id
    ) AS chat_row;

  IF subsidy_entry IS NOT NULL THEN
    subsidy_entry := subsidy_entry || pg_catalog.jsonb_build_object(
      'messages', COALESCE(subsidy_messages, '[]'::jsonb)
    );
  END IF;

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

  -- F13-15: Finanzierung des Invite-Projekts (Stand/Typ/Phasen-Daten;
  -- Referenz/Volumen/Laufzeit bleiben intern — nie im Portal).
  SELECT (
    SELECT pg_catalog.jsonb_build_object(
      'status', fcase.status,
      'produkttyp', fcase.produkttyp,
      'beantragtAt', fcase.beantragt_at,
      'entschiedenAt', fcase.entschieden_at,
      'ausgezahltAt', fcase.ausgezahlt_at,
      'abgeschlossenAt', fcase.abgeschlossen_at
    )
      FROM public.financing_case AS fcase
     WHERE fcase.workspace_id = invite_row.workspace_id
       AND fcase.project_id = invite_row.project_id
       -- Nur der aktive Vorgang (Genau-ein-aktiv-UQ: max 1 Zeile;
       -- terminale Historie blendet als null aus (kein Portal-Block);
       -- LIMIT 1 als Netz gegen UQ-Luecken, Owner-P0).
       AND fcase.status IN ('beantragt', 'bonitaet', 'entschieden', 'ausgezahlt')
     LIMIT 1
  ) INTO financing_entry;

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
    'invoices', invoice_list,
    'appointments', appointment_list,
    'installation', installation_entry,
    'fileRequests', file_request_list,
    'subsidy', subsidy_entry,
    'service', service_case_list,
    'gridRegistration', grid_entry,
    'financing', financing_entry
  );
END
$f1315_resolve_token$;$ddl$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f1315_replace_resolver$;--> statement-breakpoint
DO $f1315_grants$
BEGIN
  IF current_user <> 'app_owner' THEN
    -- Projektion-Relation des Definers (Strict: Tabellen-Ownership).
    -- F10-10: Folge-Beleg-Projektion des Definers (Muster 0119).
    GRANT SELECT ON public.file_request_upload TO app_owner;
    -- F8-15: Geldbeleg-Projektion des Definers (Muster file_request).
    GRANT SELECT ON public.commercial_document TO app_owner;
    -- F13-15: Finanzierungs-Projektion des Definers (Muster file_request).
    GRANT SELECT ON public.financing_case TO app_owner;
  END IF;
END
$f1315_grants$;
--> statement-breakpoint
-- =======================================================================
-- F13-15 Antrags-Kapsel (Agent I, Owner-angehängt; UQ-Kommentare korrigiert).
-- =======================================================================
-- ═══════════════════════════════════════════════════════════════════════
-- F13-15 Antrags-Kapsel (Portal-Schreibpfad, DEFINER) — .part, KEIN
-- eigenständiges Migration-File! Der Owner hängt diese Datei an das
-- 0264 an (Tabelle + Amendment financing_case, gelandet;
-- Kapsel läuft DANACH). Muster: 0107 confirm_service_case (F13-06)
-- + Service-Signatur confirmServiceCaseByToken
-- (modules/service-cases/service.ts).
--
-- ABGLEICH mit Backend-Agent H (verifiziert):
--  1. Spalte heißt volumen_eur_cents (integer, Cent-genau); der
--     Kapsel-Parameter heißt volumen_cents (Delegation F13-15) und
--     trägt GANZE CENT ein. Spec-§1-Name volumen_eur gilt NICHT.
--  2. created_by uuid NOT NULL (ohne FK): Kapsel setzt
--     invite_row.created_by (Invite-Aussteller als zurechenbarer
--     Akteur des Portal-Antrags — nichts erfunden). Domain-Events
--     tragen actor 'system' (Muster 0107).
--  3. Partieller UNIQUE-Index financing_case_ws_project_active_uq
--     (0264, §1 Genau-ein-aktiver-Vorgang): der Kapsel-Guard (EXISTS)
--     ist die fail-closed Vorprüfung, der unique_violation-Handler
--     fängt das Race-Fenster paralleler Anträge (Owner-angehängt).
-- ═══════════════════════════════════════════════════════════════════════
-- F13-15 Finanzierungs-Antrag (dritter anonymer Schreibpfad des Portals,
-- Muster confirm_service_case): EIN atomares INSERT (Status 'beantragt')
-- mit Token-Invite-Bindung (Mandant + Projekt aus dem Invite, nie aus
-- dem Request). Guards = Service-Guards §1 (Ratenkauf-Schranken:
-- Laufzeit 1–25 J., Volumen ≤ 70.000 € = 7.000.000 Cent, Provider
-- bees_bears; PSD-Kredit: nur positiv+ganzzahlig, keine Katalogschranke).
-- Rückgabe: Fall-ID (uuid) bei Erfolg, NULL uniform ohne Orakel (toter
-- Link, entzogen/abgelaufen, Guard-Verletzung, bereits aktiver Vorgang).
CREATE FUNCTION public.request_financing_case_by_token(
  requested_token_hash bytea,
  requested_produkttyp text,
  requested_laufzeit_jahre integer,
  requested_volumen_cents integer,
  requested_provider text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1315_request$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  new_case_id uuid;
  active_exists boolean := false;
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  -- Guard: Wortschatz (Spec §1; Unbekanntes fällt fail-closed auf NULL).
  IF requested_produkttyp NOT IN ('ratenkauf', 'kredit')
     OR requested_provider NOT IN ('bees_bears', 'psd_bank') THEN
    RETURN NULL;
  END IF;
  -- Guard: Ratenkauf-Schranken (Katalogwahrheit, Cent-genau).
  IF requested_produkttyp = 'ratenkauf' THEN
    IF requested_laufzeit_jahre IS NULL
       OR requested_laufzeit_jahre < 1
       OR requested_laufzeit_jahre > 25
       OR requested_volumen_cents IS NULL
       OR requested_volumen_cents < 1
       OR requested_volumen_cents > 7000000
       OR requested_provider <> 'bees_bears' THEN
      RETURN NULL;
    END IF;
  ELSE
    -- PSD-Kredit: nur positiv + ganzzahlig (integer-Typ), keine
    -- Katalogschranke — aber geschlossene Paarung kredit↔psd_bank (§1,
    -- Owner-P1: Service prüft sie, Kapsel als letzte Linie auch).
    IF requested_laufzeit_jahre IS NULL
       OR requested_laufzeit_jahre < 1
       OR requested_volumen_cents IS NULL
       OR requested_volumen_cents < 1
       OR requested_provider <> 'psd_bank' THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT * INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  -- Abgelaufen/entzogen: fail-closed ohne Mutation (kein Orakel).
  IF NOT FOUND OR invite_row.status <> 'active'
     OR invite_row.expires_at <= mutation_time THEN
    RETURN NULL;
  END IF;

  -- Guard: genau ein aktiver Vorgang je Projekt (§1; terminal:
  -- abgeschlossen/storniert/abgelehnt bleiben Historie).
  SELECT true INTO active_exists
    FROM public.financing_case AS fcase
   WHERE fcase.workspace_id = invite_row.workspace_id
     AND fcase.project_id = invite_row.project_id
     AND fcase.status IN ('beantragt', 'bonitaet', 'entschieden', 'ausgezahlt');
  IF active_exists THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO public.financing_case (
      workspace_id, project_id, produkttyp, laufzeit_jahre,
      volumen_eur_cents, provider, status, beantragt_at, created_by
    ) VALUES (
      invite_row.workspace_id, invite_row.project_id, requested_produkttyp,
      requested_laufzeit_jahre, requested_volumen_cents, requested_provider,
      'beantragt', mutation_time, invite_row.created_by
    ) RETURNING id INTO new_case_id;
  EXCEPTION WHEN unique_violation THEN
    -- Race gegen parallelen Antrag (partielle UNIQUE 0264):
    -- uniform NULL, kein Orakel, keine Teilanlage.
    RETURN NULL;
  END;

  -- Events/Audit ohne PII über IDs hinaus (§2: nur caseId — Titel/Volumen
  -- nie im Audit, wie Angebotskette F13-01 §Scopes-3).
  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    invite_row.workspace_id, 'project', invite_row.project_id,
    'financing_case.requested', 'system',
    pg_catalog.jsonb_build_object(
      'caseId', new_case_id,
      'inviteId', invite_row.id
    ),
    mutation_time
  );
  RETURN new_case_id;
END
$f1315_request$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.request_financing_case_by_token(bytea, text, integer, integer, text) FROM PUBLIC;--> statement-breakpoint
-- Owner-Tanz NUR im Testmodus (Muster 0107 f1306_confirm_owner_dance:
-- RESTRICTIVE-Actor-Policies tragen den app_owner-Escape-Hatch, der
-- nur greift, wenn CURRENT_USER = 'app_owner' ist; Strict migriert
-- ohnehin als app_owner).
DO $f1315_request_owner_dance$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    IF pg_catalog.to_regrole('app_owner') IS NULL THEN
      CREATE ROLE app_owner nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;
    END IF;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    ALTER FUNCTION public.request_financing_case_by_token(
      bytea, text, integer, integer, text
    ) OWNER TO app_owner;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    SET ROLE app_owner;
    REVOKE ALL ON FUNCTION public.request_financing_case_by_token(
      bytea, text, integer, integer, text
    ) FROM PUBLIC;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.request_financing_case_by_token(
        bytea, text, integer, integer, text
      ) TO %I',
      v_app
    );
    RESET ROLE;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
    -- Relationen des oeffentlichen Pfads (Strict: Tabellen-Ownership):
    GRANT SELECT ON public.portal_token_locator TO app_owner;
    GRANT SELECT ON public.portal_invite TO app_owner;
    GRANT SELECT, INSERT ON public.financing_case TO app_owner;
    GRANT SELECT, INSERT ON public.domain_events TO app_owner;
  END IF;
END
$f1315_request_owner_dance$;--> statement-breakpoint

-- Oeffentliche Ausfuehrung rollenunabhaengig (Muster f1306_confirm_acl):
-- Der Owner-Tanz oben greift nur im Testmodus (v_app); Strict migriert
-- als app_owner und wuerde den EXECUTE-Grant sonst nie vergeben.
DO $f1315_request_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.request_financing_case_by_token(
      bytea, text, integer, integer, text
    ) TO app_runtime;
  END IF;
END
$f1315_request_acl$;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
