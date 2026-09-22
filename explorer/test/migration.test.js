import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/202609220001_research_annotations.sql', import.meta.url);

test('Supabase migration enables RLS and keeps drawings owned by their annotation', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /research_members enable row level security/i);
  assert.match(sql, /research_annotations enable row level security/i);
  assert.match(sql, /members can read shared research/i);
  assert.match(sql, /authors can update own research/i);
  assert.match(sql, /authors can delete own research/i);
  assert.match(sql, /author_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /drawings jsonb not null/i);
  assert.match(sql, /revoke all on public\.research_annotations from anon/i);
});
