-- ═══════════════════════════════════════════════════════════════════════
-- F10-10 Datei-Anfragen Allow-many (Katalog F10-04: „Templates: Titel,
-- Dateityp, Allow many"): Eine Anfrage nimmt je nach allow_many einen
-- (v1-Single) oder mehrere Belege an. Erster Beleg weiter über
-- fulfill_file_request (Spalten-Pfad, receipt-CHECK unverändert);
-- Folge-Belege nur bei allow_many über die neue Kapsel
-- fulfill_file_request_followup in die Child-Tabelle
-- file_request_upload (je Zeile ein WORM-Beleg, unveränderlich).
-- Resolver projiziert je Anfrage allowMany/uploadCount/filenames (nur
-- Dateinamen, nie Keys/Prüfsummen). Rechte: project.read/project.write
-- im Service-Layer (keine neue Permission, keine Grants — Muster 0104).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "file_request" ADD COLUMN "allow_many" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_request_template" ADD COLUMN "allow_many" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "file_request_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"file_request_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"original_filename" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_request_upload_receipt_ck" CHECK (pg_catalog.length(pg_catalog.btrim("file_request_upload"."storage_key")) between 1 and 512 and pg_catalog.length("file_request_upload"."file_sha256") = 64 and pg_catalog.length("file_request_upload"."content_type") between 1 and 128 and ("file_request_upload"."byte_size" between 1 and 10485760) and pg_catalog.length(pg_catalog.btrim("file_request_upload"."original_filename")) between 1 and 255),
	CONSTRAINT "file_request_upload_storage_key_uq" UNIQUE("storage_key")
);--> statement-breakpoint
ALTER TABLE "file_request_upload" ADD CONSTRAINT "file_request_upload_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_request_upload" ADD CONSTRAINT "file_request_upload_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_request_upload" ADD CONSTRAINT "file_request_upload_request_fk" FOREIGN KEY ("workspace_id","file_request_id") REFERENCES "public"."file_request"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_request_upload_ws_id_uq" ON "file_request_upload" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "file_request_upload_ws_request_idx" ON "file_request_upload" USING btree ("workspace_id","file_request_id","uploaded_at","id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F10-10: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Schreiben nur per Service (app_runtime) bzw. DEFINER-Kapsel als Owner.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.file_request_upload ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.file_request_upload FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.file_request_upload
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F10-10 Folge-Beleg-Kapsel: EIN atomarer INSERT je Folge-Upload, nur
-- bei status 'hochgeladen' UND allow_many (Mandant + Projekt aus dem
-- Invite, nie aus dem Request). 'conflict' bei Single/terminaler/
-- fremder Anfrage, 'invalid' auf dem falschen Pfad (offen → Erst-Upload
-- über fulfill_file_request), 'not_found' ohne Orakel. Duplikat-Key
-- (gleiche Datei erneut) → 'conflict' über storage_key-UNIQUE.
-- Der Storage-Put läuft VORHER im Service; bei 'conflict' bleibt ein
-- verwaistes WORM-Objekt liegen (Muster 0104, ESTIMATE).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.fulfill_file_request_followup(
  requested_token_hash bytea,
  requested_request_id uuid,
  p_storage_key text,
  p_file_sha256 text,
  p_content_type text,
  p_byte_size integer,
  p_original_filename text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1010_fulfill_followup$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  request_row public.file_request%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  inserted_count integer := 0;
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN 'not_found';
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
    RETURN 'not_found';
  END IF;

  -- Fail-closed Metadaten-Grenze (Service validiert vorab strenger).
  IF p_storage_key IS NULL OR pg_catalog.length(p_storage_key) > 512
     OR p_file_sha256 IS NULL OR pg_catalog.length(p_file_sha256) <> 64
     OR p_content_type IS NULL OR pg_catalog.length(p_content_type) > 128
     OR p_byte_size IS NULL OR p_byte_size < 1 OR p_byte_size > 10485760
     OR p_original_filename IS NULL
     OR pg_catalog.length(p_original_filename) NOT BETWEEN 1 AND 255 THEN
    RETURN 'invalid';
  END IF;

  SELECT * INTO request_row
    FROM public.file_request AS freq
   WHERE freq.workspace_id = invite_row.workspace_id
     AND freq.project_id = invite_row.project_id
     AND freq.id = requested_request_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  -- Falscher Pfad: offene Anfragen erfüllt ausschließlich
  -- fulfill_file_request (setzt die Spalten-Belegdaten).
  IF request_row.status = 'offen' THEN
    RETURN 'invalid';
  END IF;
  -- Nur hochgeladene Allow-many-Anfragen nehmen Folge-Belege an.
  IF request_row.status <> 'hochgeladen' OR NOT request_row.allow_many THEN
    RETURN 'conflict';
  END IF;

  INSERT INTO public.file_request_upload (
    workspace_id, project_id, file_request_id, storage_key,
    file_sha256, content_type, byte_size, original_filename, uploaded_at
  ) VALUES (
    invite_row.workspace_id, invite_row.project_id, requested_request_id,
    p_storage_key, p_file_sha256, p_content_type, p_byte_size,
    p_original_filename, mutation_time
  )
  ON CONFLICT (storage_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN
    RETURN 'conflict';
  END IF;

  UPDATE public.file_request AS freq
     SET updated_at = mutation_time
   WHERE freq.workspace_id = invite_row.workspace_id
     AND freq.id = requested_request_id;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    invite_row.workspace_id, 'project', invite_row.project_id,
    'file_request.uploaded', 'system',
    pg_catalog.jsonb_build_object(
      'requestId', requested_request_id,
      'inviteId', invite_row.id
    ),
    mutation_time
  );
  RETURN 'ok';
END
$f1010_fulfill_followup$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.fulfill_file_request_followup(bytea, uuid, text, text, text, integer, text) FROM PUBLIC;--> statement-breakpoint
-- Owner-Tanz NUR im Testmodus (Muster 0104 fulfill_file_request).
DO $f1010_fulfill_followup_owner_dance$
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
    ALTER FUNCTION public.fulfill_file_request_followup(
      bytea, uuid, text, text, text, integer, text
    ) OWNER TO app_owner;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    SET ROLE app_owner;
    REVOKE ALL ON FUNCTION public.fulfill_file_request_followup(
      bytea, uuid, text, text, text, integer, text
    ) FROM PUBLIC;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.fulfill_file_request_followup(
        bytea, uuid, text, text, text, integer, text
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
    GRANT SELECT, UPDATE ON public.file_request TO app_owner;
    GRANT SELECT, INSERT ON public.file_request_upload TO app_owner;
    GRANT SELECT, INSERT ON public.domain_events TO app_owner;
  END IF;
END
$f1010_fulfill_followup_owner_dance$;--> statement-breakpoint

-- Oeffentliche Ausfuehrung rollenunabhaengig (Muster 0119):
-- Der Owner-Tanz oben greift nur im Testmodus (v_app); Strict migriert
-- als app_owner und wuerde den EXECUTE-Grant sonst nie vergeben.
DO $f1010_fulfill_followup_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.fulfill_file_request_followup(
      bytea, uuid, text, text, text, integer, text
    ) TO app_runtime;
  END IF;
END
$f1010_fulfill_followup_acl$;
--> statement-breakpoint
DO $f1010_replace_resolver$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app = 'app_owner' THEN
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1010_resolve_token$
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
  status_label_map jsonb;
  status_faq_map jsonb;
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
$f1010_resolve_token$;$ddl$;
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
    SET ROLE app_owner;
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.resolve_portal_public_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1010_resolve_token$
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
  status_label_map jsonb;
  status_faq_map jsonb;
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
$f1010_resolve_token$;$ddl$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f1010_replace_resolver$;--> statement-breakpoint
DO $f1010_grants$
BEGIN
  IF current_user <> 'app_owner' THEN
    -- Projektion-Relation des Definers (Strict: Tabellen-Ownership).
    -- F10-10: Folge-Beleg-Projektion des Definers (Muster 0119).
    GRANT SELECT ON public.file_request_upload TO app_owner;
  END IF;
END
$f1010_grants$;
