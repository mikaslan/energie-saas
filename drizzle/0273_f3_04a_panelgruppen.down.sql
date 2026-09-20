-- F3-BATCH-1 Down 0273: baut planning_panel_group wieder ab.
-- Reihenfolge: dieser Down zuerst (FK-Nehmer), dann 0272/0271/0270-Down.
DROP TABLE IF EXISTS public.planning_panel_group;
