-- F3-BATCH-1 Down 0275: baut planning_string_equipment wieder ab.
-- Reihenfolge: dieser Down zuerst (FK-Nehmer), dann 0274-Down.
DROP TABLE IF EXISTS public.planning_string_equipment;
