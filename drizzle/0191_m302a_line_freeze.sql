-- M3-02a: Zeilen-Freeze-Guard (GoBD) — Migration 0191.
--
-- Verschliesst die Luecke "Zeilen nur service-seitig eingefroren":
-- INSERT/UPDATE/DELETE auf commercial_document_line werden abgewiesen,
-- sobald ein beteiligter Elternbeleg ausgestellt/storniert ist (23514).
-- UPDATE prueft ALT- und NEU-Eltern (Abziehen aus versiegeltem Beleg
-- ist sonst ein Ein-Statement-Angriff). Entwuerfe bleiben offen. Liest
-- den Elternstatus als aufrufende Rolle unter RLS (workspace-skoped);
-- unsichtbarer/fehlender Elternteil faellt geschlossen ab (Wartung muss
-- Tenant-Kontext setzen wie ueberall). Keine Schema-Aenderung im
-- drizzle-Sinn (nur Funktion + Trigger): Hand-SQL + Journal, kein
-- Snapshot-Delta (0134-Praezedenz).
CREATE OR REPLACE FUNCTION public._m301_guard_line_parent_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m301_line_parent_immutable$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO old_status
      FROM public.commercial_document
     WHERE id = OLD.document_id
       AND workspace_id = OLD.workspace_id;
    IF NOT FOUND OR old_status IS NULL THEN
      RAISE EXCEPTION 'line_parent_not_found' USING ERRCODE = '23514';
    END IF;
    IF old_status IN ('issued', 'voided') THEN
      RAISE EXCEPTION 'line_parent_immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO new_status
    FROM public.commercial_document
   WHERE id = NEW.document_id
     AND workspace_id = NEW.workspace_id;
  IF NOT FOUND OR new_status IS NULL THEN
    RAISE EXCEPTION 'line_parent_not_found' USING ERRCODE = '23514';
  END IF;
  IF new_status IN ('issued', 'voided') THEN
    RAISE EXCEPTION 'line_parent_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO old_status
      FROM public.commercial_document
     WHERE id = OLD.document_id
       AND workspace_id = OLD.workspace_id;
    IF NOT FOUND OR old_status IS NULL THEN
      RAISE EXCEPTION 'line_parent_not_found' USING ERRCODE = '23514';
    END IF;
    IF old_status IN ('issued', 'voided') THEN
      RAISE EXCEPTION 'line_parent_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$m301_line_parent_immutable$;--> statement-breakpoint
DROP TRIGGER IF EXISTS commercial_document_line_parent_immutable_ins ON public.commercial_document_line;--> statement-breakpoint
CREATE TRIGGER commercial_document_line_parent_immutable_ins
  BEFORE INSERT ON public.commercial_document_line
  FOR EACH ROW EXECUTE FUNCTION public._m301_guard_line_parent_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS commercial_document_line_parent_immutable_upd ON public.commercial_document_line;--> statement-breakpoint
CREATE TRIGGER commercial_document_line_parent_immutable_upd
  BEFORE UPDATE ON public.commercial_document_line
  FOR EACH ROW EXECUTE FUNCTION public._m301_guard_line_parent_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS commercial_document_line_parent_immutable_del ON public.commercial_document_line;--> statement-breakpoint
CREATE TRIGGER commercial_document_line_parent_immutable_del
  BEFORE DELETE ON public.commercial_document_line
  FOR EACH ROW EXECUTE FUNCTION public._m301_guard_line_parent_immutable();
