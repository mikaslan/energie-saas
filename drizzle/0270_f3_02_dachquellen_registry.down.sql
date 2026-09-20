-- F3-BATCH-1 Down 0270: baut planning_source wieder ab.
-- Reihenfolge: 0271-Down laeuft zuerst (FK-Nehmer), dann dieser.
DROP TABLE IF EXISTS public.planning_source;
