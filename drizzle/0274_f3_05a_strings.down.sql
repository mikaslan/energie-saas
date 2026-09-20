-- F3-BATCH-1 Down 0274: baut planning_string + planning_inverter ab.
-- Reihenfolge: erst String (FK-Nehmer), dann WR, dann Funktion,
-- dann 0273-Down.
DROP TABLE IF EXISTS public.planning_string;
DROP TABLE IF EXISTS public.planning_inverter;
DROP FUNCTION IF EXISTS public.planning_string_members_valid(jsonb);
