-- Trade Bot Explorer Sprint 1.2: additive replay-analysis identity and snapshot.
-- Apply manually after reviewing. Existing rows remain retrospective.

alter table public.research_annotations
  add column if not exists analysis_type text not null default 'retrospective',
  add column if not exists replay_timestamp bigint,
  add column if not exists replay_position integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'research_annotations_replay_context_check'
      and conrelid = 'public.research_annotations'::regclass
  ) then
    alter table public.research_annotations
      add constraint research_annotations_replay_context_check
      check (
        (
          analysis_type = 'retrospective'
          and replay_timestamp is null
          and replay_position is null
        )
        or
        (
          analysis_type = 'replay'
          and replay_timestamp is not null
          and replay_position is not null
          and replay_timestamp >= end_timestamp
          and replay_timestamp >= analysis_cutoff_timestamp
          and replay_position >= 0
        )
      );
  end if;
end
$$;

-- No grants or RLS policies change: replay analyses retain the parent table's
-- membership reads and author-only update/delete rules.
