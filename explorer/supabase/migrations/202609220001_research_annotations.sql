-- Trade Bot Explorer v0.2: explicit two-person membership and research records.
-- Apply through the Supabase SQL editor only after reviewing the policies.

create extension if not exists pgcrypto;

create table if not exists public.research_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists research_members_email_lower_idx
  on public.research_members (lower(email));

create table if not exists public.research_annotations (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version = 1),
  author_id uuid not null default auth.uid()
    references public.research_members(user_id) on delete restrict,
  contract text not null check (contract ~ '^[A-Z0-9]+$'),
  trading_date date not null,
  timeframe_minutes integer not null check (timeframe_minutes in (1, 5, 10, 15, 30, 60)),
  start_timestamp bigint not null check (start_timestamp > 0),
  end_timestamp bigint not null check (end_timestamp >= start_timestamp),
  analysis_cutoff_timestamp bigint not null check (analysis_cutoff_timestamp >= start_timestamp),
  pattern text not null check (pattern in ('false_breakout', 'pullback', 'inside_bar', 'doji', 'other')),
  pattern_detail text not null default '',
  direction text not null check (direction in ('long', 'short', 'undetermined')),
  market_context text not null check (market_context in ('uptrend', 'downtrend', 'sideways', 'transition')),
  context_explanation text not null default '',
  factors jsonb not null default '[]'::jsonb check (jsonb_typeof(factors) = 'array'),
  assessment text not null check (assessment in ('consider', 'discard', 'wait', 'undetermined')),
  assessment_explanation text not null check (length(btrim(assessment_explanation)) > 0),
  missing_confirmation text not null default '',
  invalidation_conditions text not null default '',
  candidate_rule text not null default '',
  research_status text not null check (research_status in ('observation', 'candidate', 'clarification', 'review')),
  drawings jsonb not null default '[]'::jsonb check (jsonb_typeof(drawings) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_annotations_day_idx
  on public.research_annotations (contract, trading_date, updated_at desc);
create index if not exists research_annotations_author_idx
  on public.research_annotations (author_id, updated_at desc);

create or replace function public.set_research_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists research_annotations_set_updated_at on public.research_annotations;
create trigger research_annotations_set_updated_at
before update on public.research_annotations
for each row execute function public.set_research_updated_at();

create or replace function public.is_research_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.research_members where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_research_member() from public;
grant execute on function public.is_research_member() to authenticated;

alter table public.research_members enable row level security;
alter table public.research_annotations enable row level security;

drop policy if exists "members can read allowlist" on public.research_members;
create policy "members can read allowlist"
on public.research_members for select to authenticated
using (public.is_research_member());

drop policy if exists "members can read shared research" on public.research_annotations;
create policy "members can read shared research"
on public.research_annotations for select to authenticated
using (public.is_research_member());

drop policy if exists "members can create own research" on public.research_annotations;
create policy "members can create own research"
on public.research_annotations for insert to authenticated
with check (public.is_research_member() and author_id = (select auth.uid()));

drop policy if exists "authors can update own research" on public.research_annotations;
create policy "authors can update own research"
on public.research_annotations for update to authenticated
using (public.is_research_member() and author_id = (select auth.uid()))
with check (public.is_research_member() and author_id = (select auth.uid()));

drop policy if exists "authors can delete own research" on public.research_annotations;
create policy "authors can delete own research"
on public.research_annotations for delete to authenticated
using (public.is_research_member() and author_id = (select auth.uid()));

revoke all on public.research_members from anon;
revoke all on public.research_annotations from anon;
grant select on public.research_members to authenticated;
grant select, insert, update, delete on public.research_annotations to authenticated;

-- After both researchers have signed in once, add exactly those accounts:
-- insert into public.research_members (user_id, email, display_name)
-- select id, email, coalesce(raw_user_meta_data ->> 'full_name', email)
-- from auth.users
-- where lower(email) in ('researcher-one@example.com', 'researcher-two@example.com')
-- on conflict (user_id) do update
-- set email = excluded.email, display_name = excluded.display_name;
