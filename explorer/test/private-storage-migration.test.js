import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../supabase/migrations/202609220002_private_candle_storage.sql', import.meta.url);

test('private candle bucket is idempotent and readable only through membership policy', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /insert into storage\.buckets/i);
  assert.match(sql, /'trade-bot-candles'/i);
  assert.match(sql, /on conflict \(id\) do update/i);
  assert.match(sql, /set public = false/i);
  assert.match(sql, /on storage\.objects\s+for select\s+to authenticated/is);
  assert.match(sql, /bucket_id = 'trade-bot-candles'/i);
  assert.match(sql, /storage\.allow_any_operation/i);
  assert.match(sql, /object\.get_authenticated/i);
  assert.match(sql, /public\.is_research_member\(\)/i);
  assert.doesNotMatch(sql, /create policy[\s\S]*for (insert|update|delete)/i);
});
