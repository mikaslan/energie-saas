-- F3-BATCH-1 Down 0271: baut planning_roof_min + Tilt-Validator ab.
-- Reihenfolge: dieser Down zuerst (FK-Nehmer), dann 0270-Down.
DROP TABLE IF EXISTS public.planning_roof_min;
DROP FUNCTION IF EXISTS public.planning_roof_min_tilt_per_edge_valid(jsonb);
