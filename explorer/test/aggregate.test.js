import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateCandles } from '../src/aggregate.js';
import { aggregateCompletedReplayCandles } from '../src/replay.js';

const minute = (hour, value, changes = {}) => ({
  time: Date.UTC(2026, 8, 21, hour, value) / 1000,
  open: 100 + value,
  high: 102 + value,
  low: 99 + value,
  close: 101 + value,
  volume: 10,
  trades: 2,
  ...changes,
});

test('aggregates OHLC and preserves volume and trade totals', () => {
  const source = [
    minute(9, 0, { open: 10, high: 12, low: 9, close: 11, volume: 2, trades: 1 }),
    minute(9, 1, { open: 11, high: 15, low: 10, close: 14, volume: 3, trades: 2 }),
    minute(9, 4, { open: 14, high: 14, low: 8, close: 9, volume: 5, trades: 4 }),
  ];
  const [result] = aggregateCandles(source, 5);
  assert.deepEqual(result, {
    time: source[0].time, open: 10, high: 15, low: 8, close: 9, volume: 10, trades: 7,
  });
});

test('aligns buckets to clock boundaries', () => {
  const source = [minute(9, 4), minute(9, 5), minute(9, 9), minute(9, 10)];
  const result = aggregateCandles(source, 5);
  assert.deepEqual(result.map((item) => item.time), [minute(9, 0).time, minute(9, 5).time, minute(9, 10).time]);
});

test('does not synthesize buckets across missing minutes', () => {
  const result = aggregateCandles([minute(9, 0), minute(9, 12)], 5);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.time), [minute(9, 0).time, minute(9, 10).time]);
});

test('aggregates clock-aligned completed two-minute buckets without synthesizing missing minutes', () => {
  const source = [
    minute(9, 0, { open: 10, high: 12, low: 9, close: 11, volume: 2, trades: 1 }),
    minute(9, 1, { open: 11, high: 15, low: 10, close: 14, volume: 3, trades: 2 }),
    minute(9, 3, { open: 14, high: 16, low: 13, close: 15, volume: 5, trades: 4 }),
    minute(9, 4),
  ];
  const completed = aggregateCompletedReplayCandles(source, 2, source.at(-1).time);
  assert.deepEqual(completed, [
    { time: minute(9, 0).time, open: 10, high: 15, low: 9, close: 14, volume: 5, trades: 3 },
    { time: minute(9, 2).time, open: 14, high: 16, low: 13, close: 15, volume: 5, trades: 4 },
  ]);
  assert.equal(completed.some(({ time }) => time === minute(9, 4).time), false, 'partial final bucket is excluded');
});

test('one-minute mode returns independent copies', () => {
  const source = [minute(9, 0)];
  const result = aggregateCandles(source, 1);
  assert.deepEqual(result, source);
  assert.notEqual(result[0], source[0]);
});

test('rejects unsupported intervals and unordered source candles', () => {
  assert.throws(() => aggregateCandles([], 3), RangeError);
  assert.throws(() => aggregateCandles([minute(9, 1), minute(9, 0)], 5), /unique, increasing/);
  assert.throws(() => aggregateCandles([minute(9, 0), minute(9, 0)], 5), /unique, increasing/);
});
