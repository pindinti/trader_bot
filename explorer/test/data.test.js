import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDayPayload } from '../src/data.js';

const base = {
  sourceTimeframeMinutes: 1, contract: 'WDOV26', date: '2026-09-21',
};

test('schema 2 daily payload carries exact trade notional into candle data', () => {
  const [candle] = parseDayPayload({
    ...base, schemaVersion: 2,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'notional', 'trades'],
    candles: [['2026-09-21 10:00:00', '10', '12', '9', '11', 5, '54', 3]],
  }, 'WDOV26', '2026-09-21');
  assert.equal(candle.notional, 54);
});

test('schema 1 remains readable but explicitly lacks exact VWAP notional', () => {
  const [candle] = parseDayPayload({
    ...base, schemaVersion: 1,
    columns: ['datetime', 'open', 'high', 'low', 'close', 'volume', 'trades'],
    candles: [['2026-09-21 10:00:00', '10', '12', '9', '11', 5, 3]],
  }, 'WDOV26', '2026-09-21');
  assert.equal(candle.notional, null);
});
