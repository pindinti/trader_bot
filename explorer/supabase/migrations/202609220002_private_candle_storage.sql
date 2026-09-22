-- Trade Bot Explorer: private, read-only candle objects for authorized researchers.
-- Object layout:
--   manifest.json
--   WDOV26/YYYY-MM-DD.json

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trade-bot-candles',
  'trade-bot-candles',
  false,
  1048576,
  array['application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "research members can read private candles" on storage.objects;
create policy "research members can read private candles"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'trade-bot-candles'
  and storage.allow_any_operation(array[
    'object.get_authenticated_info',
    'object.get_authenticated'
  ])
  and public.is_research_member()
);

-- Intentionally no INSERT, UPDATE, or DELETE policy is created for this bucket.
-- Uploads are an explicit administrative operation through the Supabase Dashboard.
