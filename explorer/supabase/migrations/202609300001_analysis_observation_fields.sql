-- Trade Bot Explorer Sprint 1.4: descriptive observation fields and revised
-- trader-assessment vocabulary. Apply manually after review.

alter table public.research_annotations
  add column if not exists description text not null default '',
  add column if not exists trigger text not null default '',
  add column if not exists entry_order text not null default '',
  add column if not exists stop text not null default '',
  add column if not exists target text not null default '';

-- Keep the two legacy values readable and editable without rewriting old rows.
-- New-entry UI offers only the four current values.
alter table public.research_annotations
  drop constraint if exists research_annotations_assessment_check;

alter table public.research_annotations
  add constraint research_annotations_assessment_check
  check (assessment in (
    'trade_taken',
    'trade_not_taken',
    'consider',
    'discard',
    'wait',
    'undetermined'
  ));

-- candidate_rule is intentionally retained for historical compatibility.
-- RLS policies and ownership rules are unchanged.
