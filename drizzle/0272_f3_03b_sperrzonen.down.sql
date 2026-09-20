-- F3-BATCH-1 Down 0272: baut planning_roof_restriction wieder ab.
-- Reihenfolge: dieser Down zuerst (FK-Nehmer), dann 0271/0270-Down.
DROP TABLE IF EXISTS public.planning_roof_restriction;
