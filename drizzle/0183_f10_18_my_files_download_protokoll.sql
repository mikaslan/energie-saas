-- ═══════════════════════════════════════════════════════════════════════
-- F10-18 My-Files-Download-Protokoll (Katalog F10.7 „Download-
-- Protokollierung/Audit"): Jeder ausgelieferte Portal-My-Files-Download
-- schreibt genau eine Zeile in portal_download_log (Invite + Datei +
-- Zeitpunkt). issuance_id wird NULLABLE, project_file_id kommt hinzu,
-- CHECK genau-eine-gesetzt + FK auf project_file + Index. Der Download-
-- Insert sitzt in read_portal_project_file_artifact nach 0137-Muster
-- (Sichtbarkeits-SELECT INTO + IF FOUND + mutation_time — nur Treffer
-- schreiben, kein Orakel, kein Rauschen). Der interne Zähler
-- (getPortalStatus, invite-weiter count(*) ohne issuance-Filter) wird
-- dadurch automatisch vollständig — kein Service-Change. Grants/RLS
-- unverändert (0137 table-level Grants decken die neue Spalte,
-- tenant_isolation + FORCE sind spaltenunabhängig); kein DELETE-Grant,
-- keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "portal_download_log" ALTER COLUMN "issuance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_download_log" ADD COLUMN "project_file_id" uuid;--> statement-breakpoint
ALTER TABLE "portal_download_log" ADD CONSTRAINT "portal_download_log_exactly_one_target_ck" CHECK (num_nonnulls("issuance_id", "project_file_id") = 1);--> statement-breakpoint
ALTER TABLE "portal_download_log" ADD CONSTRAINT "portal_download_log_file_fk" FOREIGN KEY ("workspace_id","project_file_id") REFERENCES "public"."project_file"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_download_log_ws_file_idx" ON "portal_download_log" USING btree ("workspace_id","project_file_id","downloaded_at","id");--> statement-breakpoint
-- F10-18: Download-Insert in der My-Files-Kapsel (gleiche Sichtbarkeit
-- wie F10-17: nur gültiger Invite + sichtbare Datei des Invite-Projekts
-- erreicht den Insert; null Zeilen schreiben nichts). Owner-Tanz wie
-- 0137 (Muster 0116): CREATE OR REPLACE scheitert als Nicht-Owner;
-- Strict migriert ohnehin als app_owner. Kapselrumpf = 0182-Rumpf plus
-- Download-Insert, in beiden Rümpfen bytegleich (ein Hash).
DO $f1018_replace_artifact$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app = 'app_owner' THEN
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.read_portal_project_file_artifact(
  requested_token_hash bytea,
  requested_file_id uuid
)
RETURNS TABLE (
  original_filename text,
  content_type text,
  byte_size integer,
  file_sha256 text,
  storage_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1018_read_portal_project_file_artifact$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  downloaded_file_id uuid;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT *
    INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  -- Abgelaufen/entzogen: fail-closed ohne Unterschied (kein Orakel).
  IF NOT FOUND OR invite_row.status <> 'active'
     OR invite_row.expires_at <= mutation_time THEN
    RETURN;
  END IF;

  -- F10-18: genau eine Protokollzeile je ausgelieferter Datei
  -- (Auslieferungsbedingung = gleiche Sichtbarkeit wie unten).
  SELECT pfile.id
    INTO downloaded_file_id
    FROM public.project_file AS pfile
   WHERE pfile.workspace_id = invite_row.workspace_id
     AND pfile.project_id = invite_row.project_id
     AND pfile.id = requested_file_id
     AND pfile.visible_to_customer = true
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.portal_download_log (
      workspace_id, portal_invite_id, project_file_id, downloaded_at
    ) VALUES (
      invite_row.workspace_id, invite_row.id,
      downloaded_file_id, mutation_time
    );
  END IF;

  RETURN QUERY
  SELECT pfile.original_filename,
         pfile.content_type,
         pfile.byte_size,
         pfile.file_sha256,
         pfile.storage_key
    FROM public.project_file AS pfile
   WHERE pfile.workspace_id = invite_row.workspace_id
     AND pfile.project_id = invite_row.project_id
     AND pfile.id = requested_file_id
     AND pfile.visible_to_customer = true;
END;
$f1018_read_portal_project_file_artifact$;$ddl$;
  ELSE
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    -- Definer-Rechte fuer den Download-Insert (Muster 0137:
    -- ohne Tabellen-Grant scheitert der Insert mit 42501).
    GRANT SELECT, INSERT ON public.portal_download_log TO app_owner;
    SET ROLE app_owner;
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.read_portal_project_file_artifact(
  requested_token_hash bytea,
  requested_file_id uuid
)
RETURNS TABLE (
  original_filename text,
  content_type text,
  byte_size integer,
  file_sha256 text,
  storage_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1018_read_portal_project_file_artifact$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  downloaded_file_id uuid;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT *
    INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  -- Abgelaufen/entzogen: fail-closed ohne Unterschied (kein Orakel).
  IF NOT FOUND OR invite_row.status <> 'active'
     OR invite_row.expires_at <= mutation_time THEN
    RETURN;
  END IF;

  -- F10-18: genau eine Protokollzeile je ausgelieferter Datei
  -- (Auslieferungsbedingung = gleiche Sichtbarkeit wie unten).
  SELECT pfile.id
    INTO downloaded_file_id
    FROM public.project_file AS pfile
   WHERE pfile.workspace_id = invite_row.workspace_id
     AND pfile.project_id = invite_row.project_id
     AND pfile.id = requested_file_id
     AND pfile.visible_to_customer = true
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.portal_download_log (
      workspace_id, portal_invite_id, project_file_id, downloaded_at
    ) VALUES (
      invite_row.workspace_id, invite_row.id,
      downloaded_file_id, mutation_time
    );
  END IF;

  RETURN QUERY
  SELECT pfile.original_filename,
         pfile.content_type,
         pfile.byte_size,
         pfile.file_sha256,
         pfile.storage_key
    FROM public.project_file AS pfile
   WHERE pfile.workspace_id = invite_row.workspace_id
     AND pfile.project_id = invite_row.project_id
     AND pfile.id = requested_file_id
     AND pfile.visible_to_customer = true;
END;
$f1018_read_portal_project_file_artifact$;$ddl$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f1018_replace_artifact$;
