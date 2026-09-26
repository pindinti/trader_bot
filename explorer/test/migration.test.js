import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/202609220001_research_annotations.sql', import.meta.url);
const replayMigrationUrl = new URL('../supabase/migrations/202609230001_replay_analyses.sql', import.meta.url);
const twoMinuteMigrationUrl = new URL('../supabase/migrations/202609250001_add_two_minute_timeframe.sql', import.meta.url);

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

test('replay analysis migration is additive and preserves existing authorization', async () => {
  const sql = await readFile(replayMigrationUrl, 'utf8');
  assert.match(sql, /add column if not exists analysis_type text not null default 'retrospective'/i);
  assert.match(sql, /add column if not exists replay_timestamp bigint/i);
  assert.match(sql, /add column if not exists replay_position integer/i);
  assert.match(sql, /analysis_type = 'replay'/i);
  assert.match(sql, /replay_timestamp is not null/i);
  assert.match(sql, /replay_position is not null/i);
  assert.match(sql, /replay_timestamp >= end_timestamp/i);
  assert.doesNotMatch(sql, /create policy|drop policy|grant .*research_annotations|revoke .*research_annotations/i);
});

test('two-minute migration changes only the timeframe constraint', async () => {
  const sql = await readFile(twoMinuteMigrationUrl, 'utf8');
  assert.match(sql, /timeframe_minutes in \(1, 2, 5, 10, 15, 30, 60\)/i);
  assert.doesNotMatch(sql, /create policy|drop policy|grant |revoke |alter column|drop column/i);
});
