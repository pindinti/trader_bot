import assert from 'node:assert/strict';
import test from 'node:test';

import { CANDLE_BUCKET, downloadPrivateJson } from '../src/candle-storage.js';

function storageResult(result, calls) {
  return {
    from(bucket) {
      calls.push({ bucket });
      return {
        async download(path) {
          calls.push({ path });
          return result;
        },
      };
    },
  };
}

test('authenticated Storage download parses the existing candle JSON format', async () => {
  const calls = [];
  const payload = { schemaVersion: 1, contract: 'WDOV26', candles: [] };
  const storage = storageResult({ data: new Blob([JSON.stringify(payload)]), error: null }, calls);

  assert.deepEqual(await downloadPrivateJson(storage, 'WDOV26/2026-09-21.json'), payload);
  assert.deepEqual(calls, [
    { bucket: CANDLE_BUCKET },
    { path: 'WDOV26/2026-09-21.json' },
  ]);
});

test('denied Storage access produces a clear error without exposing object paths', async () => {
  const storage = storageResult({ data: null, error: { statusCode: '403', message: 'Forbidden' } }, []);
  await assert.rejects(
    downloadPrivateJson(storage, 'WDOV26/2026-09-21.json'),
    (error) => error.code === 'access-denied'
      && /sessão expirou|não tem acesso/i.test(error.message)
      && !error.message.includes('WDOV26'),
  );
});

test('missing Storage objects have a distinct actionable error', async () => {
  const storage = storageResult({ data: null, error: { statusCode: '404', message: 'Not found' } }, []);
  await assert.rejects(
    downloadPrivateJson(storage, 'manifest.json'),
    (error) => error.code === 'missing-object' && /não foi encontrado/i.test(error.message),
  );
});

test('private object paths reject traversal before calling Storage', async () => {
  let called = false;
  const storage = { from() { called = true; } };
  await assert.rejects(downloadPrivateJson(storage, '../manifest.json'), { code: 'invalid-path' });
  assert.equal(called, false);
});
