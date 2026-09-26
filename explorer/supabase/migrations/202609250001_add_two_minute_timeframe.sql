-- Trade Bot Explorer Sprint 1.3: allow analyses created on the 2-minute chart.
-- Apply manually after review. Existing rows, grants, and RLS policies are unchanged.

alter table public.research_annotations
  drop constraint if exists research_annotations_timeframe_minutes_check;

alter table public.research_annotations
  add constraint research_annotations_timeframe_minutes_check
  check (timeframe_minutes in (1, 2, 5, 10, 15, 30, 60));
